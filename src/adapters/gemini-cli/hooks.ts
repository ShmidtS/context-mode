/**
 * adapters/gemini-cli/hooks — Gemini CLI hook definitions and matchers.
 *
 * Defines the hook types, matchers, and registration format specific to
 * Gemini CLI's hook system. This module is used by:
 *   - CLI setup/upgrade commands (to configure hooks in settings.json)
 *   - Doctor command (to validate hook configuration)
 *   - Hook config generation
 *
 * Gemini CLI hook system reference:
 *   - Hooks are registered in ~/.gemini/settings.json under "hooks" key
 *   - Each hook type maps to an array of { matcher, hooks } entries
 *   - Hook names: BeforeAgent, BeforeTool, AfterTool, PreCompress, SessionStart
 *   - Input: JSON on stdin
 *   - Output: JSON on stdout (or empty for passthrough)
 *   - BeforeAgent fires when user submits a prompt — input.prompt carries
 *     the user message; hookSpecificOutput.additionalContext is appended
 *     to the prompt (hookRunner.ts:183-197). Equivalent to Claude Code's
 *     UserPromptSubmit for session-continuity capture.
 */

import { createIsContextModeHook, createBuildHookCommand } from "../hooks-helpers.js";

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** Gemini CLI hook types. */
export const HOOK_TYPES = {
  BEFORE_AGENT: "BeforeAgent",
  BEFORE_TOOL: "BeforeTool",
  AFTER_TOOL: "AfterTool",
  PRE_COMPRESS: "PreCompress",
  SESSION_START: "SessionStart",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

// ─────────────────────────────────────────────────────────
// Hook script file names
// ─────────────────────────────────────────────────────────

/** Map of hook types to their script file names. */
export const HOOK_SCRIPTS: Record<HookType, string> = {
  [HOOK_TYPES.BEFORE_AGENT]: "beforeagent.mjs",
  [HOOK_TYPES.BEFORE_TOOL]: "beforetool.mjs",
  [HOOK_TYPES.AFTER_TOOL]: "aftertool.mjs",
  [HOOK_TYPES.PRE_COMPRESS]: "precompress.mjs",
  [HOOK_TYPES.SESSION_START]: "sessionstart.mjs",
};

// ─────────────────────────────────────────────────────────
// Hook validation
// ─────────────────────────────────────────────────────────

/** Required hooks that must be configured for context-mode to function. */
export const REQUIRED_HOOKS: HookType[] = [
  HOOK_TYPES.BEFORE_TOOL,
  HOOK_TYPES.SESSION_START,
];

/** Optional hooks that enhance functionality but aren't critical. */
export const OPTIONAL_HOOKS: HookType[] = [
  HOOK_TYPES.AFTER_TOOL,
  HOOK_TYPES.PRE_COMPRESS,
];

// ─────────────────────────────────────────────────────────
// Factory-generated helpers
// ─────────────────────────────────────────────────────────

const buildHookCommandForPlatform = createBuildHookCommand<HookType>(
  HOOK_SCRIPTS,
  "gemini-cli",
  "gemini-cli",
);

export const isContextModeHook = createIsContextModeHook<HookType>(
  HOOK_SCRIPTS,
  (hookType) => buildHookCommandForPlatform(hookType),
);

export function buildHookCommand(hookType: HookType, pluginRoot?: string): string {
  return buildHookCommandForPlatform(hookType, pluginRoot);
}
