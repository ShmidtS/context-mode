import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { detectPlatform, getAdapter } from "../../src/adapters/detect.js";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { GeminiCLIAdapter } from "../../src/adapters/gemini-cli/index.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode/index.js";
import { OpenClawAdapter } from "../../src/adapters/openclaw/index.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { VSCodeCopilotAdapter } from "../../src/adapters/vscode-copilot/index.js";
import { CursorAdapter } from "../../src/adapters/cursor/index.js";
import { AntigravityAdapter } from "../../src/adapters/antigravity/index.js";
import { KiroAdapter } from "../../src/adapters/kiro/index.js";
import { QwenCodeAdapter } from "../../src/adapters/qwen-code/index.js";
import { JetBrainsCopilotAdapter } from "../../src/adapters/jetbrains-copilot/index.js";

// ── Shared env var cleanup ────────────────────────────────

const PLATFORM_ENV_VARS = [
  "CLAUDE_PROJECT_DIR", "CLAUDE_SESSION_ID",
  "GEMINI_PROJECT_DIR", "GEMINI_CLI",
  "KILO", "KILO_PID",
  "OPENCODE", "OPENCODE_PID",
  "OPENCLAW_HOME", "OPENCLAW_CLI",
  "CODEX_CI", "CODEX_THREAD_ID",
  "CURSOR_CWD", "CURSOR_SESSION_ID", "CURSOR_TRACE_ID", "CURSOR_CLI",
  "VSCODE_PID", "VSCODE_CWD",
  "QWEN_PROJECT_DIR",
  "IDEA_INITIAL_DIRECTORY", "IDEA_HOME", "JETBRAINS_CLIENT_ID",
  "ANTIGRAVITY_CLI_ALIAS",
  "ZED_SESSION_ID", "ZED_TERM",
  "PI_PROJECT_DIR",
  "CONTEXT_MODE_PLATFORM",
];

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of PLATFORM_ENV_VARS) delete process.env[key];
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = savedEnv;
});

// ── Parameterized env-var detection specs ─────────────────

interface EnvDetectionSpec {
  desc: string;
  envVars: Record<string, string>;
  expectedPlatform: string;
}

const envDetectionSpecs: EnvDetectionSpec[] = [
  { desc: "claude-code when CLAUDE_PROJECT_DIR is set", envVars: { CLAUDE_PROJECT_DIR: "/some/project" }, expectedPlatform: "claude-code" },
  { desc: "claude-code when CLAUDE_SESSION_ID is set", envVars: { CLAUDE_SESSION_ID: "abc-123" }, expectedPlatform: "claude-code" },
  { desc: "gemini-cli when GEMINI_PROJECT_DIR is set", envVars: { GEMINI_PROJECT_DIR: "/some/project" }, expectedPlatform: "gemini-cli" },
  { desc: "gemini-cli when GEMINI_CLI is set", envVars: { GEMINI_CLI: "1" }, expectedPlatform: "gemini-cli" },
  { desc: "opencode when OPENCODE=1 is set", envVars: { OPENCODE: "1" }, expectedPlatform: "opencode" },
  { desc: "opencode when OPENCODE_PID is set", envVars: { OPENCODE_PID: "12345" }, expectedPlatform: "opencode" },
  { desc: "kilo when KILO_PID is set", envVars: { KILO_PID: "12345" }, expectedPlatform: "kilo" },
  { desc: "codex when CODEX_CI is set", envVars: { CODEX_CI: "1" }, expectedPlatform: "codex" },
  { desc: "codex when CODEX_THREAD_ID is set", envVars: { CODEX_THREAD_ID: "thread-abc" }, expectedPlatform: "codex" },
  { desc: "cursor when CURSOR_TRACE_ID is set", envVars: { CURSOR_TRACE_ID: "trace-abc-123" }, expectedPlatform: "cursor" },
  { desc: "cursor when CURSOR_CLI is set", envVars: { CURSOR_CLI: "1" }, expectedPlatform: "cursor" },
  { desc: "vscode-copilot when VSCODE_PID is set", envVars: { VSCODE_PID: "12345" }, expectedPlatform: "vscode-copilot" },
  { desc: "vscode-copilot when VSCODE_CWD is set", envVars: { VSCODE_CWD: "/some/dir" }, expectedPlatform: "vscode-copilot" },
  { desc: "antigravity via ANTIGRAVITY_CLI_ALIAS", envVars: { ANTIGRAVITY_CLI_ALIAS: "agtg" }, expectedPlatform: "antigravity" },
  { desc: "zed via ZED_SESSION_ID", envVars: { ZED_SESSION_ID: "01HZED-uuid" }, expectedPlatform: "zed" },
  { desc: "zed via ZED_TERM", envVars: { ZED_TERM: "true" }, expectedPlatform: "zed" },
  { desc: "pi via PI_PROJECT_DIR", envVars: { PI_PROJECT_DIR: "/some/project" }, expectedPlatform: "pi" },
  { desc: "jetbrains-copilot via IDEA_INITIAL_DIRECTORY", envVars: { IDEA_INITIAL_DIRECTORY: "/home/user/project" }, expectedPlatform: "jetbrains-copilot" },
  { desc: "qwen-code via QWEN_PROJECT_DIR", envVars: { QWEN_PROJECT_DIR: "/some/project" }, expectedPlatform: "qwen-code" },
];

