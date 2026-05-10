/**
 * Reciprocal Rank Fusion (Cormack et al. 2009).
 *
 * Pure function utility — fuses multiple ranked result lists into a single
 * ranked list using the standard RRF formula: score = Σ 1/(k + rank).
 */

/**
 * Fuse multiple ranked result lists using Reciprocal Rank Fusion.
 *
 * @param resultsArrays - Array of ranked result lists to fuse
 * @param keyFn - Function to extract a unique key from each item for dedup
 * @param k - RRF constant (default 60), dampens high-rank contribution
 * @returns Fused results sorted by rrfScore descending, with rrfScore attached
 */
export function reciprocalRankFuse<T extends object>(
  resultsArrays: Array<Array<T>>,
  keyFn: (item: T) => string,
  k = 60,
): Array<T & { rrfScore: number }> {
  const scoreMap = new Map<string, { item: T; score: number }>();

  for (const results of resultsArrays) {
    for (const [i, r] of results.entries()) {
      const key = keyFn(r);
      const rrfScore = 1 / (k + i + 1);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { item: r, score: rrfScore });
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, rrfScore: score }));
}
