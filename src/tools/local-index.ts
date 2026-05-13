/**
 * local-index — MCP tool handlers for ctx_local_index, ctx_local_search,
 * ctx_local_status, ctx_local_repos.
 */

import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LocalIndexer } from "../local-indexer.js";
import { LocalSearcher } from "../searcher.js";
import { rerank } from "../rerank.js";
import { formatResults } from "../result-formatter.js";
import { startWatching, stopWatching } from "../watcher.js";

function deriveRepoId(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "repo";
}

export function registerLocalIndexTools(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
): void {
  // ── ctx_local_index ────────────────────────────────────────
  server.registerTool(
    "ctx_local_index",
    {
      title: "Local Code Index",
      description:
        "Index a local source code repository for semantic and full-text search. " +
        "Uses Merkle diff for incremental updates — unchanged files are skipped on re-index.",
      inputSchema: z.object({
        path: z.string().describe("Absolute or relative path to the repository root to index."),
        repo_id: z.string().optional().describe("Repository identifier. Defaults to the directory name."),
        fresh: z.boolean().optional().default(false).describe("If true, re-index from scratch (ignore previous state)."),
      }),
    },
    async ({ path, repo_id, fresh }) => {
      try {
        const resolved = resolve(path);
        if (!existsSync(resolved)) {
          return {
            content: [{ type: "text" as const, text: `Directory not found: ${resolved}` }],
            isError: true,
          };
        }
        const repoId = repo_id || deriveRepoId(resolved);
        const indexer = new LocalIndexer();
        const result = await indexer.indexRepository(resolved, repoId, { fresh });
        indexer.close();

        if (result.status === "failed") {
          return {
            content: [{ type: "text" as const, text: `Index failed: ${result.error || "unknown error"}` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `Indexed ${result.filesIndexed} files (${result.chunksIndexed} chunks) for repo "${repoId}".\nJob ID: ${result.id}\nStatus: ${result.status}`,
          }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ctx_local_index error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── ctx_local_search ───────────────────────────────────────
  server.registerTool(
    "ctx_local_search",
    {
      title: "Local Code Search",
      description:
        "Search indexed local code repositories using FTS5 BM25 + vector hybrid ranking. " +
        "Returns code chunks (functions, classes, etc.) sorted by relevance.",
      inputSchema: z.object({
        query: z.string().describe("Search query (free text)."),
        repo_id: z.string().optional().describe("Limit search to a specific repository."),
        limit: z.number().optional().default(10).describe("Maximum number of results (default 10)."),
        intent: z.string().optional().describe("Optional intent hint for future rerankers."),
      }),
    },
    async ({ query, repo_id, limit }) => {
      try {
        const searcher = new LocalSearcher();
        const results = await searcher.search(query, repo_id, limit * 2);
        searcher.close();

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No results found.\nTip: run ctx_local_index first." }],
          };
        }

        const reranked = await rerank(query, results, limit);
        const formatted = formatResults(reranked, 2000);

        const payload = JSON.stringify({
          query,
          repo_id: repo_id || null,
          results: formatted,
        }, null, 2);

        return {
          content: [{ type: "text" as const, text: payload }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ctx_local_search error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── ctx_local_status ───────────────────────────────────────
  server.registerTool(
    "ctx_local_status",
    {
      title: "Local Index Job Status",
      description: "Check the status of a local indexing job by its job ID.",
      inputSchema: z.object({
        job_id: z.string().describe("Job ID returned by ctx_local_index."),
      }),
    },
    async ({ job_id }) => {
      try {
        const indexer = new LocalIndexer();
        const job = indexer.getJobStatus(job_id);
        indexer.close();

        if (!job) {
          return {
            content: [{ type: "text" as const, text: `Job not found: ${job_id}` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `Job ${job.id}\n  status: ${job.status}\n  files: ${job.filesIndexed}\n  chunks: ${job.chunksIndexed}\n  error: ${job.error || "none"}`,
          }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ctx_local_status error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── ctx_local_repos ────────────────────────────────────────
  server.registerTool(
    "ctx_local_repos",
    {
      title: "List Local Repos",
      description: "List all locally indexed repositories with file counts.",
      inputSchema: z.object({
        path: z.string().optional().describe("Optional path filter (not implemented — lists all)."),
      }),
    },
    async () => {
      try {
        const indexer = new LocalIndexer();
        const repos = indexer.listRepos();
        indexer.close();

        if (repos.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No repositories indexed yet.\nRun ctx_local_index to get started." }],
          };
        }

        const lines = repos.map((r) => `  ${r.repoId}: ${r.files} files`).join("\n");
        return {
          content: [{ type: "text" as const, text: `Indexed repositories:\n${lines}` }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ctx_local_repos error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── ctx_local_watch ────────────────────────────────────────
  server.registerTool(
    "ctx_local_watch",
    {
      title: "Watch Local Repo",
      description:
        "Start a file watcher on a repository. Changed files will be automatically re-indexed " +
        "after a 1-second debounce.",
      inputSchema: z.object({
        path: z.string().describe("Path to the repository root."),
        repo_id: z.string().optional().describe("Repository identifier."),
      }),
    },
    async ({ path, repo_id }) => {
      try {
        const resolved = resolve(path);
        if (!existsSync(resolved)) {
          return {
            content: [{ type: "text" as const, text: `Directory not found: ${resolved}` }],
            isError: true,
          };
        }
        const repoId = repo_id || deriveRepoId(resolved);
        startWatching(resolved, repoId);
        return {
          content: [{ type: "text" as const, text: `Watching ${resolved} as repo "${repoId}".` }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ctx_local_watch error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── ctx_local_unwatch ──────────────────────────────────────
  server.registerTool(
    "ctx_local_unwatch",
    {
      title: "Stop Watching Repo",
      description: "Stop the file watcher for a repository.",
      inputSchema: z.object({
        repo_id: z.string().describe("Repository identifier."),
      }),
    },
    async ({ repo_id }) => {
      stopWatching(repo_id);
      return {
        content: [{ type: "text" as const, text: `Stopped watching repo "${repo_id}".` }],
      };
    },
  );
}
