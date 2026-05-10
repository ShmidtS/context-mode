/**
 * Vocabulary extraction and fuzzy correction.
 *
 * Vocabulary extraction stores unique words for fuzzy matching.
 * Fuzzy correction uses Levenshtein distance with an LRU cache.
 */

import type { Database as DatabaseInstance } from "better-sqlite3";
import type { PreparedStatement } from "../db-base.js";
import { STOPWORDS } from "./types.js";

// ─────────────────────────────────────────────────────────
// Fuzzy correction helpers
// ─────────────────────────────────────────────────────────

export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

export function maxEditDistance(wordLength: number): number {
  if (wordLength <= 4) return 1;
  if (wordLength <= 12) return 2;
  return 3;
}

// ─────────────────────────────────────────────────────────
// Vocabulary extraction
// ─────────────────────────────────────────────────────────

export function extractAndStoreVocabulary(
  db: DatabaseInstance,
  stmtInsertVocab: PreparedStatement,
  content: string,
  fuzzyCache: Map<string, string | null>,
): void {
  const words = content
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  const unique = [...new Set(words)];

  let inserted = 0;
  db.transaction(() => {
    for (const word of unique) {
      const info = stmtInsertVocab.run(word);
      inserted += info.changes;
    }
  })();

  // Invalidate fuzzy cache when new vocab words actually land. INSERT OR
  // IGNORE reports changes=0 for duplicates, so re-indexing identical
  // content does not thrash the cache during iterative workflows.
  if (inserted > 0) fuzzyCache.clear();
}

// ─────────────────────────────────────────────────────────
// Fuzzy correction
// ─────────────────────────────────────────────────────────

export function fuzzyCorrect(
  stmtFuzzyVocab: PreparedStatement,
  fuzzyCache: Map<string, string | null>,
  maxCacheSize: number,
  query: string,
): string | null {
  const word = query.toLowerCase().trim();
  if (word.length < 3) return null;

  // Cache hit: promote to tail (Map preserves insertion order → LRU).
  if (fuzzyCache.has(word)) {
    const cached = fuzzyCache.get(word) ?? null;
    fuzzyCache.delete(word);
    fuzzyCache.set(word, cached);
    return cached;
  }

  const maxDist = maxEditDistance(word.length);

  const candidates = stmtFuzzyVocab.all(
    word.length - maxDist,
    word.length + maxDist,
  ) as Array<{ word: string }>;

  let bestWord: string | null = null;
  let bestDist = maxDist + 1;
  let exactMatch = false;

  for (const { word: candidate } of candidates) {
    if (candidate === word) {
      exactMatch = true;
      break;
    }
    const dist = levenshtein(word, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      bestWord = candidate;
    }
  }

  const result = exactMatch ? null : bestDist <= maxDist ? bestWord : null;

  // Evict the oldest entry before insert if we hit the size cap.
  if (fuzzyCache.size >= maxCacheSize) {
    const oldestKey = fuzzyCache.keys().next().value;
    if (oldestKey !== undefined) fuzzyCache.delete(oldestKey);
  }
  fuzzyCache.set(word, result);

  return result;
}
