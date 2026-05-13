/**
 * local-indexer — Merkle diff + full indexing pipeline for local code repositories.
 *
 * Steps:
 *   1. collectFileMetas(dir) → list files
 *   2. diffWithDb(metas, repoId) → changed / new / deleted files
 *   3. For each changed file: chunk → embed → insert into SQLite
 *   4. Remove deleted files from DB
 *   5. Track progress via jobs table
 */

import type { Database as DatabaseInstance } from "better-sqlite3";
import { loadDatabase, applyWALPragmas, withRetry } from "./db-base.js";
import { initLocalSchema, prepareLocalStatements, type PreparedLocalStatements } from "./db-schema.js";
import {
  collectFileMetas,
  diffWithDb,
  computeFileHash,
  readFilesByPath,
  normalizePath,
  type FileMeta,
  type DiffResult,
} from "./utils/fs.js";
import { parseFile } from "./chunker.js";
import { embed } from "./embedding.js";
import type { AstChunk } from "./types.js";

export interface IndexOptions {
  fresh?: boolean;
  batchSize?: number;
}

export interface IndexJob {
  id: string;
  repoId: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
  error?: string;
  filesIndexed: number;
  chunksIndexed: number;
}

export class LocalIndexer {
  readonly db: DatabaseInstance;
  readonly dbPath: string;
  private stmts: PreparedLocalStatements;

  constructor(dbPath?: string) {
    const Database = loadDatabase();
    this.dbPath = dbPath || normalizePath(`${process.cwd()}/.context-mode/code-index.db`);
    this.db = new Database(this.dbPath, { timeout: 30000 });
    applyWALPragmas(this.db);
    initLocalSchema(this.db);
    this.stmts = prepareLocalStatements(this.db);
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }

  private insertFile(meta: FileMeta, repoId: string, hash: string): void {
    this.stmts.stmtInsertFile.run(meta.relPath, repoId, meta.mtime, meta.size, hash, Date.now());
  }

  private deleteChunksForFile(relPath: string): void {
    this.stmts.stmtDeleteChunksByFile.run(relPath);
  }

  private insertChunkAndVector(
    chunk: AstChunk,
    repoId: string,
    relPath: string,
    vector: number[],
  ): void {
    const meta = chunk.metadata;
    const result = this.stmts.stmtInsertChunk.run(
      chunk.content,
      meta.symbolName,
      meta.symbolKind,
      relPath,
      repoId,
      meta.lineStart,
      meta.lineEnd,
    );
    const rowid = result.lastInsertRowid;
    if (rowid && vector && vector.length > 0 && vector.some((v) => v !== 0)) {
      const buf = Buffer.from(new Float32Array(vector).buffer);
      this.stmts.stmtInsertVector.run(Number(rowid), buf);
    }
  }

  async indexRepository(dirPath: string, repoId: string, options: IndexOptions = {}): Promise<IndexJob> {
    const jobId = `${repoId}-${Date.now()}`;
    const startedAt = Date.now();
    this.stmts.stmtInsertJob.run(jobId, repoId, "running", startedAt, null, null, 0, 0);

    try {
      const normalizedDir = normalizePath(dirPath);
      const metas = collectFileMetas(normalizedDir, repoId);

      // Cap to avoid memory issues on huge repos
      const MAX_FILES = 10000;
      if (metas.length > MAX_FILES) {
        throw new Error(`Repository exceeds ${MAX_FILES} files limit (${metas.length} files)`);
      }

      // If fresh, wipe existing data for repo
      if (options.fresh) {
        const existing = this.stmts.stmtListFilesByRepo.all(repoId) as Array<{ path: string }>;
        for (const f of existing) {
          this.stmts.stmtDeleteChunksByFile.run(f.path);
        }
        this.db.prepare("DELETE FROM files WHERE repo_id = ?").run(repoId);
        this.db.prepare("DELETE FROM vectors WHERE chunk_id NOT IN (SELECT rowid FROM chunks_fts)").run();
      }

      // Diff
      const dbFiles = this.stmts.stmtListFilesByRepo.all(repoId) as Array<{
        path: string; mtime: number; size: number; sha256: string;
      }>;
      const diff = diffWithDb(metas, dbFiles);

      let filesIndexed = 0;
      let chunksIndexed = 0;

      // Delete removed files
      for (const del of diff.toDelete) {
        this.stmts.stmtDeleteChunksByFile.run(del);
        this.stmts.stmtDeleteFile.run(del);
      }

      // Read changed files in batches
      const BATCH_READ = 300;
      const readRelPaths = diff.toUpload.map((m) => m.relPath);
      for (let i = 0; i < readRelPaths.length; i += BATCH_READ) {
        const batchPaths = readRelPaths.slice(i, i + BATCH_READ);
        const contents = readFilesByPath(normalizedDir, batchPaths);

        for (const relPath of batchPaths) {
          const content = contents.get(relPath);
          if (content === undefined) continue;

          const meta = diff.toUpload.find((m) => m.relPath === relPath)!;
          const hash = computeFileHash(meta.path);

          // Chunk
          const chunks = parseFile(content, relPath);

          // Embed in batches
          const chunkTexts = chunks.map((c) => c.content);
          let vectors: number[][] = [];
          if (chunkTexts.length > 0) {
            vectors = await embed(chunkTexts);
          }

          // Atomic write: delete old chunks for file, insert new ones
          this.withTransaction(() => {
            this.deleteChunksForFile(relPath);
            // Also delete orphaned vectors
            this.db.prepare("DELETE FROM vectors WHERE chunk_id NOT IN (SELECT rowid FROM chunks_fts)").run();
            this.insertFile(meta, repoId, hash);
            for (let j = 0; j < chunks.length; j++) {
              this.insertChunkAndVector(chunks[j], repoId, relPath, vectors[j] || []);
            }
          });

          filesIndexed++;
          chunksIndexed += chunks.length;
        }
      }

      const completedAt = Date.now();
      this.stmts.stmtUpdateJob.run("completed", completedAt, null, filesIndexed, chunksIndexed, jobId);

      return {
        id: jobId,
        repoId,
        status: "completed",
        createdAt: startedAt,
        completedAt,
        filesIndexed,
        chunksIndexed,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stmts.stmtUpdateJob.run("failed", null, message, 0, 0, jobId);
      return {
        id: jobId,
        repoId,
        status: "failed",
        createdAt: startedAt,
        error: message,
        filesIndexed: 0,
        chunksIndexed: 0,
      };
    }
  }

  getJobStatus(jobId: string): IndexJob | null {
    const row = this.stmts.stmtGetJobById.get(jobId) as {
      id: string; repo_id: string; status: string; created_at: number;
      completed_at: number | null; error: string | null;
      nodes_indexed: number; edges_indexed: number;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      repoId: row.repo_id,
      status: row.status as IndexJob["status"],
      createdAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
      filesIndexed: row.nodes_indexed,
      chunksIndexed: row.edges_indexed,
    };
  }

  listRepos(): Array<{ repoId: string; files: number }> {
    const rows = this.db.prepare("SELECT repo_id, COUNT(*) as files FROM files GROUP BY repo_id").all() as Array<{ repo_id: string; files: number }>;
    return rows.map((r) => ({ repoId: r.repo_id, files: r.files }));
  }

  private withTransaction<T>(fn: () => T): T {
    return withRetry(() => {
      this.db.prepare("BEGIN").run();
      try {
        const result = fn();
        this.db.prepare("COMMIT").run();
        return result;
      } catch (err) {
        try { this.db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
        throw err;
      }
    });
  }
}
