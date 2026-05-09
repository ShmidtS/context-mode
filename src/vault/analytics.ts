/**
 * analytics — Graph intelligence layer for the vault graph.
 *
 * Inspired by graphify's analytical pipeline:
 *   - God nodes: most-connected concepts (architectural hubs)
 *   - Surprising connections: cross-module / cross-tag links
 *   - Suggested questions: auto-generated from graph structure
 *   - Community hints: edge-density clustering without external deps
 */

import type { VaultGraphStore } from "./graph-store.js";
import type { VaultGraphSearch } from "./search.js";
import type { VaultNode, VaultEdge } from "../types.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface GodNode {
  id: number;
  title: string;
  path: string;
  inDegree: number;
  outDegree: number;
  pageRank?: number;
  tags: string[];
}

export interface SurprisingConnection {
  sourcePath: string;
  targetPath: string;
  edgeType: string;
  unexpectedness: number;
  sourceTags: string[];
  targetTags: string[];
  context: string | null;
}

export interface CommunityHint {
  id: number;
  representativePath: string;
  nodeCount: number;
  internalEdges: number;
  externalEdges: number;
  avgInternalDensity: number;
  tags: string[];
}

export interface SuggestedQuestion {
  question: string;
  relevance: number;
  relatedNodes: string[];
}

export interface GraphAnalysisResult {
  godNodes: GodNode[];
  surprisingConnections: SurprisingConnection[];
  communityHints: CommunityHint[];
  suggestedQuestions: SuggestedQuestion[];
  summary: string;
}

export interface AnalyzeOpts {
  /** Max god nodes to return. Default 10. */
  godNodeLimit?: number;
  /** Max surprising connections. Default 10. */
  surpriseLimit?: number;
  /** Max community hints. Default 5. */
  communityLimit?: number;
  /** Max suggested questions. Default 5. */
  questionLimit?: number;
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function getNodeTags(store: VaultGraphStore, nodeId: number): string[] {
  try {
    return store.getTagsByNode(nodeId).map((t) => t.tag);
  } catch {
    return [];
  }
}

function tagSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const intersection = b.filter((t) => setA.has(t)).length;
  return intersection / Math.max(a.length, b.length);
}

function pathModulePrefix(path: string): string {
  return path.split("/").slice(0, 2).join("/");
}

// ─────────────────────────────────────────────────────────
// God nodes — top by in_degree + PageRank
// ─────────────────────────────────────────────────────────

function findGodNodes(
  store: VaultGraphStore,
  search: VaultGraphSearch,
  limit: number,
): GodNode[] {
  const allNodeIds = store.getAllNodeIds();
  const pr = search.pageRank();

  const scored: Array<{ node: VaultNode; score: number; pr: number }> = [];
  for (const id of allNodeIds) {
    const node = store.getNodeById(id);
    if (!node) continue;
    const pageRank = pr.get(id) ?? 0;
    // Composite: PageRank (primary) + normalized in_degree
    const inDegScore = node.in_degree / Math.max(1, allNodeIds.length);
    const score = pageRank * 0.7 + inDegScore * 0.3;
    scored.push({ node, score, pr: pageRank });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ node, pr }) => ({
    id: node.id,
    title: node.title,
    path: node.note_path,
    inDegree: node.in_degree,
    outDegree: node.out_degree,
    pageRank: pr,
    tags: getNodeTags(store, node.id),
  }));
}

// ─────────────────────────────────────────────────────────
// Surprising connections — edges between distant communities
// ─────────────────────────────────────────────────────────

