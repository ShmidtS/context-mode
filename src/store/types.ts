/**
 * Internal types for the store module.
 * Public-facing types (SearchResult, IndexResult, StoreStats) live in src/types.ts.
 */

export interface Chunk {
  title: string;
  content: string;
  hasCode: boolean;
}

export type SourceMatchMode = "like" | "exact";

export type SearchRow = {
  title: string;
  content: string;
  content_type: string;
  timestamp: string | null;
  label: string;
  rank: number;
  highlighted: string;
};

export const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
  "new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
  "say", "she", "too", "use", "will", "with", "this", "that", "from",
  "they", "been", "have", "many", "some", "them", "than", "each", "make",
  "like", "just", "over", "such", "take", "into", "year", "your", "good",
  "could", "would", "about", "which", "their", "there", "other", "after",
  "should", "through", "also", "more", "most", "only", "very", "when",
  "what", "then", "these", "those", "being", "does", "done", "both",
  "same", "still", "while", "where", "here", "were", "much",
  // Common in code/changelogs
  "update", "updates", "updated", "deps", "dev", "tests", "test",
  "add", "added", "fix", "fixed", "run", "running", "using",
]);

export const MAX_CHUNK_BYTES = 4096;

export const FTS5_COLUMNS = `
  title,
  content,
  source_id UNINDEXED,
  content_type UNINDEXED,
  source_category UNINDEXED,
  session_id UNINDEXED,
  event_id UNINDEXED,
  timestamp UNINDEXED`;
