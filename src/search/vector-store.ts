/**
 * VectorStore — SQLite-backed vector storage for semantic search.
 *
 * Stores Float32Array embeddings as BLOBs alongside magnitude metadata.
 * Cosine similarity is computed via brute-force scan in JS — acceptable
 * for <10K vectors. For larger corpora, a dedicated vector index (HNSW,
 * IVF) would be needed, but SQLite brute-force avoids native dependencies
 * and keeps the stack simple.
 *
 * Magnitude pre-filtering narrows candidates before the full dot-product
 * scan, trading a small recall loss for ~5x fewer distance computations.
 */

import type { Database as DatabaseInstance } from 'better-sqlite3'
import type { PreparedStatement } from '../db-base.js'
import { loadDatabase, applyWALPragmas, cleanOrphanedWALFiles, closeDB, deleteDBFiles } from '../db-base.js'

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** Result from a similarity search. */
export interface VectorSearchResult {
  nodeId: number
  symbolId?: number
  similarity: number
}

// ─────────────────────────────────────────────────────────
// VectorStore
// ─────────────────────────────────────────────────────────

export class VectorStore {
  #db: DatabaseInstance
  #dbPath: string

  // ── Prepared Statements ──

  #stmtInsertVector!: PreparedStatement
  #stmtDeleteByNode!: PreparedStatement
  #stmtCount!: PreparedStatement
  #stmtCountByModel!: PreparedStatement
  #stmtSelectCandidates!: PreparedStatement
  #stmtSelectAllByModel!: PreparedStatement

  constructor(dbOrPath: DatabaseInstance | string) {
    if (typeof dbOrPath === 'string') {
      const Database = loadDatabase()
      this.#dbPath = dbOrPath
      cleanOrphanedWALFiles(dbOrPath)
      const db = new Database(dbOrPath, { timeout: 30000 })
      applyWALPragmas(db)
      this.#db = db
    } else {
      this.#db = dbOrPath
      this.#dbPath = ''
    }
    this.#initSchema()
    this.#prepareStatements()
  }

  // ── Schema ──

  #initSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS code_vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL,
        symbol_id INTEGER,
        embedding BLOB NOT NULL,
        model_name TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        magnitude REAL NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_code_vectors_node ON code_vectors(node_id);
      CREATE INDEX IF NOT EXISTS idx_code_vectors_model ON code_vectors(model_name);
      CREATE INDEX IF NOT EXISTS idx_code_vectors_mag ON code_vectors(magnitude);
    `)
  }

  #prepareStatements(): void {
    this.#stmtInsertVector = this.#db.prepare(
      'INSERT INTO code_vectors (node_id, symbol_id, embedding, model_name, dimensions, magnitude, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    this.#stmtDeleteByNode = this.#db.prepare(
      'DELETE FROM code_vectors WHERE node_id = ?'
    )
    this.#stmtCount = this.#db.prepare(
      'SELECT COUNT(*) as count FROM code_vectors'
    )
    this.#stmtCountByModel = this.#db.prepare(
      'SELECT COUNT(*) as count FROM code_vectors WHERE model_name = ?'
    )
    // Magnitude-bucketed candidate selection for cosine similarity
    this.#stmtSelectCandidates = this.#db.prepare(
      'SELECT id, node_id, symbol_id, embedding, magnitude FROM code_vectors WHERE model_name = ? AND magnitude BETWEEN ? AND ?'
    )
    // Full scan fallback for small tables
    this.#stmtSelectAllByModel = this.#db.prepare(
      'SELECT id, node_id, symbol_id, embedding, magnitude FROM code_vectors WHERE model_name = ?'
    )
  }

  // ── Write ──

  /**
   * Insert a vector embedding for a code node.
   * Computes L2 norm (magnitude) and stores embedding as a raw BLOB.
   */
  insertVector(
    nodeId: number,
    symbolId: number | undefined,
    embedding: Float32Array,
    modelName: string,
    contentHash: string,
  ): void {
    const magnitude = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0))
    const blob = Buffer.from(embedding.buffer)
    this.#stmtInsertVector.run(
      nodeId,
      symbolId ?? null,
      blob,
      modelName,
      embedding.length,
      magnitude,
      contentHash,
    )
  }

  // ── Search ──

  /**
   * Perform cosine similarity search against stored vectors.
   *
   * Strategy: for tables with <10K rows, brute-force scan all vectors
   * with the same model_name. For larger tables, pre-filter by magnitude
   * bucket (0.8x .. 1.2x query magnitude) to reduce candidate set.
   */
  searchSimilar(
    queryEmbedding: Float32Array,
    modelName: string,
    limit = 10,
    minSimilarity = 0.7,
  ): VectorSearchResult[] {
    const qMag = Math.sqrt(queryEmbedding.reduce((s, v) => s + v * v, 0))
    if (qMag === 0) return []

    const totalRow = this.#stmtCountByModel.get(modelName) as { count: number } | undefined
    const total = totalRow?.count ?? 0

    // For small tables, scan all; for larger ones, filter by magnitude bucket
    let rows: Array<{ id: number; node_id: number; symbol_id: number | null; embedding: Buffer; magnitude: number }>
    if (total < 10000) {
      rows = this.#stmtSelectAllByModel.all(modelName) as typeof rows
    } else {
      const lo = qMag * 0.8
      const hi = qMag * 1.2
      rows = this.#stmtSelectCandidates.all(modelName, lo, hi) as typeof rows
    }

    const results: VectorSearchResult[] = []

    for (const row of rows) {
      const candidateMag = row.magnitude
      if (candidateMag === 0) continue

      // Read BLOB back into Float32Array
      const buf = row.embedding
      const candidateVec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

      // Dot product
      let dot = 0
      const len = Math.min(queryEmbedding.length, candidateVec.length)
      for (let i = 0; i < len; i++) {
        dot += queryEmbedding[i] * candidateVec[i]
      }

      const similarity = dot / (qMag * candidateMag)

      if (similarity >= minSimilarity) {
        results.push({
          nodeId: row.node_id,
          symbolId: row.symbol_id ?? undefined,
          similarity,
        })
      }
    }

    // Sort descending by similarity, return top limit
    results.sort((a, b) => b.similarity - a.similarity)
    return results.slice(0, limit)
  }

  // ── Delete ──

  /** Delete all vectors for a given node. */
  deleteByNode(nodeId: number): void {
    this.#stmtDeleteByNode.run(nodeId)
  }

  // ── Stats ──

  /** Total number of stored vectors. */
  count(): number {
    const row = this.#stmtCount.get() as { count: number } | undefined
    return row?.count ?? 0
  }

  // ── Lifecycle ──

  /** Close the database connection. Only needed when VectorStore owns the DB. */
  close(): void {
    if (this.#dbPath) {
      closeDB(this.#db)
    }
  }

  /** Close and delete DB files. Only needed when VectorStore owns the DB. */
  cleanup(): void {
    if (this.#dbPath) {
      closeDB(this.#db)
      deleteDBFiles(this.#dbPath)
    }
  }
}
