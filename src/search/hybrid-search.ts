/**
 * Hybrid search — 3-way Reciprocal Rank Fusion (RRF).
 *
 * Fuses BM25, vector-semantic, and graph results into a single ranked list.
 * Pure function utility — no DB or file system access.
 */

import type { SearchResult } from '../store.js'

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface ScoredResult {
  id: string | number
  score: number
  metadata?: Record<string, unknown>
}

export interface FuseOptions {
  bm25Weight?: number
  vectorWeight?: number
  graphWeight?: number
  k?: number
}

// ─────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────

/**
 * Fuse three ranked result lists using Reciprocal Rank Fusion.
 *
 * RRF score = Σ (weight_source × 1 / (k + rank_in_source))
 * where k=60 is the standard constant that dampens the contribution
 * of high ranks (prevents top-1 dominance).
 *
 * Results are merged by `id` (string or number). If a result appears
 * in multiple sources, its RRF scores accumulate — items found by
 * both BM25 and vector search rank higher than single-source hits.
 *
 * When `metadata` contains a `path` field, dedup falls back to path
 * comparison if no direct id match is found.
 */
export function fuseThreeWay(
  bm25Results: ScoredResult[],
  vectorResults: ScoredResult[],
  graphResults: ScoredResult[],
  options?: FuseOptions,
): SearchResult[] {
  const {
    bm25Weight = 1.0,
    vectorWeight = 1.0,
    graphWeight = 1.0,
    k = 60,
  } = options ?? {}

  const fusedMap = new Map<string, { result: ScoredResult; score: number }>()

  const resolveKey = (r: ScoredResult): string => {
    if (r.metadata?.path && typeof r.metadata.path === 'string') {
      return String(r.metadata.path)
    }
    return String(r.id)
  }

  const addSource = (results: ScoredResult[], weight: number): void => {
    for (const [i, r] of results.entries()) {
      const key = resolveKey(r)
      const rrfScore = weight * (1 / (k + i + 1))
      const existing = fusedMap.get(key)
      if (existing) {
        existing.score += rrfScore
        // Preserve richer metadata on merge
        if (r.metadata && !existing.result.metadata) {
          existing.result.metadata = r.metadata
        }
      } else {
        fusedMap.set(key, { result: { ...r }, score: rrfScore })
      }
    }
  }

  addSource(bm25Results, bm25Weight)
  addSource(vectorResults, vectorWeight)
  addSource(graphResults, graphWeight)

  return Array.from(fusedMap.values())
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({
      title: (result.metadata?.title as string) ?? String(result.id),
      content: (result.metadata?.content as string) ?? '',
      source: (result.metadata?.source as string) ?? String(result.id),
      rank: -score,
      contentType: ((result.metadata?.contentType as 'code' | 'prose') ?? 'prose'),
      matchLayer: 'rrf-3way' as const,
    }))
}
