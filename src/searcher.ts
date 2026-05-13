/**
 * searcher — Hybrid FTS5 + vector similarity search over local code index.
 *
 * 1. FTS5 BM25 query to get candidates.
 * 2. If vectors available: cosine similarity against query embedding.
 * 3. Fuse BM25 rank + cosine score for final ranking.
 */

import type { Database as DatabaseInstance } from "better-sqlite3";
import { loadDatabase, applyWALPragmas } from "./db-base.js";
import { initLocalSchema, prepareLocalStatements } from "./db-schema.js";
import { embed } from "./embedding.js";

export interface SearchChunk {
  rowid: number;
  content: string;
  symbolName: string;
  symbolType: string;
  filePath: string;
  repoId: string;
  startLine: number;
  endLine: number;
  score: number;
}

function escapeFts5(query: string): string {
  // Escape FTS5 special characters: double-quote, backslash, control chars
  return query
    .replace(/"/g, '""')
    .replace(/\\/g, '\\\\')
    .replace(/[\x00-\x1f]/g, " ");
}

function buildMatch(query: string): string {
  const terms = escapeFts5(query)
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return "*";
  // Search in both content and symbol_name columns
  return terms.map((t) => `"${t}"`).join(" OR ");
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function normalizeFtsRank(rank: number): number {
  // FTS5 rank is negative BM25; lower (more negative) = better.
  // Normalize to 0..1 where 1 = best.
  const minRank = -20;
  const maxRank = 0;
  const clamped = Math.max(minRank, Math.min(maxRank, rank));
  return (clamped - minRank) / (maxRank - minRank);
}

export class LocalSearcher {
  readonly db: DatabaseInstance;
  readonly dbPath: string;

  constructor(dbPath?: string) {
    const Database = loadDatabase();
    this.dbPath = dbPath || `${process.cwd()}/.context-mode/code-index.db`;
    this.db = new Database(this.dbPath, { timeout: 30000 });
    applyWALPragmas(this.db);
    initLocalSchema(this.db);
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }

  async search(query: string, repoId?: string, limit = 10): Promise<SearchChunk[]> {
    const matchExpr = buildMatch(query);
    const stmt = repoId
      ? this.db.prepare(
          "SELECT rowid, rank, content, symbol_name, symbol_type, file_path, repo_id, start_line, end_line FROM chunks_fts WHERE repo_id = ? AND chunks_fts MATCH ? ORDER BY rank LIMIT ?"
        )
      : this.db.prepare(
          "SELECT rowid, rank, content, symbol_name, symbol_type, file_path, repo_id, start_line, end_line FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?"
        );

    const rows = repoId
      ? (stmt.all(repoId, matchExpr, limit * 2) as Array<{
          rowid: number; rank: number; content: string; symbol_name: string; symbol_type: string;
          file_path: string; repo_id: string; start_line: number; end_line: number;
        }>)
      : (stmt.all(matchExpr, limit * 2) as Array<{
          rowid: number; rank: number; content: string; symbol_name: string; symbol_type: string;
          file_path: string; repo_id: string; start_line: number; end_line: number;
        }>);

    if (rows.length === 0) return [];

    // Try vector similarity
    let queryVec: Float32Array | null = null;
    try {
      const vecs = await embed([query]);
      if (vecs[0] && vecs[0].some((v) => v !== 0)) {
        queryVec = new Float32Array(vecs[0]);
      }
    } catch {
      // ignore
    }

    const scored: SearchChunk[] = [];

    for (const row of rows) {
      let score = normalizeFtsRank(row.rank);
      if (queryVec) {
        const vecRow = this.db
          .prepare("SELECT vec FROM vectors WHERE chunk_id = ?")
          .get(row.rowid) as { vec: Buffer } | undefined;
        if (vecRow) {
          const vec = new Float32Array(vecRow.vec.buffer, vecRow.vec.byteOffset, vecRow.vec.length / 4);
          const sim = cosineSimilarity(queryVec, vec);
          score = score * 0.5 + sim * 0.5;
        }
      }
      scored.push({
        rowid: row.rowid,
        content: row.content,
        symbolName: row.symbol_name,
        symbolType: row.symbol_type,
        filePath: row.file_path,
        repoId: row.repo_id,
        startLine: row.start_line,
        endLine: row.end_line,
        score,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
