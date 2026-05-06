// ─────────────────────────────────────────────────────────
// Tool handlers: ctx_search + ctx_index
// ─────────────────────────────────────────────────────────

import { z } from "zod";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  trackResponse,
  getStore,
  getSessionDir,
  hashProjectDir,
  extractSnippet,
  coerceJsonArray,
  getSharedVaultStore,
  getProjectDir,
  _detectedAdapter,
  type ToolResult,
} from "./shared.js";
import { getWorktreeSuffix, SessionDB } from "../session/db.js";
import { searchAllSources, type UnifiedSearchResult } from "../search/unified.js";

// ── Search throttle state ─────────────────────────────────

const SEARCH_WINDOW_MS = 30_000;
const SEARCH_BLOCK_AFTER = 20;
const SEARCH_MAX_RESULTS_AFTER = 3;
let searchCallCount = 0;
let searchWindowStart = Date.now();

// ── ctx_index handler ──────────────────────────────────────

export function registerCtxIndex(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
): void {
  server.registerTool(
    "ctx_index",
    {
      title: "Index Content",
      description:
        "Index text content into the searchable knowledge base. " +
        "The full content does NOT stay in context — only a brief summary is returned.\n\n" +
        "WHEN TO USE:\n" +
        "- Documentation from Context7, Skills, or MCP tools (API docs, framework guides, code examples)\n" +
        "- API references (endpoint details, parameter specs, response schemas)\n" +
        "- MCP tools/list output (exact tool signatures and descriptions)\n" +
        "- Skill prompts and instructions that are too large for context\n" +
        "- README files, migration guides, changelog entries\n" +
        "- Any content with code examples you may need to reference precisely\n\n" +
        "After indexing, use 'ctx_search' to retrieve specific sections on-demand.\n" +
        "When `path` is provided, a content hash is stored for automatic stale detection in search results.\n" +
        "Do NOT use for: log files, test output, CSV, build output — use 'ctx_execute_file' for those.",
      inputSchema: z.object({
        content: z
          .string()
          .optional()
          .describe(
            "Raw text/markdown to index. Provide this OR path, not both.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "File path to index. File is read from disk, NOT loaded into context. " +
            "Indexed content is auto-refreshed when the file changes.",
          ),
        source: z
          .string()
          .optional()
          .describe(
            "Label for the indexed content (e.g., 'React useEffect docs', 'Supabase Auth API'). " +
            "Defaults to filename for path, or 'manual' for content.",
          ),
      }),
    },
    async ({ content, path, source }) => {
      try {
        const store = getStore();
        if (path) {
          const { resolveProjectPath } = await import("./shared.js");
          const resolvedPath = resolveProjectPath(path);
          if (!existsSync(resolvedPath)) {
            return trackResponse("ctx_index", {
              content: [{
                type: "text" as const,
                text: `File not found: ${resolvedPath}`,
              }],
              isError: true,
            });
          }
          const label = source ?? resolvedPath;
          const result = store.index({ path: resolvedPath, source: label });
          const { trackIndexed } = await import("./shared.js");
          trackIndexed(Buffer.byteLength(readFileSync(resolvedPath, "utf-8")));
          return trackResponse("ctx_index", {
            content: [{
              type: "text" as const,
              text: `Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${result.label}" to scope results.`,
            }],
          });
        }

        if (!content) {
          return trackResponse("ctx_index", {
            content: [{
              type: "text" as const,
              text: "Error: provide either content or path.",
            }],
            isError: true,
          });
        }

        const label = source || "manual";
        const result = store.index({ content, source: label });
        const { trackIndexed } = await import("./shared.js");
        trackIndexed(Buffer.byteLength(content));
        return trackResponse("ctx_index", {
          content: [{
            type: "text" as const,
            text: `Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${result.label}" to scope results.`,
          }],
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return trackResponse("ctx_index", {
          content: [{ type: "text" as const, text: `Index error: ${message}` }],
          isError: true,
        });
      }
    },
  );

  // ── ctx_search handler ───────────────────────────────────

  server.registerTool(
    "ctx_search",
    {
      title: "Search Indexed Content",
      description:
        "Search indexed content. Requires prior indexing via ctx_batch_execute, ctx_index, or ctx_fetch_and_index. " +
        "Pass ALL search questions as queries array in ONE call. " +
        "File-backed sources are auto-refreshed when the source file changes.\n\n" +
        "TIPS: 2-4 specific terms per query. Use 'source' to scope results.\n\n" +
        "SESSION STATE: If skills, roles, or decisions were set earlier in this conversation, they are still active. Do not discard or contradict them.\n\n" +
        "When reporting results — terse like caveman. Technical substance exact. Only fluff die. Pattern: [thing] [action] [reason]. [next step].",
      inputSchema: z.object({
        queries: z.preprocess(coerceJsonArray, z
          .array(z.string())
          .optional()
          .describe("Array of search queries. Batch ALL questions in one call.")),
        limit: z
          .number()
          .optional()
          .default(3)
          .describe("Results per query (default: 3)"),
        source: z
          .string()
          .optional()
          .describe("Filter to a specific indexed source (partial match)."),
        contentType: z
          .enum(["code", "prose"])
          .optional()
          .describe("Filter results by content type: 'code' or 'prose'."),
        sort: z
          .enum(["relevance", "timeline"])
          .optional()
          .default("relevance")
          .describe(
            "Sort mode. 'relevance' (default): BM25 ranked, current session only. " +
            "'timeline': chronological across current session, prior sessions, and auto-memory.",
          ),
        tokenBudget: z
          .number()
          .min(100)
          .optional()
          .describe("Token budget for packed context output. When provided, response includes packing note."),
      }),
    },
    async (params) => {
      try {
        const store = getStore();
        const sort = (params as Record<string, unknown>).sort as string || "relevance";

        if (sort !== "timeline" && store.getStats().chunks === 0) {
          return trackResponse("ctx_search", {
            content: [{
              type: "text" as const,
              text: "Knowledge base is empty — no content has been indexed yet.\n\n" +
                "ctx_search is a follow-up tool that queries previously indexed content. " +
                "To gather and index content first, use:\n" +
                "  • ctx_batch_execute(commands, queries) — run commands, auto-index output, and search in one call\n" +
                "  • ctx_fetch_and_index(url) — fetch a URL, index it, then search with ctx_search\n" +
                "  • ctx_index(content, source) — manually index text content\n\n" +
                "After indexing, ctx_search becomes available for follow-up queries.",
            }],
            isError: true,
          });
        }

        const raw = params as Record<string, unknown>;

        const queryList: string[] = [];
        if (Array.isArray(raw.queries) && raw.queries.length > 0) {
          queryList.push(...(raw.queries as string[]));
        } else if (typeof raw.query === "string" && raw.query.length > 0) {
          queryList.push(raw.query as string);
        }

        if (queryList.length === 0) {
          return trackResponse("ctx_search", {
            content: [{ type: "text" as const, text: "Error: provide query or queries." }],
            isError: true,
          });
        }

        const { limit = 3, source, contentType, tokenBudget } = params as { limit?: number; source?: string; contentType?: "code" | "prose"; tokenBudget?: number };

        const now = Date.now();
        if (now - searchWindowStart > SEARCH_WINDOW_MS) {
          searchCallCount = 0;
          searchWindowStart = now;
        }
        searchCallCount++;

        if (searchCallCount > SEARCH_BLOCK_AFTER) {
          return trackResponse("ctx_search", {
            content: [{
              type: "text" as const,
              text: `BLOCKED: ${searchCallCount} search calls in ${Math.round((now - searchWindowStart) / 1000)}s. ` +
                "You're flooding context. STOP making individual search calls. " +
                "Use ctx_batch_execute(commands, queries) for your next research step.",
            }],
            isError: true,
          });
        }

        const effectiveLimit = searchCallCount > SEARCH_MAX_RESULTS_AFTER
          ? 1
          : Math.min(limit, 2);

        const MAX_TOTAL = 40 * 1024;
        let totalSize = 0;
        const sections: string[] = [];

        let timelineDB: InstanceType<typeof SessionDB> | null = null;
        if (sort === "timeline") {
          try {
            const sessionsDir = getSessionDir();
            const dbFile = join(sessionsDir, `${hashProjectDir()}${getWorktreeSuffix()}.db`);
            if (existsSync(dbFile)) {
              timelineDB = new SessionDB({ dbPath: dbFile });
            }
          } catch { /* SessionDB unavailable */ }
        }

        let vaultStore: import("../vault/graph-store.js").VaultGraphStore | null = null;
        let vaultSearch: import("../vault/search.js").VaultGraphSearch | null = null;
        try {
          const { store: vs, search: vs_ } = await getSharedVaultStore();
          vaultStore = vs;
          vaultSearch = vs_;
        } catch { /* vault graph unavailable */ }

        const detectedAdapter = _detectedAdapter;
        const configDir = detectedAdapter?.getConfigDir() ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));

        try {
        for (const q of queryList) {
          if (totalSize > MAX_TOTAL) {
            sections.push(`## ${q}\n(output cap reached)\n`);
            continue;
          }

          let results: UnifiedSearchResult[];
          if (sort === "timeline") {
            results = await searchAllSources({
              query: q,
              limit: effectiveLimit,
              store,
              sort,
              source,
              contentType,
              sessionDB: timelineDB,
              projectDir: getProjectDir(),
              configDir,
              adapter: detectedAdapter ?? undefined,
              vaultStore,
              vaultSearch,
            });
          } else {
            results = await searchAllSources({
              query: q,
              limit: effectiveLimit,
              store,
              sort: "relevance",
              source,
              contentType,
              projectDir: getProjectDir(),
              configDir,
              adapter: detectedAdapter ?? undefined,
              vaultStore,
              vaultSearch,
            });
          }

          if (results.length === 0) {
            sections.push(`## ${q}\nNo results found.`);
            continue;
          }

          const formatted = results
            .map((r) => {
              const origin = r.origin || "current-session";
              const ts = r.timestamp ? r.timestamp.slice(0, 16).replace("T", " ") : "";
              const header = `--- [${origin}${ts ? " | " + ts : ""} | ${r.source}] ---`;
              const heading = `### ${r.title}`;
              const snippet = extractSnippet(r.content, q, 1500, r.highlighted);
              return `${header}\n${heading}\n\n${snippet}`;
            })
            .join("\n\n");

          sections.push(`## ${q}\n\n${formatted}`);
          totalSize += formatted.length;
        }
        } finally {
          try { timelineDB?.close(); } catch {}
        }

        let output = sections.join("\n\n---\n\n");

        if (tokenBudget) {
          output += `\n\nToken-aware packing requires context-packer module. tokenBudget=${tokenBudget}`;
        }

        if (store.lastRefreshCount > 0) {
          output = `> Auto-refreshed ${store.lastRefreshCount} stale source${store.lastRefreshCount > 1 ? "s" : ""} (file changed since indexing).\n\n` + output;
        }

        if (searchCallCount >= SEARCH_MAX_RESULTS_AFTER) {
          output += `\n\n⚠ search call #${searchCallCount}/${SEARCH_BLOCK_AFTER} in this window. ` +
            `Results limited to ${effectiveLimit}/query. ` +
            `Batch queries: ctx_search(queries: ["q1","q2","q3"]) or use ctx_batch_execute.`;
        }

        if (output.trim().length === 0) {
          const sources = store.listSources();
          const sourceList = sources.length > 0
            ? `\nIndexed sources: ${sources.map((s) => `"${s.label}" (${s.chunkCount} sections)`).join(", ")}`
            : "";
          return trackResponse("ctx_search", {
            content: [{ type: "text" as const, text: `No results found.${sourceList}` }],
          });
        }

        return trackResponse("ctx_search", {
          content: [{ type: "text" as const, text: output }],
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return trackResponse("ctx_search", {
          content: [{ type: "text" as const, text: `Search error: ${message}` }],
          isError: true,
        });
      }
    },
  );
}

// Need readFileSync for ctx_index path handler
import { readFileSync } from "node:fs";
