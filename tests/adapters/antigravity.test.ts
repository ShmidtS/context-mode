import "../setup-home";
import { it, expect } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AntigravityAdapter } from "../../src/adapters/experimental/antigravity/index.js";
import { testMcpOnlyAdapter } from "../shared/adapter-harness.js";

testMcpOnlyAdapter({
  name: "Antigravity",
  createAdapter: () => new AntigravityAdapter(),
  errorName: "Antigravity",
  settingsPath: resolve(homedir(), ".gemini", "antigravity", "mcp_config.json"),
  sessionDirContains: ".gemini",
  instructionFiles: ["GEMINI.md"],
  extraConfigPathTests: (getAdapter) => {
    it("session DB path contains project hash", () => {
      const dbPath = getAdapter().getSessionDBPath("/test/project").replace(/\\/g, "/");
      expect(dbPath).toMatch(/[a-f0-9]{16}\.db$/);
      expect(dbPath).toContain(".gemini");
    });

    it("session events path contains project hash with -events.md suffix", () => {
      const eventsPath = getAdapter().getSessionEventsPath("/test/project").replace(/\\/g, "/");
      expect(eventsPath).toMatch(/[a-f0-9]{16}-events\.md$/);
      expect(eventsPath).toContain(".gemini");
    });
  },
});
