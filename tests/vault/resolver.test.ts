/**
 * resolver.test — Unit tests for wiki-link resolution.
 */

import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { resolveLink } from "../../src/vault/resolver.js";

describe("resolveLink: exact match", () => {
  test("resolves target at vault root", () => {
    const allPaths = new Set(["Auth.md", "Session.md", "Index.md"]);
    const result = resolveLink("Auth", "", "/vault", allPaths);
    assert.equal(result, "Auth.md");
  });

  test("resolves target as full relative path", () => {
    const allPaths = new Set(["notes/Auth.md", "notes/Session.md"]);
    const result = resolveLink("notes/Auth", "", "/vault", allPaths);
    assert.equal(result, "notes/Auth.md");
  });
});

describe("resolveLink: path suffix match", () => {
  test("resolves target in subfolder via suffix", () => {
    const allPaths = new Set(["notes/Auth.md", "Session.md"]);
    const result = resolveLink("Auth", "", "/vault", allPaths);
    assert.equal(result, "notes/Auth.md");
  });

  test("resolves target deeply nested", () => {
    const allPaths = new Set(["a/b/c/Auth.md"]);
    const result = resolveLink("Auth", "", "/vault", allPaths);
    assert.equal(result, "a/b/c/Auth.md");
  });
});

describe("resolveLink: broken link", () => {
  test("returns null when no match exists", () => {
    const allPaths = new Set(["Index.md", "Session.md"]);
    const result = resolveLink("NonExistent", "", "/vault", allPaths);
    assert.equal(result, null);
  });

  test("returns null on empty vault", () => {
    const allPaths = new Set<string>();
    const result = resolveLink("Anything", "", "/vault", allPaths);
    assert.equal(result, null);
  });
});

describe("resolveLink: ambiguous links", () => {
  test("shortest path wins among suffix matches", () => {
    const allPaths = new Set(["Auth.md", "notes/Auth.md", "a/b/Auth.md"]);
    const result = resolveLink("Auth", "", "/vault", allPaths);
    assert.equal(result, "Auth.md");
  });

  test("alphabetical tiebreaker when depth equal", () => {
    const allPaths = new Set(["a/Auth.md", "b/Auth.md"]);
    const result = resolveLink("Auth", "", "/vault", allPaths);
    assert.equal(result, "a/Auth.md");
  });

  test("exact match preferred over suffix match", () => {
    const allPaths = new Set(["Auth.md", "notes/Auth.md"]);
    const result = resolveLink("Auth", "", "/vault", allPaths);
    assert.equal(result, "Auth.md");
  });
});