// ── Parameterized clientInfo detection specs ──────────────

interface ClientInfoSpec {
  desc: string;
  clientInfo: { name: string; version?: string };
  expectedPlatform: string;
}

const clientInfoSpecs: ClientInfoSpec[] = [
  { desc: "antigravity when clientInfo name is antigravity-client", clientInfo: { name: "antigravity-client", version: "1.0" }, expectedPlatform: "antigravity" },
  { desc: "kiro when clientInfo name is Kiro CLI", clientInfo: { name: "Kiro CLI", version: "1.0.0" }, expectedPlatform: "kiro" },
  { desc: "gemini-cli when clientInfo name is gemini-cli-mcp-client", clientInfo: { name: "gemini-cli-mcp-client", version: "1.0" }, expectedPlatform: "gemini-cli" },
  { desc: "cursor when clientInfo name is cursor-vscode", clientInfo: { name: "cursor-vscode", version: "1.0" }, expectedPlatform: "cursor" },
  { desc: "qwen-code via qwen-cli-mcp-client clientInfo", clientInfo: { name: "qwen-cli-mcp-client-context-mode" }, expectedPlatform: "qwen-code" },
];

// ── Parameterized getAdapter specs ────────────────────────

interface GetAdapterSpec {
  platform: string;
  AdapterClass: new (...args: any[]) => unknown;
  extraCheck?: (adapter: unknown) => void;
}

const getAdapterSpecs: GetAdapterSpec[] = [
  { platform: "claude-code", AdapterClass: ClaudeCodeAdapter },
  { platform: "gemini-cli", AdapterClass: GeminiCLIAdapter },
  { platform: "opencode", AdapterClass: OpenCodeAdapter },
  { platform: "kilo", AdapterClass: OpenCodeAdapter, extraCheck: (a) => { expect((a as any).name).toBe("KiloCode"); } },
  { platform: "openclaw", AdapterClass: OpenClawAdapter },
  { platform: "codex", AdapterClass: CodexAdapter },
  { platform: "vscode-copilot", AdapterClass: VSCodeCopilotAdapter },
  { platform: "cursor", AdapterClass: CursorAdapter },
  { platform: "antigravity", AdapterClass: AntigravityAdapter },
  { platform: "kiro", AdapterClass: KiroAdapter },
  { platform: "qwen-code", AdapterClass: QwenCodeAdapter },
  { platform: "jetbrains-copilot", AdapterClass: JetBrainsCopilotAdapter },
];

// ─────────────────────────────────────────────────────────
// detectPlatform — env var detection
// ─────────────────────────────────────────────────────────

