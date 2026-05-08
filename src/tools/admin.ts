// ─────────────────────────────────────────────────────────
// Tool handlers: ctx_fetch_and_index, ctx_stats, ctx_doctor,
//                ctx_upgrade, ctx_purge, ctx_insight, ctx_index
// ─────────────────────────────────────────────────────────

import { z } from "zod";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, statSync, rmSync, readdirSync, unlinkSync, realpathSync,
} from "node:fs";
import { join, dirname, resolve, basename, relative, isAbsolute } from "node:path";
import { homedir, tmpdir, cpus, platform } from "node:os";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import {
  trackResponse,
  trackIndexed,
  sessionStats,
  getStore,
  resetStore,
  resetVaultStore,
  getSessionDir,
  hashProjectDir,
  getWorktreeSuffix,
  getStatsFilePath,
  getLifetimeStats,
  _latestVersion,
  _detectedAdapter,
  setDetectedAdapter,
  _insightChild,
  setInsightChild,
  __pkg_dir,
  VERSION,
  classifyIp,
  type ToolResult,
} from "./shared.js";
import { runPool, type PoolJob } from "../concurrency/runPool.js";
import { composeFetchCacheKey } from "../fetch-cache.js";
import { type IndexResult } from "../store.js";
import { loadDatabase } from "../db-base.js";
import { AnalyticsEngine, formatReport } from "../session/analytics.js";
import { getRuntimeSummary, detectRuntimes, hasBunRuntime } from "../runtime.js";

const runtimes = detectRuntimes();

// ── Turndown path resolution ────────────────────────────────

let _turndownPath: string | null = null;
let _gfmPluginPath: string | null = null;

function resolveTurndownPath(): string {
  if (!_turndownPath) {
    const require = createRequire(import.meta.url);
    _turndownPath = require.resolve("turndown");
  }
  return _turndownPath;
}

function resolveGfmPluginPath(): string {
  if (!_gfmPluginPath) {
    const require = createRequire(import.meta.url);
    _gfmPluginPath = require.resolve("turndown-plugin-gfm");
  }
  return _gfmPluginPath;
}

// ── Fetch helpers ──────────────────────────────────────────

function buildFetchCode(url: string, outputPath: string): string {
  const turndownPath = JSON.stringify(resolveTurndownPath());
  const gfmPath = JSON.stringify(resolveGfmPluginPath());
  return `
const TurndownService = require(${turndownPath});
const { gfm } = require(${gfmPath});
const fs = require('fs');
const url = ${JSON.stringify(url)};
const outputPath = ${JSON.stringify(outputPath)};

function emit(ct, content) {
  fs.writeFileSync(outputPath, content);
  console.log('__CM_CT__:' + ct);
}

async function main() {
  const resp = await fetch(url);
  if (!resp.ok) { throw new Error("HTTP " + resp.status); }
  const contentType = resp.headers.get('content-type') || '';

  if (contentType.includes('application/json') || contentType.includes('+json')) {
    const text = await resp.text();
    try { emit('json', JSON.stringify(JSON.parse(text), null, 2)); } catch { emit('text', text); }
    return;
  }

  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const html = await resp.text();
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    td.use(gfm);
    td.remove(['script', 'style', 'nav', 'header', 'footer', 'noscript']);
    emit('html', td.turndown(html));
    return;
  }

  const text = await resp.text();
  emit('text', text);
}
main();
`;
}

const FETCH_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_PREVIEW_LIMIT = 3072;

type FetchOneResult =
  | { kind: "cached"; label: string; chunkCount: number; estimatedBytes: number; ageStr: string }
  | { kind: "fetched"; url: string; source?: string; markdown: string; header: string }
  | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "throw" };

async function ssrfGuard(rawUrl: string): Promise<FetchOneResult | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: "fetch_error", url: rawUrl, error: "invalid URL", reason: "exit" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: `URL scheme "${parsed.protocol}" not allowed (only http: and https:)`,
      reason: "exit",
    };
  }

  const allowPrivate = process.env.CTX_FETCH_ALLOW_PRIVATE === "1";

  try {
    const { lookup } = await import("node:dns/promises");
    const records = await lookup(parsed.hostname, { all: true, verbatim: true });
    for (const rec of records) {
      const verdict = classifyIp(rec.address);
      if (verdict === "block") {
        return {
          kind: "fetch_error",
          url: rawUrl,
          error: `URL "${parsed.hostname}" resolves to ${rec.address} — blocked (link-local / IMDS / multicast / reserved)`,
          reason: "exit",
        };
      }
      if (verdict === "private" && !allowPrivate) {
        return {
          kind: "fetch_error",
          url: rawUrl,
          error: `URL "${parsed.hostname}" resolves to private IP ${rec.address} — blocked by default. Set CTX_FETCH_ALLOW_PRIVATE=1 to allow.`,
          reason: "exit",
        };
      }
    }
  } catch (err) {
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: `DNS lookup failed for "${parsed.hostname}": ${err instanceof Error ? err.message : String(err)}`,
      reason: "exit",
    };
  }

  return null;
}