function findSurprisingConnections(
  store: VaultGraphStore,
  limit: number,
): SurprisingConnection[] {
  const allEdges = store.getAllEdges();
  const scored: Array<{ edge: VaultEdge; unexpectedness: number; sourceTags: string[]; targetTags: string[] }> = [];

  for (const edge of allEdges) {
    if (!edge.target_id) continue;
    const source = store.getNodeById(edge.source_id);
    const target = store.getNodeById(edge.target_id);
    if (!source || !target) continue;

    const sourceTags = getNodeTags(store, source.id);
    const targetTags = getNodeTags(store, target.id);
    const sim = tagSimilarity(sourceTags, targetTags);
    const pathSim = pathModulePrefix(source.note_path) === pathModulePrefix(target.note_path) ? 1 : 0;

    // Unexpected = low tag similarity AND different path prefix AND not external
    const unexpectedness = (1 - sim) * 0.5 + (1 - pathSim) * 0.5;
    if (unexpectedness < 0.3) continue; // Not surprising enough

    scored.push({
      edge,
      unexpectedness,
      sourceTags,
      targetTags,
    });
  }

  scored.sort((a, b) => b.unexpectedness - a.unexpectedness);

  return scored.slice(0, limit).map(({ edge, unexpectedness, sourceTags, targetTags }) => {
    const source = store.getNodeById(edge.source_id);
    const target = edge.target_id ? store.getNodeById(edge.target_id) : null;
    return {
      sourcePath: source?.note_path ?? "",
      targetPath: target?.note_path ?? "",
      edgeType: edge.edge_type,
      unexpectedness,
      sourceTags,
      targetTags,
      context: edge.context,
    };
  });
}

// ─────────────────────────────────────────────────────────
// Community hints — simple edge-density clustering
// ─────────────────────────────────────────────────────────

function findCommunityHints(
  store: VaultGraphStore,
  limit: number,
): CommunityHint[] {
  const allNodeIds = store.getAllNodeIds();
  const allEdges = store.getAllEdges();

  // Build adjacency + tag groups
  const adj = new Map<number, Set<number>>();
  for (const edge of allEdges) {
    if (!edge.target_id) continue;
    const set = adj.get(edge.source_id);
    if (set) set.add(edge.target_id);
    else adj.set(edge.source_id, new Set([edge.target_id]));
  }

  // Greedy community expansion by tag similarity + edge density
  const visited = new Set<number>();
  const communities: Array<{ nodes: VaultNode[]; edges: number; internal: number; tags: Set<string> }> = [];

  for (const id of allNodeIds) {
    if (visited.has(id)) continue;
    const node = store.getNodeById(id);
    if (!node) continue;

    const community = new Set<number>([id]);
    const frontier = [id];
    let idx = 0;
    while (idx < frontier.length) {
      const current = frontier[idx++];
      const neighbors = adj.get(current);
      if (!neighbors) continue;
      for (const nId of neighbors) {
        if (visited.has(nId)) continue;
        const nNode = store.getNodeById(nId);
        if (!nNode) continue;
        // Accept if shares >=1 tag or same path prefix
        const cNode = store.getNodeById(current);
        const cTags = getNodeTags(store, current);
        const nTags = getNodeTags(store, nId);
        const shareTag = cTags.length === 0 || nTags.length === 0 || tagSimilarity(cTags, nTags) > 0;
        const sharePath = pathModulePrefix(cNode?.note_path ?? "") === pathModulePrefix(nNode.note_path);
        if (shareTag || sharePath) {
          community.add(nId);
          frontier.push(nId);
        }
      }
    }

    for (const cId of community) visited.add(cId);

    const nodes = Array.from(community)
      .map((cid) => store.getNodeById(cid))
      .filter(Boolean) as VaultNode[];

    let internalEdges = 0;
    let externalEdges = 0;
    for (const edge of allEdges) {
      if (!edge.target_id) continue;
      const srcIn = community.has(edge.source_id);
      const tgtIn = community.has(edge.target_id);
      if (srcIn && tgtIn) internalEdges++;
      else if (srcIn || tgtIn) externalEdges++;
    }

    const allTags = new Set<string>();
    for (const n of nodes) {
      for (const t of getNodeTags(store, n.id)) allTags.add(t);
    }

    communities.push({ nodes, edges: internalEdges + externalEdges, internal: internalEdges, tags: allTags });
  }

  // Merge overlapping communities (simplified: skip for now to keep O(n))
  const maxPossible = (nodes: VaultNode[]) => nodes.length * (nodes.length - 1) / 2;
  const ranked = communities
    .filter((c) => c.nodes.length >= 2)
    .map((c, i) => ({
      id: i,
      representativePath: c.nodes[0].note_path,
      nodeCount: c.nodes.length,
      internalEdges: c.internal,
      externalEdges: c.edges - c.internal,
      avgInternalDensity: c.internal / Math.max(1, maxPossible(c.nodes)),
      tags: Array.from(c.tags),
    }))
    .sort((a, b) => b.avgInternalDensity - a.avgInternalDensity);

  return ranked.slice(0, limit);
}

