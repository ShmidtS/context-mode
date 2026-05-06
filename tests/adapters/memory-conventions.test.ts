import "../setup-home";
import { fakeHome } from "../setup-home";
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// Adapters that honor XDG_CONFIG_HOME / APPDATA (e.g. opencode) read the env
// var BEFORE falling back to homedir(). GitHub Actions Ubuntu can have these
// set to the runner's real home and bypass the homedir mock — anchor them
// under fakeHome so adapters stay sandboxed regardless of host env.
process.env.XDG_CONFIG_HOME = join(fakeHome, ".config");
process.env.XDG_DATA_HOME = join(fakeHome, ".local", "share");
process.env.APPDATA = join(fakeHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(fakeHome, "AppData", "Local");

import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { QwenCodeAdapter } from "../../src/adapters/qwen-code/index.js";
import { GeminiCLIAdapter } from "../../src/adapters/gemini-cli/index.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode/index.js";
import { CursorAdapter } from "../../src/adapters/cursor/index.js";
import { VSCodeCopilotAdapter } from "../../src/adapters/vscode-copilot/index.js";
import { JetBrainsCopilotAdapter } from "../../src/adapters/jetbrains-copilot/index.js";
import { KiroAdapter } from "../../src/adapters/kiro/index.js";
import { ZedAdapter } from "../../src/adapters/zed/index.js";
import { AntigravityAdapter } from "../../src/adapters/antigravity/index.js";
import { OpenClawAdapter } from "../../src/adapters/openclaw/index.js";

// ── Home-rooted adapter specs ─────────────────────────────

type AdapterConstructor = new (...args: any[]) => ReturnType<typeof Object.create>;

interface HomeRootedSpec {
  name: string;
  AdapterClass: AdapterConstructor;
  constructorArgs?: unknown[];
  configDir: string;
  instructionFiles: string[];
  memoryDir: string;
}

const xdgRoot =
  process.platform === "win32"
    ? join(homedir(), "AppData", "Roaming")
    : join(homedir(), ".config");

const homeRootedSpecs: HomeRootedSpec[] = [
  { name: "QwenCodeAdapter", AdapterClass: QwenCodeAdapter, configDir: join(homedir(), ".qwen"), instructionFiles: ["QWEN.md"], memoryDir: join(homedir(), ".qwen", "memory") },
  { name: "GeminiCLIAdapter", AdapterClass: GeminiCLIAdapter, configDir: join(homedir(), ".gemini"), instructionFiles: ["GEMINI.md"], memoryDir: join(homedir(), ".gemini", "memory") },
  { name: "CodexAdapter", AdapterClass: CodexAdapter, configDir: join(homedir(), ".codex"), instructionFiles: ["AGENTS.md", "AGENTS.override.md"], memoryDir: join(homedir(), ".codex", "memories") },
  { name: "OpenCodeAdapter (opencode)", AdapterClass: OpenCodeAdapter, configDir: join(xdgRoot, "opencode"), instructionFiles: ["AGENTS.md"], memoryDir: join(xdgRoot, "opencode", "memory") },
  { name: "OpenCodeAdapter (kilo)", AdapterClass: OpenCodeAdapter, constructorArgs: ["kilo"], configDir: join(xdgRoot, "kilo"), instructionFiles: ["AGENTS.md"], memoryDir: join(xdgRoot, "kilo", "memory") },
  { name: "ZedAdapter", AdapterClass: ZedAdapter, configDir: join(homedir(), ".config", "zed"), instructionFiles: ["AGENTS.md"], memoryDir: join(homedir(), ".config", "zed", "memory") },
  { name: "AntigravityAdapter", AdapterClass: AntigravityAdapter, configDir: join(homedir(), ".gemini", "antigravity"), instructionFiles: ["GEMINI.md"], memoryDir: join(homedir(), ".gemini", "antigravity", "memory") },
];

// ── Project-scoped adapter specs ──────────────────────────

interface ProjectScopedSpec {
  name: string;
  AdapterClass: AdapterConstructor;
  configDir: (projectDir: string) => string;
  instructionFiles: string[];
  memoryDir: () => string;
  memoryDirSuffix?: string;
}

const projectDir = join(fakeHome, "fixture-project");

const projectScopedSpecs: ProjectScopedSpec[] = [
  { name: "CursorAdapter", AdapterClass: CursorAdapter, configDir: (p) => resolve(p, ".cursor"), instructionFiles: ["context-mode.mdc"], memoryDir: () => resolve(process.cwd(), ".cursor", "memory") },
  { name: "VSCodeCopilotAdapter", AdapterClass: VSCodeCopilotAdapter, configDir: (p) => resolve(p, ".github"), instructionFiles: ["copilot-instructions.md"], memoryDir: () => resolve(process.cwd(), ".github", "memory") },
  { name: "KiroAdapter", AdapterClass: KiroAdapter, configDir: (p) => resolve(p, ".kiro"), instructionFiles: ["KIRO.md"], memoryDir: () => resolve(process.cwd(), ".kiro", "memory") },
  { name: "OpenClawAdapter", AdapterClass: OpenClawAdapter, configDir: (p) => resolve(p), instructionFiles: ["AGENTS.md"], memoryDir: () => resolve(process.cwd(), "memory") },
];

describe("Adapter memory conventions", () => {
  // ── Home-rooted adapters ────────────────────────────────

  describe("home-rooted adapters", () => {
    it.each(homeRootedSpecs)(
      "$name getConfigDir returns expected path",
      ({ AdapterClass, constructorArgs, configDir }) => {
        const a = constructorArgs ? new AdapterClass(...constructorArgs) : new AdapterClass();
        expect(a.getConfigDir()).toBe(configDir);
      },
    );

    it.each(homeRootedSpecs)(
      "$name getInstructionFiles returns expected list",
      ({ AdapterClass, constructorArgs, instructionFiles }) => {
        const a = constructorArgs ? new AdapterClass(...constructorArgs) : new AdapterClass();
        expect(a.getInstructionFiles()).toEqual(instructionFiles);
      },
    );

    it.each(homeRootedSpecs)(
      "$name getMemoryDir returns expected path",
      ({ AdapterClass, constructorArgs, memoryDir }) => {
        const a = constructorArgs ? new AdapterClass(...constructorArgs) : new AdapterClass();
        expect(a.getMemoryDir()).toBe(memoryDir);
      },
    );
  });

  // ── Project-scoped adapters ──────────────────────────────

  describe("project-scoped adapters", () => {
    it.each(projectScopedSpecs)(
      "$name getConfigDir(projectDir) returns expected absolute path",
      ({ AdapterClass, configDir }) => {
        const a = new AdapterClass();
        expect(a.getConfigDir(projectDir)).toBe(configDir(projectDir));
      },
    );

    it.each(projectScopedSpecs)(
      "$name getInstructionFiles returns expected list",
      ({ AdapterClass, instructionFiles }) => {
        const a = new AdapterClass();
        expect(a.getInstructionFiles()).toEqual(instructionFiles);
      },
    );

    it.each(projectScopedSpecs)(
      "$name getMemoryDir returns expected absolute path",
      ({ AdapterClass, memoryDir }) => {
        const a = new AdapterClass();
        expect(a.getMemoryDir()).toBe(memoryDir());
      },
    );
  });

  // ── JetBrains (special memoryDir check) ──────────────────

  describe("JetBrainsCopilotAdapter", () => {
    const a = new JetBrainsCopilotAdapter();
    it("getConfigDir is <project>/.github (absolute)", () => {
      expect(a.getConfigDir(projectDir)).toBe(resolve(projectDir, ".github"));
    });
    it("getInstructionFiles is ['copilot-instructions.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["copilot-instructions.md"]);
    });
    it("getMemoryDir is <project>/.github/memory (absolute)", () => {
      expect(isAbsolute(a.getMemoryDir())).toBe(true);
      expect(a.getMemoryDir().endsWith(join(".github", "memory"))).toBe(true);
    });
  });

  // ── Cross-adapter contract ──────────────────────────────

  describe("HookAdapter.getConfigDir contract", () => {
    const projectDirForContract = join(fakeHome, "fixture-project");

    const allAdapters: Array<{ name: string; instance: { getConfigDir: (p?: string) => string } }> = [
      { name: "ClaudeCodeAdapter", instance: new ClaudeCodeAdapter() },
      { name: "QwenCodeAdapter", instance: new QwenCodeAdapter() },
      { name: "GeminiCLIAdapter", instance: new GeminiCLIAdapter() },
      { name: "CodexAdapter", instance: new CodexAdapter() },
      { name: "OpenCodeAdapter (opencode)", instance: new OpenCodeAdapter() },
      { name: "OpenCodeAdapter (kilo)", instance: new OpenCodeAdapter("kilo") },
      { name: "CursorAdapter", instance: new CursorAdapter() },
      { name: "VSCodeCopilotAdapter", instance: new VSCodeCopilotAdapter() },
      { name: "JetBrainsCopilotAdapter", instance: new JetBrainsCopilotAdapter() },
      { name: "KiroAdapter", instance: new KiroAdapter() },
      { name: "ZedAdapter", instance: new ZedAdapter() },
      { name: "AntigravityAdapter", instance: new AntigravityAdapter() },
      { name: "OpenClawAdapter", instance: new OpenClawAdapter() },
    ];

    it.each(allAdapters)(
      "$name.getConfigDir(projectDir) returns an absolute path",
      ({ instance }) => {
        const dir = instance.getConfigDir(projectDirForContract);
        expect(typeof dir).toBe("string");
        expect(dir.length).toBeGreaterThan(0);
        expect(isAbsolute(dir)).toBe(true);
      },
    );

    it.each(allAdapters)(
      "$name.getConfigDir() (no args) still returns an absolute path",
      ({ instance }) => {
        const dir = instance.getConfigDir();
        expect(typeof dir).toBe("string");
        expect(dir.length).toBeGreaterThan(0);
        expect(isAbsolute(dir)).toBe(true);
      },
    );
  });
});
