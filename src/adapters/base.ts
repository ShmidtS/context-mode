/**
 * BaseAdapter — shared implementation for methods identical across all adapters.
 *
 * Eliminates ~288 lines of duplication across 12 adapters.
 * Each concrete adapter extends this and provides platform-specific logic.
 *
 * Shared methods:
 *   - getSessionDir()       — builds session dir from sessionDirSegments
 *   - getSessionDBPath()    — SHA-256 hash of projectDir → .db file
 *   - getSessionEventsPath()— SHA-256 hash of projectDir → -events.md file
 *   - backupSettings()      — copies settings file to .bak
 *
 * Adapters with custom logic override the relevant method:
 *   - vscode-copilot: overrides getSessionDir (checks .github dir)
 *   - opencode: overrides getSessionDir (XDG_CONFIG_HOME / APPDATA)
 *              and backupSettings (calls checkPluginRegistration first)
 *   - openclaw: overrides backupSettings (searches 3 config paths)
 */

import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { accessSync, copyFileSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { DiagnosticResult } from "./types.js";

export abstract class BaseAdapter {
  constructor(protected readonly sessionDirSegments: string[]) {}

  getSessionDir(): string {
    const dir = join(homedir(), ...this.sessionDirSegments, "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  #projectHash(projectDir: string): string {
    return createHash("sha256")
      .update(projectDir)
      .digest("hex")
      .slice(0, 16);
  }

  getSessionDBPath(projectDir: string): string {
    return join(this.getSessionDir(), `${this.#projectHash(projectDir)}.db`);
  }

  getSessionEventsPath(projectDir: string): string {
    return join(this.getSessionDir(), `${this.#projectHash(projectDir)}-events.md`);
  }

  /**
   * Default: build config dir from sessionDirSegments rooted at $HOME.
   *
   * Contract: ALWAYS returns an absolute path. Adapters with project-scoped
   * or non-home-rooted config dirs (cursor, vscode-copilot, jetbrains-copilot,
   * openclaw, opencode) override this and resolve their segments against
   * `projectDir` (or `process.cwd()` when omitted).
   *
   * @param _projectDir Unused by the home-rooted default — accepted so
   *                    project-scoped overrides honor the same signature.
   */
  getConfigDir(_projectDir?: string): string {
    return join(homedir(), ...this.sessionDirSegments);
  }

  /**
   * Default: Claude Code convention. Most adapters override with their
   * own platform-specific instruction file name (AGENTS.md, GEMINI.md, ...).
   */
  getInstructionFiles(): string[] {
    return ["CLAUDE.md"];
  }

  /**
   * Default: <configDir>/memory. Always absolute (configDir is absolute by
   * contract). Adapters with a different memory dir name (e.g., codex uses
   * "memories" plural) override this.
   */
  getMemoryDir(): string {
    return join(this.getConfigDir(), "memory");
  }

  backupSettings(): string | null {
    const settingsPath = this.getSettingsPath();
    try {
      accessSync(settingsPath, constants.R_OK);
      const backupPath = settingsPath + ".bak";
      copyFileSync(settingsPath, backupPath);
      return backupPath;
    } catch {
      return null;
    }
  }

  /**
   * Default: read JSON from getSettingsPath(). Identical in 6+ adapters.
   * Override for multi-path search (cursor, openclaw, opencode),
   * TOML format (codex), or fallback paths (copilot-base).
   */
  readSettings(): Record<string, unknown> | null {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Default: mkdirSync dirname + writeFileSync JSON.
   * Override for: copilot-base (different dir), qwen-code (require-based),
   * codex (TOML no-op), cursor (project dir mkdir), gemini-cli (homedir mkdir).
   */
  writeSettings(settings: Record<string, unknown>): void {
    const settingsPath = this.getSettingsPath();
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  /**
   * Read version from <baseDir>/extensions/context-mode/package.json.
   * Shared by: antigravity, kiro, gemini-cli.
   * Returns "not installed" on failure.
   */
  protected readVersionFromExtensionCache(baseSegments: string[]): string {
    try {
      const pkgPath = resolve(homedir(), ...baseSegments, "extensions", "context-mode", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return pkg.version ?? "unknown";
    } catch {
      return "not installed";
    }
  }

  /**
   * Read a routing instructions file from configs/<platformName>/<fileName>.
   * Shared by: antigravity, zed, codex, kiro.
   * Returns fallback inline instructions on failure.
   */
  protected readRoutingInstructionsFile(platformName: string, fileName: string, fallbackTools: string): string {
    const instructionsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "configs",
      platformName,
      fileName,
    );
    try {
      return readFileSync(instructionsPath, "utf-8");
    } catch {
      return `# context-mode\n\nUse context-mode MCP tools (${fallbackTools}) instead of bash/cat/curl for data-heavy operations.`;
    }
  }

  /**
   * Check for context-mode in mcpServers section of a JSON config file.
   * Shared by: antigravity, kiro.
   * Returns a DiagnosticResult with pass/fail/warn.
   */
  protected checkMcpServersRegistration(configLabel: string): DiagnosticResult {
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
        fix: `Add context-mode to mcpServers in ${configLabel}`,
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: `Could not read ${configLabel}`,
      };
    }
  }

  abstract getSettingsPath(): string;
}
