/**
 * visualize — DOT/Mermaid/HTML graph rendering for vault dependencies.
 *
 * Queries vault_edges from VaultGraphStore and generates graph
 * visualizations in Graphviz DOT, Mermaid flowchart, or standalone
 * HTML with D3.js force-directed layout.
 */

import type { VaultGraphStore } from '../vault/graph-store.js'

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface VisualizeOptions {
  edgeTypes?: string[]
  maxNodes?: number
  clusterByDir?: boolean
}

/** Edge color map by type. */
const EDGE_COLORS: Record<string, string> = {
  import: '#4a90d9',
  calls: '#5cb85c',
  inherits: '#9b59b6',
  implements: '#9b59b6',
  'type-ref': '#e67e22',
  type_ref: '#e67e22',
  decorates: '#e74c3c',
  wikilink: '#95a5a6',
}

// ─────────────────────────────────────────────────────────
// GraphVisualizer
// ─────────────────────────────────────────────────────────

export class GraphVisualizer {
  #store: VaultGraphStore

  constructor(store: VaultGraphStore) {
    this.#store = store
  }

  // ── DOT format ──

  toDOT(vaultPath: string, options?: VisualizeOptions): string {
    const { edges, nodes } = this.#loadGraph(vaultPath, options)
    if (nodes.size === 0) return 'digraph Dependencies {}'

    const maxNodes = options?.maxNodes ?? 200
    const clusterByDir = options?.clusterByDir ?? false
    const lines: string[] = ['digraph Dependencies {', '  rankdir=LR;', '  node [shape=box, style=rounded];']

    // Limit nodes
    const limitedNodes = this.#limitNodes(nodes, maxNodes)

    if (clusterByDir) {
      // Group nodes by directory
      const dirs = new Map<string, string[]>()
      for (const [path] of limitedNodes) {
        const dir = path.substring(0, path.lastIndexOf('/')) || '(root)'
        const list = dirs.get(dir)
        if (list) {
          list.push(path)
        } else {
          dirs.set(dir, [path])
        }
      }
      for (const [dir, paths] of dirs) {
        const clusterId = this.#sanitizeId(dir.replace(/[^a-zA-Z0-9]/g, '_'))
        lines.push(`  subgraph cluster_${clusterId} {`)
        lines.push(`    label="${this.#escapeDot(dir)}";`)
        for (const path of paths) {
          const label = path.split('/').pop() ?? path
          lines.push(`    "${this.#escapeDot(path)}" [label="${this.#escapeDot(label)}"];`)
        }
        lines.push('  }')
      }
    } else {
      for (const [path] of limitedNodes) {
        const label = path.split('/').pop() ?? path
        lines.push(`  "${this.#escapeDot(path)}" [label="${this.#escapeDot(label)}"];`)
      }
    }

    // Add edges
    for (const edge of edges) {
      if (!limitedNodes.has(edge.sourcePath) || !limitedNodes.has(edge.targetPath)) continue
      const color = EDGE_COLORS[edge.edgeType] ?? '#666'
      lines.push(
        `  "${this.#escapeDot(edge.sourcePath)}" -> "${this.#escapeDot(edge.targetPath)}" [label="${edge.edgeType}" color="${color}"];`
      )
    }

    lines.push('}')
    return lines.join('\n')
  }

  // ── Mermaid format ──

