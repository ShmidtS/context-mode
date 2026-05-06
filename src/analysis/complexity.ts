/**
 * complexity — Cyclomatic complexity via token-based regex scanning.
 *
 * Uses tree-sitter symbol boundaries (from ast-parser) to locate functions,
 * then counts decision points via regex within each symbol's source text.
 * This is a lizard-style token approximation: fast, language-agnostic.
 *
 * McCabe formula: complexity = decisionPoints + 1
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSymbols, canParse } from '../vault/ast-parser.js'
import type { CodeSymbol } from '../types.js'
import type { VaultGraphStore } from '../vault/graph-store.js'

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface SymbolComplexity {
  name: string
  kind: string
  complexity: number
  decisionPoints: number
  loc: number
}

export interface VaultComplexityResult {
  path: string
  symbol: string
  complexity: number
  decisionPoints: number
  loc: number
}

/** Decision point patterns for token-based complexity counting. */
const DECISION_PATTERNS = [
  /\belse\s+if\b/g,       // else if (counted separately from if)
  /\bif\b/g,               // if
  /\bfor\b/g,              // for
  /\bwhile\b/g,            // while
  /\bdo\b/g,               // do...while
  /\bcase\b/g,             // switch case
  /\bcatch\b/g,            // catch
  /&&/g,                   // logical AND
  /\|\|/g,                 // logical OR
  /\?[^?]/g,               // ternary (not nullish coalescing)
  /\?\?/g,                 // nullish coalescing
]

// ─────────────────────────────────────────────────────────
// ComplexityAnalyzer
// ─────────────────────────────────────────────────────────

export class ComplexityAnalyzer {

  // ── Schema ──

  ensureTables(db: import('better-sqlite3').Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_complexity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol_id INTEGER,
        node_id INTEGER NOT NULL,
        complexity INTEGER NOT NULL,
        decision_points INTEGER NOT NULL,
        lines_of_code INTEGER NOT NULL,
        analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_complexity_node ON code_complexity(node_id);
      CREATE INDEX IF NOT EXISTS idx_complexity_value ON code_complexity(complexity DESC);
    `)
  }

  // ── Per-file analysis ──

  /**
   * Analyze cyclomatic complexity of symbols in a single source file.
   * Uses tree-sitter for symbol boundaries, regex for decision point counting.
   * Returns empty array if tree-sitter is unavailable.
   */
  analyzeFile(source: string, filePath: string): SymbolComplexity[] {
    if (!canParse(filePath)) return []

    const symbols = parseSymbols(source, filePath)
    if (symbols.length === 0) return []

    const results: SymbolComplexity[] = []

    for (const symbol of symbols) {
      const symbolSource = source.substring(symbol.byteStart, symbol.byteEnd)
      const decisionPoints = this.#countDecisionPoints(symbolSource)
      const complexity = decisionPoints + 1
      const loc = symbol.lineEnd - symbol.lineStart + 1

      results.push({
        name: symbol.scope ? `${symbol.scope}.${symbol.name}` : symbol.name,
        kind: symbol.kind,
        complexity,
        decisionPoints,
        loc,
      })
    }

    return results
  }

  // ── Full vault analysis ──

  /**
   * Analyze all code files in a vault.
   * Reads source from disk, calls analyzeFile() per file,
   * and stores results in code_complexity table.
   */
  analyzeVault(
    vaultPath: string,
    graphStore: VaultGraphStore,
  ): VaultComplexityResult[] {
    const db = graphStore.db
    this.ensureTables(db)

    // Get all vault nodes for this path
    const nodes = db.prepare(
      'SELECT id, note_path FROM vault_nodes WHERE vault_path = ? AND source_type = ?'
    ).all(vaultPath, 'vault') as Array<{ id: number; note_path: string }>

    if (nodes.length === 0) return []

    const results: VaultComplexityResult[] = []
    const insertStmt = db.prepare(
      'INSERT INTO code_complexity (symbol_id, node_id, complexity, decision_points, lines_of_code) VALUES (?, ?, ?, ?, ?)'
    )

    // Clear old results for this vault
    const nodeIds = nodes.map((n) => n.id)
    if (nodeIds.length > 0) {
      const placeholders = nodeIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM code_complexity WHERE node_id IN (${placeholders})`).run(...nodeIds)
    }

    for (const node of nodes) {
      // Only analyze files that tree-sitter can parse
      if (!canParse(node.note_path)) continue

      const fullPath = join(vaultPath, node.note_path)
      let source: string
      try {
        source = readFileSync(fullPath, 'utf8')
      } catch {
        // File may not exist on disk
        continue
      }

      const symbolResults = this.analyzeFile(source, node.note_path)
      for (const sym of symbolResults) {
        results.push({
          path: node.note_path,
          symbol: sym.name,
          complexity: sym.complexity,
          decisionPoints: sym.decisionPoints,
          loc: sym.loc,
        })

        insertStmt.run(null, node.id, sym.complexity, sym.decisionPoints, sym.loc)
      }
    }

    return results
  }

  // ── Private helpers ──

  /**
   * Count decision points in source text using regex patterns.
   * This is a token-based approximation (lizard-style).
   * Handles overlap: 'else if' is counted once, not as 'if' + 'else if'.
   */
  #countDecisionPoints(source: string): number {
    let count = 0

    // Count 'else if' first (to avoid double-counting the 'if' part)
    const elseIfMatches = source.match(/\belse\s+if\b/g)
    count += (elseIfMatches?.length ?? 0)

    // Count standalone 'if' (not preceded by 'else')
    // Replace 'else if' with placeholder first, then count remaining 'if'
    const cleaned = source.replace(/\belse\s+if\b/g, ' __ELSEIF__ ')
    const ifMatches = cleaned.match(/\bif\b/g)
    count += (ifMatches?.length ?? 0)

    // Other patterns (no overlap concerns)
    const forMatches = source.match(/\bfor\b/g)
    count += (forMatches?.length ?? 0)

    const whileMatches = source.match(/\bwhile\b/g)
    count += (whileMatches?.length ?? 0)

    const doMatches = source.match(/\bdo\b(?!\s*:)/g)  // exclude object literal 'do:'
    count += (doMatches?.length ?? 0)

    const caseMatches = source.match(/\bcase\b/g)
    count += (caseMatches?.length ?? 0)

    const catchMatches = source.match(/\bcatch\b/g)
    count += (catchMatches?.length ?? 0)

    // Logical operators
    const andMatches = source.match(/&&/g)
    count += (andMatches?.length ?? 0)

    const orMatches = source.match(/\|\|/g)
    count += (orMatches?.length ?? 0)

    // Nullish coalescing
    const nullishMatches = source.match(/\?\?/g)
    count += (nullishMatches?.length ?? 0)

    // Ternary — match '?' not followed by '?' and not preceded by '?'
    // This avoids matching '??' as ternary
    const ternaryMatches = source.match(/[^?]\?[^?:]/g)
    count += (ternaryMatches?.length ?? 0)

    return count
  }
}
