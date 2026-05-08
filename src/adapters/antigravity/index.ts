/**
 * adapters/antigravity — Google Antigravity platform adapter.
 *
 * Extends McpOnlyBaseAdapter (MCP-only, no hooks).
 *
 * Antigravity specifics:
 *   - NO hook support (MCP-only)
 *   - Config: ~/.gemini/antigravity/mcp_config.json (JSON format)
 *   - MCP: full support via mcpServers in mcp_config.json
 *   - Session dir: ~/.gemini/context-mode/sessions/
 *   - Routing file: GEMINI.md (shared with Gemini CLI filename, different content)
 *
 * Sources:
 *   - Config path: https://github.com/google-gemini/gemini-cli/issues/16058
 *   - MCP support: https://antigravity.google/docs/mcp
 *   - Tool list: System prompt leak (21 verified tools)
 */

import {
  readFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { McpOnlyBaseAdapter } from "../mcp-only-base.js";

import type {
  DiagnosticResult,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class AntigravityAdapter extends McpOnlyBaseAdapter {
  constructor() {
    super([".gemini"]);
  }

  readonly name = "Antigravity";

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return resolve(homedir(), ".gemini", "antigravity", "mcp_config.json");
  }

  /**
   * Antigravity nests under ~/.gemini/antigravity/. Always absolute.
   * `_projectDir` accepted to interface symmetry but unused — home-rooted.
   */
  getConfigDir(_projectDir?: string): string {
    return resolve(homedir(), ".gemini", "antigravity");
  }

  getInstructionFiles(): string[] {
    return ["GEMINI.md"];
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    return [
      {
        check: "Hook support",
        status: "warn",
        message:
          "Antigravity does not support hooks. " +
          "Only MCP integration is available.",
      },
    ];
  }

  checkPluginRegistration(): DiagnosticResult {
    return this.checkMcpServersRegistration("~/.gemini/antigravity/mcp_config.json");
  }

  getInstalledVersion(): string {
    return this.readVersionFromExtensionCache([".gemini"]);
  }

  getRoutingInstructions(): string {
    return this.readRoutingInstructionsFile("antigravity", "GEMINI.md", "execute, execute_file, batch_execute, fetch_and_index, search");
  }
}