  toMermaid(vaultPath: string, options?: VisualizeOptions): string {
    const { edges, nodes } = this.#loadGraph(vaultPath, options)
    if (nodes.size === 0) return 'flowchart LR'

    const maxNodes = options?.maxNodes ?? 200
    const limitedNodes = this.#limitNodes(nodes, maxNodes)
    const lines: string[] = ['flowchart LR']

    // Add edges (Mermaid infers nodes from edges)
    const seenEdges = new Set<string>()
    for (const edge of edges) {
      if (!limitedNodes.has(edge.sourcePath) || !limitedNodes.has(edge.targetPath)) continue
      const key = `${edge.sourcePath}|${edge.targetPath}|${edge.edgeType}`
      if (seenEdges.has(key)) continue
      seenEdges.add(key)

      const srcId = this.#sanitizeId(edge.sourcePath)
      const tgtId = this.#sanitizeId(edge.targetPath)
      const srcLabel = edge.sourcePath.split('/').pop() ?? edge.sourcePath
      const tgtLabel = edge.targetPath.split('/').pop() ?? edge.targetPath

      lines.push(
        `  ${srcId}["${srcLabel}"] -->|${edge.edgeType}| ${tgtId}["${tgtLabel}"]`
      )
    }

    // Add isolated nodes (no edges)
    const nodesInEdges = new Set<string>()
    for (const edge of edges) {
      nodesInEdges.add(edge.sourcePath)
      nodesInEdges.add(edge.targetPath)
    }
    for (const [path] of limitedNodes) {
      if (!nodesInEdges.has(path)) {
        const nodeId = this.#sanitizeId(path)
        const label = path.split('/').pop() ?? path
        lines.push(`  ${nodeId}["${label}"]`)
      }
    }

    return lines.join('\n')
  }

  // ── HTML format ──

