/**
 * VaultGraphSearch — Graph-aware search over vault nodes.
 *
 * Provides BFS traversal, backlink queries, tag-cluster expansion,
 * and BM25+graph reciprocal rank fusion. Uses in_degree (not PageRank)
 * as the authority signal in v1.
 *
 * Design: bounded BFS (maxHops <= 3), in-memory edge loading for
 * sub-100ms query times on 1000-node vaults.
 */

import type { VaultGraphStore } from "./graph-store.js";
import type { SearchResult } from "../store.js";
import type { GraphSearchResult } from "../types.js";

const DEBUG = process.env.DEBUG?.includes("context-mode");

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface FusionSearchOpts {
  /** Weight for graph neighbor contribution. Default 0.3. */
  graphBoost?: number;
  /** Max BFS hops from top text results. Default 2, max 3. */
  maxHops?: number;
}

/** Internal node for BFS frontier. */
interface BFSNode {
  id: number;
  hopDistance: number;
}

// ─────────────────────────────────────────────────────────
// VaultGraphSearch
// ─────────────────────────────────────────────────────────

export class VaultGraphSearch {
  #store: VaultGraphStore;
  #cachedPageRank: Map<number, number> | null = null;

  constructor(store: VaultGraphStore) {
    this.#store = store;
  }

  // ── PageRank ──

  /**
   * Compute iterative PageRank over all vault nodes.
   * 20 iterations with damping factor 0.85.
   * Returns Map<nodeId, pageRankValue>.
   * Cached: invalidated on re-index via invalidateCache().
   */
  pageRank(): Map<number, number> {
    if (this.#cachedPageRank) return this.#cachedPageRank;

    const edges = this.#store.getAllEdges();
    const damping = 0.85;
    const iterations = 20;

    // Collect all node IDs
    const nodeIds = new Set<number>();
    for (const edge of edges) {
      if (edge.source_id !== null) nodeIds.add(edge.source_id);
      if (edge.target_id !== null) nodeIds.add(edge.target_id);
    }
    // Also add nodes with no edges
    const allNodeIds = this.#store.getAllNodeIds();
    for (const id of allNodeIds) nodeIds.add(id);

    const N = nodeIds.size;
    if (N === 0) {
      this.#cachedPageRank = new Map();
      return this.#cachedPageRank;
    }

    // Build out-degree (source -> count of outgoing edges)
    const outDegree = new Map<number, number>();
    // Build reverse adjacency (target -> sources that link to it) — O(E) once
    const reverseAdj = new Map<number, number[]>();

    for (const edge of edges) {
      if (edge.target_id === null) continue;
      outDegree.set(edge.source_id, (outDegree.get(edge.source_id) ?? 0) + 1);
      const list = reverseAdj.get(edge.target_id);
      if (list) {
        list.push(edge.source_id);
      } else {
        reverseAdj.set(edge.target_id, [edge.source_id]);
      }
    }

    // Initialize: uniform 1/N
    const rank = new Map<number, number>();
    for (const id of nodeIds) {
      rank.set(id, 1 / N);
    }

    // Iterative PageRank — each iteration O(V+E) via reverse adjacency
    for (let iter = 0; iter < iterations; iter++) {
      const newRank = new Map<number, number>();
      // Dangling node contribution (nodes with out-degree 0)
      let danglingSum = 0;
      for (const id of nodeIds) {
        if ((outDegree.get(id) ?? 0) === 0) {
          danglingSum += rank.get(id) ?? 0;
        }
      }

      for (const id of nodeIds) {
        let sum = danglingSum / N;
        // In-links: look up reverse adjacency directly — O(in_degree) per node
        const sources = reverseAdj.get(id);
        if (sources) {
          for (const srcId of sources) {
            const srcOutDeg = outDegree.get(srcId) ?? 1;
            sum += (rank.get(srcId) ?? 0) / srcOutDeg;
          }
        }
        newRank.set(id, (1 - damping) / N + damping * sum);
      }

      // Swap
      for (const [id, val] of newRank) {
        rank.set(id, val);
      }
    }

    this.#cachedPageRank = rank;
    return rank;
  }

  /**
   * Invalidate cached PageRank result.
   * Call after re-indexing changes the graph structure.
   */
  invalidateCache(): void {
    this.#cachedPageRank = null;
  }

  // ── BFS Traversal ──

  /**
   * BFS from nodeId up to maxHops. Returns reachable nodes with hopDistance.
   * Bounded: maxHops clamped to 3 for performance.
   * Optional edgeType filter (e.g. "wikilink").
   */
  neighbors(
    nodeId: number,
    maxHops: number = 1,
    edgeType?: string,
  ): GraphSearchResult[] {
    const hops = Math.min(maxHops, 3);
    const visited = new Set<number>([nodeId]);
    const frontier: BFSNode[] = [{ id: nodeId, hopDistance: 0 }];
    const results: GraphSearchResult[] = [];

    // Load all edges into memory for BFS traversal (fast for 1000-node vaults)
    const edges = this.#store.getAllEdges();
    const adjacency = this.#buildAdjacency(edges, edgeType);

    let idx = 0;
    while (idx < frontier.length) {
      const current = frontier[idx++];
      if (current.hopDistance >= hops) continue;

      const neighbors = adjacency.get(current.id) ?? [];
      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const node = this.#store.getNodeById(neighborId);
        if (!node) continue;

        const hopDistance = current.hopDistance + 1;
        frontier.push({ id: neighborId, hopDistance });

        results.push({
          id: node.id,
          title: node.title,
          path: node.note_path,
          hopDistance,
          backlinkCount: node.in_degree,
          tags: this.#getTagNames(node.id),
          frontmatter: this.#parseFrontmatter(node.frontmatter),
          matchLayer: "bfs",
          origin: "vault-graph",
        });
      }
    }

    return results;
  }

