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
  writeFileSync,
  mkdirSync,
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

  readSettings(): Record<string, unknown> | null {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  writeSettings(settings: Record<string, unknown>): void {
    const settingsPath = this.getSettingsPath();
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
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
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const config = JSON.parse(raw);
      const mcpServers = config?.mcpServers ?? {};

      if ("context-mode" in mcpServers) {
        return {
          check: "MCP registration",
          status: "pass",
          message: "context-mode found in mcpServers config",
        };
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "context-mode not found in mcpServers",
        fix: "Add context-mode to mcpServers in ~/.gemini/antigravity/mcp_config.json",
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: "Could not read ~/.gemini/antigravity/mcp_config.json",
      };
    }
  }

  getInstalledVersion(): string {
    try {
      const pkgPath = resolve(
        homedir(),
        ".gemini",
        "extensions",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return pkg.version ?? "unknown";
    } catch {
      return "not installed";
    }
  }

  getRoutingInstructions(): string {
    const instructionsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "configs",
      "antigravity",
      "GEMINI.md",
    );
    try {
      return readFileSync(instructionsPath, "utf-8");
    } catch {
      return "# context-mode\n\nUse context-mode MCP tools (execute, execute_file, batch_execute, fetch_and_index, search) instead of run_command/view_file for data-heavy operations.";
    }
  }
}