describe("detectPlatform", () => {
  it.each(envDetectionSpecs)(
    "returns $expectedPlatform $desc",
    ({ envVars, expectedPlatform }) => {
      Object.assign(process.env, envVars);
      const signal = detectPlatform();
      expect(signal.platform).toBe(expectedPlatform);
      expect(signal.confidence).toBe("high");
    },
  );

  it("kilo wins when both KILO_PID and OPENCODE are set (fork-collision)", () => {
    process.env.KILO_PID = "12345";
    process.env.OPENCODE = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("kilo");
  });

  it("prefers cursor over vscode-copilot when both env vars are set", () => {
    process.env.CURSOR_TRACE_ID = "trace-abc-123";
    process.env.VSCODE_PID = "12345";
    const signal = detectPlatform();
    expect(signal.platform).toBe("cursor");
    expect(signal.confidence).toBe("high");
  });

  it.each(clientInfoSpecs)(
    "returns $expectedPlatform $desc",
    ({ clientInfo, expectedPlatform }) => {
      const signal = detectPlatform(clientInfo);
      expect(signal.platform).toBe(expectedPlatform);
      expect(signal.confidence).toBe("high");
    },
  );

  it("antigravity clientInfo detection reason contains clientInfo", () => {
    const signal = detectPlatform({ name: "antigravity-client", version: "1.0" });
    expect(signal.reason).toContain("clientInfo");
  });

  it("clientInfo takes priority over env vars", () => {
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    const signal = detectPlatform({ name: "antigravity-client", version: "1.0" });
    expect(signal.platform).toBe("antigravity");
  });

  it("unknown clientInfo falls through to env var detection", () => {
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    const signal = detectPlatform({ name: "some-unknown-client", version: "1.0" });
    expect(signal.platform).toBe("claude-code");
  });

  // ── CONTEXT_MODE_PLATFORM override ──────────────────────

  it("returns antigravity when CONTEXT_MODE_PLATFORM=antigravity", () => {
    process.env.CONTEXT_MODE_PLATFORM = "antigravity";
    const signal = detectPlatform();
    expect(signal.platform).toBe("antigravity");
    expect(signal.confidence).toBe("high");
    expect(signal.reason).toContain("CONTEXT_MODE_PLATFORM");
  });

  it("returns kiro when CONTEXT_MODE_PLATFORM=kiro", () => {
    process.env.CONTEXT_MODE_PLATFORM = "kiro";
    const signal = detectPlatform();
    expect(signal.platform).toBe("kiro");
    expect(signal.confidence).toBe("high");
    expect(signal.reason).toContain("CONTEXT_MODE_PLATFORM");
  });

  it("CONTEXT_MODE_PLATFORM takes priority over env vars", () => {
    process.env.CONTEXT_MODE_PLATFORM = "antigravity";
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    const signal = detectPlatform();
    expect(signal.platform).toBe("antigravity");
  });

  it("clientInfo takes priority over CONTEXT_MODE_PLATFORM", () => {
    process.env.CONTEXT_MODE_PLATFORM = "codex";
    const signal = detectPlatform({ name: "antigravity-client", version: "1.0" });
    expect(signal.platform).toBe("antigravity");
  });

  it("invalid CONTEXT_MODE_PLATFORM is ignored", () => {
    process.env.CONTEXT_MODE_PLATFORM = "not-a-platform";
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
  });

  // ── Fallback ───────────────────────────────────────────

  it("returns a valid platform as default when no env vars are set", () => {
    const signal = detectPlatform();
    expect(["claude-code", "gemini-cli", "codex", "cursor", "opencode", "kilo", "openclaw", "vscode-copilot", "antigravity", "kiro", "pi", "zed", "qwen-code", "jetbrains-copilot"]).toContain(signal.platform);
  });
});

// ─────────────────────────────────────────────────────────
// getAdapter — returns correct adapter for each platform
// ─────────────────────────────────────────────────────────

describe("getAdapter", () => {
  it.each(getAdapterSpecs)(
    "returns $AdapterClass.name for $platform",
    async ({ platform, AdapterClass, extraCheck }) => {
      const adapter = await getAdapter(platform as any);
      expect(adapter).toBeInstanceOf(AdapterClass);
      extraCheck?.(adapter);
    },
  );

  it("returns ClaudeCodeAdapter for unknown platform", async () => {
    const adapter = await getAdapter("unknown" as any);
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
  });
});