  // ── Backlinks ──

  /**
   * Return all nodes that link TO nodeId (in-degree neighbors).
   * Optional edgeType filter.
   */
  backlinks(nodeId: number, edgeType?: string): GraphSearchResult[] {
    const edges = this.#store.getEdgesByTarget(nodeId);
    const results: GraphSearchResult[] = [];
    const seen = new Set<number>();

    for (const edge of edges) {
      if (edgeType && edge.edge_type !== edgeType) continue;
      if (seen.has(edge.source_id)) continue;
      seen.add(edge.source_id);

      const node = this.#store.getNodeById(edge.source_id);
      if (!node) continue;

      results.push({
        id: node.id,
        title: node.title,
        path: node.note_path,
        hopDistance: 1,
        backlinkCount: node.in_degree,
        tags: this.#getTagNames(node.id),
        frontmatter: this.#parseFrontmatter(node.frontmatter),
        snippet: edge.context ?? undefined,
        matchLayer: "backlinks",
        origin: "vault-graph",
      });
    }

    return results;
  }

  // ── Tag Cluster ──

  /**
   * Return all nodes with the given tag, plus any nodes linked to those
   * nodes within 1 hop.
   */
  tagCluster(tag: string): GraphSearchResult[] {
    // Match exact tag AND hierarchical children (e.g. "parent" matches "parent/child")
    const taggedNodes = this.#store.getNodesByTagHierarchy(tag);
    const results: GraphSearchResult[] = [];
    const seen = new Set<number>();

    // Add all directly-tagged nodes
    for (const node of taggedNodes) {
      seen.add(node.id);
      results.push({
        id: node.id,
        title: node.title,
        path: node.note_path,
        hopDistance: 0,
        backlinkCount: node.in_degree,
        tags: this.#getTagNames(node.id),
        frontmatter: this.#parseFrontmatter(node.frontmatter),
        matchLayer: "tag-cluster",
        origin: "vault-graph",
      });
    }

    // Expand 1 hop from each tagged node
    const edges = this.#store.getAllEdges();
    const adjacency = this.#buildAdjacency(edges);

    for (const node of taggedNodes) {
      const neighbors = adjacency.get(node.id) ?? [];
      for (const neighborId of neighbors) {
        if (seen.has(neighborId)) continue;
        seen.add(neighborId);

        const neighbor = this.#store.getNodeById(neighborId);
        if (!neighbor) continue;

        results.push({
          id: neighbor.id,
          title: neighbor.title,
          path: neighbor.note_path,
          hopDistance: 1,
          backlinkCount: neighbor.in_degree,
          tags: this.#getTagNames(neighbor.id),
          frontmatter: this.#parseFrontmatter(neighbor.frontmatter),
          matchLayer: "tag-cluster",
          origin: "vault-graph",
        });
      }
    }

    return results;
  }

