/**
 * Shared hook integration test harness — eliminates duplication across
 * gemini-hooks, vscode-hooks, jetbrains-hooks, and kiro-hooks tests.
 *
 * Each platform-specific test file provides a HookTestContext and calls
 * testSharedHookBehavior() to get the common assertions for free, then
 * adds its own platform-specific tests.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";

export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HookTestContext {
  /** Display name for describe blocks */
  platformName: string;
  /** Absolute path to the platform hooks directory */
  hooksDir: string;
  /** Session dir segments under homedir, e.g. [".gemini", "context-mode", "sessions"] */
  sessionDirSegments: string[];
  /** Build env for hook subprocess */
  getEnv: (tempDir: string) => Record<string, string>;
  /** Name of the post-tool hook file (e.g. "aftertool.mjs" or "posttooluse.mjs") */
  postToolHook: string;
  /** Name of the pre-compact hook file */
  preCompactHook: string;
  /** Name of the session-start hook file */
  sessionStartHook: string;
  /** Whether platform uses camelCase sessionId field */
  camelCaseSessionId?: boolean;
}

export function runHook(
  hooksDir: string,
  hookFile: string,
  input: Record<string, unknown>,
  env?: Record<string, string>,
  cwd?: string,
): HookResult {
  const result = spawnSync("node", [join(hooksDir, hookFile)], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, ...env },
    ...(cwd ? { cwd } : {}),
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

export interface SharedHookSetup {
  tempDir: string;
  dbPath: string;
  eventsPath: string;
  cleanup: () => void;
  getEnv: () => Record<string, string>;
}

export function createSharedHookSetup(ctx: HookTestContext): SharedHookSetup {
  let tempDir: string;
  let dbPath: string;
  let eventsPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), `${ctx.platformName.toLowerCase()}-hook-test-`));
    const hash = createHash("sha256").update(tempDir).digest("hex").slice(0, 16);
    const sessionsDir = join(homedir(), ...ctx.sessionDirSegments);
    dbPath = join(sessionsDir, `${hash}.db`);
    eventsPath = join(sessionsDir, `${hash}-events.md`);
  });

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch { /* best effort */ }
    try { if (existsSync(eventsPath)) unlinkSync(eventsPath); } catch { /* best effort */ }
  });

  return {
    get tempDir() { return tempDir; },
    get dbPath() { return dbPath; },
    get eventsPath() { return eventsPath; },
    cleanup: () => {},
    getEnv: () => ctx.getEnv(tempDir),
  };
}

/**
 * Run the shared post-tool hook assertions (Read, Write, empty input).
 * Only tests whose platform supports the given tool events should call this.
 */
export function testPostToolCapture(
  ctx: HookTestContext,
  setup: SharedHookSetup,
): void {
  describe("post-tool capture", () => {
    const sessionIdField = ctx.camelCaseSessionId ? "sessionId" : "session_id";

    test("captures Read event silently", () => {
      const input: Record<string, unknown> = {
        tool_name: "Read",
        tool_input: { file_path: "/src/main.ts" },
        [sessionIdField]: `test-${ctx.platformName}-session`,
      };
      // jetbrains/vscode use tool_response, gemini uses tool_output
      if (ctx.camelCaseSessionId) {
        input.tool_response = "file contents";
      } else {
        input.tool_output = "file contents";
      }

      const result = runHook(ctx.hooksDir, ctx.postToolHook, input, setup.getEnv());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("captures Write event silently", () => {
      const input: Record<string, unknown> = {
        tool_name: "Write",
        tool_input: { file_path: "/src/new.ts", content: "code" },
        [sessionIdField]: `test-${ctx.platformName}-session`,
      };

      const result = runHook(ctx.hooksDir, ctx.postToolHook, input, setup.getEnv());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("handles empty input gracefully", () => {
      const result = runHook(ctx.hooksDir, ctx.postToolHook, {}, setup.getEnv());
      expect(result.exitCode).toBe(0);
    });
  });
}

/**
 * Run shared pre-compact hook assertions.
 */
export function testPreCompactBehavior(
  ctx: HookTestContext,
  setup: SharedHookSetup,
): void {
  describe("pre-compact", () => {
    const sessionIdField = ctx.camelCaseSessionId ? "sessionId" : "session_id";

    test("runs silently with no events", () => {
      const result = runHook(ctx.hooksDir, ctx.preCompactHook, {
        [sessionIdField]: `test-${ctx.platformName}-precompact`,
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("handles empty input gracefully", () => {
      const result = runHook(ctx.hooksDir, ctx.preCompactHook, {}, setup.getEnv());
      expect(result.exitCode).toBe(0);
    });
  });
}

/**
 * Run shared session-start hook assertions (startup, compact, clear).
 */
export function testSessionStartBehavior(
  ctx: HookTestContext,
  setup: SharedHookSetup,
): void {
  describe("session-start", () => {
    const sessionIdField = ctx.camelCaseSessionId ? "sessionId" : "session_id";

    test("startup: outputs routing block", () => {
      const result = runHook(ctx.hooksDir, ctx.sessionStartHook, {
        source: "startup",
        [sessionIdField]: `test-${ctx.platformName}-startup`,
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
      expect(result.stdout).toContain("context-mode");
    });

    test("compact: outputs routing block", () => {
      const result = runHook(ctx.hooksDir, ctx.sessionStartHook, {
        source: "compact",
        [sessionIdField]: `test-${ctx.platformName}-compact`,
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    test("clear: outputs routing block only", () => {
      const result = runHook(ctx.hooksDir, ctx.sessionStartHook, {
        source: "clear",
        [sessionIdField]: `test-${ctx.platformName}-clear`,
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });
  });
}

/**
 * Run shared end-to-end flow test: PostTool -> PreCompact -> SessionStart(compact).
 */
export function testEndToEndFlow(
  ctx: HookTestContext,
  setup: SharedHookSetup,
): void {
  describe("end-to-end flow", () => {
    const sessionIdField = ctx.camelCaseSessionId ? "sessionId" : "session_id";

    test("capture events, build snapshot, and restore on compact", () => {
      const sessionId = `test-${ctx.platformName}-e2e`;
      const env = setup.getEnv();

      // 1. Capture events via post-tool hook
      const readInput: Record<string, unknown> = {
        tool_name: "Read",
        tool_input: { file_path: "/src/app.ts" },
        [sessionIdField]: sessionId,
      };
      if (ctx.camelCaseSessionId) {
        readInput.tool_response = "export default {}";
      } else {
        readInput.tool_output = "export default {}";
      }
      runHook(ctx.hooksDir, ctx.postToolHook, readInput, env);

      const editInput: Record<string, unknown> = {
        tool_name: "Edit",
        tool_input: { file_path: "/src/app.ts", old_string: "{}", new_string: "{ foo: 1 }" },
        [sessionIdField]: sessionId,
      };
      runHook(ctx.hooksDir, ctx.postToolHook, editInput, env);

      // 2. Build snapshot via PreCompact
      const precompactResult = runHook(ctx.hooksDir, ctx.preCompactHook, {
        [sessionIdField]: sessionId,
      }, env);
      expect(precompactResult.exitCode).toBe(0);

      // 3. SessionStart compact should include session knowledge
      const startResult = runHook(ctx.hooksDir, ctx.sessionStartHook, {
        source: "compact",
        [sessionIdField]: sessionId,
      }, env);
      expect(startResult.exitCode).toBe(0);
      expect(startResult.stdout).toContain("SessionStart");
    });
  });
}
