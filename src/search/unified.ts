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
import type { VaultGraphSearch } from "../vault/search.js";
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
  /** Vault graph search — when present, enables vault-graph fusion results with PageRank cache. */
  vaultSearch?: VaultGraphSearch | null;
  /** Vault graph store — needed for timestamp lookups on vault results. */
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
 *
 * Sources 1 (ContentStore), 2 (SessionDB), and 3 (auto-memory) run in
 * parallel via Promise.allSettled. Source 4 (vault-graph) runs after
 * source 1 because fusionSearch depends on ContentStore results.
 */
export async function searchAllSources(opts: SearchAllSourcesOpts): Promise<UnifiedSearchResult[]> {
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
    vaultSearch,
    vaultStore,
  } = opts;

  // Capture session start time once — used as proxy for ContentStore items
  // (we don't know exact indexing time, but all content is from current session)
  const sessionStartTime = new Date().toISOString();

  // ── Sources 1, 2, 3: run in parallel ──
  const [s1, s2, s3] = await Promise.allSettled([
    // Source 1: ContentStore (always, both modes)
    (async () => {
      try {
        const storeResults = await store.searchWithFallback(query, limit, source, contentType);
        const unified = storeResults.map((r: SearchResult) => ({
          title: r.title,
          content: r.content,
          source: r.source,
          origin: "current-session" as const,
          timestamp: r.timestamp || sessionStartTime,
          rank: r.rank,
          matchLayer: r.matchLayer,
          highlighted: r.highlighted,
          contentType: r.contentType,
        }));
        return { storeResults, unified };
      } catch (e) {
        if (DEBUG) process.stderr.write(`[ctx] ContentStore search failed: ${e}\n`);
        return { storeResults: [] as SearchResult[], unified: [] as UnifiedSearchResult[] };
      }
    })(),

    // Source 2: SessionDB — prior session events (timeline mode only)
    (async () => {
      if (sort !== "timeline" || !sessionDB) return [] as UnifiedSearchResult[];
      try {
        const dbResults = sessionDB.searchEvents(query, limit, projectDir || "", source);
        return dbResults.map((r: Pick<StoredEvent, "id" | "session_id" | "category" | "type" | "data" | "created_at">) => ({
          title: `[${r.category}] ${r.type}`,
          content: r.data,
          source: "prior-session",
          origin: "prior-session" as const,
          timestamp: r.created_at,
        }));
      } catch (e) {
        if (DEBUG) process.stderr.write(`[ctx] SessionDB search failed: ${e}\n`);
        return [];
      }
    })(),

    // Source 3: Auto-memory (timeline mode only)
    (async () => {
      if (sort !== "timeline") return [] as UnifiedSearchResult[];
      try {
        return searchAutoMemory([query], limit, projectDir, configDir, adapter);
      } catch (e) {
        if (DEBUG) process.stderr.write(`[ctx] auto-memory search failed: ${e}\n`);
        return [];
      }
    })(),
  ]);

  // Extract parallel results
  const storeResults = s1.status === "fulfilled" ? s1.value.storeResults : [];
  const results: UnifiedSearchResult[] = [
    ...(s1.status === "fulfilled" ? s1.value.unified : []),
    ...(s2.status === "fulfilled" ? s2.value : []),
    ...(s3.status === "fulfilled" ? s3.value : []),
  ];

  // ── Source 4: Vault-graph (both modes, when vaultSearch present) ──
  // Runs after source 1 — fusionSearch needs storeResults.
  if (vaultSearch) {
    try {
      const graphResults = vaultSearch.fusionSearch(query, storeResults);

      if (sort === "timeline") {
        // Timeline mode: interleave vault results by indexed_at timestamp
        for (const gr of graphResults) {
          const node = vaultStore?.getNodeById(gr.id);
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