// ─────────────────────────────────────────────────────────
// Suggested questions — from god nodes + surprising links
// ─────────────────────────────────────────────────────────

function generateQuestions(
  godNodes: GodNode[],
  surprising: SurprisingConnection[],
  limit: number,
): SuggestedQuestion[] {
  const questions: SuggestedQuestion[] = [];
  const used = new Set<string>();

  // Questions from god node pairs
  for (let i = 0; i < Math.min(godNodes.length, 3); i++) {
    for (let j = i + 1; j < Math.min(godNodes.length, 4); j++) {
      const a = godNodes[i];
      const b = godNodes[j];
      const q = `How does ${a.title} relate to ${b.title}?`;
      if (!used.has(q)) {
        used.add(q);
        questions.push({ question: q, relevance: (a.pageRank ?? 0) + (b.pageRank ?? 0), relatedNodes: [a.path, b.path] });
      }
    }
  }

  // Questions from surprising connections
  for (const s of surprising.slice(0, 5)) {
    const q = `What connects ${s.sourcePath.split("/").pop() ?? s.sourcePath} to ${s.targetPath.split("/").pop() ?? s.targetPath}?`;
    if (!used.has(q)) {
      used.add(q);
      questions.push({ question: q, relevance: s.unexpectedness, relatedNodes: [s.sourcePath, s.targetPath] });
    }
  }

  // Architecture question
  if (godNodes.length > 0) {
    const top = godNodes[0];
    const q = `Why is ${top.title} the most central concept?`;
    if (!used.has(q)) {
      used.add(q);
      questions.push({ question: q, relevance: top.pageRank ?? top.inDegree, relatedNodes: [top.path] });
    }
  }

  questions.sort((a, b) => b.relevance - a.relevance);
  return questions.slice(0, limit);
}

// ─────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────

export function analyzeGraph(
  store: VaultGraphStore,
  search: VaultGraphSearch,
  opts: AnalyzeOpts = {},
): GraphAnalysisResult {
  const godNodeLimit = opts.godNodeLimit ?? 10;
  const surpriseLimit = opts.surpriseLimit ?? 10;
  const communityLimit = opts.communityLimit ?? 5;
  const questionLimit = opts.questionLimit ?? 5;

  const godNodes = findGodNodes(store, search, godNodeLimit);
  const surprisingConnections = findSurprisingConnections(store, surpriseLimit);
  const communityHints = findCommunityHints(store, communityLimit);
  const suggestedQuestions = generateQuestions(godNodes, surprisingConnections, questionLimit);

  const summary = [
    `Graph analysis: ${godNodes.length} god nodes, ${surprisingConnections.length} surprising connections, ${communityHints.length} community hints.`,
    `Top god node: ${godNodes[0]?.title ?? "none"} (PR=${godNodes[0]?.pageRank?.toFixed(3) ?? "N/A"}).`,
    surprisingConnections.length > 0
      ? `Most surprising: ${surprisingConnections[0].sourcePath.split("/").pop()} → ${surprisingConnections[0].targetPath.split("/").pop()} (unexpectedness=${surprisingConnections[0].unexpectedness.toFixed(2)}).`
      : "No surprising cross-community connections found.",
  ].join(" ");

  return { godNodes, surprisingConnections, communityHints, suggestedQuestions, summary };
}
