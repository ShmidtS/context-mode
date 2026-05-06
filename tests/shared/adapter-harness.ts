/**
 * Shared adapter test harness — eliminates duplication across adapter tests.
 *
 * Two parameterized suites:
 *   1. testMcpOnlyAdapter()  — for adapters where all capabilities are false
 *   2. testJsonStdioAdapter() — shared capability/format assertions for json-stdio adapters
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { HookAdapter, PlatformCapabilities } from "../../src/adapters/types.js";

// ── MCP-only adapters (antigravity, zed) ──────────────────

export interface McpOnlyAdapterSpec {
  name: string;
  createAdapter: () => HookAdapter;
  /** Expected error substring in thrown messages (e.g. "Antigravity") */
  errorName: string;
  settingsPath: string;
  sessionDirContains: string;
  instructionFiles: string[];
  sessionDirSegments?: string[];
  /** Extra config-path tests unique to this adapter; getAdapter returns the lazily-initialized adapter */
  extraConfigPathTests?: (getAdapter: () => HookAdapter) => void;
}

export function testMcpOnlyAdapter(spec: McpOnlyAdapterSpec): void {
  describe(`${spec.name}Adapter`, () => {
    let adapter: HookAdapter;

    beforeEach(() => {
      adapter = spec.createAdapter();
    });

    describe("capabilities", () => {
      it("all capabilities are false", () => {
        const c: PlatformCapabilities = adapter.capabilities;
        expect(c.preToolUse).toBe(false);
        expect(c.postToolUse).toBe(false);
        expect(c.preCompact).toBe(false);
        expect(c.sessionStart).toBe(false);
        expect(c.canModifyArgs).toBe(false);
        expect(c.canModifyOutput).toBe(false);
        expect(c.canInjectSessionContext).toBe(false);
      });

      it("paradigm is mcp-only", () => {
        expect(adapter.paradigm).toBe("mcp-only");
      });
    });

    describe("parse methods", () => {
      it("parsePreToolUseInput throws", () => {
        expect(() => adapter.parsePreToolUseInput({})).toThrow(
          new RegExp(`${spec.errorName} does not support hooks`),
        );
      });

      it("parsePostToolUseInput throws", () => {
        expect(() => adapter.parsePostToolUseInput({})).toThrow(
          new RegExp(`${spec.errorName} does not support hooks`),
        );
      });

      it("parsePreCompactInput throws", () => {
        expect(() => adapter.parsePreCompactInput!({})).toThrow(
          new RegExp(`${spec.errorName} does not support hooks`),
        );
      });

      it("parseSessionStartInput throws", () => {
        expect(() => adapter.parseSessionStartInput!({})).toThrow(
          new RegExp(`${spec.errorName} does not support hooks`),
        );
      });
    });

    describe("format methods", () => {
      it("formatPreToolUseResponse returns undefined", () => {
        expect(adapter.formatPreToolUseResponse({ decision: "deny", reason: "test" })).toBeUndefined();
      });

      it("formatPostToolUseResponse returns undefined", () => {
        expect(adapter.formatPostToolUseResponse({ additionalContext: "test" })).toBeUndefined();
      });

      it("formatPreCompactResponse returns undefined", () => {
        expect(adapter.formatPreCompactResponse!({ context: "test" })).toBeUndefined();
      });

      it("formatSessionStartResponse returns undefined", () => {
        expect(adapter.formatSessionStartResponse!({ context: "test" })).toBeUndefined();
      });
    });

    describe("hook config", () => {
      it("generateHookConfig returns empty object", () => {
        expect(adapter.generateHookConfig("/some/plugin/root")).toEqual({});
      });

      it("configureAllHooks returns empty array", () => {
        expect(adapter.configureAllHooks("/some/plugin/root")).toEqual([]);
      });

      it("setHookPermissions returns empty array", () => {
        expect(adapter.setHookPermissions("/some/plugin/root")).toEqual([]);
      });
    });

    describe("config paths", () => {
      it("settings path is correct", () => {
        expect(adapter.getSettingsPath()).toBe(spec.settingsPath);
      });

      it("session dir contains expected segments", () => {
        const sessionDir = adapter.getSessionDir().replace(/\\/g, "/");
        expect(sessionDir).toContain(spec.sessionDirContains.replace(/\\/g, "/"));
        expect(sessionDir).toContain("context-mode");
        expect(sessionDir).toContain("sessions");
      });

      it("instruction files are correct", () => {
        expect(adapter.getInstructionFiles()).toEqual(spec.instructionFiles);
      });

      if (spec.extraConfigPathTests) {
        spec.extraConfigPathTests(() => adapter);
      }
    });
  });
}

// ── Json-stdio adapters shared assertions ─────────────────

export interface JsonStdioCapabilitySpec {
  name: string;
  createAdapter: () => HookAdapter;
  paradigm?: string;
  overrides?: Partial<PlatformCapabilities>;
}

export function testJsonStdioCapabilities(spec: JsonStdioCapabilitySpec): void {
  describe(`${spec.name} capabilities`, () => {
    let adapter: HookAdapter;

    beforeEach(() => {
      adapter = spec.createAdapter();
    });

    it("paradigm is json-stdio", () => {
      expect(adapter.paradigm).toBe(spec.paradigm ?? "json-stdio");
    });

    it("formatPreToolUseResponse returns undefined for allow", () => {
      expect(adapter.formatPreToolUseResponse({ decision: "allow" })).toBeUndefined();
    });

    it("formatPostToolUseResponse returns undefined for empty response", () => {
      expect(adapter.formatPostToolUseResponse({})).toBeUndefined();
    });
  });
}