async function fetchOneUrl(url: string, source: string | undefined, force: boolean | undefined, executor: import("../executor.js").PolyglotExecutor): Promise<FetchOneResult> {
  const ssrfBlock = await ssrfGuard(url);
  if (ssrfBlock) return ssrfBlock;

  if (!force) {
    const store = getStore();
    const cacheKey = composeFetchCacheKey(source, url);
    const meta = store.getSourceMeta(cacheKey);
    if (meta) {
      const indexedAt = new Date(meta.indexedAt + "Z");
      const ageMs = Date.now() - indexedAt.getTime();
      if (ageMs < FETCH_TTL_MS) {
        const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
        const ageMin = Math.floor(ageMs / (60 * 1000));
        const ageStr = ageHours > 0 ? `${ageHours}h ago` : ageMin > 0 ? `${ageMin}m ago` : "just now";
        const estimatedBytes = meta.chunkCount * 1600;
        return { kind: "cached", label: meta.label, chunkCount: meta.chunkCount, estimatedBytes, ageStr };
      }
    }
  }

  const outputPath = join(tmpdir(), `ctx-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.dat`);
  try {
    const fetchCode = buildFetchCode(url, outputPath);
    const result = await executor.execute({
      language: "javascript",
      code: fetchCode,
      timeout: 30_000,
    });
    if (result.exitCode !== 0) {
      return { kind: "fetch_error", url, error: result.stderr || result.stdout || "unknown error", reason: "exit" };
    }
    const header = (result.stdout || "").trim();
    let markdown: string;
    try {
      markdown = readFileSync(outputPath, "utf-8").trim();
    } catch {
      return { kind: "fetch_error", url, error: "could not read subprocess output", reason: "read" };
    }
    if (markdown.length === 0) {
      return { kind: "fetch_error", url, error: "empty content", reason: "empty" };
    }
    return { kind: "fetched", url, source, markdown, header };
  } catch (err: unknown) {
    return {
      kind: "fetch_error",
      url,
      error: err instanceof Error ? err.message : String(err),
      reason: "throw",
    };
  } finally {
    try { rmSync(outputPath); } catch (e) { console.warn("fetchAndIndex rmSync outputPath failed", e) }
  }
}

interface IndexedFetchResult {
  label: string;
  totalChunks: number;
  totalBytes: number;
  preview: string;
}

function indexFetched(f: { url: string; source?: string; markdown: string; header: string }): IndexedFetchResult {
  const store = getStore();
  const storageLabel = composeFetchCacheKey(f.source, f.url);
  let indexed: IndexResult;
  if (f.header === "__CM_CT__:json") {
    indexed = store.indexJSON(f.markdown, storageLabel);
  } else if (f.header === "__CM_CT__:text") {
    indexed = store.indexPlainText(f.markdown, storageLabel);
  } else {
    indexed = store.index({ content: f.markdown, source: storageLabel });
  }
  trackIndexed(Buffer.byteLength(f.markdown));
  const preview = f.markdown.length > FETCH_PREVIEW_LIMIT
    ? f.markdown.slice(0, FETCH_PREVIEW_LIMIT) + "\n\n…[truncated — use ctx_search() for full content]"
    : f.markdown;
  return {
    label: indexed.label,
    totalChunks: indexed.totalChunks,
    totalBytes: Buffer.byteLength(f.markdown),
    preview,
  };
}

// ── Minimal DB adapter for ctx_stats ────────────────────────

function createMinimalDb(): import("../session/analytics.js").DatabaseAdapter {
  return {
    prepare: () => ({
      run: () => undefined,
      get: (..._args: unknown[]) => ({ cnt: 0, compact_count: 0, minutes: null, rate: 0, avg: 0, outcome: "exploratory" }),
      all: () => [],
    }),
  };
}

// ── Register all admin tools ────────────────────────────────

