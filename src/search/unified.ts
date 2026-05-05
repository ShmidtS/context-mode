/**
 * Unified multi-source search — merges ContentStore, SessionDB, and
 * auto-memory results into a single ranked or chronological result set.
 *
 * Used by ctx_search when sort="timeline" to search across all sources,
 * or sort="relevance" (default) for ContentStore-only BM25 search.
 */

import type { ContentStore, SearchResult } from "../store.js";
import type { SessionDB, StoredEvent } from "../session/db.js";
import type { VaultGraphStore } from "../vault/graph-store.js";
import { VaultGraphSearch } from "../vault/search.js";
import { searchAutoMemory, type AutoMemoryAdapter } from "./auto-memory.js";

const DEBUG = process.env.DEBUG?.includes("context-mode");

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface UnifiedSearchResult {
  title: string;
  content: string;
  source: string;
  origin: "current-session" | "prior-session" | "auto-memory" | "vault-graph";
  timestamp?: string;
  rank?: number;
  matchLayer?: string;
  highlighted?: string;
  contentType?: "code" | "prose";
}

export interface SearchAllSourcesOpts {
  query: string;
  limit: number;
  store: ContentStore;
  sort?: "relevance" | "timeline";
  source?: string;
  contentType?: "code" | "prose";
  sessionDB?: SessionDB | null;
  projectDir?: string;
  configDir?: string;
  /** Detected platform adapter — used for adapter-aware auto-memory. */
  adapter?: AutoMemoryAdapter;
  /** Vault graph store — when present, enables vault-graph fusion results. */
  vaultStore?: VaultGraphStore | null;
}

// ─────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────

/**
 * Search across all available sources.
 *
 * - sort="relevance" (default): BM25-ranked results from ContentStore only.
 * - sort="timeline": chronological merge of ContentStore + SessionDB + auto-memory.
 *
 * Errors in any single source are caught and logged — partial results
 * are always returned.
 */
export function searchAllSources(opts: SearchAllSourcesOpts): UnifiedSearchResult[] {
  const {
    query,
    limit,
    store,
    sort = "relevance",
    source,
    contentType,
    sessionDB,
    projectDir,
    configDir,
    adapter,
    vaultStore,
  } = opts;

  const results: UnifiedSearchResult[] = [];

  // Capture session start time once — used as proxy for ContentStore items
  // (we don't know exact indexing time, but all content is from current session)
  const sessionStartTime = new Date().toISOString();

  // ── Source 1: ContentStore (always, both modes) ──
  let storeResults: SearchResult[] = [];
  try {
    storeResults = store.searchWithFallback(query, limit, source, contentType);
    results.push(
      ...storeResults.map((r: SearchResult) => ({
        title: r.title,
        content: r.content,
        source: r.source,
        origin: "current-session" as const,
        timestamp: r.timestamp || sessionStartTime,
        rank: r.rank,
        matchLayer: r.matchLayer,
        highlighted: r.highlighted,
        contentType: r.contentType,
      })),
    );
  } catch (e) {
    if (DEBUG) process.stderr.write(`[ctx] ContentStore search failed: ${e}\n`);
  }

  // ── Sources 2+3: timeline mode only ──
  if (sort === "timeline") {
    // Source 2: SessionDB — prior session events
    try {
      if (sessionDB) {
        const dbResults = sessionDB.searchEvents(query, limit, projectDir || "", source);
        results.push(
          ...dbResults.map((r: Pick<StoredEvent, "id" | "session_id" | "category" | "type" | "data" | "created_at">) => ({
            title: `[${r.category}] ${r.type}`,
            content: r.data,
            source: "prior-session",
            origin: "prior-session" as const,
            timestamp: r.created_at,
          })),
        );
      }
    } catch (e) {
      if (DEBUG) process.stderr.write(`[ctx] SessionDB search failed: ${e}\n`);
    }

    // Source 3: Auto-memory
    try {
      const memResults = searchAutoMemory([query], limit, projectDir, configDir, adapter);
      results.push(...memResults);
    } catch (e) {
      if (DEBUG) process.stderr.write(`[ctx] auto-memory search failed: ${e}\n`);
    }
  }

  // ── Source 4: Vault-graph (both modes, when vaultStore present) ──
  if (vaultStore) {
    try {
      const graphSearch = new VaultGraphSearch(vaultStore);
      const graphResults = graphSearch.fusionSearch(query, storeResults);

      if (sort === "timeline") {
        // Timeline mode: interleave vault results by indexed_at timestamp
        for (const gr of graphResults) {
          const node = vaultStore.getNodeById(gr.id);
          const timestamp = node?.indexed_at;
          results.push({
            title: gr.title,
            content: gr.snippet ?? "",
            source: gr.path,
            origin: "vault-graph" as const,
            timestamp,
            rank: gr.fusionScore,
            matchLayer: gr.matchLayer,
            contentType: "prose",
          });
        }
      } else {
        // Relevance mode: append vault-graph results AFTER current-session
        // fusion score becomes the rank
        for (const gr of graphResults) {
          results.push({
            title: gr.title,
            content: gr.snippet ?? "",
            source: gr.path,
            origin: "vault-graph" as const,
            rank: gr.fusionScore,
            matchLayer: gr.matchLayer,
            contentType: "prose",
          });
        }
      }
    } catch (e) {
      if (DEBUG) process.stderr.write(`[ctx] vault-graph search failed: ${e}\n`);
    }
  }

  // ── Normalize timestamps for consistent sorting ──
  // SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (no T, no Z)
  // ISO → "YYYY-MM-DDTHH:MM:SS.sssZ"
  for (const r of results) {
    if (r.timestamp && !r.timestamp.includes("T")) {
      r.timestamp = r.timestamp.replace(" ", "T") + "Z";
    }
  }

  // ── Sort ──
  if (sort === "timeline") {
    results.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  } else {
    // Relevance mode: higher rank first (ContentStore BM25 + vault-graph fusion scores)
    results.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  }

  return results.slice(0, limit);
}
