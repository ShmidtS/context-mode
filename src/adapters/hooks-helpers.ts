/**
 * adapters/hooks-helpers — Factory functions for isContextModeHook and buildHookCommand.
 *
 * 6 hooks.ts files (claude-code, gemini-cli, vscode-copilot, jetbrains-copilot,
 * cursor, kiro) contain near-identical isContextModeHook/buildHookCommand
 * implementations that differ only in HOOK_SCRIPTS map, platform ID, and
 * optional hooks subdirectory. These factories eliminate ~8 lines per adapter.
 */

import { buildNodeCommand } from "./types.js";

/**
 * Create an isContextModeHook checker for a platform's hook scripts.
 *
 * Pattern shared by claude-code, gemini-cli, vscode-copilot, jetbrains-copilot:
 * check if any command in entry.hooks includes the script filename or the
 * CLI dispatcher command for the given hook type.
 */
export function createIsContextModeHook<T extends string>(
  hookScripts: Record<string, string | undefined>,
  getDispatcherCommand: (hookType: T) => string,
) {
  return (
    entry: { command?: string; hooks?: Array<{ command?: string }> },
    hookType: T,
  ): boolean => {
    const scriptName = hookScripts[hookType as string];
    if (!scriptName) return false;
    const cliCommand = getDispatcherCommand(hookType);
    const commands = entry.hooks ?? [entry];
    return commands.some((h) =>
      h.command?.includes(scriptName) || h.command?.includes(cliCommand),
    );
  };
}

/**
 * Create a buildHookCommand builder for a platform.
 *
 * @param hookScripts - Map of hook type → script filename
 * @param platformId - Platform identifier for CLI dispatcher (e.g., "claude-code")
 * @param hooksSubDir - Optional subdirectory under hooks/ (e.g., "vscode-copilot")
 * @param throwOnMissingScript - If true, throw when no script for hookType
 *   (vscode-copilot, jetbrains-copilot). If false, fall through to dispatcher
 *   (claude-code, gemini-cli, kiro).
 */
export function createBuildHookCommand<T extends string>(
  hookScripts: Record<string, string>,
  platformId: string,
  hooksSubDir?: string,
  throwOnMissingScript = false,
) {
  return (hookType: T, pluginRoot?: string): string => {
    const scriptName = hookScripts[hookType as string];

    if (throwOnMissingScript && !scriptName) {
      throw new Error(`No script defined for hook type: ${String(hookType)}`);
    }

    if (pluginRoot && scriptName) {
      const scriptPath = hooksSubDir
        ? `${pluginRoot}/hooks/${hooksSubDir}/${scriptName}`
        : `${pluginRoot}/hooks/${scriptName}`;
      return buildNodeCommand(scriptPath);
    }

    return `context-mode hook ${platformId} ${String(hookType).toLowerCase()}`;
  };
}
