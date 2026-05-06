# Context Mode — Benchmark Results

> Benchmarked against real outputs from Claude Code MCP servers, Skills, and dev tools. All fixtures from actual tool invocations.

## Overview

| Metric | Value |
|--------|-------|
| Total scenarios | 21 |
| Tools benchmarked | `ctx_execute_file` (summarize) + `ctx_index`/`ctx_search` (knowledge retrieval) |
| Truncation strategy | Head + tail (60/40 split) |
| Total raw data | 376 KB |
| Total context consumed | 16.5 KB |
| Overall savings | **96%** |
| Code examples preserved | **100%** |

## Tool Decision Matrix

| Data Type | Best Tool | Why |
|-----------|-----------|-----|
| Documentation, API refs | `ctx_index` + `ctx_search` | Need exact code, not summaries |
| Skills prompts | `ctx_index` + `ctx_search` | Large prompts; search on-demand |
| Log files, test output | `ctx_execute_file` | Need aggregate stats |
| CSV data, analytics | `ctx_execute_file` | Need computed metrics |
| Build output | `ctx_execute_file` | Need error counts |
| Browser snapshots | `ctx_execute_file` | Need page structure summary |

## Part 1: `ctx_execute_file` — Structured Data Processing

| Scenario | Source | Raw Size | Context | Savings |
|----------|--------|----------|---------|---------|
| React useEffect docs | Context7 | 5.9 KB | 261 B | 96% |
| Next.js App Router docs | Context7 | 6.5 KB | 249 B | 96% |
| Tailwind CSS docs | Context7 | 4.0 KB | 186 B | 95% |
| Page snapshot (Hacker News) | Playwright | 56.2 KB | 299 B | 99% |
| PR list (vercel/next.js) | GitHub | 6.4 KB | 719 B | 89% |
| Issues (facebook/react) | GitHub | 58.9 KB | 1,139 B | 98% |
| Test output (30 suites) | vitest | 6.0 KB | 337 B | 95% |
| TypeScript errors (50) | tsc | 4.9 KB | 347 B | 93% |
| Build output (100+ lines) | next build | 6.4 KB | 405 B | 94% |
| MCP tools (40 tools) | MCP tools/list | 17.0 KB | 742 B | 96% |
| Access log (500 requests) | nginx | 45.1 KB | 155 B | 100% |
| Git log (150+ commits) | git | 11.6 KB | 107 B | 99% |
| Analytics CSV (500 rows) | analytics | 85.5 KB | 222 B | 100% |

**Subtotal: 315 KB raw -> 5.5 KB context (98% savings)**

## Part 2: `ctx_index` + `ctx_search` — Knowledge Retrieval

| Scenario | Source | Raw Size | Search Result (3 queries) | Savings | Code Blocks |
|----------|--------|----------|---------------------------|---------|-------------|
| Supabase Edge Functions | Context7 | 3.9 KB | 2,246 B | 44% | 4 |
| React useEffect docs | Context7 | 5.9 KB | 1,494 B | 75% | 4 |
| Next.js App Router docs | Context7 | 6.5 KB | 3,311 B | 50% | 5 |
| Tailwind CSS docs | Context7 | 4.0 KB | 620 B | 85% | 5 |
| Skill prompt (main) | context-mode | 4.4 KB | 932 B | 79% | 6 |
| Skill references (4 files) | context-mode | 33.2 KB | 2,412 B | 93% | 32 |

**Subtotal: 60.3 KB raw -> 11.0 KB context (82% savings)**

`ctx_index + ctx_search` returns **exact code blocks** — not summaries. Lower percentage savings but actually useful for coding.

## Smart Truncation

When output exceeds limit: head (60%) + tail (40%), snapped to line boundaries. Error messages at the end are preserved.

| Before (v0.2) | After (v0.3) |
|---|---|
| Blindly keeps first N bytes | Head (60%) + tail (40%) |
| Cuts mid-line | Snaps to line boundaries |
| Error messages: LOST | Error messages: PRESERVED |
| `"... [output truncated]"` | `"[47 lines / 3.2KB truncated — showing first 12 + last 8 lines]"` |

## Test Suite

| Suite | Tests | Status |
|-------|-------|--------|
| Executor (10 languages) | 55 | All pass |
| ContentStore (FTS5 BM25) | 34 | All pass |
| MCP Integration | 22 | All pass |
| Ecosystem Benchmark | 14 | All pass |
| **Total** | **125** | **All pass** |
