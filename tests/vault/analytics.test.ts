/**
 * analytics.test -- Tests for src/vault/analytics.ts
 *
 * All internal functions (findGodNodes, findSurprisingConnections,
 * findCommunityHints, generateQuestions) are exercised through the
 * public analyzeGraph API with lightweight mock objects.
 */

import { describe, test, expect } from "vitest";
import { analyzeGraph } from "../../src/vault/analytics.js";
import type { VaultNode, VaultEdge, VaultTag } from "../../src/types.js";

// -- Helpers ---------------------------------------------------------------

function makeNode(
  id: number,
  title: string,
  notePath: string,
  inDegree = 0,
  outDegree = 0,
): VaultNode {
  return {
    id,
    vault_path: "vault",
    note_path: notePath,
    title,
    frontmatter: null,
    content_hash: `h${id}`,
    file_mtime: 1000,
    out_degree: outDegree,
    in_degree: inDegree,
    source_id: null,
    indexed_at: "2025-01-01",
    source_type: "manual",
    connector_meta: null,
  };
}

function makeEdge(
  id: number,
  sourceId: number,
  targetId: number | null,
  edgeType = "wikilink",
  context: string | null = null,
): VaultEdge {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    target_name: "",
    alias: null,
    line_number: null,
    context,
    edge_type: edgeType,
    confidence: "EXTRACTED",
  };
}

/** Minimal mock satisfying the VaultGraphStore methods used by analytics. */
function mockStore(
  nodes: VaultNode[],
  edges: VaultEdge[],
  tagsByNode: Map<number, string[]>,
) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return {
    getAllNodeIds: () => nodes.map((n) => n.id),
    getNodeById: (id: number) => nodeMap.get(id),
    getAllEdges: () => edges,
    getTagsByNode: (nodeId: number): VaultTag[] =>
      (tagsByNode.get(nodeId) ?? []).map((tag, i) => ({
        id: i,
        tag,
        node_id: nodeId,
      })),
  };
}

/** Minimal mock satisfying the VaultGraphSearch methods used by analytics. */
function mockSearch(pageRank: Map<number, number>) {
  return { pageRank: () => pageRank };
}

// -- Tests -----------------------------------------------------------------

