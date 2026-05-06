import "../setup-home";
/**
 * Hook Integration Tests — JetBrains Copilot hooks
 *
 * Tests pretooluse.mjs, posttooluse.mjs, precompact.mjs, and sessionstart.mjs
 * by piping simulated JSON stdin and asserting correct output/behavior.
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
  platformName: "jetbrains",
  hooksDir: join(__dirname, "..", "..", "hooks", "jetbrains-copilot"),
  sessionDirSegments: [".config", "JetBrains", "context-mode", "sessions"],
  getEnv: (tempDir) => ({ IDEA_INITIAL_DIRECTORY: tempDir }),
  postToolHook: "posttooluse.mjs",
  preCompactHook: "precompact.mjs",
  sessionStartHook: "sessionstart.mjs",
  camelCaseSessionId: true,
};

const setup = createSharedHookSetup(ctx);

// MCP readiness sentinel
const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);

// ── Hook scripts exist ────────────────────────────────────

describe("JetBrains Copilot hook scripts", () => {
  test("pretooluse.mjs exists in hooks/jetbrains-copilot/", () => {
    expect(existsSync(join(ctx.hooksDir, "pretooluse.mjs"))).toBe(true);
  });

  test("posttooluse.mjs exists in hooks/jetbrains-copilot/", () => {
    expect(existsSync(join(ctx.hooksDir, "posttooluse.mjs"))).toBe(true);
  });

  test("precompact.mjs exists in hooks/jetbrains-copilot/", () => {
    expect(existsSync(join(ctx.hooksDir, "precompact.mjs"))).toBe(true);
  });

  test("sessionstart.mjs exists in hooks/jetbrains-copilot/", () => {
    expect(existsSync(join(ctx.hooksDir, "sessionstart.mjs"))).toBe(true);
  });
});

// ── Hooks use parseStdin (not JSON.parse) ─────────────────

describe("JetBrains Copilot hooks use parseStdin", () => {
  test("pretooluse.mjs imports parseStdin from session-helpers", () => {
    const src = readFileSync(join(ctx.hooksDir, "pretooluse.mjs"), "utf-8");
    expect(src).toContain("parseStdin");
    expect(src).not.toMatch(/JSON\.parse\s*\(\s*raw/);
  });

  test("posttooluse.mjs imports parseStdin from session-helpers", () => {
    const src = readFileSync(join(ctx.hooksDir, "posttooluse.mjs"), "utf-8");
    expect(src).toContain("parseStdin");
    expect(src).not.toMatch(/JSON\.parse\s*\(\s*raw/);
  });

  test("precompact.mjs imports parseStdin from session-helpers", () => {
    const src = readFileSync(join(ctx.hooksDir, "precompact.mjs"), "utf-8");
    expect(src).toContain("parseStdin");
    expect(src).not.toMatch(/JSON\.parse\s*\(\s*raw/);
  });

  test("sessionstart.mjs imports parseStdin from session-helpers", () => {
    const src = readFileSync(join(ctx.hooksDir, "sessionstart.mjs"), "utf-8");
    expect(src).toContain("parseStdin");
    expect(src).not.toMatch(/JSON\.parse\s*\(\s*raw/);
  });
});

// ── session-loaders.mjs bundle resolution ────────────────

describe("createSessionLoaders — bundle directory resolution (jetbrains-copilot)", () => {
  const hooksDir = join(__dirname, "..", "..", "hooks");

  test("resolves bundles when hookDir has trailing slash (jetbrains-copilot/)", async () => {
    const hookDirWithSlash = join(hooksDir, "jetbrains-copilot") + "/";

    const { createSessionLoaders } = await import(
      join(hooksDir, "session-loaders.mjs")
    );
    const loaders = createSessionLoaders(hookDirWithSlash);

    const mod = await loaders.loadSessionDB();
    expect(mod.SessionDB).toBeDefined();
  });

  test("resolves bundles when hookDir has no trailing separator", async () => {
    const hookDirClean = join(hooksDir, "jetbrains-copilot");

    const { createSessionLoaders } = await import(
      join(hooksDir, "session-loaders.mjs")
    );
    const loaders = createSessionLoaders(hookDirClean);

    const mod = await loaders.loadSessionDB();
    expect(mod.SessionDB).toBeDefined();
  });
});

// ── Hook integration tests ────────────────────────────────

describe("JetBrains Copilot hooks", () => {
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

  // ── JetBrains-specific: PreToolUse ────────────────────────

  describe("pretooluse.mjs", () => {
    test("run_in_terminal: injects guidance additionalContext", () => {
      const result = runHook(ctx.hooksDir, "pretooluse.mjs", {
        tool_name: "run_in_terminal",
        tool_input: { command: "npm test" },
      }, setup.getEnv());

      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.hookSpecificOutput.additionalContext).toContain("ctx_batch_execute");
    });

    test("handles empty input gracefully (no crash)", () => {
      const result = runHook(ctx.hooksDir, "pretooluse.mjs", {}, setup.getEnv());
      expect(result.exitCode).toBe(0);
    });
  });

  // ── JetBrains-specific: SessionStart JSON format ──────────

  describe("sessionstart.mjs", () => {
    test("produces valid JSON with hookSpecificOutput", () => {
      const hookSrc = readFileSync(resolve(ROOT, "hooks/jetbrains-copilot/sessionstart.mjs"), "utf-8");
      expect(hookSrc).toContain("JSON.stringify");
      expect(hookSrc).toContain("hookSpecificOutput");
      expect(hookSrc).toContain("hookEventName");
      expect(hookSrc).toContain('"SessionStart"');
    });

    test("handles empty stdin without crashing", () => {
      const result = runHook(ctx.hooksDir, "sessionstart.mjs", {}, setup.getEnv());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });
  });
});
