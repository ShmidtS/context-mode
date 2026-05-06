import "../setup-home";
/**
 * Hook Integration Tests — VS Code Copilot hooks
 *
 * Tests posttooluse.mjs, precompact.mjs, and sessionstart.mjs by piping
 * simulated JSON stdin and asserting correct output/behavior.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

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
  platformName: "vscode",
  hooksDir: join(__dirname, "..", "..", "hooks", "vscode-copilot"),
  sessionDirSegments: [".vscode", "context-mode", "sessions"],
  getEnv: (tempDir) => ({ VSCODE_CWD: tempDir }),
  postToolHook: "posttooluse.mjs",
  preCompactHook: "precompact.mjs",
  sessionStartHook: "sessionstart.mjs",
  camelCaseSessionId: true,
};

const setup = createSharedHookSetup(ctx);

// MCP readiness sentinel
const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);

// ── session-loaders.mjs bundle resolution ────────────────

describe("createSessionLoaders — bundle directory resolution", () => {
  const hooksDir = join(__dirname, "..", "..", "hooks");

  test("resolves bundles when hookDir has trailing slash (vscode-copilot/)", async () => {
    const hookDirWithSlash = join(hooksDir, "vscode-copilot") + "/";

    const { createSessionLoaders } = await import(
      join(hooksDir, "session-loaders.mjs")
    );
    const loaders = createSessionLoaders(hookDirWithSlash);

    const mod = await loaders.loadSessionDB();
    expect(mod.SessionDB).toBeDefined();
  });

  test.skipIf(process.platform !== "win32")("resolves bundles when hookDir has trailing backslash (Windows)", async () => {
    const hookDirWithBackslash = join(hooksDir, "vscode-copilot") + "\\";

    const { createSessionLoaders } = await import(
      join(hooksDir, "session-loaders.mjs")
    );
    const loaders = createSessionLoaders(hookDirWithBackslash);

    const mod = await loaders.loadSessionDB();
    expect(mod.SessionDB).toBeDefined();
  });

  test("resolves bundles when hookDir has no trailing separator", async () => {
    const hookDirClean = join(hooksDir, "vscode-copilot");

    const { createSessionLoaders } = await import(
      join(hooksDir, "session-loaders.mjs")
    );
    const loaders = createSessionLoaders(hookDirClean);

    const mod = await loaders.loadSessionDB();
    expect(mod.SessionDB).toBeDefined();
  });

  test("resolves bundles from root hooks dir (non-vscode path)", async () => {
    const { createSessionLoaders } = await import(
      join(hooksDir, "session-loaders.mjs")
    );
    const loaders = createSessionLoaders(hooksDir);

    const mod = await loaders.loadSessionDB();
    expect(mod.SessionDB).toBeDefined();
  });
});

describe("VS Code Copilot hooks", () => {
  // Clean file-based guidance throttle markers between tests
  beforeEach(() => {
    const wid = process.env.VITEST_WORKER_ID;
    const suffix = wid ? `${process.pid}-w${wid}` : String(process.pid);
    const legacyDir = resolve(tmpdir(), `context-mode-guidance-${suffix}`);
    const sessionDir = resolve(tmpdir(), `context-mode-guidance-s-pid-${process.pid}`);
    try { rmSync(legacyDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* best effort */ }
    writeFileSync(mcpSentinel, String(process.pid));
  });

  afterEach(() => {
    try { unlinkSync(mcpSentinel); } catch {}
  });

  testPostToolCapture(ctx, setup);
  testPreCompactBehavior(ctx, setup);
  testSessionStartBehavior(ctx, setup);
  testEndToEndFlow(ctx, setup);

  // ── VS Code-specific: PreToolUse ────────────────────────

  describe("pretooluse.mjs", () => {
    test("run_in_terminal: injects BASH_GUIDANCE additionalContext", () => {
      const result = runHook(ctx.hooksDir, "pretooluse.mjs", {
        tool_name: "run_in_terminal",
        tool_input: { command: "npm test" },
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.hookSpecificOutput.additionalContext).toContain("ctx_batch_execute");
    });

    test("run_in_terminal: curl is redirected to echo", () => {
      const result = runHook(ctx.hooksDir, "pretooluse.mjs", {
        tool_name: "run_in_terminal",
        tool_input: { command: "curl https://example.com" },
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.hookSpecificOutput.updatedInput.command).toContain("context-mode");
      expect(out.hookSpecificOutput.updatedInput.command).toContain("ctx_fetch_and_index");
    });

    test("run_in_terminal: safe short command passes through with guidance", () => {
      const result = runHook(ctx.hooksDir, "pretooluse.mjs", {
        tool_name: "run_in_terminal",
        tool_input: { command: "git status" },
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.hookSpecificOutput.additionalContext).toContain("ctx_batch_execute");
    });
  });

  // ── VS Code-specific: PostToolUse sessionId ─────────────

  describe("posttooluse.mjs", () => {
    test("supports sessionId camelCase field", () => {
      const result = runHook(ctx.hooksDir, "posttooluse.mjs", {
        tool_name: "Bash",
        tool_input: { command: "git log --oneline -5" },
        tool_response: "abc1234 feat: add feature",
        sessionId: "test-vscode-camelcase",
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  // ── VS Code-specific: SessionStart ──────────────────────

  describe("sessionstart.mjs", () => {
    test("supports sessionId camelCase in session start", () => {
      const result = runHook(ctx.hooksDir, "sessionstart.mjs", {
        source: "startup",
        sessionId: "test-vscode-camelcase-start",
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    test("sessionstart outputs valid JSON with hookSpecificOutput", () => {
      const hookSrc = readFileSync(resolve(ROOT, "hooks/vscode-copilot/sessionstart.mjs"), "utf-8");
      expect(hookSrc).toContain("JSON.stringify");
      expect(hookSrc).toContain("hookSpecificOutput");
      expect(hookSrc).toContain("hookEventName");
      expect(hookSrc).toContain('"SessionStart"');
      expect(hookSrc).not.toContain("SessionStart:compact hook success");
    });
  });
});
