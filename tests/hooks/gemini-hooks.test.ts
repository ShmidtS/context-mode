import "../setup-home";
/**
 * Hook Integration Tests — Gemini CLI hooks
 *
 * Tests aftertool.mjs, precompress.mjs, and sessionstart.mjs by piping
 * simulated JSON stdin and asserting correct output/behavior.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";

import {
  type HookTestContext,
  runHook,
  createSharedHookSetup,
  testPostToolCapture,
  testPreCompactBehavior,
  testSessionStartBehavior,
  testEndToEndFlow,
} from "../shared/hook-harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const ctx: HookTestContext = {
  platformName: "gemini",
  hooksDir: join(__dirname, "..", "..", "hooks", "gemini-cli"),
  sessionDirSegments: [".gemini", "context-mode", "sessions"],
  getEnv: (tempDir) => ({ GEMINI_PROJECT_DIR: tempDir }),
  postToolHook: "aftertool.mjs",
  preCompactHook: "precompress.mjs",
  sessionStartHook: "sessionstart.mjs",
};

const setup = createSharedHookSetup(ctx);

describe("Gemini CLI hooks", () => {
  beforeAll(() => {
    // ensure setup is initialized (createSharedHookSetup uses beforeAll internally)
  });

  testPostToolCapture(ctx, setup);
  testPreCompactBehavior(ctx, setup);
  testSessionStartBehavior(ctx, setup);
  testEndToEndFlow(ctx, setup);

  // ── Gemini-specific: Bash git capture ──────────────────

  describe("aftertool.mjs", () => {
    test("captures Bash git event silently", () => {
      const result = runHook(ctx.hooksDir, "aftertool.mjs", {
        tool_name: "Bash",
        tool_input: { command: "git status" },
        tool_output: "On branch main",
        session_id: "test-gemini-session",
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  // ── Gemini-specific: SessionStart JSON format ──────────

  describe("sessionstart.mjs", () => {
    test("default source is startup", () => {
      const result = runHook(ctx.hooksDir, "sessionstart.mjs", {
        session_id: "test-gemini-default",
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    test("sessionstart outputs structured JSON (hidden from user in Gemini CLI)", () => {
      const result = runHook(ctx.hooksDir, "sessionstart.mjs", {
        source: "startup",
        session_id: "test-gemini-json-shape",
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput).toBeDefined();
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("context-mode");

      expect(result.stdout).not.toContain("SessionStart:compact hook success");
      expect(result.stdout).not.toContain("SessionStart hook additional context:");
    });

    test("sessionstart source uses JSON.stringify, not plaintext output (#299)", () => {
      const hookSrc = readFileSync(resolve(ROOT, "hooks/gemini-cli/sessionstart.mjs"), "utf-8");
      expect(hookSrc).toContain("JSON.stringify");
      expect(hookSrc).toContain("hookSpecificOutput");
      expect(hookSrc).toContain("hookEventName");
      expect(hookSrc).toContain('"SessionStart"');
      expect(hookSrc).not.toContain("SessionStart:compact hook success");
    });

    test("writes GEMINI.md when adapter supports it", () => {
      const result = runHook(ctx.hooksDir, "sessionstart.mjs", {
        source: "startup",
        session_id: "test-gemini-gemini-md",
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);

      const geminiMdPath = join(setup.tempDir, "GEMINI.md");
      if (existsSync(geminiMdPath)) {
        expect(readFileSync(geminiMdPath, "utf-8")).toContain("context-mode");
      }
    });
  });
});
