/**
 * adapters/vscode-copilot/hooks — VS Code Copilot hook definitions and matchers.
 *
 * Defines the hook types, matchers, and registration format specific to
 * VS Code Copilot's hook system. This module is used by:
 *   - CLI setup/upgrade commands (to configure hooks)
 *   - Doctor command (to validate hook configuration)
 *   - Hook config generation
 *
 * VS Code Copilot hook system reference:
 *   - Hooks are registered in .github/hooks/*.json
 *   - Hook names: PreToolUse, PostToolUse, PreCompact, SessionStart (PascalCase)
 *   - CRITICAL: matchers are parsed but IGNORED (all hooks fire on all tools)
 *   - Input: JSON on stdin
 *   - Output: JSON on stdout (or empty for passthrough)
 *   - Preview status — API may change
 */

import { createIsContextModeHook, createBuildHookCommand } from "../hooks-helpers.js";

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** VS Code Copilot hook types. */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  SESSION_START: "SessionStart",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

// ─────────────────────────────────────────────────────────
// Hook script file names
// ─────────────────────────────────────────────────────────

/** Map of hook types to their script file names. */
export const HOOK_SCRIPTS: Record<string, string> = {
  [HOOK_TYPES.PRE_TOOL_USE]: "pretooluse.mjs",
  [HOOK_TYPES.POST_TOOL_USE]: "posttooluse.mjs",
  [HOOK_TYPES.PRE_COMPACT]: "precompact.mjs",
  [HOOK_TYPES.SESSION_START]: "sessionstart.mjs",
};

// ─────────────────────────────────────────────────────────
// Hook validation
// ─────────────────────────────────────────────────────────

/** Required hooks that must be configured for context-mode to function. */
export const REQUIRED_HOOKS: HookType[] = [
  HOOK_TYPES.PRE_TOOL_USE,
  HOOK_TYPES.SESSION_START,
];

/** Optional hooks that enhance functionality but aren't critical. */
export const OPTIONAL_HOOKS: HookType[] = [
  HOOK_TYPES.POST_TOOL_USE,
  HOOK_TYPES.PRE_COMPACT,
];

// ─────────────────────────────────────────────────────────
// Factory-generated helpers
// ─────────────────────────────────────────────────────────

const buildHookCommandForPlatform = createBuildHookCommand<HookType>(
  HOOK_SCRIPTS,
  "vscode-copilot",
  "vscode-copilot",
  true, // throwOnMissingScript
);

export const isContextModeHook = createIsContextModeHook<HookType>(
  HOOK_SCRIPTS,
  (hookType) => buildHookCommandForPlatform(hookType),
);

export function buildHookCommand(hookType: HookType, pluginRoot?: string): string {
  return buildHookCommandForPlatform(hookType, pluginRoot);
}
