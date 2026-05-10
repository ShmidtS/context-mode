#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PolyglotExecutor } from "./executor.js";
import { cleanupStaleDBs } from "./store.js";
import { detectRuntimes, getRuntimeSummary, hasBunRuntime } from "./runtime.js";
import { startLifecycleGuard } from "./lifecycle.js";
import { ListPromptsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  VERSION,
  _insightChild,
  closeStore,
} from "./tools/paths.js";
import {
  persistStats,
  restoreStatsOnStartup,
  startVersionCheck,
  CM_FS_PRELOAD,
  writeFsPreload,
} from "./tools/stats.js";
import { resetVaultStore } from "./tools/vault-lifecycle.js";
import { registerAllTools } from "./tools/register.js";

// Prevent silent server death from unhandled async errors
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[context-mode] unhandledRejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`[context-mode] uncaughtException: ${err?.message ?? err}\n`);
});

const runtimes = detectRuntimes();
const server = new McpServer({
  name: "context-mode",
  version: VERSION,
});

// Register empty prompts/resources handlers so MCP clients don't get -32601 (#168).
server.server.registerCapabilities({ prompts: { listChanged: false }, resources: { listChanged: false } });
server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

const executor = new PolyglotExecutor({
  runtimes,
  projectRoot: () => process.env.CLAUDE_PROJECT_DIR
    || process.env.GEMINI_PROJECT_DIR
    || process.env.VSCODE_CWD
    || process.env.OPENCODE_PROJECT_DIR
    || process.env.PI_PROJECT_DIR
    || process.env.IDEA_INITIAL_DIRECTORY
    || process.env.CONTEXT_MODE_PROJECT_DIR
    || process.cwd(),
});

// Write the FS read tracking preload script for ctx_batch_execute
writeFsPreload();

// ── Register all tools ────────────────────────────────────
registerAllTools(server, executor);

// ─────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────

async function main() {
  // Clean up stale DB files from previous sessions
  const cleaned = cleanupStaleDBs();
  if (cleaned > 0) {
    console.error(`Cleaned up ${cleaned} stale DB file(s) from previous sessions`);
  }

  // MCP readiness sentinel path (#230, #347)
  const mcpSentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
  const mcpSentinel = join(mcpSentinelDir, `context-mode-mcp-ready-${process.pid}`);

  // Clean up own DB + backgrounded processes + preload script on shutdown
  const shutdown = () => {
    executor.cleanupBackgrounded();
    closeStore();
    resetVaultStore();
    try { unlinkSync(CM_FS_PRELOAD); } catch (e) { console.warn("unlinkSync preload failed", e) }
    // Remove MCP readiness sentinel (#230)
    try { unlinkSync(mcpSentinel); } catch (e) { console.warn("unlinkSync sentinel failed", e) }
    // Stop ctx_insight dashboard so it does not outlive Claude.
    if (_insightChild && _insightChild.pid && !_insightChild.killed) {
      try { _insightChild.kill("SIGTERM"); } catch (e) { console.warn("kill insight child failed", e) }
    }
  };
  const gracefulShutdown = async () => {
    // Final stats flush — bypass throttle so the last 0-500ms of
    // bytes_indexed / bytes_returned aren't silently lost on SIGTERM/SIGINT
    try {
      persistStats(true);
    } catch (e) { console.warn("persistStats during shutdown failed", e) }
    shutdown();
    process.exit(0);
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => { gracefulShutdown(); });
  process.on("SIGTERM", () => { gracefulShutdown(); });

  // Lifecycle guard: detect parent death + stdin close to prevent orphaned processes (#103)
  startLifecycleGuard({ onShutdown: () => gracefulShutdown() });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Write MCP readiness sentinel (#230)
  try { writeFileSync(mcpSentinel, String(process.pid)); } catch (e) { console.warn("writeSentinel failed", e) }

  // Detect platform adapter — stored for platform-aware session paths
  try {
    const { detectPlatform, getAdapter } = await import("./adapters/detect.js");
    const clientInfo = server.server.getClientVersion();
    const signal = detectPlatform(clientInfo ?? undefined);
    const adapter = await getAdapter(signal.platform);
    // Use setDetectedAdapter to update the live binding in shared.ts
    const { setDetectedAdapter } = await import("./tools/shared.js");
    setDetectedAdapter(adapter);
    if (clientInfo) {
      console.error(`MCP client: ${clientInfo.name} v${clientInfo.version} → ${signal.platform}`);
    }
  } catch (e) { console.warn("detectPlatform adapter failed", e) }

  // Restore tool-call counters from SessionDB BEFORE the heartbeat fires
  restoreStatsOnStartup();

  // Non-blocking version check — result stored for trackResponse warnings.
  startVersionCheck();

  // Stats heartbeat — keep the statusline truthful while the user works in
  // tools other than MCP (Bash/Read/Edit during long sessions or post-/compact
  // pauses). Heartbeat refreshes updated_at every 60s.
  setInterval(() => persistStats(), 60_000).unref();

  console.error(`Context Mode MCP server v${VERSION} running on stdio`);
  console.error(`Detected runtimes:\n${getRuntimeSummary(runtimes)}`);
  if (!hasBunRuntime()) {
    console.error(
      "\nPerformance tip: Install Bun for 3-5x faster JS/TS execution",
    );
    console.error("  curl -fsSL https://bun.sh/install | bash");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
