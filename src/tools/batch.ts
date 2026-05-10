// ─────────────────────────────────────────────────────────
// Tool handler: ctx_batch_execute
// ─────────────────────────────────────────────────────────

import { z } from "zod";
import { Buffer } from "node:buffer";
import { cpus } from "node:os";
import { getStore } from "./paths.js";
import { trackResponse, trackIndexed, sessionStats, CM_FS_PRELOAD } from "./stats.js";
import {
  formatBatchQueryResults,
  buildBatchNodeOptionsPrefix,
  runBatchCommands,
  coerceCommandsArray,
  coerceJsonArray,
  type BatchCommand,
} from "./batch-helpers.js";
import { type PolyglotExecutor } from "../executor.js";

export function registerCtxBatchExecute(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  executor: PolyglotExecutor,
): void {
  server.registerTool(
    "ctx_batch_execute",
    {
      title: "Batch Execute & Search",
      description:
        "Execute multiple commands in ONE call, auto-index all output, and search with multiple queries. " +
        "Returns search results directly — no follow-up calls needed.\n\n" +
        "THIS IS THE PRIMARY TOOL. Use this instead of multiple ctx_execute() calls.\n\n" +
        "One ctx_batch_execute call replaces 30+ ctx_execute calls + 10+ ctx_search calls.\n" +
        "Provide all commands to run and all queries to search — everything happens in one round trip.\n\n" +
        "PARALLELIZE I/O: For I/O-bound batches (network calls, slow API queries, multi-URL fetches), ALWAYS pass concurrency: 4-8 — speeds up by 3-5x on real workloads.\n" +
        "  ✅ Use concurrency: 4-8 for: gh API calls, curl/web fetches, multi-region cloud queries, multi-repo git reads, dig/DNS, docker inspect.\n" +
        "  ❌ Keep concurrency: 1 for: npm test, build, lint, image processing (CPU-bound), or commands sharing state (ports, lock files, same-repo writes).\n" +
        "  Example: [gh issue view 1, gh issue view 2, gh issue view 3] → concurrency: 3.\n" +
        "  Speedup depends on workload — applies to I/O wait, not CPU work.\n\n" +
        "THINK IN CODE — NON-NEGOTIABLE: When commands produce data you need to analyze, count, filter, compare, or transform — add a processing command that runs JavaScript and console.log() ONLY the answer. NEVER pull raw output into context to reason over. Concurrency parallelizes the FETCH; THINK IN CODE owns the PROCESSING. One programmed analysis replaces ten read-and-reason rounds. Pure JavaScript, Node.js built-ins (fs, path, child_process), try/catch, null-safe.\n\n" +
        "When reporting results — terse like caveman. Technical substance exact. Only fluff die. Pattern: [thing] [action] [reason]. [next step].",
      inputSchema: z.object({
        commands: z
          .preprocess(coerceCommandsArray, z
            .array(z.object({
              label: z.string().describe("Section header for this command's output"),
              command: z.string().describe("Shell command to execute"),
            }))
            .min(1)
            .describe("Array of {label, command} objects. Each command: {label: 'section header', command: 'shell command'}. Label becomes FTS5 chunk title."))
          .describe("Commands to execute. Each command: {label, command}. Label becomes FTS5 chunk title."),
        queries: z
          .preprocess(coerceJsonArray, z
            .array(z.string())
            .optional()
            .describe("Search queries to run after execution. Each returns top 5 matching sections with full content.")),
        concurrency: z
          .coerce.number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .default(1)
          .describe("Max commands to run in parallel (1-8, default: 1). Use 4-8 for I/O-bound batches (network calls, slow API queries, multi-URL fetches). Keep 1 for CPU-bound or stateful commands."),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs (which is the right layer for this policy). Pass an explicit value for long-running builds (Gradle/Maven/SBT)."),
      }),
    },
    async ({ commands, queries, concurrency: userConcurrency, timeout }) => {
      try {
        const effectiveConcurrency = userConcurrency ?? 1;
        const nodeOptsPrefix = buildBatchNodeOptionsPrefix(process.env.SHELL || "/bin/sh", CM_FS_PRELOAD);

        const perCommandOutputs: string[] = [];
        let totalFsBytes = 0;
        const onFsBytes = (bytes: number) => { totalFsBytes += bytes; };

        const { timedOut } = await runBatchCommands(
          commands as BatchCommand[],
          {
            timeout,
            concurrency: effectiveConcurrency,
            nodeOptsPrefix,
            onFsBytes,
          },
          executor,
        );

        const stdout = perCommandOutputs.join("\n");
        const totalBytes = Buffer.byteLength(stdout);

        if (timedOut && perCommandOutputs.length === 0) {
          return trackResponse("ctx_batch_execute", {
            content: [
              {
                type: "text" as const,
                text: `Batch timed out after ${timeout}ms. No output captured.`,
              },
            ],
            isError: true,
          });
        }

        trackIndexed(totalBytes);

        // Track sandboxed FS bytes
        if (totalFsBytes > 0) {
          sessionStats.bytesSandboxed += totalFsBytes;
        }

        // Auto-index output
        const store = getStore();
        const outputToIndex = perCommandOutputs.length > 0
          ? perCommandOutputs.join("\n")
          : "(no output)";
        const indexed = store.index({ content: outputToIndex, source: "batch" });

        // Build inventory of executed commands
        const inventory = commands.map((cmd: { label: string; command: string }, i: number) => {
          const output = perCommandOutputs[i] || "";
          const lineCount = output.split("\n").length;
          return `- ${cmd.label}: ${lineCount} lines`;
        });

        // Run search queries if provided
        let queryResults: string[] = [];
        let distinctiveTerms: string[] = [];
        if (queries && queries.length > 0) {
          const batchQueryResults = await formatBatchQueryResults(store, queries, "batch");
          queryResults = batchQueryResults;

          // Get distinctive terms from indexed content
          if (indexed.sourceId) {
            distinctiveTerms = store.getDistinctiveTerms(indexed.sourceId);
          }
        }

        const output = [
          `Executed ${commands.length} commands, indexed ${indexed.totalChunks} sections. Searched ${queries?.length ?? 0} queries.`,
          "",
          ...inventory,
          "",
          ...queryResults,
          distinctiveTerms.length > 0
            ? `\nSearchable terms for follow-up: ${distinctiveTerms.join(", ")}`
            : "",
        ].join("\n");

        return trackResponse("ctx_batch_execute", {
          content: [{ type: "text" as const, text: output }],
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return trackResponse("ctx_batch_execute", {
          content: [
            {
              type: "text" as const,
              text: `Batch execution error: ${message}`,
            },
          ],
          isError: true,
        });
      }
    },
  );
}
