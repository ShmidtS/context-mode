// ─────────────────────────────────────────────────────────
// Central tool registration — wires all tools to McpServer
// ─────────────────────────────────────────────────────────

import type { PolyglotExecutor } from "../executor.js";
import { registerCtxExecute } from "./execute.js";
import { registerCtxIndex } from "./search.js";
import { registerCtxBatchExecute } from "./batch.js";
import { registerAdminTools } from "./admin.js";
import { registerVaultTools } from "./vault.js";

export function registerAllTools(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  executor: PolyglotExecutor,
): void {
  registerCtxExecute(server, executor);
  registerCtxIndex(server);
  registerCtxBatchExecute(server, executor);
  registerAdminTools(server, executor);
  registerVaultTools(server);
}
