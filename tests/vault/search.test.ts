/**
 * search.test — Tests for src/vault/search.ts
 *
 * Uses in-memory SQLite with the graph-store.ts VaultGraphStore
 * (which provides the API that VaultGraphSearch depends on).
 */

import { describe, test, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { VaultGraphStore } from "../../src/vault/graph-store.js";
import { VaultGraphSearch } from "../../src/vault/search.js";
import type { SearchResult } from "../../src/types.js";

let db: Database.Database;
let store: InstanceType<typeof VaultGraphStore>;
let search: InstanceType<typeof VaultGraphSearch>;

beforeEach(() => {
  db = new Database(":memory:");
  store = new VaultGraphStore(db);
  search = new VaultGraphSearch(store);
});

afterEach(() => {
  db.close();
});

/** Helper: seed a small graph for traversal tests. */
function seedGraph(): { indexId: number; authId: number; sessionId: number; configId: number } {
  const indexId = store.upsertNode("vault", "index.md", "Index", null, "h1", 1000, null);
  const authId = store.upsertNode("vault", "auth.md", "Auth", null, "h2", 1000, null);
  const sessionId = store.upsertNode("vault", "session.md", "Session", null, "h3", 1000, null);
  const configId = store.upsertNode("vault", "config.md", "Config", null, "h4", 1000, null);

  // Index -> Auth, Index -> Session
  store.insertEdge(indexId, authId, "Auth", null, 1, "link to auth", "wikilink");
  store.insertEdge(indexId, sessionId, "Session", null, 2, "link to session", "wikilink");
  // Session -> Auth
  store.insertEdge(sessionId, authId, "Auth", null, 1, "see auth", "wikilink");
  // Auth -> Config
  store.insertEdge(authId, configId, "Config", null, 1, "config ref", "wikilink");

  // Tags
  store.insertTag("security", authId);
  store.insertTag("auth", authId);
  store.insertTag("config", configId);

  // Recalc degrees for accurate backlink counts
  store.recalcDegrees(indexId);
  store.recalcDegrees(authId);
  store.recalcDegrees(sessionId);
  store.recalcDegrees(configId);

  return { indexId, authId, sessionId, configId };
}

describe("VaultGraphSearch: BFS neighbors", () => {
  test("1-hop from Index reaches Auth and Session", () => {
    const { indexId } = seedGraph();
    const results = search.neighbors(indexId, 1);
    assert.equal(results.length, 2);
    const titles = results.map((r) => r.title);
    assert.ok(titles.includes("Auth"));
    assert.ok(titles.includes("Session"));
  });

  test("2-hop from Index reaches Config via Auth", () => {
    const { indexId } = seedGraph();
    const results = search.neighbors(indexId, 2);
    assert.equal(results.length, 3);
    const titles = results.map((r) => r.title);
    assert.ok(titles.includes("Auth"));
    assert.ok(titles.includes("Session"));
    assert.ok(titles.includes("Config"));
  });

  test("0-hop returns empty", () => {
    const { indexId } = seedGraph();
    const results = search.neighbors(indexId, 0);
    assert.equal(results.length, 0);
  });
});

describe("VaultGraphSearch: backlinks", () => {
  test("Auth has backlinks from Index and Session", () => {
    const { authId } = seedGraph();
    const results = search.backlinks(authId);
    assert.equal(results.length, 2);
    const titles = results.map((r) => r.title);
    assert.ok(titles.includes("Index"));
    assert.ok(titles.includes("Session"));
  });

  test("Config has backlink from Auth only", () => {
    const { configId } = seedGraph();
    const results = search.backlinks(configId);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Auth");
  });
});

describe("VaultGraphSearch: tagCluster", () => {
  test("security tag cluster includes Auth + 1-hop neighbors", () => {
    seedGraph();
    const results = search.tagCluster("security");
    // Auth (tagged) + Index and Session (1-hop from Auth) + Config (Auth->Config)
    assert.ok(results.length >= 2);
    const titles = results.map((r) => r.title);
    assert.ok(titles.includes("Auth"));
  });

  test("unknown tag returns empty", () => {
    seedGraph();
    const results = search.tagCluster("nonexistent");
    assert.equal(results.length, 0);
  });
});

describe("VaultGraphSearch: tagCluster hierarchy", () => {
  test("tagCluster('parent') matches nodes tagged 'parent/child'", () => {
    const nodeId = store.upsertNode("vault", "note.md", "Note", null, "h1", 1000, null);
    store.insertTag("parent/child", nodeId);
    store.recalcDegrees(nodeId);

    const results = search.tagCluster("parent");
    assert.ok(results.length >= 1);
    const titles = results.map((r) => r.title);
    assert.ok(titles.includes("Note"));
  });

  test("tagCluster('ml') matches 'ml/transformers' tag", () => {
    const nodeId = store.upsertNode("vault", "ml-note.md", "ML Note", null, "h2", 1000, null);
    store.insertTag("ml/transformers", nodeId);
    store.recalcDegrees(nodeId);

    const results = search.tagCluster("ml");
    assert.ok(results.length >= 1);
    const titles = results.map((r) => r.title);
    assert.ok(titles.includes("ML Note"));
  });

  test("tagCluster does not match unrelated tags", () => {
    const nodeId = store.upsertNode("vault", "other.md", "Other", null, "h3", 1000, null);
    store.insertTag("unrelated", nodeId);
    store.recalcDegrees(nodeId);

    const results = search.tagCluster("ml");
    assert.equal(results.length, 0);
  });
});

describe("VaultGraphSearch: fusionSearch", () => {
  test("boosts graph neighbors of text results", () => {
    const { indexId, authId, sessionId, configId } = seedGraph();

    // Mock BM25 results that match Index
    const textResults: SearchResult[] = [
      { title: "Index", content: "...", source: "index.md", rank: -1, contentType: "prose" },
    ];

    const results = search.fusionSearch("test query", textResults);
    assert.ok(results.length >= 1);

    // The text result (Index) should be first or near-first by fusion score
    const indexResult = results.find((r) => r.title === "Index");
    assert.ok(indexResult);
    assert.ok(indexResult!.fusionScore! > 0);

    // Graph neighbors (Auth, Session) should also appear with boosted scores
    const authResult = results.find((r) => r.title === "Auth");
    assert.ok(authResult);
    assert.ok(authResult!.fusionScore! > 0);
  });

  test("empty text results returns empty", () => {
    seedGraph();
    const results = search.fusionSearch("nothing", []);
    assert.equal(results.length, 0);
  });
});

describe("VaultGraphSearch: pageRank", () => {
  test("returns Map with PageRank values for all nodes", () => {
    const { indexId, authId, sessionId, configId } = seedGraph();
    const prMap = search.pageRank();

    assert.ok(prMap.has(indexId));
    assert.ok(prMap.has(authId));
    assert.ok(prMap.has(sessionId));
    assert.ok(prMap.has(configId));
  });

  test("PageRank values are positive numbers", () => {
    seedGraph();
    const prMap = search.pageRank();

    for (const [, value] of prMap) {
      assert.ok(value > 0, `PageRank value should be positive, got ${value}`);
    }
  });

  test("node with more backlinks has higher PageRank than node with fewer", () => {
    const { indexId, authId } = seedGraph();
    const prMap = search.pageRank();

    // Index has no backlinks (in_degree=0), Auth has 2 backlinks.
    // Auth should have higher PR than Index.
    const authPR = prMap.get(authId) ?? 0;
    const indexPR = prMap.get(indexId) ?? 0;
    assert.ok(authPR > indexPR, `Auth PR (${authPR}) should be > Index PR (${indexPR})`);
  });

  test("PageRank values present in fusionSearch results", () => {
    const { indexId } = seedGraph();

    const textResults: SearchResult[] = [
      { title: "Index", content: "...", source: "index.md", rank: -1, contentType: "prose" },
    ];

    const results = search.fusionSearch("test", textResults);
    for (const r of results) {
      assert.ok(r.pageRank !== undefined, `Result ${r.title} should have pageRank`);
      assert.ok(typeof r.pageRank === "number", `pageRank should be number`);
    }
  });

  test("empty graph returns empty PageRank map", () => {
    const prMap = search.pageRank();
    assert.equal(prMap.size, 0);
  });
});