export function registerAdminTools(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  executor: import("../executor.js").PolyglotExecutor,
): void {

  // ── ctx_fetch_and_index ──────────────────────────────────

  server.registerTool(
    "ctx_fetch_and_index",
    {
      title: "Fetch & Index URL(s)",
      description:
        "Fetches URL content, converts HTML to markdown, indexes into searchable knowledge base, " +
        "and returns a ~3KB preview. Full content stays in sandbox — use ctx_search() for deeper lookups.\n\n" +
        "Better than WebFetch: preview is immediate, full content is searchable, raw HTML never enters context.\n\n" +
        "Content-type aware: HTML is converted to markdown, JSON is chunked by key paths, plain text is indexed directly.\n\n" +
        "PARALLELIZE I/O: For multi-URL research (library evaluation, migration scans, doc comparisons), pass `requests: [{url, source}, ...]` with `concurrency: 4-8` — speeds up by 3-5x on real workloads.\n" +
        "  ✅ Use concurrency: 4-8 for: library docs sweep, multi-changelog scan, competitive pricing pages, multi-region docs, GitHub raw file pulls.\n" +
        "  ❌ Single URL → use the legacy {url, source} shape (concurrency irrelevant).\n" +
        "  Example: requests: [{url: 'https://react.dev/...', source: 'react'}, {url: 'https://vuejs.org/...', source: 'vue'}], concurrency: 5.\n" +
        "  Indexing is serial regardless of concurrency — fetches race, FTS5 writes don't (avoids SQLite WAL contention).\n\n" +
        "When reporting results — terse like caveman. Technical substance exact. Only fluff die. Pattern: [thing] [action] [reason]. [next step].",
      inputSchema: z.object({
        url: z.string().optional().describe("Single URL to fetch and index (legacy single-shape)"),
        source: z.string().optional().describe("Label for the indexed content when using single `url`. For batch, put source in each requests entry."),
        requests: z.array(z.object({
          url: z.string().describe("URL to fetch"),
          source: z.string().optional().describe("Label for this URL's indexed content"),
        })).min(1).optional().describe("Batch shape: array of {url, source?} entries. Use with concurrency>1 for parallel fetch."),
        concurrency: z.coerce.number().int().min(1).max(8).optional().default(1).describe("Max URLs to fetch in parallel (1-8, default: 1). Use 4-8 for I/O-bound multi-URL batches."),
        force: z.boolean().optional().describe("Skip cache and re-fetch even if content was recently indexed"),
      }),
    },
    async ({ url, source, requests, concurrency, force }) => {
      const batch: { url: string; source?: string }[] = requests
        ? requests
        : url
          ? [{ url, source }]
          : [];

      if (batch.length === 0) {
        return trackResponse("ctx_fetch_and_index", {
          content: [{
            type: "text" as const,
            text: "ctx_fetch_and_index requires either `url` (single) or `requests: [{url, source?}, ...]` (batch).",
          }],
          isError: true,
        });
      }

      const isLegacySingle = !requests && batch.length === 1;
      const requestedConcurrency = concurrency ?? 1;

      const jobs: PoolJob<FetchOneResult>[] = batch.map((req) => ({
        run: () => fetchOneUrl(req.url, req.source, force, executor),
      }));
      const { settled, effectiveConcurrency, capped } = await runPool(jobs, {
        concurrency: requestedConcurrency,
        capByCpuCount: !isLegacySingle && requestedConcurrency > 1,
      });

      type Finalized =
        | { kind: "cached"; label: string; chunkCount: number; ageStr: string }
        | { kind: "fetched"; indexed: IndexedFetchResult }
        | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "throw" }
        | { kind: "job_error"; url: string; error: string };

      const finalized: Finalized[] = [];
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === "rejected") {
          const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
          finalized.push({ kind: "job_error", url: batch[i].url, error: message });
          continue;
        }
        const v = r.value;
        if (v.kind === "cached") {
          sessionStats.cacheHits++;
          sessionStats.cacheBytesSaved += v.estimatedBytes;
          finalized.push({ kind: "cached", label: v.label, chunkCount: v.chunkCount, ageStr: v.ageStr });
        } else if (v.kind === "fetch_error") {
          finalized.push({ kind: "fetch_error", url: v.url, error: v.error, reason: v.reason });
        } else {
          finalized.push({ kind: "fetched", indexed: indexFetched(v) });
        }
      }

      // Backward-compat single-URL response
      if (isLegacySingle) {
        const r = finalized[0];
        if (r.kind === "cached") {
          return trackResponse("ctx_fetch_and_index", {
            content: [{
              type: "text" as const,
              text: `Cached: **${r.label}** — ${r.chunkCount} sections, indexed ${r.ageStr} (fresh, TTL: 24h).\nTo refresh: call ctx_fetch_and_index again with \`force: true\`.\n\nYou MUST call ctx_search() to answer questions about this content — this cached response contains no content.\nUse: ctx_search(queries: [...], source: "${r.label}")`,
            }],
          });
        }
        if (r.kind === "fetched") {
          const totalKB = (r.indexed.totalBytes / 1024).toFixed(1);
          const text = [
            `Fetched and indexed **${r.indexed.totalChunks} sections** (${totalKB}KB) from: ${r.indexed.label}`,
            `Full content indexed in sandbox — use ctx_search(queries: [...], source: "${r.indexed.label}") for specific lookups.`,
            "",
            "---",
            "",
            r.indexed.preview,
          ].join("\n");
          return trackResponse("ctx_fetch_and_index", {
            content: [{ type: "text" as const, text }],
          });
        }
        if (r.kind === "fetch_error") {
          const text =
            r.reason === "empty" ? `Fetched ${r.url} but got empty content`
            : r.reason === "read" ? `Fetched ${r.url} but could not read subprocess output`
            : r.reason === "exit" ? `Failed to fetch ${r.url}: ${r.error}`
            : `Fetch error: ${r.error}`;
          return trackResponse("ctx_fetch_and_index", {
            content: [{ type: "text" as const, text }],
            isError: true,
          });
        }
        return trackResponse("ctx_fetch_and_index", {
          content: [{ type: "text" as const, text: `Fetch error: ${r.error}` }],
          isError: true,
        });
      }

      // Batch response
      const FETCH_BATCH_PREVIEW_LIMIT = 384;
      const lines: string[] = [];
      let totalSections = 0;
      let totalBytes = 0;
      let cachedCount = 0;
      let fetchedCount = 0;
      let errorCount = 0;
      const snippets: string[] = [];
      for (const r of finalized) {
        if (r.kind === "cached") {
          cachedCount++;
          lines.push(`- [cache] ${r.label} — ${r.chunkCount} sections (${r.ageStr})`);
        } else if (r.kind === "fetched") {
          fetchedCount++;
          totalSections += r.indexed.totalChunks;
          totalBytes += r.indexed.totalBytes;
          const kb = (r.indexed.totalBytes / 1024).toFixed(1);
          lines.push(`- [new]   ${r.indexed.label} — ${r.indexed.totalChunks} sections (${kb}KB)`);
          const snippet = r.indexed.preview.length > FETCH_BATCH_PREVIEW_LIMIT
            ? r.indexed.preview.slice(0, FETCH_BATCH_PREVIEW_LIMIT).trimEnd() + "…"
            : r.indexed.preview;
          snippets.push(`### ${r.indexed.label}\n\n${snippet}`);
        } else {
          errorCount++;
          lines.push(`- [err]   ${r.url}: ${r.error}`);
        }
      }

      const totalKB = (totalBytes / 1024).toFixed(1);
      const cappedNote = capped ? ` cap=${effectiveConcurrency}/${cpus().length}cpu` : "";
      const fmt = (n: number, sing: string, plur: string) => `${n} ${n === 1 ? sing : plur}`;
      const headerLine =
        `fetched ${batch.length} c=${effectiveConcurrency}${cappedNote}. ` +
        `ok=${fetchedCount} cache=${cachedCount} err=${errorCount}. ` +
        `${fmt(totalSections, "section", "sections")} ${totalKB}KB.`;

      const text = [
        headerLine,
        "",
        ...lines,
        "",
        `ctx_search(queries: [...], source: "<label>") for full content.`,
        ...(snippets.length > 0 ? ["", "---", "", ...snippets] : []),
      ].join("\n");

      return trackResponse("ctx_fetch_and_index", {
        content: [{ type: "text" as const, text }],
        isError: errorCount === batch.length,
      });
    },
  );

  // ── ctx_stats ───────────────────────────────────────────

  server.registerTool(
    "ctx_stats",
    {
      title: "Session Statistics",
      description:
        "Returns context consumption statistics for the current session. " +
        "Shows total bytes returned to context, breakdown by tool, call counts, " +
        "estimated token usage, and context savings ratio.",
      inputSchema: z.object({}),
    },
    async () => {
      let text: string;
      try {
        const dbHash = hashProjectDir();
        const worktreeSuffix = getWorktreeSuffix();
        const sessionDbPath = join(
          getSessionDir(),
          `${dbHash}${worktreeSuffix}.db`,
        );

        if (existsSync(sessionDbPath)) {
          const Database = loadDatabase();
          const sdb = new Database(sessionDbPath, { readonly: true });
          try {
            const engine = new AnalyticsEngine(sdb);
            const report = engine.queryAll(sessionStats);
            const mcpUsage = engine.getMcpToolUsage();
            const lifetime = getLifetimeStats();
            text = formatReport(report, VERSION, _latestVersion, { lifetime, mcpUsage });
          } finally {
            sdb.close();
          }
        } else {
          const engine = new AnalyticsEngine(createMinimalDb());
          const report = engine.queryAll(sessionStats);
          const lifetime = getLifetimeStats();
          text = formatReport(report, VERSION, _latestVersion, { lifetime });
        }
      } catch {
        const engine = new AnalyticsEngine(createMinimalDb());
        const report = engine.queryAll(sessionStats);
        let lifetime;
        try { lifetime = getLifetimeStats(); } catch (e) { console.warn("getLifetimeStats failed", e) }
        text = formatReport(report, VERSION, _latestVersion, lifetime ? { lifetime } : undefined);
      }

      return trackResponse("ctx_stats", {
        content: [{ type: "text" as const, text }],
      });
    },
  );

  // ── ctx_doctor ──────────────────────────────────────────

  server.registerTool(
    "ctx_doctor",
    {
      title: "Run Diagnostics",
      description:
        "Check context-mode setup: binary paths, hook scripts, database, runtimes, and version.",
      inputSchema: z.object({}),
    },
    async () => {
      const lines: string[] = ["context-mode doctor", ""];

      // Runtimes
      lines.push(`[OK] Runtimes: ${getRuntimeSummary(runtimes)}`);

      // Performance
      if (hasBunRuntime()) {
        lines.push("[OK] Performance: FAST (Bun)");
      } else {
        lines.push("[WARN] Performance: NORMAL — install Bun for 3-5x speed boost");
      }

      // Server test — cleanup executor to prevent resource leaks (#247)
      {
        const testExecutor = new (await import("../executor.js")).PolyglotExecutor({ runtimes });
        try {
          const result = await testExecutor.execute({ language: "javascript", code: 'console.log("ok");', timeout: 5000 });
          if (result.exitCode === 0 && result.stdout.trim() === "ok") {
            lines.push("[OK] Server test: PASS");
          } else {
            const detail = result.stderr?.trim() ? ` (${result.stderr.trim().slice(0, 200)})` : "";
            lines.push(`[FAIL] Server test: FAIL — exit ${result.exitCode}${detail}`);
          }
        } catch (err: unknown) {
          lines.push(`[FAIL] Server test: FAIL — ${err instanceof Error ? err.message : err}`);
        } finally {
          testExecutor.cleanupBackgrounded();
        }
      }

      // FTS5 / SQLite — close in finally to prevent GC segfault (#247)
      {
        let testDb: ReturnType<typeof loadDatabase> extends (...args: any[]) => infer R ? R : never;
        try {
          const Database = loadDatabase();
          testDb = new Database(":memory:");
          testDb.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
          testDb.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
          const row = testDb.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
          if (row && row.content === "hello world") {
            lines.push("[OK] FTS5 / SQLite: PASS — native module works");
          } else {
            lines.push("[FAIL] FTS5 / SQLite: FAIL — unexpected result");
          }
        } catch (err: unknown) {
          lines.push(`[FAIL] FTS5 / SQLite: FAIL — ${err instanceof Error ? err.message : err}`);
        } finally {
          try { testDb!?.close(); } catch (e) { console.warn("doctor testDb close failed", e) }
        }
      }

      // Content DB
      try {
        const store = getStore();
        const stats = store.getStats();
        lines.push(`[OK] Content DB: ${stats.chunks} chunks from ${stats.sources} sources`);
      } catch {
        lines.push("[FAIL] Content DB: cannot open");
      }

      // Hook script
      const pluginRoot = existsSync(resolve(__pkg_dir, "package.json")) ? __pkg_dir : dirname(__pkg_dir);
      const hookPath = resolve(pluginRoot, "hooks", "pretooluse.mjs");
      {
        if (existsSync(hookPath)) {
          lines.push(`[OK] Hook script: PASS — ${hookPath}`);
        } else {
          lines.push(`[FAIL] Hook script: FAIL — not found at ${hookPath}`);
        }
      }

      // Version
      lines.push(`[OK] Version: v${VERSION}`);

      return trackResponse("ctx_doctor", {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      });
    },
  );

  // ── ctx_upgrade ─────────────────────────────────────────

  server.registerTool(
    "ctx_upgrade",
    {
      title: "Upgrade Plugin",
      description:
        "Upgrade context-mode to the latest version. Returns a shell command to execute. " +
        "You MUST run the returned command using your shell tool and display the output as a checklist.",
      inputSchema: z.object({}),
    },
    async () => {
      const adapter = _detectedAdapter;
      let cmd: string;
      if (adapter?.name === "Claude Code") {
        cmd = "/ctx-upgrade";
      } else if (adapter?.name === "OpenClaw") {
        cmd = "npm run install:openclaw";
      } else {
        cmd = "npm update -g context-mode";
      }

      const text = [
        "## ctx-upgrade",
        "",
        "Run this command using your shell execution tool:",
        "",
        "```",
        cmd,
        "```",
        "",
        "After the command completes, display results as a markdown checklist:",
        "- `[x]` for success, `[ ]` for failure",
      ].join("\n");

      return trackResponse("ctx_upgrade", {
        content: [{ type: "text" as const, text }],
      });
    },
  );

  // ── ctx_purge ───────────────────────────────────────────

  server.registerTool(
    "ctx_purge",
    {
      title: "Purge Knowledge Base",
      description:
        "Permanently deletes ALL session data for this project: " +
        "FTS5 knowledge base (indexed content), session events DB (analytics, metadata, " +
        "resume snapshots), and session events markdown. Resets in-memory stats. " +
        "This is irreversible.",
      inputSchema: z.object({
        confirm: z.boolean().describe("Must be true to confirm the destructive operation."),
      }),
    },
    async ({ confirm }) => {
      if (!confirm) {
        return trackResponse("ctx_purge", {
          content: [{
            type: "text" as const,
            text: "Purge cancelled. Pass confirm: true to proceed.",
          }],
        });
      }

      const deleted: string[] = [];

      if (getStore) {
                // Wipe the persistent FTS5 content store
        try {
          const store = getStore();
          // Reset store state
          resetStore();
          resetVaultStore();
          deleted.push("content store");
        } catch (e) { console.warn("purgeStore resetStore failed", e) }
      }

      // Delete session DB
      try {
        const dbPath = join(getSessionDir(), `${hashProjectDir()}${getWorktreeSuffix()}.db`);
        if (existsSync(dbPath)) {
          rmSync(dbPath);
          deleted.push("session DB");
        }
      } catch (e) { console.warn("purgeStore deleteSessionDB failed", e) }

      // Delete content DB
      try {
        const contentDbPath = join(dirname(getSessionDir()), "content", `${hashProjectDir()}.db`);
        if (existsSync(contentDbPath)) {
          rmSync(contentDbPath);
          deleted.push("content DB");
        }
      } catch (e) { console.warn("purgeStore deleteContentDB failed", e) }

      // Delete session events markdown files
      try {
        const sessionsDir = getSessionDir();
                const files = readdirSync(sessionsDir).filter(f => f.endsWith("-events.md"));
        for (const file of files) {
          try { unlinkSync(join(sessionsDir, file)); deleted.push("session events"); } catch (e) { console.warn("purgeStore unlink session event failed", e) }
        }
      } catch (e) { console.warn("purgeStore deleteSessionEvents failed", e) }

      // Reset in-memory stats
      sessionStats.calls = {};
      sessionStats.bytesReturned = {};
      sessionStats.bytesIndexed = 0;
      sessionStats.bytesSandboxed = 0;
      sessionStats.cacheHits = 0;
      sessionStats.cacheBytesSaved = 0;

      // Also drop the persisted stats file
      try {
        const statsFile = getStatsFilePath();
        if (existsSync(statsFile)) unlinkSync(statsFile);
      } catch (e) { console.warn("purgeStore deleteStatsFile failed", e) }

      return trackResponse("ctx_purge", {
        content: [{
          type: "text" as const,
          text: `Purged: ${deleted.join(", ")}. All session data for this project has been permanently deleted.`,
        }],
      });
    },
  );

  // ── ctx_insight ─────────────────────────────────────────

  server.registerTool(
    "ctx_insight",
    {
      title: "Open Insight Dashboard",
      description:
        "Opens the context-mode Insight dashboard in the browser. " +
        "Shows personal analytics: session activity, tool usage, error rate, " +
        "parallel work patterns, project focus, and actionable insights. " +
        "First run installs dependencies (~30s). Subsequent runs open instantly.",
      inputSchema: z.object({
        port: z.coerce.number().optional().describe("Port to serve on (default: 4747)"),
        sessionDir: z.string().optional().describe("Override INSIGHT_SESSION_DIR"),
        contentDir: z.string().optional().describe("Override INSIGHT_CONTENT_DIR"),
        insightSessionDir: z.string().optional().describe("Alias for sessionDir"),
        insightContentDir: z.string().optional().describe("Alias for contentDir"),
      }),
    },
    async ({ port: userPort, sessionDir, contentDir, insightSessionDir, insightContentDir }) => {
      const rawPort = userPort || 4747;
      if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
        return trackResponse("ctx_insight", {
          content: [{ type: "text" as const, text: `Invalid port: ${rawPort}. Must be an integer 1-65535.` }],
          isError: true,
        });
      }
      const port: number = rawPort;
      const explicitSessionDir = sessionDir || insightSessionDir;
      const explicitContentDir = contentDir || insightContentDir;
      // Path traversal guard: user-supplied dirs used as execSync cwd
      // must stay within homedir() or tmpdir() (MEDIUM fix).
      const safeRealpathForDirCreate = (p: string): string => {
        const abs = resolve(p);
        if (existsSync(abs)) return realpathSync(abs);
        const parent = dirname(abs);
        if (!existsSync(parent)) throw new Error(`Parent directory does not exist: ${parent}`);
        return join(realpathSync(parent), basename(abs));
      };
      const canonicalRoot = (p: string): string => {
        try { return realpathSync(resolve(p)); } catch { return resolve(p); }
      };

      const isInsideDir = (child: string, parent: string): boolean => {
        const norm = (p: string) => platform() === "win32" ? p.toLowerCase() : p;
        const rel = relative(norm(parent), norm(child));
        return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
      };

      const validateSafePath = (p: string, label: string): string => {
        const rp = safeRealpathForDirCreate(p);
        const home = canonicalRoot(homedir());
        const tmp = canonicalRoot(tmpdir());
        if (!isInsideDir(rp, home) && !isInsideDir(rp, tmp)) {
          throw new McpError(ErrorCode.InvalidRequest, `${label} must be inside home or temp directory: ${p}`);
        }
        return rp;
      };
      const pluginRoot = existsSync(resolve(__pkg_dir, "package.json")) ? __pkg_dir : dirname(__pkg_dir);
      const insightSource = resolve(pluginRoot, "insight");
      const sessDir = explicitSessionDir ? validateSafePath(explicitSessionDir, "sessionDir") : getSessionDir();
      const derivedBase = dirname(sessDir);
      const insightContentDirResolved = explicitContentDir
        ? validateSafePath(explicitContentDir, "contentDir")
        : explicitSessionDir
          ? validateSafePath(join(derivedBase, "content"), "derived contentDir")
          : join(derivedBase, "content");
      const cacheDir = explicitSessionDir
        ? validateSafePath(join(derivedBase, "insight-cache"), "cacheDir")
        : join(derivedBase, "insight-cache");

      if (!existsSync(join(insightSource, "server.mjs"))) {
        return trackResponse("ctx_insight", {
          content: [{ type: "text" as const, text: "Error: Insight source not found in plugin. Try upgrading context-mode." }],
        });
      }

      try {
        const steps: string[] = [];
        let sourceUpdated = false;

        mkdirSync(cacheDir, { recursive: true });

        const srcMtime = statSync(join(insightSource, "server.mjs")).mtimeMs;
        const cacheMtime = existsSync(join(cacheDir, "server.mjs"))
          ? statSync(join(cacheDir, "server.mjs")).mtimeMs : 0;

        if (srcMtime > cacheMtime) {
          steps.push("Copying source files...");
          cpSync(insightSource, cacheDir, { recursive: true, force: true });
          steps.push("Source files copied.");
          sourceUpdated = true;
        }

        // Install deps if needed
        if (!existsSync(join(cacheDir, "node_modules", "better-sqlite3"))) {
          steps.push("Installing dependencies...");
          execSync("npm install --omit=dev", { cwd: cacheDir, stdio: "pipe", timeout: 120_000 });
          if (!existsSync(join(cacheDir, "node_modules", "better-sqlite3"))) {
            rmSync(join(cacheDir, "node_modules"), { recursive: true, force: true });
            throw new Error("npm install incomplete — please retry");
          }
          steps.push("Dependencies installed.");
        }

        // Build
        steps.push("Building dashboard...");
        execSync("npx vite build", { cwd: cacheDir, stdio: "pipe", timeout: 60000 });
        steps.push("Build complete.");

        // Check port
        let portOccupied = false;
        try {
          const { request } = await import("node:http");
          await new Promise<void>((resolve, reject) => {
            const req = request(`http://localhost:${port}/`, { method: "HEAD" }, (res) => {
              res.resume();
              resolve();
            });
            req.on("error", () => reject());
            req.on("timeout", () => { req.destroy(); reject(); });
            req.end();
          });
          portOccupied = true;
        } catch (e) { console.warn("insight port check failed", e) }

        if (portOccupied && sourceUpdated) {
          steps.push("Killing stale dashboard server (source updated)...");
          try {
            if (process.platform === "win32") {
              execSync(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port}') do taskkill /F /PID %a`, { stdio: "pipe" });
            } else {
              execSync(`lsof -ti:${port} | xargs kill 2>/dev/null || true`, { stdio: "pipe" });
            }
            await new Promise(r => setTimeout(r, 500));
          } catch (e) { console.warn("insight kill stale server failed", e) }
          steps.push("Stale server killed.");
        } else if (portOccupied) {
          steps.push("Dashboard already running.");
          const url = `http://localhost:${port}`;
          try {
            if (process.platform === "darwin") execSync(`open "${url}"`, { stdio: "pipe" });
            else if (process.platform === "win32") execSync(`start "" "${url}"`, { stdio: "pipe" });
            else execSync(`xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null`, { stdio: "pipe" });
          } catch (e) { console.warn("insight openBrowser failed", e) }
          return trackResponse("ctx_insight", {
            content: [{ type: "text" as const, text: `Dashboard already running at http://localhost:${port}` }],
          });
        }

        // Kill any previous insight child
        const currentChild = _insightChild;
        if (currentChild && currentChild.pid && !currentChild.killed) {
          try { currentChild.kill("SIGTERM"); } catch (e) { console.warn("insight kill previous child failed", e) }
        }

        // Start server
        const child = spawn("node", [join(cacheDir, "server.mjs")], {
          cwd: cacheDir,
          env: {
            ...process.env,
            PORT: String(port),
            INSIGHT_SESSION_DIR: sessDir,
            INSIGHT_CONTENT_DIR: insightContentDirResolved,
            INSIGHT_PARENT_PID: String(process.pid),
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });

        setInsightChild(child);

        // Wait for server to be ready
        try {
          const { request } = await import("node:http");
          await new Promise<void>((resolve, reject) => {
            const tryConnect = (attempt: number) => {
              if (attempt > 20) { reject(new Error("timeout")); return; }
              const req = request(`http://localhost:${port}/`, { method: "HEAD" }, (res) => {
                res.resume();
                resolve();
              });
              req.on("error", () => setTimeout(() => tryConnect(attempt + 1), 500));
              req.on("timeout", () => { req.destroy(); setTimeout(() => tryConnect(attempt + 1), 500); });
              req.setTimeout(2000);
              req.end();
            };
            setTimeout(() => tryConnect(1), 1000);
          });
        } catch {
          return trackResponse("ctx_insight", {
            content: [{
              type: "text" as const,
              text: `Port ${port} appears to be in use.\n\nTo fix:\n- Kill the existing process: ${process.platform === "win32" ? `netstat -ano | findstr :${port}` : `lsof -ti:${port} | xargs kill`}\n- Or use a different port: ctx_insight({ port: ${port + 1} })`,
            }],
          });
        }

        // Open browser
        const url = `http://localhost:${port}`;
        try {
          if (process.platform === "darwin") execSync(`open "${url}"`, { stdio: "pipe" });
          else if (process.platform === "win32") execSync(`start "" "${url}"`, { stdio: "pipe" });
          else execSync(`xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null`, { stdio: "pipe" });
        } catch (e) { console.warn("insight openBrowser failed", e) }

        steps.push(`Dashboard running at ${url}`);

        return trackResponse("ctx_insight", {
          content: [{
            type: "text" as const,
            text: steps.map(s => `- ${s}`).join("\n") + `\n\nOpen: ${url}\nPID: ${child.pid} · Stop: ${process.platform === "win32" ? `taskkill /PID ${child.pid} /F` : `kill ${child.pid}`}`,
          }],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return trackResponse("ctx_insight", {
          content: [{ type: "text" as const, text: `Insight setup failed: ${msg}` }],
        });
      }
    },
  );
}
