/**
 * analytics — Graph intelligence layer for the vault graph.
 *
 * Inspired by graphify's analytical pipeline:
 *   - God nodes: most-connected concepts (architectural hubs)
 *   - Surprising connections: cross-module / cross-tag links
 *   - Suggested questions: auto-generated from graph structure
 *   - Community hints: edge-density clustering without external deps
 *
 * PERFORMANCE: all computations run on an in-memory snapshot built from
 * the store in a single batch (3 SQLite queries). No N+1 per-edge lookups.
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
  /** Human-readable explanation of why this connection is surprising. */
  explanation?: string;
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

export interface TokenEstimate {
  rawTokens: number;
  graphTokens: number;
  reductionRatio: number;
}

export interface GraphAnalysisResult {
  godNodes: GodNode[];
  surprisingConnections: SurprisingConnection[];
  communityHints: CommunityHint[];
  suggestedQuestions: SuggestedQuestion[];
  summary: string;
  /** Human-readable Markdown report (GRAPH_REPORT.md style). */
  markdownReport: string;
  /** Approximate token reduction of querying the graph vs reading raw notes. */
  tokenEstimate?: TokenEstimate;
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

/** Result from surprise score computation for a single node. */
export interface SurpriseScoreResult {
  id: number;
  title: string;
  path: string;
  /** Composite surprise score. */
  surprise: number;
  /** Total degree (in + out). */
  degree: number;
  /** Edges connecting to nodes in different communities (different path prefix + tag set). */
  crossCommunityEdges: number;
  /** Edges connecting nodes of different file types (e.g. .md -> .ts). */
  crossFileTypeEdges: number;
  tags: string[];
}

/** Edge with source/target node info, filtered by confidence. */
export interface ConfidenceFilteredEdge {
  edgeId: number;
  sourcePath: string;
  targetPath: string | null;
  edgeType: string;
  confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  context: string | null;
}

// ─────────────────────────────────────────────────────────
// In-memory snapshot (eliminates N+1 SQLite queries)
// ─────────────────────────────────────────────────────────

interface GraphSnapshot {
  nodes: Map<number, VaultNode>;
  edges: VaultEdge[];
  tags: Map<number, string[]>;
  nodeIds: number[];
}

/**
 * Build an in-memory snapshot from the store.
 *
 * Prefer batch methods (getAllNodes, getNodeTagMap) when available;
 * fall back to getAllNodeIds + per-node lookups for test mocks.
 */
function buildSnapshot(store: VaultGraphStore): GraphSnapshot {
  // Fast path: batch load in 3 queries
  let nodes: VaultNode[];
  let tags: Map<number, string[]>;

  if (typeof (store as any).getAllNodes === "function") {
    nodes = (store as any).getAllNodes();
  } else {
    const ids = store.getAllNodeIds();
    nodes = [];
    for (const id of ids) {
      const n = store.getNodeById(id);
      if (n) nodes.push(n);
    }
  }

  if (typeof (store as any).getNodeTagMap === "function") {
    tags = (store as any).getNodeTagMap();
  } else {
    tags = new Map();
    for (const node of nodes) {
      const t = store.getTagsByNode(node.id);
      tags.set(node.id, t.map((x) => x.tag));
    }
  }

  const edges = store.getAllEdges();
  const nodeMap = new Map<number, VaultNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  return { nodes: nodeMap, edges, tags, nodeIds: nodes.map((n) => n.id) };
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function getNodeTags(snap: GraphSnapshot, nodeId: number): string[] {
  return snap.tags.get(nodeId) ?? [];
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

function getExtension(path: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return "";
  return path.substring(lastDot);
}

// ─────────────────────────────────────────────────────────
// God nodes — top by in_degree + PageRank
// ─────────────────────────────────────────────────────────

function findGodNodes(
  snap: GraphSnapshot,
  search: VaultGraphSearch,
  limit: number,
): GodNode[] {
  const pr = search.pageRank();
  const N = snap.nodeIds.length;

  const scored: Array<{ node: VaultNode; score: number; pr: number }> = [];
  for (const id of snap.nodeIds) {
    const node = snap.nodes.get(id);
    if (!node) continue;
    const pageRank = pr.get(id) ?? 0;
    const inDegScore = node.in_degree / Math.max(1, N);
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
    tags: getNodeTags(snap, node.id),
  }));
}

function explainSurprisingConnection(
  source: VaultNode,
  target: VaultNode,
  sourceTags: string[],
  targetTags: string[],
  unexpectedness: number,
): string {
  const reasons: string[] = [];
  if (sourceTags.length === 0 || targetTags.length === 0 || tagSimilarity(sourceTags, targetTags) === 0) {
    reasons.push("no shared tags");
  }
  if (pathModulePrefix(source.note_path) !== pathModulePrefix(target.note_path)) {
    reasons.push(`cross-module (${pathModulePrefix(source.note_path)} → ${pathModulePrefix(target.note_path)})`);
  }
  if (getExtension(source.note_path) !== getExtension(target.note_path)) {
    reasons.push(`cross-file-type (${getExtension(source.note_path)} → ${getExtension(target.note_path)})`);
  }
  if (reasons.length === 0) reasons.push("low tag similarity");
  return `Unexpected because ${reasons.join(", ")} (score=${unexpectedness.toFixed(2)}).`;
}

// ─────────────────────────────────────────────────────────
// Surprising connections — edges between distant communities
// ─────────────────────────────────────────────────────────

function findSurprisingConnections(
  snap: GraphSnapshot,
  limit: number,
): SurprisingConnection[] {
  const scored: Array<{
    edge: VaultEdge;
    unexpectedness: number;
    sourceTags: string[];
    targetTags: string[];
  }> = [];

  for (const edge of snap.edges) {
    if (!edge.target_id) continue;
    const source = snap.nodes.get(edge.source_id);
    const target = snap.nodes.get(edge.target_id);
    if (!source || !target) continue;

    const sourceTags = getNodeTags(snap, source.id);
    const targetTags = getNodeTags(snap, target.id);
    const sim = tagSimilarity(sourceTags, targetTags);
    const pathSim =
      pathModulePrefix(source.note_path) === pathModulePrefix(target.note_path) ? 1 : 0;

    const unexpectedness = (1 - sim) * 0.5 + (1 - pathSim) * 0.5;
    if (unexpectedness < 0.3) continue;

    scored.push({ edge, unexpectedness, sourceTags, targetTags });
  }

  scored.sort((a, b) => b.unexpectedness - a.unexpectedness);

  return scored.slice(0, limit).map(({ edge, unexpectedness, sourceTags, targetTags }) => {
    const source = snap.nodes.get(edge.source_id);
    const target = edge.target_id ? snap.nodes.get(edge.target_id) : null;
    const explanation = source && target
      ? explainSurprisingConnection(source, target, sourceTags, targetTags, unexpectedness)
      : undefined;
    return {
      sourcePath: source?.note_path ?? "",
      targetPath: target?.note_path ?? "",
      edgeType: edge.edge_type,
      unexpectedness,
      sourceTags,
      targetTags,
      context: edge.context,
      explanation,
    };
  });
}

// ─────────────────────────────────────────────────────────
// Community hints — simple edge-density clustering
// ─────────────────────────────────────────────────────────

function findCommunityHints(
  snap: GraphSnapshot,
  limit: number,
): CommunityHint[] {
  const { nodes, edges, nodeIds } = snap;

  // Build adjacency list once
  const adj = new Map<number, Set<number>>();
  for (const edge of edges) {
    if (!edge.target_id) continue;
    const set = adj.get(edge.source_id);
    if (set) set.add(edge.target_id);
    else adj.set(edge.source_id, new Set([edge.target_id]));
  }

  // Union-Find for fast community grouping by tag/path similarity
  const parent = new Map<number, number>();
  for (const id of nodeIds) parent.set(id, id);

  function find(id: number): number {
    let p = parent.get(id);
    if (p === undefined) return id;
    while (p !== id) {
      const gp = parent.get(p);
      if (gp === undefined) break;
      parent.set(id, gp); // path compression
      id = p;
      p = gp;
    }
    return p;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Union nodes that share a tag or path prefix
  for (const edge of edges) {
    if (!edge.target_id) continue;
    const s = nodes.get(edge.source_id);
    const t = nodes.get(edge.target_id);
    if (!s || !t) continue;

    const sTags = getNodeTags(snap, s.id);
    const tTags = getNodeTags(snap, t.id);
    const shareTag = sTags.length === 0 || tTags.length === 0 || tagSimilarity(sTags, tTags) > 0;
    const sharePath = pathModulePrefix(s.note_path) === pathModulePrefix(t.note_path);

    if (shareTag || sharePath) {
      union(s.id, t.id);
    }
  }

  // Group by root
  const groups = new Map<number, Set<number>>();
  for (const id of nodeIds) {
    const root = find(id);
    const g = groups.get(root);
    if (g) g.add(id);
    else groups.set(root, new Set([id]));
  }

  // Build communities from groups (size >= 2)
  const communities: Array<{
    nodes: VaultNode[];
    internal: number;
    external: number;
    tags: Set<string>;
  }> = [];

  for (const memberIds of groups.values()) {
    if (memberIds.size < 2) continue;
    const memberArray = Array.from(memberIds);
    const commNodes = memberArray
      .map((cid) => nodes.get(cid))
      .filter(Boolean) as VaultNode[];

    // Count internal/external edges in one pass
    let internalEdges = 0;
    let externalEdges = 0;
    for (const edge of edges) {
      if (!edge.target_id) continue;
      const srcIn = memberIds.has(edge.source_id);
      const tgtIn = memberIds.has(edge.target_id);
      if (srcIn && tgtIn) internalEdges++;
      else if (srcIn || tgtIn) externalEdges++;
    }

    const allTags = new Set<string>();
    for (const n of commNodes) {
      for (const t of getNodeTags(snap, n.id)) allTags.add(t);
    }

    communities.push({
      nodes: commNodes,
      internal: internalEdges,
      external: externalEdges,
      tags: allTags,
    });
  }

  const maxPossible = (ns: VaultNode[]) => (ns.length * (ns.length - 1)) / 2;
  const ranked = communities
    .map((c, i) => ({
      id: i,
      representativePath: c.nodes[0]?.note_path ?? "",
      nodeCount: c.nodes.length,
      internalEdges: c.internal,
      externalEdges: c.external,
      avgInternalDensity: c.internal / Math.max(1, maxPossible(c.nodes)),
      tags: Array.from(c.tags),
    }))
    .sort((a, b) => b.avgInternalDensity - a.avgInternalDensity);

  return ranked.slice(0, limit);
}

// ─────────────────────────────────────────────────────────
// Markdown report (GRAPH_REPORT.md style) inspired by graphify
// ─────────────────────────────────────────────────────────

function generateMarkdownReport(
  result: Pick<GraphAnalysisResult, "godNodes" | "surprisingConnections" | "communityHints" | "suggestedQuestions" | "summary">,
  nodeCount: number,
  edgeCount: number,
): string {
  const lines: string[] = [];
  lines.push("# Graph Analysis Report");
  lines.push("");
  lines.push(`- **Nodes:** ${nodeCount} | **Edges:** ${edgeCount}`);
  lines.push("");

  if (result.godNodes.length > 0) {
    lines.push("## God Nodes (Architectural Hubs)");
    lines.push("");
    for (const n of result.godNodes.slice(0, 5)) {
      lines.push(`- **${n.title}** (${n.path}) — PR=${n.pageRank?.toFixed(3) ?? "N/A"}, in=${n.inDegree}, out=${n.outDegree}`);
    }
    lines.push("");
  }

  if (result.surprisingConnections.length > 0) {
    lines.push("## Surprising Connections");
    lines.push("");
    for (const s of result.surprisingConnections.slice(0, 5)) {
      lines.push(`- \`${s.sourcePath}\` → \`${s.targetPath}\` (${s.edgeType}) — unexpectedness=${s.unexpectedness.toFixed(2)}`);
      if (s.explanation) lines.push(`  - *Why:* ${s.explanation}`);
    }
    lines.push("");
  }

  if (result.communityHints.length > 0) {
    lines.push("## Community Hints");
    lines.push("");
    for (const c of result.communityHints) {
      lines.push(`- **${c.representativePath}** — ${c.nodeCount} nodes, density=${c.avgInternalDensity.toFixed(2)}`);
    }
    lines.push("");
  }

  if (result.suggestedQuestions.length > 0) {
    lines.push("## Suggested Questions");
    lines.push("");
    for (const q of result.suggestedQuestions) {
      lines.push(`- ${q.question}`);
    }
    lines.push("");
  }

  lines.push("## Summary");
  lines.push("");
  lines.push(result.summary);
  lines.push("");

  return lines.join("\n");
}

function computeTokenEstimate(
  nodeCount: number,
  result: Pick<GraphAnalysisResult, "godNodes" | "surprisingConnections" | "communityHints" | "suggestedQuestions">,
): TokenEstimate {
  const avgNoteTokens = 400;
  const rawTokens = nodeCount * avgNoteTokens;
  const graphTokens =
    200 +
    result.godNodes.length * 50 +
    result.surprisingConnections.length * 30 +
    result.communityHints.length * 40 +
    result.suggestedQuestions.length * 20;
  const reductionRatio = rawTokens / Math.max(1, graphTokens);
  return {
    rawTokens,
    graphTokens,
    reductionRatio: Math.round(reductionRatio * 10) / 10,
  };
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
        questions.push({
          question: q,
          relevance: (a.pageRank ?? 0) + (b.pageRank ?? 0),
          relatedNodes: [a.path, b.path],
        });
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
  const snap = buildSnapshot(store);

  const godNodeLimit = opts.godNodeLimit ?? 10;
  const surpriseLimit = opts.surpriseLimit ?? 10;
  const communityLimit = opts.communityLimit ?? 5;
  const questionLimit = opts.questionLimit ?? 5;

  const godNodes = findGodNodes(snap, search, godNodeLimit);
  const surprisingConnections = findSurprisingConnections(snap, surpriseLimit);
  const communityHints = findCommunityHints(snap, communityLimit);
  const suggestedQuestions = generateQuestions(godNodes, surprisingConnections, questionLimit);

  const summary = [
    `Graph analysis: ${godNodes.length} god nodes, ${surprisingConnections.length} surprising connections, ${communityHints.length} community hints.`,
    `Top god node: ${godNodes[0]?.title ?? "none"} (PR=${godNodes[0]?.pageRank?.toFixed(3) ?? "N/A"}).`,
    surprisingConnections.length > 0
      ? `Most surprising: ${surprisingConnections[0].sourcePath.split("/").pop()} → ${surprisingConnections[0].targetPath.split("/").pop()} (unexpectedness=${surprisingConnections[0].unexpectedness.toFixed(2)}).`
      : "No surprising cross-community connections found.",
  ].join(" ");

  const result: GraphAnalysisResult = {
    godNodes,
    surprisingConnections,
    communityHints,
    suggestedQuestions,
    summary,
    markdownReport: "",
  };

  result.markdownReport = generateMarkdownReport(result, snap.nodeIds.length, snap.edges.length);
  result.tokenEstimate = computeTokenEstimate(snap.nodeIds.length, result);

  return result;
}

// ─────────────────────────────────────────────────────────
// Surprise score — composite metric for node importance
// ─────────────────────────────────────────────────────────

/**
 * Compute surprise scores for all nodes in the graph.
 *
 * Formula: surprise = degree * 0.3 + crossCommunityEdges * 0.4 + crossFileTypeEdges * 0.3
 *
 * - degree: total in + out degree (centrality)
 * - crossCommunityEdges: edges where source and target have different path-module prefixes
 *   and zero tag overlap
 * - crossFileTypeEdges: edges where source and target have different file extensions
 *
 * Higher score = more "surprising" or important node.
 */
export function computeSurpriseScores(
  store: VaultGraphStore,
  limit: number = 20,
): SurpriseScoreResult[] {
  const snap = buildSnapshot(store);

  // Pre-compute node metadata
  const nodeData = new Map<
    number,
    {
      degree: number;
      crossCommunity: number;
      crossFileType: number;
      tags: string[];
    }
  >();

  for (const id of snap.nodeIds) {
    nodeData.set(id, { degree: 0, crossCommunity: 0, crossFileType: 0, tags: getNodeTags(snap, id) });
  }

  for (const edge of snap.edges) {
    if (edge.target_id === null) continue;

    const src = nodeData.get(edge.source_id);
    const tgt = nodeData.get(edge.target_id);
    if (src) src.degree++;
    if (tgt) tgt.degree++;

    const sourceNode = snap.nodes.get(edge.source_id);
    const targetNode = snap.nodes.get(edge.target_id);
    if (sourceNode && targetNode) {
      const srcPrefix = pathModulePrefix(sourceNode.note_path);
      const tgtPrefix = pathModulePrefix(targetNode.note_path);
      const srcTags = nodeData.get(edge.source_id)?.tags ?? [];
      const tgtTags = nodeData.get(edge.target_id)?.tags ?? [];
      const tagsOverlap = tagSimilarity(srcTags, tgtTags) > 0;

      if (srcPrefix !== tgtPrefix && !tagsOverlap) {
        if (src) src.crossCommunity++;
        if (tgt) tgt.crossCommunity++;
      }

      const srcExt = getExtension(sourceNode.note_path);
      const tgtExt = getExtension(targetNode.note_path);
      if (srcExt !== tgtExt) {
        if (src) src.crossFileType++;
        if (tgt) tgt.crossFileType++;
      }
    }
  }

  const results: SurpriseScoreResult[] = [];
  for (const id of snap.nodeIds) {
    const data = nodeData.get(id);
    if (!data) continue;
    const node = snap.nodes.get(id);
    if (!node) continue;

    const surprise = data.degree * 0.3 + data.crossCommunity * 0.4 + data.crossFileType * 0.3;
    results.push({
      id,
      title: node.title,
      path: node.note_path,
      surprise,
      degree: data.degree,
      crossCommunityEdges: data.crossCommunity,
      crossFileTypeEdges: data.crossFileType,
      tags: data.tags,
    });
  }

  results.sort((a, b) => b.surprise - a.surprise);
  return results.slice(0, limit);
}

/**
 * Filter edges by confidence threshold, returning edges with context.
 *
 * Confidence mapping: EXTRACTED=1.0, INFERRED=0.7, AMBIGUOUS=0.5.
 * Only edges with confidence >= minConfidence are returned.
 */
export function filterEdgesByConfidence(
  store: VaultGraphStore,
  minConfidence: number = 0.0,
): ConfidenceFilteredEdge[] {
  const snap = buildSnapshot(store);
  const confidenceValue: Record<string, number> = {
    EXTRACTED: 1.0,
    INFERRED: 0.7,
    AMBIGUOUS: 0.5,
  };

  const results: ConfidenceFilteredEdge[] = [];

  for (const edge of snap.edges) {
    const value = confidenceValue[edge.confidence] ?? 1.0;
    if (value < minConfidence) continue;

    const source = snap.nodes.get(edge.source_id);
    const target = edge.target_id ? snap.nodes.get(edge.target_id) : null;

    results.push({
      edgeId: edge.id,
      sourcePath: source?.note_path ?? "",
      targetPath: target?.note_path ?? null,
      edgeType: edge.edge_type,
      confidence: edge.confidence,
      context: edge.context,
    });
  }

  return results;
}
