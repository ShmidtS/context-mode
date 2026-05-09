import "../setup-home";
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BaseAdapter } from "../../src/adapters/base.js";

/**
 * BaseAdapter memory/config dispatch defaults.
 *
 * Slice 1 of the adapter-aware persistent memory rework.
 * Verifies the three new defaults BaseAdapter exposes for
 * auto-memory + ctx_search timeline + rule detection:
 *   - getConfigDir()       — derived from sessionDirSegments
 *   - getInstructionFiles()— defaults to ["CLAUDE.md"] (Claude convention)
 *   - getMemoryDir()       — defaults to <configDir>/memory
 */

class TestAdapter extends BaseAdapter {
  constructor(segments: string[]) {
    super(segments);
  }
  getSettingsPath(): string {
    return join(this.getConfigDir(), "settings.json");
  }
  protected findPluginEntry(settings: Record<string, unknown>): ReturnType<BaseAdapter["checkPluginRegistration"]> | null {
    const plugins = settings.plugins as Record<string, boolean> | undefined;
    const pluginKey = Object.keys(plugins ?? {}).find((key) => key.startsWith("context-mode") && plugins?.[key]);
    if (!pluginKey) return null;
    return {
      check: "Plugin registration",
      status: "pass",
      message: `Plugin enabled: ${pluginKey}`,
    };
  }
  protected extractVersion(settings: Record<string, unknown>): string {
    return typeof settings.version === "string" ? settings.version : "unknown";
  }
}

describe("BaseAdapter memory/config defaults", () => {
  it("getConfigDir returns $HOME joined with sessionDirSegments (single segment)", () => {
    const adapter = new TestAdapter([".claude"]);
    expect(adapter.getConfigDir()).toBe(join(homedir(), ".claude"));
  });

  it("getConfigDir handles multi-segment sessionDirSegments", () => {
    const adapter = new TestAdapter([".config", "zed"]);
    expect(adapter.getConfigDir()).toBe(join(homedir(), ".config", "zed"));
  });

  it("getInstructionFiles defaults to ['CLAUDE.md']", () => {
    const adapter = new TestAdapter([".claude"]);
    expect(adapter.getInstructionFiles()).toEqual(["CLAUDE.md"]);
  });

  it("getMemoryDir defaults to <configDir>/memory", () => {
    const adapter = new TestAdapter([".claude"]);
    expect(adapter.getMemoryDir()).toBe(join(homedir(), ".claude", "memory"));
  });

  it("reads settings from getSettingsPath", () => {
    const adapter = new TestAdapter([".base-template"]);
    const settingsPath = adapter.getSettingsPath();
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ version: "1.2.3" }), "utf-8");

    expect(adapter.readSettings()).toEqual({ version: "1.2.3" });
  });

  it("returns warn when plugin registration settings cannot be read", () => {
    const adapter = new TestAdapter([".missing-template"]);

    expect(adapter.checkPluginRegistration()).toEqual({
      check: "Plugin registration",
      status: "warn",
      message: "Could not read settings.json",
    });
  });

  it("returns pass when findPluginEntry locates an enabled plugin", () => {
    const adapter = new TestAdapter([".base-template-pass"]);
    const settingsPath = adapter.getSettingsPath();
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ plugins: { "context-mode": true } }), "utf-8");

    expect(adapter.checkPluginRegistration()).toEqual({
      check: "Plugin registration",
      status: "pass",
      message: "Plugin enabled: context-mode",
    });
  });

  it("returns not installed when installed version settings cannot be read", () => {
    const adapter = new TestAdapter([".missing-version"]);

    expect(adapter.getInstalledVersion()).toBe("not installed");
  });

  it("extracts installed version from readable settings", () => {
    const adapter = new TestAdapter([".base-template-version"]);
    const settingsPath = adapter.getSettingsPath();
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ version: "4.5.6" }), "utf-8");

    expect(adapter.getInstalledVersion()).toBe("4.5.6");
  });
});
