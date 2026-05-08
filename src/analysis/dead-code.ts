/**
 * dead-code — Graph-based dead code detection.
 *
 * Uses vault_edges (import, calls, inherits, implements) to find
 * nodes unreachable from entry points. Entry points are auto-detected
 * from conventional file names or manually configured.
 *
 * Algorithm: BFS from entry points → unreachable nodes = dead code.
 * Also flags zero-in-degree nodes that aren't entry points.
 */

import type { VaultGraphStore } from '../vault/graph-store.js'
import type { VaultNode } from '../types.js'

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface DeadCodeResult {
  path: string
  reason: 'zero-in-degree' | 'unreachable' | 'unused-export'
  entryPath?: string
}

/** Conventional entry point file basenames for auto-detection. */
const ENTRY_PATTERNS = [
  /^index\.ts$/,
  /^index\.js$/,
  /^main\.ts$/,
  /^main\.js$/,
  /^cli\.ts$/,
  /^cli\.js$/,
  /^server\.ts$/,
  /^server\.js$/,
  /^app\.ts$/,
  /^app\.js$/,
  /^mod\.ts$/,
]

/** Edge types that establish reachability. */
const REACHABLE_EDGES = new Set(['import', 'calls', 'inherits', 'implements'])

// ─────────────────────────────────────────────────────────
// DeadCodeAnalyzer
// ─────────────────────────────────────────────────────────

export class DeadCodeAnalyzer {
  #store: VaultGraphStore

  constructor(store: VaultGraphStore) {
    this.#store = store
  }

  // ── Schema ──

  ensureTables(): void {
    const db = this.#store
    db.exec(`
      CREATE TABLE IF NOT EXISTS entry_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_path TEXT NOT NULL,
        note_path TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'auto',
        UNIQUE(vault_path, note_path)
      );
      CREATE TABLE IF NOT EXISTS dead_code_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_path TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        reason TEXT NOT NULL,
        entry_path TEXT,
        analyzed_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (node_id) REFERENCES vault_nodes(id)
      );
    `)
  }

  // ── Main detection ──

  detect(
    vaultPath: string,
    entryPoints?: string[],
    includeTests = false,
  ): DeadCodeResult[] {
    this.ensureTables()

    const db = this.#store
    const results: DeadCodeResult[] = []

    // Step 1: Resolve entry point node IDs
    const entryNodeIds = new Set<number>()
    const entryPaths = new Set<string>()

    // Manual entry points from parameter
    if (entryPoints) {
      for (const ep of entryPoints) {
        const node = this.#store.getNodeByPath(vaultPath, ep)
        if (node) {
          entryNodeIds.add(node.id)
          entryPaths.add(ep)
        }
      }
    }

    // Manual entry points from DB table
    try {
      const rows = db.prepare(
        'SELECT note_path FROM entry_points WHERE vault_path = ?'
      ).all(vaultPath) as Array<{ note_path: string }>
      for (const row of rows) {
        const node = this.#store.getNodeByPath(vaultPath, row.note_path)
        if (node) {
          entryNodeIds.add(node.id)
          entryPaths.add(row.note_path)
        }
      }
    } catch (e) { console.warn("getDeadCode table read failed", e) }

    // Auto-detect entry points if none provided
    if (entryNodeIds.size === 0) {
      this.#autoDetectEntryPoints(vaultPath, entryNodeIds, entryPaths)
    }

    // If still no entry points and no nodes, return empty
    const allNodes = this.#getVaultNodes(vaultPath)
    if (allNodes.length === 0) return results

    // If no entry points found, nothing is "dead" by definition
    if (entryNodeIds.size === 0) return results

    // Step 2: BFS from entry points over reachable edge types
    const reachable = this.#bfsReachable(entryNodeIds)

    // Step 3: Find dead code
    for (const node of allNodes) {
      // Skip test files unless includeTests
      if (!includeTests && this.#isTestPath(node.note_path)) continue

      // Skip connector nodes
      if (node.source_type !== 'vault') continue

      // Skip entry points
      if (entryNodeIds.has(node.id)) continue

      // Zero in-degree and not an entry point
      if (node.in_degree === 0) {
        results.push({
          path: node.note_path,
          reason: 'zero-in-degree',
        })
        continue
      }

      // Not reachable from any entry point
      if (!reachable.has(node.id)) {
        results.push({
          path: node.note_path,
          reason: 'unreachable',
          entryPath: this.#findNearestEntry(node.id, entryNodeIds),
        })
      }
    }

    // Step 4: Store results
    this.#storeResults(vaultPath, results, allNodes)

    return results
  }

  // ── Entry point management ──

  addEntryPoint(vaultPath: string, notePath: string, reason = 'manual'): void {
    this.ensureTables()
    const db = this.#store
    db.prepare(
      'INSERT OR IGNORE INTO entry_points (vault_path, note_path, reason) VALUES (?, ?, ?)'
    ).run(vaultPath, notePath, reason)
  }

  removeEntryPoint(vaultPath: string, notePath: string): void {
    this.ensureTables()
    const db = this.#store
    db.prepare(
      'DELETE FROM entry_points WHERE vault_path = ? AND note_path = ?'
    ).run(vaultPath, notePath)
  }

  listEntryPoints(vaultPath: string): Array<{ notePath: string; reason: string }> {
    this.ensureTables()
    const db = this.#store
    const rows = db.prepare(
      'SELECT note_path, reason FROM entry_points WHERE vault_path = ?'
    ).all(vaultPath) as Array<{ note_path: string; reason: string }>
    return rows.map((r) => ({ notePath: r.note_path, reason: r.reason }))
  }

  // ── Private helpers ──

  /** Auto-detect entry points from conventional file names and export default patterns. */
  #autoDetectEntryPoints(
    vaultPath: string,
    entryNodeIds: Set<number>,
    entryPaths: Set<string>,
  ): void {
    const nodes = this.#getVaultNodes(vaultPath)
    for (const node of nodes) {
      const basename = node.note_path.split('/').pop() ?? ''
      if (ENTRY_PATTERNS.some((p) => p.test(basename))) {
        entryNodeIds.add(node.id)
        entryPaths.add(node.note_path)
        continue
      }
      // Check for export default in node title or context
      if (node.title.includes('export default') || node.note_path.includes('index.')) {
        entryNodeIds.add(node.id)
        entryPaths.add(node.note_path)
      }
    }
  }

