/**
 * ContextPacker — Token-aware context packing for LLM consumption.
 *
 * Takes ranked search results and packs them into a single markdown string
 * that fits within a token budget. Uses conservative char/token heuristic
 * by default, with optional tiktoken when available.
 *
 * Pure utility — no DB or file system dependency.
 */

import type { SearchResult } from '../store.js'

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface PackOptions {
  tokenBudget?: number
  dedup?: boolean
}

export interface PackedItem {
  title: string
  tokens: number
  rank: number
}

export interface PackResult {
  packed: string
  tokensUsed: number
  items: PackedItem[]
}

// ─────────────────────────────────────────────────────────
// tiktoken lazy loader
// ─────────────────────────────────────────────────────────

let _tiktokenEncoder: {
  encode: (text: string) => Uint32Array | number[]
  free: () => void
} | null | undefined = undefined // undefined = not tried yet

async function tryLoadTiktoken(): Promise<typeof _tiktokenEncoder> {
  if (_tiktokenEncoder !== undefined) return _tiktokenEncoder
  try {
    const mod = await import('tiktoken')
    const encoding = mod.encoding_for_model('gpt-4')
    _tiktokenEncoder = encoding
    return _tiktokenEncoder
  } catch {
    _tiktokenEncoder = null
    return null
  }
}

// ─────────────────────────────────────────────────────────
// ContextPacker
// ─────────────────────────────────────────────────────────

export class ContextPacker {
  readonly maxTokens: number

  constructor(maxTokens: number = 8000) {
    this.maxTokens = maxTokens
  }

  /**
   * Estimate token count for a string.
   * Uses tiktoken if available (async), otherwise falls back to
   * Math.ceil(text.length / 3.2) — conservative heuristic with 20% margin.
   */
  async estimateTokens(text: string): Promise<number> {
    const encoder = await tryLoadTiktoken()
    if (encoder) {
      return encoder.encode(text).length
    }
    return Math.ceil(text.length / 3.2)
  }

  /**
   * Pack search results into a single markdown string within token budget.
   *
   * - Results sorted by score descending (already ranked by RRF).
   * - Each item's token cost estimated conservatively.
   * - Dedup enabled by default: skip items with >80% content overlap.
   * - Output formatted as ranked markdown sections.
   */
  async pack(
    query: string,
    results: SearchResult[],
    options?: PackOptions,
  ): Promise<PackResult> {
    const tokenBudget = options?.tokenBudget ?? this.maxTokens
    const dedup = options?.dedup ?? true

    // Sort by score descending (lower rank value = higher score in BM25 convention)
    const sorted = [...results].sort((a, b) => a.rank - b.rank)

    const packed: string[] = []
    const items: PackedItem[] = []
    let tokensUsed = 0
    const seenContents: string[] = []

    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i]
      const titleText = r.title || 'Untitled'
      const contentText = r.content || ''

      // Estimate tokens for this item's markdown block
      const blockText = `## ${i + 1}. ${titleText} (score: ${(-r.rank).toFixed(3)})\n${contentText}`
      const itemTokens = await this.estimateTokens(blockText)

      if (tokensUsed + itemTokens > tokenBudget) {
        // Budget exceeded — skip this and remaining items
        break
      }

      // Dedup: skip if >80% of content is a substring of already-packed content
      if (dedup && contentText.length > 50) {
        const contentLower = contentText.toLowerCase()
        let isDuplicate = false
        for (const seen of seenContents) {
          // Simple overlap check: if >80% of content is contained in seen, skip
          const overlapLen = longestCommonSubstring(contentLower, seen.toLowerCase())
          if (overlapLen / contentLower.length > 0.8) {
            isDuplicate = true
            break
          }
        }
        if (isDuplicate) continue
        seenContents.push(contentLower)
      } else if (dedup) {
        seenContents.push(contentText.toLowerCase())
      }

      packed.push(blockText)
      items.push({
        title: titleText,
        tokens: itemTokens,
        rank: i + 1,
      })
      tokensUsed += itemTokens
    }

    return {
      packed: packed.join('\n\n'),
      tokensUsed,
      items,
    }
  }
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Approximate longest common substring using a sliding window approach.
 * Keeps it simple — O(n*m) but for short strings (search result snippets)
 * this is fine. Returns the length of the longest common substring.
 */
function longestCommonSubstring(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  // For efficiency on longer strings, use a binary search on substring length
  const shorter = a.length < b.length ? a : b
  const longer = a.length < b.length ? b : a

  let lo = 0
  let hi = shorter.length
  let best = 0

  // Binary search for longest matching substring length
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (mid === 0) { lo = 1; continue }

    // Check if any substring of length `mid` from shorter exists in longer
    let found = false
    for (let i = 0; i <= shorter.length - mid; i++) {
      if (longer.includes(shorter.substring(i, i + mid))) {
        found = true
        break
      }
    }

    if (found) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return best
}
