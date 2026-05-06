/**
 * adapters/shared — Cross-platform helpers shared by multiple adapters.
 *
 * Two helpers that appear identically in 5+ adapters:
 *   - normalizeSessionSource: raw string → SessionStartEvent.source enum
 *   - upsertHookEntry: add-or-replace logic for hook config entries
 */

import type { SessionStartEvent } from "./types.js";

/**
 * Normalize a raw source string into the SessionStartEvent.source enum.
 * Used by: claude-code-base, copilot-base, gemini-cli, cursor, codex,
 * kiro, opencode — identical switch in all 7 locations.
 */
export function normalizeSessionSource(
  rawSource: string | undefined,
): SessionStartEvent["source"] {
  switch (rawSource ?? "startup") {
    case "compact":
      return "compact";
    case "resume":
      return "resume";
    case "clear":
      return "clear";
    default:
      return "startup";
  }
}

/**
 * Upsert a hook entry into a hooks map: replace existing context-mode entry
 * or append if none found.
 *
 * @param hooks - The hooks map being mutated
 * @param hookType - Hook type key (e.g., "PreToolUse", "BeforeTool")
 * @param entry - The new entry to insert
 * @param changes - Accumulator for change descriptions
 * @param isMatch - Function to check if an existing entry is a context-mode hook
 */
export function upsertHookEntry(
  hooks: Record<string, unknown>,
  hookType: string,
  entry: Record<string, unknown>,
  changes: string[],
  isMatch: (candidate: Record<string, unknown>) => boolean,
): void {
  const existingRaw = hooks[hookType];
  const existing = Array.isArray(existingRaw)
    ? [...existingRaw] as Record<string, unknown>[]
    : [];

  const idx = existing.findIndex(isMatch);

  if (idx >= 0) {
    existing[idx] = entry;
    changes.push(`Updated existing ${hookType} hook entry`);
  } else {
    existing.push(entry);
    changes.push(`Added ${hookType} hook entry`);
  }

  hooks[hookType] = existing;
}
