/**
 * ContentStore — FTS5 BM25-based knowledge base for context-mode.
 *
 * Chunks markdown content by headings (keeping code blocks intact),
 * stores in SQLite FTS5, and retrieves via BM25-ranked search.
 *
 * Use for documentation, API references, and any content where
 * you need EXACT text later — not summaries.
 */

import type { Database as DatabaseInstance } from "better-sqlite3";
import { loadDatabase, applyWALPragmas, closeDB, cleanOrphanedWALFiles, withRetry, deleteDBFiles, isSQLiteCorruptionError } from "../db-base.js";
import type { IndexResult, SearchResult, StoreStats, AstChunk } from "../types.js";
import { type Chunk, type SourceMatchMode, type SearchRow, STOPWORDS, MAX_CHUNK_BYTES } from "./types.js";
import { initSchema, prepareStatements, type PreparedStatements } from "./schema.js";
import { chunkMarkdown, chunkPlainText, walkJSON } from "./chunking.js";
import { applyProximityReranking } from "./reranking.js";
import { extractAndStoreVocabulary, fuzzyCorrect } from "./vocabulary.js";
import { sanitizeQuery, sanitizeTrigramQuery, searchCore, type SearchStmts } from "./search-helpers.js";
import { reciprocalRankFuse } from "../search/rrf.js";
import { readFileSync, existsSync, statSync, createReadStream, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────
// Stale DB cleanup (module-level exports)
// ─────────────────────────────────────────────────────────

/**
 * Remove stale DB files from previous sessions whose processes no longer exist.
 */
export function cleanupStaleDBs(): number {
  const dir = tmpdir();
  let cleaned = 0;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const match = file.match(/^context-mode-(\d+)\.db$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (pid === process.pid) continue;
      try {
        process.kill(pid, 0);
      } catch {
        const base = join(dir, file);
        for (const suffix of ["", "-wal", "-shm"]) {
          try { unlinkSync(base + suffix); } catch (e) { console.warn("cleanupStaleDBs unlink failed", e) }
        }
        cleaned++;
      }
    }
  } catch (e) { console.warn("cleanupStaleDBs readdir failed", e) }
  return cleaned;
}

/**
 * Clean up stale per-project content store DBs older than maxAgeDays.
 * Scans the given directory for *.db files and checks mtime.
 * Also detects zombie processes holding WAL locks — if a WAL file exists
 * but the owning PID is dead, the DB files are cleaned up regardless of age.
 */
export function cleanupStaleContentDBs(contentDir: string, maxAgeDays: number): number {
  let cleaned = 0;
  try {
    if (!existsSync(contentDir)) return 0;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(contentDir).filter(f => f.endsWith(".db"));
    for (const file of files) {
      try {
        const filePath = join(contentDir, file);
        const mtime = statSync(filePath).mtimeMs;
        let shouldClean = mtime < cutoff;

        // Detect zombie processes holding WAL locks:
        // If a WAL file exists, try to read the WAL header to extract the PID.
        // WAL files from dead processes can block new connections.
        if (!shouldClean) {
          const walPath = filePath + "-wal";
          if (existsSync(walPath)) {
            try {
              const walStat = statSync(walPath);
              // If WAL file is non-empty and DB hasn't been modified in >1 hour,
              // the owning process may be dead — check via mtime staleness
              if (walStat.size > 0 && (Date.now() - walStat.mtimeMs) > 3600_000) {
                shouldClean = true;
              }
            } catch (e) { console.warn("cleanupStaleContentDBs walStat failed", e) }
          }
        }

        if (shouldClean) {
          for (const suffix of ["", "-wal", "-shm"]) {
            try { unlinkSync(filePath + suffix); } catch (e) { console.warn("cleanupStaleContentDBs unlink failed", e) }
          }
          cleaned++;
        }
      } catch (e) { console.warn("cleanupStaleContentDBs per-file failed", e) }
    }
  } catch (e) { console.warn("cleanupStaleContentDBs readdir failed", e) }
  return cleaned;
}

