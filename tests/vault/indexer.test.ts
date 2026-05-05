/**
 * indexer.test — Tests for src/vault/indexer.ts
 *
 * Creates a temp directory with markdown files, indexes them,
 * verifies nodes/edges/tags, then cleans up.
 */

import { describe, test, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexVault } from "../../src/vault/indexer.js";
import type { VaultGraphStore as IndexerStore, VaultNode, VaultEdge } from "../../src/vault/indexer.js";

// ── In-memory store implementing the indexer's VaultGraphStore interface ──

class MemoryStore implements IndexerStore {
  nodes = new Map<string, VaultNode>();
  edges: VaultEdge[] = [];

  getNode(path: string): VaultNode | undefined {
    return this.nodes.get(path);
  }

  upsertNode(node: VaultNode): void {
    this.nodes.set(node.path, { ...node });
  }

  upsertEdge(edge: VaultEdge): void {
    this.edges.push(edge);
  }

  removeEdgesFrom(sourcePath: string): void {
    this.edges = this.edges.filter((e) => e.sourcePath !== sourcePath);
  }
}

let vaultDir: string;
let store: MemoryStore;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), "vault-indexer-"));
  store = new MemoryStore();

  // index.md
  writeFileSync(join(vaultDir, "index.md"), "# Index\n\nLink to [[Auth]] and [[Session]].\n");

  // auth.md
  writeFileSync(join(vaultDir, "auth.md"), "# Auth\n\n#security #auth\n\nAuthentication note.\n");

  // session.md
  writeFileSync(join(vaultDir, "session.md"), "# Session\n\nSee [[Auth]] for details.\n");
});

afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

describe("indexVault: initial indexing", () => {
  test("creates 3 nodes", () => {
    const result = indexVault(vaultDir, store);
    assert.equal(store.nodes.size, 3);
    assert.equal(result.indexed, 3);
  });

  test("creates edges for wiki-links", () => {
    indexVault(vaultDir, store);
    // Index->Auth, Index->Session, Session->Auth = 3 edges
    assert.equal(store.edges.length, 3);

    const targets = store.edges.map((e) => e.targetPath);
    assert.ok(targets.includes("auth.md"));
    assert.ok(targets.includes("session.md"));
  });

  test("creates tags from inline #tag syntax", () => {
    const result = indexVault(vaultDir, store);
    const authNode = store.getNode("auth.md");
    assert.ok(authNode);
    assert.ok(authNode!.tags.includes("security"));
    assert.ok(authNode!.tags.includes("auth"));
  });

  test("returns 0 broken links", () => {
    const result = indexVault(vaultDir, store);
    assert.equal(result.brokenLinks, 0);
  });
});

describe("indexVault: incremental re-index", () => {
  test("no changes → 0 updated, all skipped", () => {
    indexVault(vaultDir, store);

    const result = indexVault(vaultDir, store);
    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 3);
  });

  test("modify one file → 1 updated", async () => {
    indexVault(vaultDir, store);

    // Touch auth.md with new content AND new mtime
    const newContent = "# Auth V2\n\n#security #auth\n\nUpdated note.\n";
    writeFileSync(join(vaultDir, "auth.md"), newContent);
    // Ensure mtime changes (some filesystems have 1s resolution)
    const future = Date.now() / 1000 + 100;
    utimesSync(join(vaultDir, "auth.md"), future, future);

    const result = indexVault(vaultDir, store);
    assert.equal(result.updated, 1);
    assert.equal(result.indexed, 0);

    const authNode = store.getNode("auth.md");
    assert.ok(authNode);
    assert.equal(authNode!.title, "Auth V2");
  });
});

describe("indexVault: exclude patterns", () => {
  test("skips node_modules directory", () => {
    mkdirSync(join(vaultDir, "node_modules"), { recursive: true });
    writeFileSync(join(vaultDir, "node_modules", "pkg.md"), "# Should be skipped\n");

    indexVault(vaultDir, store);
    assert.ok(!store.getNode("node_modules/pkg.md"));
    // Only the 3 original files
    assert.equal(store.nodes.size, 3);
  });

  test("skips .git directory", () => {
    mkdirSync(join(vaultDir, ".git"), { recursive: true });
    writeFileSync(join(vaultDir, ".git", "note.md"), "# Git note\n");

    indexVault(vaultDir, store);
    assert.ok(!store.getNode(".git/note.md"));
  });

  test("skips .omc directory", () => {
    mkdirSync(join(vaultDir, ".omc"), { recursive: true });
    writeFileSync(join(vaultDir, ".omc", "state.md"), "# State\n");

    indexVault(vaultDir, store);
    assert.ok(!store.getNode(".omc/state.md"));
  });

  test("skips dist and build directories", () => {
    mkdirSync(join(vaultDir, "dist"), { recursive: true });
    mkdirSync(join(vaultDir, "build"), { recursive: true });
    writeFileSync(join(vaultDir, "dist", "bundle.md"), "# Bundle\n");
    writeFileSync(join(vaultDir, "build", "output.md"), "# Output\n");

    indexVault(vaultDir, store);
    assert.ok(!store.getNode("dist/bundle.md"));
    assert.ok(!store.getNode("build/output.md"));
  });

  test("custom exclude patterns", () => {
    mkdirSync(join(vaultDir, "custom-skip"), { recursive: true });
    writeFileSync(join(vaultDir, "custom-skip", "note.md"), "# Skipped\n");

    indexVault(vaultDir, store, { excludePatterns: [".obsidian", "custom-skip"] });
    assert.ok(!store.getNode("custom-skip/note.md"));
  });
});

