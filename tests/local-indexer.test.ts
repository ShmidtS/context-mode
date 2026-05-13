import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndexer } from "../src/local-indexer.js";
import { deleteDBFiles } from "../src/db-base.js";

describe("LocalIndexer", () => {
  let tmpDir: string;
  let dbPath: string;
  let indexer: LocalIndexer;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctx-local-"));
    dbPath = join(tmpDir, "test.db");
    indexer = new LocalIndexer(dbPath);
  });

  afterEach(() => {
    try { indexer.close(); } catch { /* ignore */ }
    try { deleteDBFiles(dbPath); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("indexes a simple repo with one file", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "export function foo(): number { return 1; }\n");
    const result = await indexer.indexRepository(tmpDir, "test-repo");
    expect(result.status).toBe("completed");
    expect(result.filesIndexed).toBe(1);
    expect(result.chunksIndexed).toBeGreaterThanOrEqual(1);
  });

  it("skips unchanged files on second index (Merkle diff)", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "export function foo(): number { return 1; }\n");
    await indexer.indexRepository(tmpDir, "test-repo");
    const result2 = await indexer.indexRepository(tmpDir, "test-repo");
    expect(result2.status).toBe("completed");
    expect(result2.filesIndexed).toBe(0);
  });

  it("re-indexes changed files", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "export function foo(): number { return 1; }\n");
    await indexer.indexRepository(tmpDir, "test-repo");
    // Touch file to change mtime
    writeFileSync(join(tmpDir, "a.ts"), "export function bar(): string { return 'x'; }\n");
    const result2 = await indexer.indexRepository(tmpDir, "test-repo");
    expect(result2.status).toBe("completed");
    expect(result2.filesIndexed).toBe(1);
  });

  it("ignores binary and unsupported files", async () => {
    writeFileSync(join(tmpDir, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(tmpDir, "b.ts"), "export const x = 1;\n");
    const result = await indexer.indexRepository(tmpDir, "test-repo");
    expect(result.status).toBe("completed");
    expect(result.filesIndexed).toBe(1);
  });

  it("ignores node_modules and dot dirs", async () => {
    mkdirSync(join(tmpDir, "node_modules"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules", "dep.ts"), "export const dep = 1;");
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "config"), "[core]");
    writeFileSync(join(tmpDir, "main.ts"), "export function main() {}");
    const result = await indexer.indexRepository(tmpDir, "test-repo");
    expect(result.status).toBe("completed");
    expect(result.filesIndexed).toBe(1);
  });

  it("lists repos after indexing", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "export function foo() {}");
    await indexer.indexRepository(tmpDir, "test-repo");
    const repos = indexer.listRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0].repoId).toBe("test-repo");
    expect(repos[0].files).toBe(1);
  });

  it("returns job status", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "export function foo() {}");
    const result = await indexer.indexRepository(tmpDir, "test-repo");
    const job = indexer.getJobStatus(result.id);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("completed");
    expect(job!.filesIndexed).toBe(1);
  });

  it("handles empty directories gracefully", async () => {
    const result = await indexer.indexRepository(tmpDir, "empty-repo");
    expect(result.status).toBe("completed");
    expect(result.filesIndexed).toBe(0);
    expect(result.chunksIndexed).toBe(0);
  });
});
