/**
 * adapters/jetbrains-copilot/hooks — JetBrains Copilot hook definitions and matchers.
 *
 * Defines the hook types, matchers, and registration format specific to
 * JetBrains Copilot's hook system. This module is used by:
 *   - CLI setup/upgrade commands (to configure hooks)
 *   - Doctor command (to validate hook configuration)
 *   - Hook config generation
 *
 * JetBrains Copilot hook system reference:
 *   - Hooks are registered in .github/hooks/*.json
 *   - Hook names: PreToolUse, PostToolUse, PreCompact, SessionStart (PascalCase)
 *   - Additional hooks: Stop, SubagentStart, SubagentStop
 *   - CRITICAL: matchers are parsed but IGNORED (all hooks fire on all tools)
 *   - Input: JSON on stdin
 *   - Output: JSON on stdout (or empty for passthrough)
 *   - JetBrains Copilot shares the same hook paradigm as VS Code Copilot
 */

import { createIsContextModeHook, createBuildHookCommand } from "../hooks-helpers.js";

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** JetBrains Copilot hook types. */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  SESSION_START: "SessionStart",
  // Additional hooks (shared with VS Code Copilot)
  STOP: "Stop",
  SUBAGENT_START: "SubagentStart",
  SUBAGENT_STOP: "SubagentStop",
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
  "jetbrains-copilot",
  "jetbrains-copilot",
  true, // throwOnMissingScript
);

export const isContextModeHook = createIsContextModeHook<HookType>(
  HOOK_SCRIPTS,
  (hookType) => buildHookCommandForPlatform(hookType),
);

export function buildHookCommand(hookType: HookType, pluginRoot?: string): string {
  return buildHookCommandForPlatform(hookType, pluginRoot);
}
