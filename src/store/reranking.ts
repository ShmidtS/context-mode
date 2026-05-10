/**
 * Proximity reranking — min-span, adjacent-pair counting, and reranking.
 *
 * Pure functions with no DB dependency. Used by the search pipeline to
 * boost results where query terms appear close together.
 */

import type { SearchResult } from "../types.js";
import { STOPWORDS } from "./types.js";

// ─────────────────────────────────────────────────────────
// Position helpers
// ─────────────────────────────────────────────────────────

/** Find all positions of a term in text. */
export function findAllPositions(text: string, term: string): number[] {
  const positions: number[] = [];
  let idx = text.indexOf(term);
  while (idx !== -1) {
    positions.push(idx);
    idx = text.indexOf(term, idx + 1);
  }
  return positions;
}

/**
 * Count matched adjacent pairs across consecutive query terms.
 * For each pair (term[i], term[i+1]), pairs each left position with at most one
 * right position whose offset falls within `gap` chars of `p + len(term[i])`.
 * `positionLists` must be sorted ascending (output of `findAllPositions` is).
 * Each right position is consumed by at most one left, so `"foo foo bar"`
 * counts 1 pair, not 2 — matches IR phrase-occurrence intent and avoids
 * inflating boosts for repeated-token queries.
 * Used by reranker to layer a frequency signal on top of minSpan proximity:
 * 30-char gap covers natural prose without rewarding distant matches.
 */
export function countAdjacentPairs(
  positionLists: number[][],
  terms: string[],
  gap: number = 30,
): number {
  if (positionLists.length < 2 || terms.length < 2) return 0;
  let total = 0;
  const pairs = Math.min(positionLists.length, terms.length) - 1;
  for (let i = 0; i < pairs; i++) {
    const left = positionLists[i];
    const right = positionLists[i + 1];
    const leftLen = terms[i].length;
    let j = 0;
    for (const p of left) {
      const minStart = p + leftLen;
      const maxStart = minStart + gap;
      while (j < right.length && right[j] < minStart) j++;
      if (j < right.length && right[j] <= maxStart) {
        total++;
        j++;
      }
    }
  }
  return total;
}

/**
 * Find minimum span (window) covering at least one position from each list.
 * Uses a sweep-line approach: advance the pointer at the current minimum.
 */
export function findMinSpan(positionLists: number[][]): number {
  if (positionLists.length === 0) return Infinity;
  if (positionLists.length === 1) return 0;

  const sorted = positionLists.map((p) => [...p].sort((a, b) => a - b));
  const ptrs = new Array(sorted.length).fill(0);
  let minSpan = Infinity;

  while (true) {
    let curMin = Infinity;
    let curMax = -Infinity;
    let minIdx = 0;

    for (let i = 0; i < sorted.length; i++) {
      const val = sorted[i][ptrs[i]];
      if (val < curMin) {
        curMin = val;
        minIdx = i;
      }
      if (val > curMax) {
        curMax = val;
      }
    }

    const span = curMax - curMin;
    if (span < minSpan) minSpan = span;

    ptrs[minIdx]++;
    if (ptrs[minIdx] >= sorted[minIdx].length) break;
  }

  return minSpan;
}

// ─────────────────────────────────────────────────────────
// Reranking
// ─────────────────────────────────────────────────────────

export function applyProximityReranking(
  results: SearchResult[],
  query: string,
): SearchResult[] {
  const allTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  // Exclude stopwords from proximity/title scoring — they match everywhere
  // and inflate boosts for irrelevant chunks. Keep all terms as fallback.
  const filtered = allTerms.filter((w) => !STOPWORDS.has(w));
  const terms = filtered.length > 0 ? filtered : allTerms;

  return results
    .map((r) => {
      // Title-match boost: query terms found in the chunk title get a boost.
      // Code chunks get a stronger title boost (function/class names are high
      // signal) while prose chunks get a moderate one (headings are useful but
      // body carries more weight).
      const titleLower = r.title.toLowerCase();
      const titleHits = terms.filter((t) => titleLower.includes(t)).length;
      const titleWeight = r.contentType === "code" ? 0.6 : 0.3;
      const titleBoost = titleHits > 0 ? titleWeight * (titleHits / terms.length) : 0;

      // Proximity boost for multi-term queries. minSpan picks the single
      // tightest window — frequency doesn't move it, so a long doc with one
      // tight occurrence outranks a short doc with several. Phrase-frequency
      // reward layers a saturating frequency signal on top: cap 0.5 (below
      // proximity max ≈1.0, in title-boost range), saturates at 4 hits.
      let proximityBoost = 0;
      let phraseBoost = 0;
      if (terms.length >= 2) {
        const content = r.content.toLowerCase();
        const positions = terms.map((t) => findAllPositions(content, t));

        if (!positions.some((p) => p.length === 0)) {
          const minSpan = findMinSpan(positions);
          proximityBoost = 1 / (1 + minSpan / Math.max(content.length, 1));

          const adjacentPairs = countAdjacentPairs(positions, terms);
          phraseBoost = 0.5 * Math.min(1, adjacentPairs / 4);
        }
      }

      return { result: r, boost: titleBoost + proximityBoost + phraseBoost };
    })
    .sort((a, b) => b.boost - a.boost || a.result.rank - b.result.rank)
    .map(({ result }) => result);
}
