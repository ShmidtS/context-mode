/**
 * Search helpers — query sanitization and RRF fusion.
 *
 * Pure functions shared across the search pipeline.
 */

import type { SearchResult } from "../types.js";
import { STOPWORDS, type SourceMatchMode, type SearchRow } from "./types.js";
import type { PreparedStatement } from "../db-base.js";
import { withRetry } from "../db-base.js";

// ─────────────────────────────────────────────────────────
// Token helpers
// ─────────────────────────────────────────────────────────

/**
 * Remove case-insensitive duplicate tokens while preserving the first
 * occurrence's original casing. FTS5's unicode61 tokenizer lowercases on
 * both sides, so `"Error" OR "error"` produces no extra recall — just
 * redundant index lookups. Dedup keeps the compiled query minimal.
 */
function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/**
 * Format tokens into a quoted FTS5 query string, filtering stopwords.
 * Falls back to unfiltered tokens if ALL are stopwords.
 */
function formatSearchTokens(
  tokens: string[],
  mode: "AND" | "OR",
  emptyFallback: string,
): string {
  if (tokens.length === 0) return emptyFallback;
  const meaningful = tokens.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const final = meaningful.length > 0 ? meaningful : tokens;
  return final.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

export function sanitizeQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const words = dedupeTokens(
    query
      .replace(/['"(){}[\]*:^~]/g, " ")
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 0 &&
          !["AND", "OR", "NOT", "NEAR"].includes(w.toUpperCase()),
      ),
  );
  return formatSearchTokens(words, mode, '""');
}

export function sanitizeTrigramQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const cleaned = query.replace(/["'(){}[\]*:^~]/g, "").trim();
  if (cleaned.length < 3) return "";
  const words = dedupeTokens(
    cleaned.split(/\s+/).filter((w) => w.length >= 3),
  );
  return formatSearchTokens(words, mode, "");
}

// ─────────────────────────────────────────────────────────
// Search row mapping
// ─────────────────────────────────────────────────────────

export function mapSearchRows(rows: SearchRow[]): SearchResult[] {
  return rows.map((r) => ({
    title: r.title,
    content: r.content,
    source: r.label,
    rank: r.rank,
    contentType: r.content_type as "code" | "prose",
    highlighted: r.highlighted,
    timestamp: r.timestamp ?? undefined,
  }));
}

// ─────────────────────────────────────────────────────────
// Statement selection
// ─────────────────────────────────────────────────────────

export function sourceFilterParam(source: string, sourceMatchMode: SourceMatchMode): string {
  return sourceMatchMode === "exact" ? source : `%${source}%`;
}

export interface SearchStmts {
  base: PreparedStatement;
  filtered: PreparedStatement;
  exact: PreparedStatement;
  contentType: PreparedStatement;
  filteredContentType: PreparedStatement;
  exactContentType: PreparedStatement;
}

export function selectSearchStmt(
  stmts: SearchStmts,
  sanitized: string,
  limit: number,
  source: string | undefined,
  contentType: "code" | "prose" | undefined,
  sourceMatchMode: SourceMatchMode,
): { stmt: PreparedStatement; params: unknown[] } {
  if (source && contentType) {
    return {
      stmt: sourceMatchMode === "exact"
        ? stmts.exactContentType
        : stmts.filteredContentType,
      params: [sanitized, sourceFilterParam(source, sourceMatchMode), contentType, limit],
    };
  }
  if (source) {
    return {
      stmt: sourceMatchMode === "exact" ? stmts.exact : stmts.filtered,
      params: [sanitized, sourceFilterParam(source, sourceMatchMode), limit],
    };
  }
  if (contentType) {
    return { stmt: stmts.contentType, params: [sanitized, contentType, limit] };
  }
  return { stmt: stmts.base, params: [sanitized, limit] };
}

// ─────────────────────────────────────────────────────────
// Core search (used by search() and searchTrigram())
// ─────────────────────────────────────────────────────────

export function searchCore(
  query: string,
  limit: number,
  source: string | undefined,
  mode: "AND" | "OR",
  contentType: "code" | "prose" | undefined,
  sourceMatchMode: SourceMatchMode,
  sanitize: (q: string, m: "AND" | "OR") => string,
  stmts: SearchStmts,
  allowEmpty: boolean,
): SearchResult[] {
  const sanitized = sanitize(query, mode);
  if (!allowEmpty && !sanitized) return [];
  const { stmt, params } = selectSearchStmt(stmts, sanitized, limit, source, contentType, sourceMatchMode);
  return withRetry(() => mapSearchRows(stmt.all(...params) as SearchRow[]));
}
