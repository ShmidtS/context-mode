import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndexer } from "../src/local-indexer.js";
import { LocalSearcher } from "../src/searcher.js";
import { deleteDBFiles } from "../src/db-base.js";

describe("LocalSearcher", () => {
  let tmpDir: string;
  let dbPath: string;
  let indexer: LocalIndexer;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctx-search-"));
    dbPath = join(tmpDir, "search.db");
    indexer = new LocalIndexer(dbPath);

    // Seed a small repo
    writeFileSync(
      join(tmpDir, "server.ts"),
      `import { McpServer } from "@modelcontextprotocol/sdk";

export function startServer() {
  const server = new McpServer({ name: "test" });
  server.connect();
  return server;
}

export class ServerManager {
  private servers: McpServer[] = [];
  add(server: McpServer) { this.servers.push(server); }
}
`,
    );
    writeFileSync(
      join(tmpDir, "client.ts"),
      `export interface ClientConfig {
    url: string;
    token: string;
  }

export function createClient(config: ClientConfig) {
  return { connect: () => config.url };
}
`,
    );

    await indexer.indexRepository(tmpDir, "search-repo");
  });

  afterEach(() => {
    try { indexer.close(); } catch { /* ignore */ }
    try { deleteDBFiles(dbPath); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("finds code by function name", async () => {
    const searcher = new LocalSearcher(dbPath);
    const results = await searcher.search("startServer", "search-repo", 5);
    searcher.close();
    expect(results.length).toBeGreaterThan(0);
    const match = results.find((r) => r.content.includes("startServer"));
    expect(match).toBeDefined();
  });

  it("finds code by class name", async () => {
    const searcher = new LocalSearcher(dbPath);
    const results = await searcher.search("ServerManager", "search-repo", 5);
    searcher.close();
    expect(results.length).toBeGreaterThan(0);
    const match = results.find((r) => r.content.includes("ServerManager"));
    expect(match).toBeDefined();
  });

  it("finds code by interface name", async () => {
    const searcher = new LocalSearcher(dbPath);
    const results = await searcher.search("ClientConfig", "search-repo", 5);
    searcher.close();
    expect(results.length).toBeGreaterThan(0);
    const match = results.find((r) => r.content.includes("ClientConfig"));
    expect(match).toBeDefined();
  });

  it("respects repo_id filter", async () => {
    const searcher = new LocalSearcher(dbPath);
    const results = await searcher.search("startServer", "nonexistent-repo", 5);
    searcher.close();
    expect(results.length).toBe(0);
  });

  it("returns empty results for unknown query", async () => {
    const searcher = new LocalSearcher(dbPath);
    const results = await searcher.search("xyzzy_not_found", "search-repo", 5);
    searcher.close();
    expect(results.length).toBe(0);
  });

  it("limits results", async () => {
    const searcher = new LocalSearcher(dbPath);
    const results = await searcher.search("export", "search-repo", 2);
    searcher.close();
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("works without explicit repo_id", async () => {
    const searcher = new LocalSearcher(dbPath);
    const results = await searcher.search("McpServer", undefined, 5);
    searcher.close();
    expect(results.length).toBeGreaterThan(0);
  });

  it("scores are in 0..1 range", async () => {
    const searcher = new LocalSearcher(dbPath);
    const results = await searcher.search("export function", "search-repo", 5);
    searcher.close();
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});