  // ── BM25 + Graph Fusion ──

  /**
   * Takes existing BM25 text search results (from ContentStore), boosts nodes
   * that are graph neighbors of top text results using RRF-style fusion.
   *
   * Formula:
   *   For each text result with rank R: score = 1 / (60 + R)   (standard RRF)
   *   For each neighbor within maxHops of any top-5 text result:
   *     score += graphBoost * (1 / (60 + hopDistance))
   *   Sort by fusionScore descending; use in_degree as tiebreaker
   */
  fusionSearch(
    query: string,
    textResults: SearchResult[],
    opts?: FusionSearchOpts,
  ): GraphSearchResult[] {
    const graphBoost = opts?.graphBoost ?? 2.0;
    const maxHops = Math.min(opts?.maxHops ?? 2, 3);
    const K = 60; // Standard RRF constant

    // Map: nodeId -> accumulated fusion score
    const scoreMap = new Map<number, { score: number; textRank?: number; hopDistance?: number }>();

    // Step 1: Score text results that match vault nodes
    const topResults = textResults.slice(0, 5);
    const seedNodeIds: number[] = [];

    for (const [rank, result] of topResults.entries()) {
      const node = this.#findNodeByTextResult(result);
      if (!node) continue;

      seedNodeIds.push(node.id);
      const textScore = 1 / (K + rank);
      const existing = scoreMap.get(node.id);
      if (existing) {
        existing.score += textScore;
        existing.textRank = rank;
      } else {
        scoreMap.set(node.id, { score: textScore, textRank: rank, hopDistance: 0 });
      }
    }

    // Step 1b: Fallback — if no text results matched vault nodes, search vault directly by query
    if (seedNodeIds.length === 0) {
      const directNodes = this.#store.searchNodes(query);
      for (const node of directNodes) {
        if (seedNodeIds.includes(node.id)) continue;
        seedNodeIds.push(node.id);
        scoreMap.set(node.id, { score: 1.0, hopDistance: 0 });
      }
    }

    // Step 2: BFS from seed nodes, accumulate graph-boosted scores
    if (seedNodeIds.length > 0) {
      const edges = this.#store.getAllEdges();
      const adjacency = this.#buildAdjacency(edges);

      const visited = new Set<number>(seedNodeIds);
      const frontier: BFSNode[] = seedNodeIds.map((id) => ({ id, hopDistance: 0 }));

      let idx = 0;
      while (idx < frontier.length) {
        const current = frontier[idx++];
        if (current.hopDistance >= maxHops) continue;

        const neighbors = adjacency.get(current.id) ?? [];
        for (const neighborId of neighbors) {
          if (visited.has(neighborId)) continue;
          visited.add(neighborId);

          const hopDistance = current.hopDistance + 1;
          frontier.push({ id: neighborId, hopDistance });

          const graphScore = graphBoost * (1 / (K + hopDistance));
          const existing = scoreMap.get(neighborId);
          if (existing) {
            existing.score += graphScore;
            if (existing.hopDistance === undefined || hopDistance < existing.hopDistance) {
              existing.hopDistance = hopDistance;
            }
          } else {
            scoreMap.set(neighborId, { score: graphScore, hopDistance });
          }
        }
      }
    }

    // Step 3: Build results sorted by fusionScore descending, in_degree then PageRank as tiebreaker
    const prMap = this.pageRank();
    const entries = Array.from(scoreMap.entries());
    entries.sort((a, b) => {
      const scoreDiff = b[1].score - a[1].score;
      if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
      // Tiebreaker 1: higher in_degree = more authoritative
      const nodeA = this.#store.getNodeById(a[0]);
      const nodeB = this.#store.getNodeById(b[0]);
      const inDegDiff = (nodeB?.in_degree ?? 0) - (nodeA?.in_degree ?? 0);
      if (inDegDiff !== 0) return inDegDiff;
      // Tiebreaker 2: higher PageRank = more authoritative
      return (prMap.get(b[0]) ?? 0) - (prMap.get(a[0]) ?? 0);
    });

    return entries.map(([nodeId, data]) => {
      const node = this.#store.getNodeById(nodeId);
      if (!node) {
        // Should not happen, but be safe
        return {
          id: nodeId,
          title: "(unknown)",
          path: "",
          fusionScore: data.score,
          matchLayer: "rrf-graph" as const,
          origin: "vault-graph" as const,
        };
      }
      return {
        id: node.id,
        title: node.title,
        path: node.note_path,
        hopDistance: data.hopDistance,
        textRank: data.textRank,
        fusionScore: data.score,
        pageRank: prMap.get(nodeId),
        backlinkCount: node.in_degree,
        tags: this.#getTagNames(node.id),
        frontmatter: this.#parseFrontmatter(node.frontmatter),
        matchLayer: "rrf-graph" as const,
        origin: "vault-graph" as const,
      };
    });
  }

