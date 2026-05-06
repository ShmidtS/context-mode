import "../setup-home";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Slice 5 — ctx_search timeline mode.
 *
 * Two static checks, asserted against the source of src/tools/search.ts:
 *   (a) the SessionDB path used by timeline mode includes the worktree
 *       suffix (matches the SessionDB path the snapshot/extract hooks write to);
 *   (b) the configDir + adapter passed to searchAllSources comes from
 *       _detectedAdapter (aliased locally as detectedAdapter) — not a
 *       hardcoded ~/.claude path.
 *
 * Running this as a static guard avoids spawning a full MCP server in tests
 * while still preventing regressions of the original bug (#367 follow-ups).
 */

const SEARCH_SRC = readFileSync(
  resolve(__dirname, "../../src/tools/search.ts"),
  "utf-8",
);

describe("ctx_search timeline mode wiring (search.ts)", () => {
  it("opens SessionDB at <hash><worktreeSuffix>.db, not bare <hash>.db", () => {
    // Bug #4: timeline mode looked to ${hash}.db but extract.ts/snapshot.ts
    // write to ${hash}${getWorktreeSuffix()}.db — they never matched in
    // worktree sessions.
    expect(SEARCH_SRC).toMatch(
      /join\(\s*sessionsDir\s*,\s*`\$\{hashProjectDir\(\)\}\$\{getWorktreeSuffix\(\)\}\.db`/,
    );
  });

  it("derives configDir from _detectedAdapter.getConfigDir() (not hardcoded ~/.claude)", () => {
    // search.ts aliases _detectedAdapter to a local const, so check
    // either the alias or the original imported name.
    expect(SEARCH_SRC).toMatch(
      /(_detectedAdapter|detectedAdapter)\??\.getConfigDir\(\)/,
    );
  });

  it("passes the detected adapter through to searchAllSources", () => {
    // searchAllSources call site should include `adapter:` in its options.
    // search.ts aliases _detectedAdapter locally as `detectedAdapter`.
    expect(SEARCH_SRC).toMatch(
      /searchAllSources\(\{[\s\S]*?adapter:\s*detectedAdapter[\s\S]*?\}\)/,
    );
  });
});
