/**
 * adapters/zed — Zed editor platform adapter.
 *
 * Extends McpOnlyBaseAdapter (MCP-only, no hooks).
 *
 * Zed specifics:
 *   - NO hook support — Zed is an editor, not a CLI with hook pipelines
 *   - Config: ~/.config/zed/settings.json (JSON format)
 *   - MCP: full support via context_servers section in settings.json
 *   - Session dir: ~/.config/zed/context-mode/sessions/
 */

import {
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import { McpOnlyBaseAdapter } from "../../mcp-only-base.js";

import type {
  DiagnosticResult,
} from "../../types.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class ZedAdapter extends McpOnlyBaseAdapter {
  constructor() {
    super([".config", "zed"]);
  }

  readonly name = "Zed";

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return resolve(homedir(), ".config", "zed", "settings.json");
  }

  getInstructionFiles(): string[] {
    return ["AGENTS.md"];
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    return [
      {
        check: "Hook support",
        status: "warn",
        message:
          "Zed does not support hooks. Only MCP integration is available.",
      },
    ];
  }

  checkPluginRegistration(): DiagnosticResult {
    // Check for context-mode in context_servers section of settings.json
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const settings = JSON.parse(raw);
      const hasContextServers = settings.context_servers !== undefined;
      const hasContextMode = raw.includes("context-mode");

      if (hasContextServers && hasContextMode) {
        return {
          check: "MCP registration",
          status: "pass",
          message: "context-mode found in context_servers config",
        };
      }

      if (hasContextServers) {
        return {
          check: "MCP registration",
          status: "fail",
          message:
            "context_servers section exists but context-mode not found",
          fix: 'Add context-mode to context_servers in ~/.config/zed/settings.json',
        };
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "No context_servers section in settings.json",
        fix: 'Add context_servers.context-mode to ~/.config/zed/settings.json',
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: "Could not read ~/.config/zed/settings.json",
      };
    }
  }

  getRoutingInstructions(): string {
    return this.readRoutingInstructionsFile("zed", "AGENTS.md", "execute, execute_file, batch_execute, fetch_and_index, search");
  }

  getInstalledVersion(): string {
    // Zed has no marketplace or plugin system for context-mode
    return "not installed";
  }
}
