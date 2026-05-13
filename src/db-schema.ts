/**
 * db-schema — SQL schema and migrations for local code indexing.
 *
 * Provides tables for file metadata, FTS5 chunks, vector embeddings,
 * and indexing jobs. Uses user_version PRAGMA for migrations.
 */

import type { Database as DatabaseInstance } from "better-sqlite3";
import type { PreparedStatement } from "./db-base.js";

export const SCHEMA_VERSION = 1;

export interface PreparedLocalStatements {
  // Files
  stmtInsertFile: PreparedStatement;
  stmtDeleteFile: PreparedStatement;
  stmtGetFileByPath: PreparedStatement;
  stmtListFilesByRepo: PreparedStatement;

  // Chunks (FTS5)
  stmtInsertChunk: PreparedStatement;
  stmtDeleteChunksByFile: PreparedStatement;

  // Vectors
  stmtInsertVector: PreparedStatement;
  stmtDeleteVectorsByChunkIds: PreparedStatement;
  stmtGetVectorByChunkId: PreparedStatement;

  // Jobs
  stmtInsertJob: PreparedStatement;
  stmtUpdateJob: PreparedStatement;
  stmtGetJobById: PreparedStatement;

  // Search
  stmtSearchFts: PreparedStatement;
  stmtSearchFtsRepo: PreparedStatement;
}

export function initLocalSchema(db: DatabaseInstance): void {
  const rawVersion = db.pragma("user_version");
  let currentVersion = 0;
  if (Array.isArray(rawVersion) && rawVersion.length > 0) {
    currentVersion = (rawVersion[0] as { user_version?: number }).user_version ?? 0;
  } else if (typeof rawVersion === "number") {
    currentVersion = rawVersion;
  }

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        mtime REAL NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        indexed_at REAL NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo_id);
      CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        symbol_name,
        symbol_type,
        file_path UNINDEXED,
        repo_id UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED,
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS vectors (
        chunk_id INTEGER PRIMARY KEY,
        vec BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at REAL NOT NULL,
        completed_at REAL,
        error TEXT,
        nodes_indexed INTEGER,
        edges_indexed INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_repo ON jobs(repo_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }
}

export function prepareLocalStatements(db: DatabaseInstance): PreparedLocalStatements {
  return {
    stmtInsertFile: db.prepare(
      "INSERT OR REPLACE INTO files (path, repo_id, mtime, size, sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)"
    ),
    stmtDeleteFile: db.prepare(
      "DELETE FROM files WHERE path = ?"
    ),
    stmtGetFileByPath: db.prepare(
      "SELECT path, repo_id, mtime, size, sha256, indexed_at FROM files WHERE path = ?"
    ),
    stmtListFilesByRepo: db.prepare(
      "SELECT path, repo_id, mtime, size, sha256, indexed_at FROM files WHERE repo_id = ?"
    ),

    stmtInsertChunk: db.prepare(
      "INSERT INTO chunks_fts (content, symbol_name, symbol_type, file_path, repo_id, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ),
    stmtDeleteChunksByFile: db.prepare(
      "DELETE FROM chunks_fts WHERE file_path = ?"
    ),

    stmtInsertVector: db.prepare(
      "INSERT OR REPLACE INTO vectors (chunk_id, vec) VALUES (?, ?)"
    ),
    stmtDeleteVectorsByChunkIds: db.prepare(
      "DELETE FROM vectors WHERE chunk_id = ?"
    ),
    stmtGetVectorByChunkId: db.prepare(
      "SELECT chunk_id, vec FROM vectors WHERE chunk_id = ?"
    ),

    stmtInsertJob: db.prepare(
      "INSERT INTO jobs (id, repo_id, status, created_at, completed_at, error, nodes_indexed, edges_indexed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    stmtUpdateJob: db.prepare(
      "UPDATE jobs SET status = ?, completed_at = ?, error = ?, nodes_indexed = ?, edges_indexed = ? WHERE id = ?"
    ),
    stmtGetJobById: db.prepare(
      "SELECT id, repo_id, status, created_at, completed_at, error, nodes_indexed, edges_indexed FROM jobs WHERE id = ?"
    ),

    stmtSearchFts: db.prepare(
      "SELECT rowid, rank, content, symbol_name, symbol_type, file_path, repo_id, start_line, end_line FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?"
    ),
    stmtSearchFtsRepo: db.prepare(
      "SELECT rowid, rank, content, symbol_name, symbol_type, file_path, repo_id, start_line, end_line FROM chunks_fts WHERE repo_id = ? AND chunks_fts MATCH ? ORDER BY rank LIMIT ?"
    ),
  };
}