describe("analyzeGraph", () => {
  // -- Empty store ---------------------------------------------------------

  test("returns empty results for empty store", () => {
    const store = mockStore([], [], new Map());
    const search = mockSearch(new Map());
    const result = analyzeGraph(store as any, search as any);

    expect(result.godNodes).toEqual([]);
    expect(result.surprisingConnections).toEqual([]);
    expect(result.communityHints).toEqual([]);
    expect(result.suggestedQuestions).toEqual([]);
    expect(result.summary).toContain("0 god nodes");
  });

  // -- God nodes -----------------------------------------------------------

  test("ranks god nodes by composite PageRank and in_degree score", () => {
    const hub = makeNode(1, "Hub", "project/core/hub.md", 5, 3);
    const secondary = makeNode(2, "Secondary", "project/core/secondary.md", 3, 1);
    const leaf = makeNode(3, "Leaf", "project/core/leaf.md", 1, 0);
    const isolated = makeNode(4, "Isolated", "project/core/isolated.md", 0, 0);

    // Edge within same module with shared tags -- not surprising
    const edges = [makeEdge(1, 1, 2)];
    const tags = new Map([
      [1, ["core"]], [2, ["core"]], [3, ["core"]], [4, ["core"]],
    ]);
    const pr = new Map([[1, 0.4], [2, 0.2], [3, 0.1], [4, 0.05]]);

    const result = analyzeGraph(
      mockStore([hub, secondary, leaf, isolated], edges, tags) as any,
      mockSearch(pr) as any,
      { godNodeLimit: 4 },
    );

    expect(result.godNodes).toHaveLength(4);
    expect(result.godNodes[0].title).toBe("Hub");
    expect(result.godNodes[1].title).toBe("Secondary");
    expect(result.godNodes[2].title).toBe("Leaf");
    expect(result.godNodes[3].title).toBe("Isolated");

    // Verify fields carried through
    expect(result.godNodes[0]).toMatchObject({
      inDegree: 5,
      outDegree: 3,
      pageRank: 0.4,
      path: "project/core/hub.md",
      tags: ["core"],
    });
  });

  test("respects godNodeLimit option", () => {
    const nodes = [
      makeNode(1, "A", "x/y/a.md", 3, 0),
      makeNode(2, "B", "x/y/b.md", 2, 0),
      makeNode(3, "C", "x/y/c.md", 1, 0),
    ];
    const pr = new Map([[1, 0.5], [2, 0.3], [3, 0.1]]);

    const result = analyzeGraph(
      mockStore(nodes, [], new Map()) as any,
      mockSearch(pr) as any,
      { godNodeLimit: 2 },
    );

    expect(result.godNodes).toHaveLength(2);
    expect(result.godNodes[0].title).toBe("A");
    expect(result.godNodes[1].title).toBe("B");
  });

  // -- Surprising connections ----------------------------------------------

  test("identifies surprising connections between different path modules with no tag overlap", () => {
    const fe = makeNode(1, "Frontend", "frontend/ui/component.md", 0, 1);
    const be = makeNode(2, "Backend", "backend/api/handler.md", 1, 0);

    const edges = [makeEdge(1, 1, 2, "wikilink", "cross-ref")];
    const tags = new Map([[1, ["frontend", "ui"]], [2, ["backend", "api"]]]);
    const pr = new Map([[1, 0.5], [2, 0.5]]);

    const result = analyzeGraph(
      mockStore([fe, be], edges, tags) as any,
      mockSearch(pr) as any,
      { surpriseLimit: 5 },
    );

    expect(result.surprisingConnections.length).toBeGreaterThanOrEqual(1);
    const conn = result.surprisingConnections[0];
    expect(conn.sourcePath).toBe("frontend/ui/component.md");
    expect(conn.targetPath).toBe("backend/api/handler.md");
    // Different module prefix + zero tag overlap = maximum unexpectedness
    expect(conn.unexpectedness).toBeCloseTo(1.0);
    expect(conn.sourceTags).toEqual(["frontend", "ui"]);
    expect(conn.targetTags).toEqual(["backend", "api"]);
    expect(conn.edgeType).toBe("wikilink");
    expect(conn.context).toBe("cross-ref");
  });

  test("does not flag same-module edges with shared tags as surprising", () => {
    const a = makeNode(1, "A", "same/mod/a.md", 0, 1);
    const b = makeNode(2, "B", "same/mod/b.md", 1, 0);

    const edges = [makeEdge(1, 1, 2)];
    const tags = new Map([[1, ["shared"]], [2, ["shared"]]]);
    const pr = new Map([[1, 0.5], [2, 0.5]]);

    const result = analyzeGraph(
      mockStore([a, b], edges, tags) as any,
      mockSearch(pr) as any,
    );

    expect(result.surprisingConnections).toHaveLength(0);
  });

  // -- Community hints -----------------------------------------------------

  test("groups notes sharing tags into separate communities", () => {
    const arch1 = makeNode(1, "ArchA", "docs/arch/a.md", 0, 1);
    const arch2 = makeNode(2, "ArchB", "docs/arch/b.md", 1, 0);
    const test1 = makeNode(3, "TestA", "docs/test/a.md", 0, 1);
    const test2 = makeNode(4, "TestB", "docs/test/b.md", 1, 0);

    const nodes = [arch1, arch2, test1, test2];
    const edges = [makeEdge(1, 1, 2), makeEdge(2, 3, 4)];
    const tags = new Map([
      [1, ["architecture"]], [2, ["architecture"]],
      [3, ["testing"]], [4, ["testing"]],
    ]);
    const pr = new Map([[1, 0.25], [2, 0.25], [3, 0.25], [4, 0.25]]);

    const result = analyzeGraph(
      mockStore(nodes, edges, tags) as any,
      mockSearch(pr) as any,
      { communityLimit: 5 },
    );

    // Two disjoint clusters: arch pair and test pair
    expect(result.communityHints.length).toBeGreaterThanOrEqual(2);
    const nodeCounts = result.communityHints.map((c) => c.nodeCount);
    expect(nodeCounts).toContain(2);
    // Each 2-node community with 1 internal edge has density 1.0
    for (const c of result.communityHints) {
      if (c.nodeCount === 2) {
        expect(c.internalEdges).toBe(1);
        expect(c.avgInternalDensity).toBe(1);
      }
    }
  });

  test("community hints collect tags from all member nodes", () => {
    const a = makeNode(1, "A", "x/y/a.md", 0, 1);
    const b = makeNode(2, "B", "x/y/b.md", 1, 0);
    const edges = [makeEdge(1, 1, 2)];
    const tags = new Map([[1, ["alpha", "beta"]], [2, ["beta", "gamma"]]]);

    const result = analyzeGraph(
      mockStore([a, b], edges, tags) as any,
      mockSearch(new Map([[1, 0.5], [2, 0.5]])) as any,
      { communityLimit: 5 },
    );

    const comm = result.communityHints.find((c) => c.nodeCount === 2);
    expect(comm).toBeDefined();
    expect(comm!.tags).toEqual(expect.arrayContaining(["alpha", "beta", "gamma"]));
  });

  // -- Questions -----------------------------------------------------------

  test("generates questions referencing god node titles", () => {
    const hub = makeNode(1, "Hub", "project/core/hub.md", 5, 3);
    const sec = makeNode(2, "Secondary", "project/core/sec.md", 3, 1);
    const far = makeNode(3, "Distant", "other/remote/far.md", 0, 0);

    // Cross-module edge creates a surprising connection
    const edges = [makeEdge(1, 1, 3)];
    const tags = new Map([[1, ["core"]], [2, ["core"]], [3, ["other"]]]);
    const pr = new Map([[1, 0.6], [2, 0.3], [3, 0.1]]);

    const result = analyzeGraph(
      mockStore([hub, sec, far], edges, tags) as any,
      mockSearch(pr) as any,
      { questionLimit: 10 },
    );

    expect(result.suggestedQuestions.length).toBeGreaterThan(0);

    // God node pair question
    const pairQ = result.suggestedQuestions.find(
      (q) => q.question.includes("Hub") && q.question.includes("Secondary"),
    );
    expect(pairQ).toBeDefined();
    expect(pairQ!.relatedNodes).toEqual(
      expect.arrayContaining(["project/core/hub.md", "project/core/sec.md"]),
    );

    // Surprising connection question uses filename from path
    const surpriseQ = result.suggestedQuestions.find(
      (q) => q.question.includes("hub.md") && q.question.includes("far.md"),
    );
    expect(surpriseQ).toBeDefined();

    // Centrality question for top god node
    const centralQ = result.suggestedQuestions.find(
      (q) => q.question.includes("Hub") && q.question.includes("central"),
    );
    expect(centralQ).toBeDefined();
  });

  test("questions have non-negative relevance and at least one related node", () => {
    const a = makeNode(1, "Alpha", "x/y/alpha.md", 2, 1);
    const b = makeNode(2, "Beta", "x/y/beta.md", 1, 0);

    const result = analyzeGraph(
      mockStore([a, b], [], new Map([[1, ["x"]], [2, ["x"]]])) as any,
      mockSearch(new Map([[1, 0.7], [2, 0.3]])) as any,
      { questionLimit: 10 },
    );

    for (const q of result.suggestedQuestions) {
      expect(q.relevance).toBeGreaterThanOrEqual(0);
      expect(q.relatedNodes.length).toBeGreaterThan(0);
    }
  });

  // -- Full result ---------------------------------------------------------

  test("returns all sub-results and non-empty summary", () => {
    const a = makeNode(1, "A", "mod-a/grp/a.md", 3, 1);
    const b = makeNode(2, "B", "mod-b/grp/b.md", 1, 1);
    const c = makeNode(3, "C", "mod-a/grp/c.md", 1, 0);

    const edges = [
      makeEdge(1, 1, 2, "wikilink"), // cross-module -- surprising
      makeEdge(2, 1, 3, "wikilink"), // same module -- not surprising
    ];
    const tags = new Map([[1, ["core"]], [2, ["backend"]], [3, ["core"]]]);
    const pr = new Map([[1, 0.6], [2, 0.2], [3, 0.2]]);

    const result = analyzeGraph(
      mockStore([a, b, c], edges, tags) as any,
      mockSearch(pr) as any,
    );

    // All fields present and typed
    expect(Array.isArray(result.godNodes)).toBe(true);
    expect(Array.isArray(result.surprisingConnections)).toBe(true);
    expect(Array.isArray(result.communityHints)).toBe(true);
    expect(Array.isArray(result.suggestedQuestions)).toBe(true);
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);

    // Top god node is A (highest composite score)
    expect(result.godNodes[0].title).toBe("A");
    // Summary references top god node
    expect(result.summary).toContain("A");
    // Summary mentions surprising connection count
    expect(result.summary).toContain("surprising");
  });
});