describe("indexVault: code file indexing", () => {
  test("indexes .ts files as nodes", () => {
    writeFileSync(join(vaultDir, "server.ts"), `import { foo } from "./utils";\nconsole.log(foo);\n`);
    writeFileSync(join(vaultDir, "utils.ts"), `export const foo = 42;\n`);

    indexVault(vaultDir, store);
    assert.ok(store.getNode("server.ts"));
    assert.ok(store.getNode("utils.ts"));
  });

  test("creates import edges for relative imports", () => {
    writeFileSync(join(vaultDir, "server.ts"), `import { foo } from "./utils";\nconsole.log(foo);\n`);
    writeFileSync(join(vaultDir, "utils.ts"), `export const foo = 42;\n`);

    indexVault(vaultDir, store);

    const importEdges = store.edges.filter((e) => e.linkType === "import");
    assert.ok(importEdges.length >= 1);
    const serverImport = importEdges.find((e) => e.sourcePath === "server.ts" && e.targetPath === "utils.ts");
    assert.ok(serverImport, "Expected import edge from server.ts to utils.ts");
  });

  test("indexes .js and .mjs files", () => {
    writeFileSync(join(vaultDir, "app.js"), `const mod = require("./lib");\n`);
    writeFileSync(join(vaultDir, "lib.js"), `module.exports = {};\n`);
    writeFileSync(join(vaultDir, "cli.mjs"), `import { run } from "./run";\n`);
    writeFileSync(join(vaultDir, "run.mjs"), `export const run = () => {};\n`);

    indexVault(vaultDir, store);
    assert.ok(store.getNode("app.js"));
    assert.ok(store.getNode("cli.mjs"));
  });

  test("code file tags derived from directory", () => {
    mkdirSync(join(vaultDir, "src", "vault"), { recursive: true });
    writeFileSync(join(vaultDir, "src", "vault", "parser.ts"), `export function parse() {}\n`);

    indexVault(vaultDir, store);
    const node = store.getNode("src/vault/parser.ts");
    assert.ok(node);
    assert.ok(node!.tags.includes("src"));
    assert.ok(node!.tags.includes("vault"));
  });
});

describe("indexVault: markdown-to-code reference edges", () => {
  test("creates reference edge for md link to .ts file", () => {
    writeFileSync(join(vaultDir, "server.ts"), `export function start() {}\n`);
    writeFileSync(join(vaultDir, "doc.md"), "# Docs\n\nSee [server](./server.ts) for details.\n");

    indexVault(vaultDir, store);

    const refEdges = store.edges.filter((e) => e.linkType === "reference");
    assert.ok(refEdges.length >= 1, "Expected at least one reference edge");
    const docToServer = refEdges.find((e) => e.sourcePath === "doc.md" && e.targetPath === "server.ts");
    assert.ok(docToServer, "Expected reference edge from doc.md to server.ts");
  });

  test("does not count md->code link as broken if target exists", () => {
    writeFileSync(join(vaultDir, "server.ts"), `export function start() {}\n`);
    writeFileSync(join(vaultDir, "doc.md"), "# Docs\n\nSee [server](./server.ts) for details.\n");

    const result = indexVault(vaultDir, store);
    assert.equal(result.brokenLinks, 0);
  });

  test("creates reference edge for md link to .js file", () => {
    writeFileSync(join(vaultDir, "app.js"), `console.log("hi");\n`);
    writeFileSync(join(vaultDir, "notes.md"), "# Notes\n\nRef: [app](./app.js)\n");

    indexVault(vaultDir, store);

    const refEdges = store.edges.filter((e) => e.linkType === "reference");
    assert.ok(refEdges.length >= 1);
  });
});
