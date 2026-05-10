/**
 * Schema management — FTS5 schema definition, migration, and prepared statements.
 *
 * Extracted from ContentStore to isolate DDL from business logic.
 */

import type { Database as DatabaseInstance } from "better-sqlite3";
import type { PreparedStatement } from "../db-base.js";
import { FTS5_COLUMNS } from "./types.js";

// ─────────────────────────────────────────────────────────
// Schema init + migration
// ─────────────────────────────────────────────────────────

export function initSchema(db: DatabaseInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      code_chunk_count INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
      file_path TEXT,
      content_hash TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(${FTS5_COLUMNS}, tokenize='porter unicode61');

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(${FTS5_COLUMNS}, tokenize='trigram');

    CREATE TABLE IF NOT EXISTS vocabulary (
      word TEXT PRIMARY KEY
    );

    CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
  `);

  // FTS5 schema migration: old schema (4 cols) → new schema (8 cols).
  // FTS5 virtual tables do not support ALTER TABLE ADD COLUMN, so we must
  // DROP + re-CREATE. Detection: check for sentinel column `source_category`
  // via pragma_table_xinfo. Three states:
  //   1. No table          → CREATE above handled it (fresh DB)
  //   2. Old schema (4 cols) → DROP + CREATE new
  //   3. New schema (8 cols) → do nothing
  try {
    const cols = db.prepare(
      "SELECT name FROM pragma_table_xinfo('chunks')"
    ).all() as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));
    if (cols.length > 0 && !colNames.has("source_category")) {
      // Old schema detected — drop both FTS5 tables and re-create with new columns
      db.exec("DROP TABLE IF EXISTS chunks");
      db.exec("DROP TABLE IF EXISTS chunks_trigram");
      db.exec(`
        CREATE VIRTUAL TABLE chunks USING fts5(${FTS5_COLUMNS}, tokenize='porter unicode61');
        CREATE VIRTUAL TABLE chunks_trigram USING fts5(${FTS5_COLUMNS}, tokenize='trigram');
      `);
    }
  } catch (e) { console.warn("#initSchema table_xinfo failed", e) }

  // Stale detection columns — safe for existing DBs (ALTER is O(1) in SQLite)
  try { db.exec("ALTER TABLE sources ADD COLUMN file_path TEXT"); } catch (e) { console.warn("#initSchema add file_path already exists", e) }
  try { db.exec("ALTER TABLE sources ADD COLUMN content_hash TEXT"); } catch (e) { console.warn("#initSchema add content_hash already exists", e) }
}

// ─────────────────────────────────────────────────────────
// Prepared statements
// ─────────────────────────────────────────────────────────

export interface PreparedStatements {
  // Write path
  stmtInsertSource: PreparedStatement;
  stmtInsertChunk: PreparedStatement;
  stmtInsertChunkTrigram: PreparedStatement;
  stmtInsertVocab: PreparedStatement;

  // Dedup path
  stmtDeleteChunksByLabel: PreparedStatement;
  stmtDeleteChunksTrigramByLabel: PreparedStatement;
  stmtDeleteSourcesByLabel: PreparedStatement;

  // Search path (hot) — 12 variants
  stmtSearchPorter: PreparedStatement;
  stmtSearchPorterFiltered: PreparedStatement;
  stmtSearchPorterExact: PreparedStatement;
  stmtSearchTrigram: PreparedStatement;
  stmtSearchTrigramFiltered: PreparedStatement;
  stmtSearchTrigramExact: PreparedStatement;
  stmtSearchPorterContentType: PreparedStatement;
  stmtSearchPorterFilteredContentType: PreparedStatement;
  stmtSearchPorterExactContentType: PreparedStatement;
  stmtSearchTrigramContentType: PreparedStatement;
  stmtSearchTrigramFilteredContentType: PreparedStatement;
  stmtSearchTrigramExactContentType: PreparedStatement;

  // Fuzzy path
  stmtFuzzyVocab: PreparedStatement;

  // Read path
  stmtListSources: PreparedStatement;
  stmtChunksBySource: PreparedStatement;
  stmtSourceChunkCount: PreparedStatement;
  stmtChunkContent: PreparedStatement;
  stmtStats: PreparedStatement;
  stmtSourceMeta: PreparedStatement;

  // Cleanup path
  stmtCleanupChunks: PreparedStatement;
  stmtCleanupChunksTrigram: PreparedStatement;
  stmtCleanupSources: PreparedStatement;
}

function buildSearchSQL(
  table: string,
  sourceFilter: "none" | "like" | "exact",
  contentTypeFilter: boolean,
): string {
  const cols = `${table}.title, ${table}.content, ${table}.content_type, ${table}.timestamp, sources.label, bm25(${table}, 5.0, 1.0) AS rank, highlight(${table}, 1, char(2), char(3)) AS highlighted`;
  const from = `FROM ${table} JOIN sources ON sources.id = ${table}.source_id`;
  const conditions: string[] = [`${table} MATCH ?`];
  if (sourceFilter === "like") conditions.push("sources.label LIKE ?");
  if (sourceFilter === "exact") conditions.push("sources.label = ?");
  if (contentTypeFilter) conditions.push(`${table}.content_type = ?`);
  return `SELECT ${cols} ${from} WHERE ${conditions.join(" AND ")} ORDER BY rank LIMIT ?`;
}

export function prepareStatements(db: DatabaseInstance): PreparedStatements {
  return {
    // Write path
    stmtInsertSource: db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
    ),
    stmtInsertChunk: db.prepare(
      "INSERT INTO chunks (title, content, source_id, content_type, source_category, session_id, event_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    stmtInsertChunkTrigram: db.prepare(
      "INSERT INTO chunks_trigram (title, content, source_id, content_type, source_category, session_id, event_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    stmtInsertVocab: db.prepare(
      "INSERT OR IGNORE INTO vocabulary (word) VALUES (?)",
    ),

    // Dedup path
    stmtDeleteChunksByLabel: db.prepare(
      "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)",
    ),
    stmtDeleteChunksTrigramByLabel: db.prepare(
      "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?)",
    ),
    stmtDeleteSourcesByLabel: db.prepare(
      "DELETE FROM sources WHERE label = ?",
    ),

    // Search path (hot) — 12 variants generated from buildSearchSQL
    stmtSearchPorter: db.prepare(buildSearchSQL("chunks", "none", false)),
    stmtSearchPorterFiltered: db.prepare(buildSearchSQL("chunks", "like", false)),
    stmtSearchPorterExact: db.prepare(buildSearchSQL("chunks", "exact", false)),
    stmtSearchTrigram: db.prepare(buildSearchSQL("chunks_trigram", "none", false)),
    stmtSearchTrigramFiltered: db.prepare(buildSearchSQL("chunks_trigram", "like", false)),
    stmtSearchTrigramExact: db.prepare(buildSearchSQL("chunks_trigram", "exact", false)),
    stmtSearchPorterContentType: db.prepare(buildSearchSQL("chunks", "none", true)),
    stmtSearchPorterFilteredContentType: db.prepare(buildSearchSQL("chunks", "like", true)),
    stmtSearchPorterExactContentType: db.prepare(buildSearchSQL("chunks", "exact", true)),
    stmtSearchTrigramContentType: db.prepare(buildSearchSQL("chunks_trigram", "none", true)),
    stmtSearchTrigramFilteredContentType: db.prepare(buildSearchSQL("chunks_trigram", "like", true)),
    stmtSearchTrigramExactContentType: db.prepare(buildSearchSQL("chunks_trigram", "exact", true)),

    // Fuzzy path
    stmtFuzzyVocab: db.prepare(
      "SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?",
    ),

    // Read path
    stmtListSources: db.prepare(
      "SELECT label, chunk_count as chunkCount FROM sources ORDER BY id DESC",
    ),
    stmtChunksBySource: db.prepare(
      `SELECT c.title, c.content, c.content_type, s.label
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
       WHERE c.source_id = ?
       ORDER BY c.rowid`,
    ),
    stmtSourceChunkCount: db.prepare(
      "SELECT chunk_count FROM sources WHERE id = ?",
    ),
    stmtChunkContent: db.prepare(
      "SELECT content FROM chunks WHERE source_id = ?",
    ),
    stmtSourceMeta: db.prepare(
      "SELECT label, chunk_count, code_chunk_count, indexed_at, file_path, content_hash FROM sources WHERE label = ?",
    ),
    stmtStats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sources) AS sources,
        (SELECT COUNT(*) FROM chunks) AS chunks,
        (SELECT COUNT(*) FROM chunks WHERE content_type = 'code') AS codeChunks
    `),

    // Cleanup path
    stmtCleanupChunks: db.prepare(
      "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days'))",
    ),
    stmtCleanupChunksTrigram: db.prepare(
      "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days'))",
    ),
    stmtCleanupSources: db.prepare(
      "DELETE FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days')",
    ),
  };
}