  toHTML(vaultPath: string, options?: VisualizeOptions): string {
    const { edges, nodes } = this.#loadGraph(vaultPath, options)
    const maxNodes = options?.maxNodes ?? 200
    const limitedNodes = this.#limitNodes(nodes, maxNodes)

    // Build JSON data for D3
    const nodeArray: Array<{ id: string; label: string; path: string }> = []
    const nodeIndex = new Map<string, number>()
    let idx = 0
    for (const [path] of limitedNodes) {
      const label = path.split('/').pop() ?? path
      nodeArray.push({ id: String(idx), label, path })
      nodeIndex.set(path, idx)
      idx++
    }

    const edgeArray: Array<{ source: number; target: number; label: string; color: string }> = []
    const seenEdges = new Set<string>()
    for (const edge of edges) {
      if (!nodeIndex.has(edge.sourcePath) || !nodeIndex.has(edge.targetPath)) continue
      const key = `${edge.sourcePath}|${edge.targetPath}|${edge.edgeType}`
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      const srcIdx = nodeIndex.get(edge.sourcePath)!
      const tgtIdx = nodeIndex.get(edge.targetPath)!
      const color = EDGE_COLORS[edge.edgeType] ?? '#666'
      edgeArray.push({ source: srcIdx, target: tgtIdx, label: edge.edgeType, color })
    }

    const nodesJson = JSON.stringify(nodeArray)
    const edgesJson = JSON.stringify(edgeArray)

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Dependency Graph</title>
<style>
  body { margin: 0; font-family: sans-serif; overflow: hidden; background: #1a1a2e; }
  svg { width: 100vw; height: 100vh; }
  .node circle { stroke: #fff; stroke-width: 1.5px; }
  .node text { fill: #eee; font-size: 11px; pointer-events: none; }
  .link { stroke-opacity: 0.6; stroke-width: 1.5px; fill: none; }
  .link-label { fill: #aaa; font-size: 9px; pointer-events: none; }
  .legend { position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.7); padding: 12px; border-radius: 8px; color: #eee; font-size: 12px; }
  .legend-item { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
  .legend-dot { width: 12px; height: 3px; border-radius: 2px; }
</style>
</head>
<body>
<div class="legend">
  <strong>Edge Types</strong>
  ${Object.entries(EDGE_COLORS).map(([type, color]) =>
    `<div class="legend-item"><div class="legend-dot" style="background:${color}"></div>${type}</div>`
  ).join('\n  ')}
</div>
<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const nodes = ${nodesJson};
const links = ${edgesJson};

const svg = d3.select("svg");
const width = window.innerWidth;
const height = window.innerHeight;

svg.attr("viewBox", [0, 0, width, height]);

const simulation = d3.forceSimulation(nodes)
  .force("link", d3.forceLink(links).id(d => d.id).distance(80))
  .force("charge", d3.forceManyBody().strength(-200))
  .force("center", d3.forceCenter(width / 2, height / 2))
  .force("collision", d3.forceCollide().radius(20));

const link = svg.append("g")
  .selectAll("line")
  .data(links)
  .join("line")
  .attr("class", "link")
  .attr("stroke", d => d.color);

const linkLabel = svg.append("g")
  .selectAll("text")
  .data(links)
  .join("text")
  .attr("class", "link-label")
  .text(d => d.label);

const node = svg.append("g")
  .selectAll("g")
  .data(nodes)
  .join("g")
  .attr("class", "node")
  .call(d3.drag()
    .on("start", dragstarted)
    .on("drag", dragged)
    .on("end", dragended));

node.append("circle")
  .attr("r", 8)
  .attr("fill", "#4a90d9");

node.append("text")
  .attr("dx", 12)
  .attr("dy", 4)
  .text(d => d.label);

node.append("title")
  .text(d => d.path);

simulation.on("tick", () => {
  link
    .attr("x1", d => d.source.x)
    .attr("y1", d => d.source.y)
    .attr("x2", d => d.target.x)
    .attr("y2", d => d.target.y);
  linkLabel
    .attr("x", d => (d.source.x + d.target.x) / 2)
    .attr("y", d => (d.source.y + d.target.y) / 2);
  node.attr("transform", d => \`translate(\${d.x},\${d.y})\`);
});

const zoom = d3.zoom()
  .scaleExtent([0.1, 4])
  .on("zoom", (event) => {
    svg.select("g").attr("transform", event.transform);
  });
svg.call(zoom);

function dragstarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x; d.fy = d.y;
}
function dragged(event, d) {
  d.fx = event.x; d.fy = event.y;
}
function dragended(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null; d.fy = null;
}
</script>
</body>
</html>`
  }

  // ── Private helpers ──

  /** Load edges and nodes from the graph store for a vault path. */
  #loadGraph(vaultPath: string, options?: VisualizeOptions): {
    edges: Array<{ sourcePath: string; targetPath: string; edgeType: string }>
    nodes: Map<string, number>
  } {
    const edgeTypes = options?.edgeTypes
    const allEdges = this.#store.getAllEdges()

    // Collect nodes for this vault
    const nodes = new Map<string, number>() // path -> id
    const nodeIdToPath = new Map<number, string>() // id -> path
    const vaultNodeRows = this.#store.getNodeIdAndPathByVaultPath(vaultPath)

    for (const row of vaultNodeRows) {
      nodes.set(row.note_path, row.id)
      nodeIdToPath.set(row.id, row.note_path)
    }

    // Filter edges to those within this vault
    const edges: Array<{ sourcePath: string; targetPath: string; edgeType: string }> = []
    for (const edge of allEdges) {
      if (edge.target_id === null) continue
      if (edgeTypes && !edgeTypes.includes(edge.edge_type)) continue
      const sourcePath = nodeIdToPath.get(edge.source_id)
      const targetPath = nodeIdToPath.get(edge.target_id)
      if (!sourcePath || !targetPath) continue
      // Only include edges where both endpoints are in this vault
      if (!nodes.has(sourcePath) || !nodes.has(targetPath)) continue
      edges.push({ sourcePath, targetPath, edgeType: edge.edge_type })
    }

    return { edges, nodes }
  }

  /** Limit nodes to maxNodes, preferring those with most edges. */
  #limitNodes(nodes: Map<string, number>, maxNodes: number): Map<string, number> {
    if (nodes.size <= maxNodes) return nodes
    // Keep first maxNodes entries (simple truncation — could be smarter)
    const limited = new Map<string, number>()
    let count = 0
    for (const [path, id] of nodes) {
      if (count >= maxNodes) break
      limited.set(path, id)
      count++
    }
    return limited
  }

  /** Escape special characters for DOT format. */
  #escapeDot(str: string): string {
    return str.replace(/"/g, '\\"')
  }

  /** Sanitize a string for use as a Mermaid node ID. */
  #sanitizeId(str: string): string {
    return str
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
  }
}