  // ── Private helpers ──

  /**
   * Build adjacency list from edge list.
   * Directed: source_id -> target_id.
   * Optional edgeType filter.
   */
  #buildAdjacency(
    edges: Array<{ source_id: number; target_id: number | null; edge_type: string }>,
    edgeType?: string,
  ): Map<number, number[]> {
    const adj = new Map<number, number[]>();
    for (const edge of edges) {
      if (edgeType && edge.edge_type !== edgeType) continue;
      if (edge.target_id === null) continue;

      const list = adj.get(edge.source_id);
      if (list) {
        list.push(edge.target_id);
      } else {
        adj.set(edge.source_id, [edge.target_id]);
      }
    }
    return adj;
  }

  /**
   * Try to find a vault node matching a ContentStore SearchResult.
   * Match by source label -> note_path, then title.
   */
  #findNodeByTextResult(result: SearchResult): { id: number; in_degree: number } | null {
    // Try matching by source label to note_path
    const byPath = this.#store.getNodeByNotePath(result.source);
    if (byPath) return { id: byPath.id, in_degree: byPath.in_degree };

    // Try matching by title
    const byTitle = this.#store.getNodeByTitle(result.title);
    if (byTitle) return { id: byTitle.id, in_degree: byTitle.in_degree };

    // Try matching by title substring in note_path
    try {
      const row = this.#store.findNodeByTitleLike(`%${result.title}%`);
      if (row) return { id: row.id, in_degree: row.in_degree };
    } catch (e) {
      if (DEBUG) process.stderr.write(`[ctx] vault node path match failed: ${e}\n`);
    }

    return null;
  }

  /** Get tag names for a node. */
  #getTagNames(nodeId: number): string[] {
    const tags = this.#store.getTagsByNode(nodeId);
    return tags.map((t) => t.tag);
  }

  /** Parse frontmatter JSON string to Record, or return null. */
  #parseFrontmatter(fm: string | null): Record<string, string> | undefined {
    if (!fm) return undefined;
    try {
      const parsed = JSON.parse(fm);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        // Ensure all values are strings
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          result[k] = String(v);
        }
        return result;
      }
    } catch (err) {
      console.warn("String failed", err);
    }
    return undefined;
  }
}
