/**
 * McpOnlyBaseAdapter — shared base for MCP-only platforms (no hooks).
 *
 * Antigravity and Zed share identical stubs for all parse/format methods,
 * empty configureAllHooks/setHookPermissions, and empty generateHookConfig.
 * This base eliminates ~80 lines of duplication per adapter.
 *
 * Subclasses provide: name, sessionDirSegments, getSettingsPath(),
 * readSettings(), writeSettings(), validateHooks(), checkPluginRegistration(),
 * getInstalledVersion(), getInstructionFiles(), and any platform-specific
 * methods (e.g., getRoutingInstructions, getConfigDir overrides).
 */

import { BaseAdapter } from "./base.js";

import type {
  HookParadigm,
  PlatformCapabilities,
  DiagnosticResult,
  HookRegistration,
  PreToolUseEvent,
  PostToolUseEvent,
  PreCompactEvent,
  SessionStartEvent,
  PreToolUseResponse,
  PostToolUseResponse,
  PreCompactResponse,
  SessionStartResponse,
} from "./types.js";

export abstract class McpOnlyBaseAdapter extends BaseAdapter {
  abstract readonly name: string;
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: false,
    postToolUse: false,
    preCompact: false,
    sessionStart: false,
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
  };

  // ── Input parsing (stubs — MCP-only platforms have no hooks) ──

  parsePreToolUseInput(_raw: unknown): PreToolUseEvent {
    throw new Error(`${this.name} does not support hooks`);
  }

  parsePostToolUseInput(_raw: unknown): PostToolUseEvent {
    throw new Error(`${this.name} does not support hooks`);
  }

  parsePreCompactInput(_raw: unknown): PreCompactEvent {
    throw new Error(`${this.name} does not support hooks`);
  }

  parseSessionStartInput(_raw: unknown): SessionStartEvent {
    throw new Error(`${this.name} does not support hooks`);
  }

  // ── Response formatting (stubs) ──────────────────────────────

  formatPreToolUseResponse(_response: PreToolUseResponse): unknown {
    return undefined;
  }

  formatPostToolUseResponse(_response: PostToolUseResponse): unknown {
    return undefined;
  }

  formatPreCompactResponse(_response: PreCompactResponse): unknown {
    return undefined;
  }

  formatSessionStartResponse(_response: SessionStartResponse): unknown {
    return undefined;
  }

  // ── Hook configuration (no-ops) ──────────────────────────────

  abstract validateHooks(pluginRoot: string): DiagnosticResult[];
  abstract checkPluginRegistration(): DiagnosticResult;
  abstract getInstalledVersion(): string;

  generateHookConfig(_pluginRoot: string): HookRegistration {
    return {};
  }

  configureAllHooks(_pluginRoot: string): string[] {
    return [];
  }

  setHookPermissions(_pluginRoot: string): string[] {
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // MCP-only platforms manage plugins through their own registries
  }
}
