import "../setup-home";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ZedAdapter } from "../../src/adapters/experimental/zed/index.js";
import { testMcpOnlyAdapter } from "../shared/adapter-harness.js";

testMcpOnlyAdapter({
  name: "Zed",
  createAdapter: () => new ZedAdapter(),
  errorName: "Zed",
  settingsPath: resolve(homedir(), ".config", "zed", "settings.json"),
  sessionDirContains: ".config/zed",
  instructionFiles: ["AGENTS.md"],
});