// ─────────────────────────────────────────────────────────
// ContentStore
// ─────────────────────────────────────────────────────────

export class ContentStore {
  #db: DatabaseInstance;
  #dbPath: string;
  #stmts: PreparedStatements;

  // FTS5 optimization: track inserts and optimize periodically to defragment
  // the index. FTS5 b-trees fragment over many insert/delete cycles, degrading
  // search performance. SQLite's built-in 'optimize' merges b-tree segments.
  #insertCount = 0;
  static readonly OPTIMIZE_EVERY = 50;

  // Fuzzy correction cache (process-local LRU). fuzzyCorrect() hits the vocab
  // DB and runs levenshtein against every candidate within length tolerance,
  // which is CPU-linear in |candidates|. Repeated queries ("erro", "erro" …)
  // recompute the same answer. The vocabulary table is insert-only, so cache
  // entries only become stale when new words enter — we clear on actual insert.
  #fuzzyCache = new Map<string, string | null>();
  static readonly FUZZY_CACHE_SIZE = 256;

  constructor(dbPath?: string) {
    const Database = loadDatabase();
    this.#dbPath =
      dbPath ?? join(tmpdir(), `context-mode-${process.pid}.db`);
    cleanOrphanedWALFiles(this.#dbPath);
    let db: DatabaseInstance;
    try {
      db = new Database(this.#dbPath, { timeout: 30000 });
      applyWALPragmas(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSQLiteCorruptionError(msg)) {
        deleteDBFiles(this.#dbPath);
        cleanOrphanedWALFiles(this.#dbPath);
        try {
          db = new Database(this.#dbPath, { timeout: 30000 });
          applyWALPragmas(db);
        } catch (retryErr) {
          throw new Error(
            `Failed to create fresh DB after deleting corrupt file: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
        }
      } else {
        throw err;
      }
    }
    this.#db = db;
    initSchema(this.#db);
    this.#stmts = prepareStatements(this.#db);
  }

  /** Delete this session's DB files. Call on process exit. */
  cleanup(): void {
    try {
      this.#db.close();
    } catch (e) { console.warn("ContentStore.cleanup close failed", e) }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(this.#dbPath + suffix); } catch (e) { console.warn("ContentStore.cleanup unlink failed", e) }
    }
  }

  // ── Index ──

  index(options: {
    content?: string;
    path?: string;
    source?: string;
  }): IndexResult {
    const { content, path, source } = options;

    // Treat empty string as "no content" so an empty `content` paired with a
    // valid `path` falls back to reading the file. Some MCP clients
    // materialize optional string fields as `""` and the previous
    // `content ?? readFileSync(path)` kept the empty string, indexing 0
    // chunks. See issue #350.
    const hasContent = typeof content === "string" && content.length > 0;

    if (!hasContent && !path) {
      throw new Error("Either content or path must be provided");
    }

    const text = hasContent ? content! : readFileSync(path!, "utf-8");
    const label = source ?? path ?? "untitled";
    const chunks = chunkMarkdown(text);

    // Stale detection: store file_path + SHA-256 for file-backed sources
    const filePath = path ?? undefined;
    const contentHash = filePath ? createHash("sha256").update(text).digest("hex") : undefined;

    return withRetry(() => this.#insertChunks(chunks, label, text, filePath, contentHash));
  }

  // ── Index Plain Text ──

  /**
   * Index plain-text output (logs, build output, test results) by splitting
   * into fixed-size line groups. Unlike markdown indexing, this does not
   * look for headings — it chunks by line count with overlap.
   */
  indexPlainText(
    content: string,
    source: string,
    linesPerChunk: number = 20,
  ): IndexResult {
    if (!content || content.trim().length === 0) {
      return this.#insertChunks([], source, "");
    }

    const chunks = chunkPlainText(content, linesPerChunk);

    return withRetry(() => this.#insertChunks(
      chunks.map((c) => ({ ...c, hasCode: false })),
      source,
      content,
    ));
  }

  // ── Index JSON ──

  /**
   * Index JSON content by walking the object tree and using key paths
   * as chunk titles (analogous to heading hierarchy in markdown). Objects
   * recurse by key; arrays batch items by size.
   *
   * Falls back to `indexPlainText` if the content is not valid JSON.
   */
  indexJSON(
    content: string,
    source: string,
    maxChunkBytes: number = MAX_CHUNK_BYTES,
  ): IndexResult {
    if (!content || content.trim().length === 0) {
      return this.indexPlainText("", source);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return this.indexPlainText(content, source);
    }

    const chunks: Chunk[] = [];
    walkJSON(parsed, [], chunks, maxChunkBytes);

    if (chunks.length === 0) {
      return this.indexPlainText(content, source);
    }

    return withRetry(() => this.#insertChunks(chunks, source, content));
  }

  // ── Code symbol chunk indexing ──

  /**
   * Index AST-derived code chunks (one per symbol) into FTS5.
   * Each AstChunk corresponds to a single code symbol extracted by tree-sitter.
   *
   * @param chunks     — AstChunk[] from chunkBySymbols()
   * @param sourcePath — Relative file path used as the source label
   * @param sourceType — Category string (e.g. 'vault-code')
   */
  indexCodeChunks(chunks: AstChunk[], sourcePath: string, sourceType: string): IndexResult {
    if (chunks.length === 0) {
      return { sourceId: 0, label: sourcePath, totalChunks: 0, codeChunks: 0 }
    }

    const label = `code:${sourcePath}`

    const transaction = this.#db.transaction(() => {
      this.#stmts.stmtDeleteChunksByLabel.run(label)
      this.#stmts.stmtDeleteChunksTrigramByLabel.run(label)
      this.#stmts.stmtDeleteSourcesByLabel.run(label)

      const info = this.#stmts.stmtInsertSource.run(label, chunks.length, chunks.length, sourcePath, null)
      const sourceId = Number(info.lastInsertRowid)

      const now = new Date().toISOString()
      for (const chunk of chunks) {
        const meta = chunk.metadata
        const contentWithMeta = `${chunk.content}\n// symbol:${meta.symbolName} kind:${meta.symbolKind}${meta.scope ? ` scope:${meta.scope}` : ''} lines:${meta.lineStart}-${meta.lineEnd}`
        this.#stmts.stmtInsertChunk.run(chunk.title, contentWithMeta, sourceId, 'code', sourceType, null, null, now)
        this.#stmts.stmtInsertChunkTrigram.run(chunk.title, contentWithMeta, sourceId, 'code', sourceType, null, null, now)
      }

      return sourceId
    })

    const sourceId = transaction()

    this.#insertCount++
    if (this.#insertCount % ContentStore.OPTIMIZE_EVERY === 0) {
      this.#optimizeFTS()
    }

    return {
      sourceId,
      label,
      totalChunks: chunks.length,
      codeChunks: chunks.length,
    }
  }

  // ── Shared DB Insertion ──

  /**
   * Shared DB insertion logic for all index methods. Inserts chunks
   * into both FTS5 tables within a transaction and extracts vocabulary.
   * Uses cached prepared statements from #prepareStatements().
   */
  #insertChunks(chunks: Chunk[], label: string, text: string, filePath?: string, contentHash?: string): IndexResult {
    const codeChunks = chunks.filter((c) => c.hasCode).length;

    // Atomic dedup + insert: delete previous source with same label,
    // then insert new content — all within a single transaction.
    // Prevents stale results in iterative workflows. (See: GitHub issue #67)
    const transaction = this.#db.transaction(() => {
      this.#stmts.stmtDeleteChunksByLabel.run(label);
      this.#stmts.stmtDeleteChunksTrigramByLabel.run(label);
      this.#stmts.stmtDeleteSourcesByLabel.run(label);

      if (chunks.length === 0) {
        const info = this.#stmts.stmtInsertSource.run(label, 0, 0, filePath ?? null, contentHash ?? null);
        return Number(info.lastInsertRowid);
      }

      const info = this.#stmts.stmtInsertSource.run(label, chunks.length, codeChunks, filePath ?? null, contentHash ?? null);
      const sourceId = Number(info.lastInsertRowid);

      const now = new Date().toISOString();
      for (const chunk of chunks) {
        const ct = chunk.hasCode ? "code" : "prose";
        this.#stmts.stmtInsertChunk.run(chunk.title, chunk.content, sourceId, ct, null, null, null, now);
        this.#stmts.stmtInsertChunkTrigram.run(chunk.title, chunk.content, sourceId, ct, null, null, null, now);
      }

      return sourceId;
    });

    const sourceId = transaction();
    if (text) extractAndStoreVocabulary(this.#db, this.#stmts.stmtInsertVocab, text, this.#fuzzyCache);

    // Periodically optimize FTS5 indexes to merge b-tree segments.
    // Fragmentation accumulates over insert/delete cycles (dedup re-indexes
    // every source on update). The 'optimize' command merges segments into
    // a single b-tree, improving search latency for long-running sessions.
    this.#insertCount++;
    if (this.#insertCount % ContentStore.OPTIMIZE_EVERY === 0) {
      this.#optimizeFTS();
    }

    return {
      sourceId,
      label,
      totalChunks: chunks.length,
      codeChunks,
    };
  }

  // ── Search ──

  search(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    return searchCore(query, limit, source, mode, contentType, sourceMatchMode, sanitizeQuery, {
      base: this.#stmts.stmtSearchPorter,
      filtered: this.#stmts.stmtSearchPorterFiltered,
      exact: this.#stmts.stmtSearchPorterExact,
      contentType: this.#stmts.stmtSearchPorterContentType,
      filteredContentType: this.#stmts.stmtSearchPorterFilteredContentType,
      exactContentType: this.#stmts.stmtSearchPorterExactContentType,
    }, true);
  }

  // ── Trigram Search (Layer 2) ──

  searchTrigram(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    return searchCore(query, limit, source, mode, contentType, sourceMatchMode, sanitizeTrigramQuery, {
      base: this.#stmts.stmtSearchTrigram,
      filtered: this.#stmts.stmtSearchTrigramFiltered,
      exact: this.#stmts.stmtSearchTrigramExact,
      contentType: this.#stmts.stmtSearchTrigramContentType,
      filteredContentType: this.#stmts.stmtSearchTrigramFilteredContentType,
      exactContentType: this.#stmts.stmtSearchTrigramExactContentType,
    }, false);
  }

  // ── Fuzzy Correction (Layer 3) ──

  fuzzyCorrect(query: string): string | null {
    return fuzzyCorrect(this.#stmts.stmtFuzzyVocab, this.#fuzzyCache, ContentStore.FUZZY_CACHE_SIZE, query);
  }

  // ── Reciprocal Rank Fusion (Cormack et al. 2009) ──

  #rrfSearch(
    query: string,
    limit: number,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const fetchLimit = Math.max(limit * 2, 10);

    const porterResults = this.search(query, fetchLimit, source, "OR", contentType, sourceMatchMode);
    const trigramResults = this.searchTrigram(query, fetchLimit, source, "OR", contentType, sourceMatchMode);

    const key = (r: SearchResult) => `${r.source}::${r.title}`;
    const fused = reciprocalRankFuse([porterResults, trigramResults], key);

    return fused
      .slice(0, limit)
      .map(({ rrfScore, ...rest }) => ({ ...rest, rank: -rrfScore }));
  }

  // ── Unified Fallback Search ──

  async searchWithFallback(
    query: string,
    limit: number = 3,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): Promise<SearchResult[]> {
    // Step 0: Auto-refresh stale file-backed sources before searching
    await this.#refreshStaleSources();

    // Step 1: RRF fusion (porter OR + trigram OR → merge)
    const rrfResults = this.#rrfSearch(query, limit, source, contentType, sourceMatchMode);
    if (rrfResults.length > 0) {
      const reranked = applyProximityReranking(rrfResults, query);
      return reranked.map((r) => ({ ...r, matchLayer: "rrf" as const }));
    }

    // Step 2: Fuzzy correction → RRF re-run
    // Skip stopwords — they'll be filtered by sanitizeQuery anyway, and each
    // fuzzyCorrect call hits the vocab DB + runs levenshtein comparisons.
    const words = query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((w: string) => w.length >= 3 && !STOPWORDS.has(w));
    const original = words.join(" ");
    const correctedWords = words.map((w: string) => this.fuzzyCorrect(w) ?? w);
    const correctedQuery = correctedWords.join(" ");

    if (correctedQuery !== original) {
      const fuzzyResults = this.#rrfSearch(correctedQuery, limit, source, contentType, sourceMatchMode);
      if (fuzzyResults.length > 0) {
        const reranked = applyProximityReranking(fuzzyResults, correctedQuery);
        return reranked.map((r) => ({ ...r, matchLayer: "rrf-fuzzy" as const }));
      }
    }

    return [];
  }

  /** Number of sources auto-refreshed in the last searchWithFallback call. */
  lastRefreshCount = 0;

  /**
   * Check all file-backed sources for staleness and auto re-index changed files.
   * Uses mtime as a fast gate — only computes SHA-256 when mtime has advanced
   * past indexed_at. Gracefully skips deleted files and non-file sources.
   * Uses streaming hash to avoid blocking the event loop on large files.
   */
  async #refreshStaleSources(): Promise<void> {
    this.lastRefreshCount = 0;
    const sources = this.#db.prepare(
      "SELECT label, file_path, content_hash, indexed_at FROM sources WHERE file_path IS NOT NULL",
    ).all() as Array<{ label: string; file_path: string; content_hash: string; indexed_at: string }>;

    for (const src of sources) {
      try {
        if (!existsSync(src.file_path)) continue; // file deleted — keep cached results
        const mtime = statSync(src.file_path).mtime;
        const indexedAt = new Date(src.indexed_at + "Z");
        if (mtime <= indexedAt) continue; // file unchanged — fast path

        // mtime advanced — stream-hash to confirm real change (not just touch)
        const newHash = await new Promise<string>((resolve, reject) => {
          const hash = createHash("sha256");
          createReadStream(src.file_path)
            .on("data", (chunk: string | Buffer) => hash.update(chunk))
            .on("end", () => resolve(hash.digest("hex")))
            .on("error", reject);
        });
        if (newHash === src.content_hash) continue; // content identical — skip

        // File genuinely changed — re-index
        this.index({ path: src.file_path, source: src.label });
        this.lastRefreshCount++;
      } catch (err) {
        console.warn("refreshStaleSource re-index failed", err);
      }
    }
  }

  // ── Sources ──

  getSourceMeta(label: string): { label: string; chunkCount: number; codeChunkCount: number; indexedAt: string; filePath: string | null; contentHash: string | null } | null {
    const row = this.#stmts.stmtSourceMeta.get(label) as { label: string; chunk_count: number; code_chunk_count: number; indexed_at: string; file_path: string | null; content_hash: string | null } | undefined;
    if (!row) return null;
    return { label: row.label, chunkCount: row.chunk_count, codeChunkCount: row.code_chunk_count, indexedAt: row.indexed_at, filePath: row.file_path ?? null, contentHash: row.content_hash ?? null };
  }

  listSources(): Array<{ label: string; chunkCount: number }> {
    return this.#stmts.stmtListSources.all() as Array<{
      label: string;
      chunkCount: number;
    }>;
  }

  /**
   * Get all chunks for a given source by ID — bypasses FTS5 MATCH entirely.
   * Use this for inventory/listing where you need all sections, not search.
   */
  getChunksBySource(sourceId: number): SearchResult[] {
    const rows = this.#stmts.stmtChunksBySource.all(sourceId) as Array<{
      title: string;
      content: string;
      content_type: string;
      label: string;
    }>;

    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      rank: 0,
      contentType: r.content_type as "code" | "prose",
    }));
  }

  // ── Vocabulary ──

  getDistinctiveTerms(sourceId: number, maxTerms: number = 40): string[] {
    const stats = this.#stmts.stmtSourceChunkCount.get(sourceId) as
      | { chunk_count: number }
      | undefined;

    if (!stats || stats.chunk_count < 3) return [];

    const totalChunks = stats.chunk_count;
    const minAppearances = 2;
    const maxAppearances = Math.max(3, Math.ceil(totalChunks * 0.4));

    // Stream chunks one at a time to avoid loading all content into memory
    // Count document frequency (how many sections contain each word)
    const docFreq = new Map<string, number>();

    for (const row of this.#stmts.stmtChunkContent.iterate(sourceId) as Iterable<{ content: string }>) {
      const words = new Set(
        row.content
          .toLowerCase()
          .split(/[^\p{L}\p{N}_-]+/u)
          .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
      );
      for (const word of words) {
        docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
      }
    }

    const filtered = Array.from(docFreq.entries())
      .filter(([, count]) => count >= minAppearances && count <= maxAppearances);

    // Score: IDF (rarity) + length bonus + identifier bonus (underscore/camelCase)
    const scored = filtered.map(([word, count]: [string, number]) => {
      const idf = Math.log(totalChunks / count);
      const lenBonus = Math.min(word.length / 20, 0.5);
      const hasSpecialChars = /[_]/.test(word);
      const isCamelOrLong = word.length >= 12;
      const identifierBonus = hasSpecialChars ? 1.5 : isCamelOrLong ? 0.8 : 0;
      return { word, score: idf + lenBonus + identifierBonus };
    });

    return scored
      .sort((a: { word: string; score: number }, b: { word: string; score: number }) => b.score - a.score)
      .slice(0, maxTerms)
      .map((s: { word: string; score: number }) => s.word);
  }

  // ── Stats ──

  getStats(): StoreStats {
    const row = this.#stmts.stmtStats.get() as {
      sources: number;
      chunks: number;
      codeChunks: number;
    } | undefined;

    return {
      sources: row?.sources ?? 0,
      chunks: row?.chunks ?? 0,
      codeChunks: row?.codeChunks ?? 0,
    };
  }

  // ── Cleanup ──

  /**
   * Delete sources (and their chunks) older than maxAgeDays.
   * Returns count of deleted sources.
   */
  cleanupStaleSources(maxAgeDays: number): number {
    const cleanup = this.#db.transaction((days: number) => {
      this.#stmts.stmtCleanupChunks.run(days);
      this.#stmts.stmtCleanupChunksTrigram.run(days);
      return this.#stmts.stmtCleanupSources.run(days);
    });
    const info = cleanup(maxAgeDays);
    return info.changes;
  }

  /** Get DB file size in bytes. */
  getDBSizeBytes(): number {
    try {
      return statSync(this.#dbPath).size;
    } catch {
      return 0;
    }
  }

  /** Merge FTS5 b-tree segments for both porter and trigram indexes. */
  #optimizeFTS(): void {
    try {
      this.#db.exec("INSERT INTO chunks(chunks) VALUES('optimize')");
      this.#db.exec("INSERT INTO chunks_trigram(chunks_trigram) VALUES('optimize')");
    } catch (e) { console.warn("#optimizeFTS failed", e) }
  }

  close(): void {
    this.#optimizeFTS(); // defragment before close
    closeDB(this.#db); // WAL checkpoint before close — important for persistent DBs
  }
}