  /** Get all vault nodes for a given vault path. */
  #getVaultNodes(vaultPath: string): VaultNode[] {
    return this.#store.getNodesByVaultPath(vaultPath)
  }

  /** BFS from entry points following reachable edge types. */
  #bfsReachable(entryNodeIds: Set<number>): Set<number> {
    const reachable = new Set<number>(entryNodeIds)
    const edges = this.#store.getAllEdges()

    // Build adjacency for reachable edge types only
    const adj = new Map<number, number[]>()
    for (const edge of edges) {
      if (!REACHABLE_EDGES.has(edge.edge_type)) continue
      if (edge.target_id === null) continue
      const list = adj.get(edge.source_id)
      if (list) {
        list.push(edge.target_id)
      } else {
        adj.set(edge.source_id, [edge.target_id])
      }
    }

    const frontier = [...entryNodeIds]
    let idx = 0
    while (idx < frontier.length) {
      const current = frontier[idx++]
      const neighbors = adj.get(current) ?? []
      for (const neighborId of neighbors) {
        if (reachable.has(neighborId)) continue
        reachable.add(neighborId)
        frontier.push(neighborId)
      }
    }

    return reachable
  }

  /** Find the nearest entry point path for context. */
  #findNearestEntry(nodeId: number, entryNodeIds: Set<number>): string | undefined {
    const edges = this.#store.getAllEdges()

    // Build reverse adjacency for back-traversal
    const reverseAdj = new Map<number, number[]>()
    for (const edge of edges) {
      if (edge.target_id === null) continue
      if (!REACHABLE_EDGES.has(edge.edge_type)) continue
      const list = reverseAdj.get(edge.target_id)
      if (list) {
        list.push(edge.source_id)
      } else {
        reverseAdj.set(edge.target_id, [edge.source_id])
      }
    }

    // BFS backward until we hit an entry point
    const visited = new Set<number>([nodeId])
    const frontier = [nodeId]
    let idx = 0
    while (idx < frontier.length) {
      const current = frontier[idx++]
      const sources = reverseAdj.get(current) ?? []
      for (const srcId of sources) {
        if (entryNodeIds.has(srcId)) {
          const node = this.#store.getNodeById(srcId)
          return node?.note_path
        }
        if (!visited.has(srcId)) {
          visited.add(srcId)
          frontier.push(srcId)
        }
      }
    }

    return undefined
  }

  /** Check if a path looks like a test file. */
  #isTestPath(notePath: string): boolean {
    const lower = notePath.toLowerCase()
    return lower.includes('.test.') ||
      lower.includes('.spec.') ||
      lower.includes('__tests__/') ||
      lower.includes('/test/') ||
      lower.includes('/tests/')
  }

  /** Store detection results in dead_code_results table. */
  #storeResults(vaultPath: string, results: DeadCodeResult[], allNodes: VaultNode[]): void {
    const db = this.#store

    // Clear old results for this vault
    db.prepare('DELETE FROM dead_code_results WHERE vault_path = ?').run(vaultPath)

    // Build path -> node_id map
    const pathToId = new Map<string, number>()
    for (const node of allNodes) {
      pathToId.set(node.note_path, node.id)
    }

    // Insert new results
    const stmt = db.prepare(
      'INSERT INTO dead_code_results (vault_path, node_id, reason, entry_path) VALUES (?, ?, ?, ?)'
    )
    for (const result of results) {
      const nodeId = pathToId.get(result.path)
      if (nodeId !== undefined) {
        stmt.run(vaultPath, nodeId, result.reason, result.entryPath ?? null)
      }
    }
  }
}
