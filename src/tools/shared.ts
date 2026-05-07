// ─────────────────────────────────────────────────────────
// Shared state, types, and helpers for tool handlers
// Extracted from server.ts for decomposition
// ─────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, unlinkSync, symlinkSync } from "node:fs";
import { join, dirname, resolve, sep, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { request as httpsRequest } from "node:https";
import { type ChildProcess } from "node:child_process";

import { ContentStore, cleanupStaleDBs, cleanupStaleContentDBs, type SearchResult, type IndexResult } from "../store.js";
import { persistToolCallCounter, restoreSessionStats } from "../session/persist-tool-calls.js";
import { getWorktreeSuffix, SessionDB } from "../session/db.js";
export { getWorktreeSuffix };
import { getLifetimeStats, OPUS_INPUT_PRICE_PER_TOKEN } from "../session/analytics.js";
export { getLifetimeStats };
import { detectPlatform, getSessionDirSegments } from "../adapters/detect.js";
import { loadDatabase } from "../db-base.js";
import { semverNewer } from "../lib/semver.js";
import { type HookAdapter } from "../adapters/types.js";

// ── Package metadata ──────────────────────────────────────

import { fileURLToPath } from "node:url";
const __pkg_dir = dirname(fileURLToPath(import.meta.url));
// Re-export for tools that need it
export { __pkg_dir };

export const VERSION: string = (() => {
  for (const rel of ["../package.json", "./package.json"]) {
    const p = resolve(__pkg_dir, rel);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")).version; } catch {}
    }
  }
  return "unknown";
})();

// ── Tool result type ───────────────────────────────────────

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Build a standardized error ToolResult for a named MCP tool. */
export function toolErrorResponse(toolName: string, err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `${toolName} error: ${message}` }],
    isError: true,
  };
}

/** Acquire the shared vault graph store pair, returning nulls on failure. */
export async function acquireVaultStores(): Promise<{
  vaultStore: import("../vault/graph-store.js").VaultGraphStore | null;
  vaultSearch: import("../vault/search.js").VaultGraphSearch | null;
}> {
  try {
    const { store, search } = await getSharedVaultStore();
    return { vaultStore: store, vaultSearch: search };
  } catch {
    return { vaultStore: null, vaultSearch: null };
  }
}

// ── Shared mutable state ───────────────────────────────────

export let _detectedAdapter: HookAdapter | null = null;
export function setDetectedAdapter(adapter: HookAdapter | null): void {
  _detectedAdapter = adapter;
}

// Tracks the ctx_insight dashboard child so shutdown can terminate it.
export let _insightChild: ChildProcess | null = null;
export function setInsightChild(child: ChildProcess | null): void {
  _insightChild = child;
}

// Lazy singleton — no DB overhead unless index/search is used
let _store: ContentStore | null = null;

// Shared vault graph store (same DB as ContentStore, separate connection)
let _vaultStoreCache: { store: import("../vault/graph-store.js").VaultGraphStore; search: import("../vault/search.js").VaultGraphSearch } | null = null;
let _projectVaultIndexed = false;
let _projectVaultEmpty = false;
const DEBUG_VAULT = process.env.DEBUG?.includes("context-mode");

export function isProjectVaultEmpty(): boolean { return _projectVaultEmpty; }

// Lazy import — used by getSharedVaultStore and ctx_vault_index handler
let _createVaultAdapter: typeof import("../vault/adapter.js").createVaultAdapter | null = null;
async function getVaultAdapter() {
  if (!_createVaultAdapter) {
    const mod = await import("../vault/adapter.js");
    _createVaultAdapter = mod.createVaultAdapter;
  }
  return _createVaultAdapter;
}

/**
 * Open (or reuse) the shared vault graph store. Auto-indexes the current
 * project directory as a vault on first access if no vault_nodes exist.
 */
export async function getSharedVaultStore(): Promise<{
  store: import("../vault/graph-store.js").VaultGraphStore;
  search: import("../vault/search.js").VaultGraphSearch;
}> {
  if (_vaultStoreCache) return _vaultStoreCache;

  const Database = loadDatabase();
  const db = new Database(getStorePath());
  db.pragma("journal_mode = WAL");
  const { VaultGraphStore } = await import("../vault/graph-store.js");
  const { VaultGraphSearch } = await import("../vault/search.js");
  const store = new VaultGraphStore(db);
  const search = new VaultGraphSearch(store);
  _vaultStoreCache = { store, search };

  // Auto-index current project as vault on first access (once per session)
  if (!_projectVaultIndexed && process.env.CTX_AUTO_INDEX_PROJECT !== "0") {
    _projectVaultIndexed = true;
    try {
      const projectDir = getProjectDir();
      const cnt = store.countNodesByVaultPath(projectDir);
      if (cnt === 0) {
        const { indexVault } = await import("../vault/indexer.js");
        const { addVaultConfig } = await import("../vault/config.js");
        const createVaultAdapter = await getVaultAdapter();
        const adapter = createVaultAdapter(store, projectDir);
        const result = indexVault(projectDir, adapter);
        // Recalc degrees only for nodes belonging to this project
        const nodeIds = store.getNodeIdsByVaultPath(projectDir);
        for (const { id } of nodeIds) {
          store.recalcDegrees(id);
        }
        addVaultConfig({
          vaultPath: projectDir,
          lastIndexedAt: new Date().toISOString(),
          noteCount: result.indexed + result.updated,
          edgeCount: store.getEdgeCount(),
        });
        if (nodeIds.length === 0) {
          _projectVaultEmpty = true;
        }
        if (DEBUG_VAULT)
          process.stderr.write(
            `[ctx] Auto-indexed project vault: ${projectDir} (${result.indexed + result.updated} nodes, ${result.brokenLinks} broken links)\n`,
          );
      }
    } catch (e) {
      if (DEBUG_VAULT)
        process.stderr.write(`[ctx] auto-index project vault: ${e}\n`);
    }
  }

  return _vaultStoreCache;
}

/**
 * Auto-index session events files written by SessionStart hook.
 * Scans ~/.claude/context-mode/sessions/ for *-events.md files.
 * Called on every getStore() — readdirSync is sub-millisecond when no files match.
 */
function maybeIndexSessionEvents(store: ContentStore): void {
  try {
    const sessionsDir = getSessionDir();
    if (!existsSync(sessionsDir)) return;
    const files = readdirSync(sessionsDir).filter(f => f.endsWith("-events.md"));
    for (const file of files) {
      const filePath = join(sessionsDir, file);
      try {
        store.index({ path: filePath, source: "session-events" });
        unlinkSync(filePath);
      } catch { /* best-effort per file */ }
    }
  } catch { /* best-effort — session continuity never blocks tools */ }
}

// ── Platform-aware paths ────────────────────────────────────

/**
 * Get the platform-specific sessions directory from the detected adapter.
 * Falls back to ~/.claude/context-mode/sessions/ before adapter detection.
 */
export function getSessionDir(): string {
  if (_detectedAdapter) return _detectedAdapter.getSessionDir();
  try {
    const signal = detectPlatform();
    const segments = getSessionDirSegments(signal.platform);
    if (segments) {
      const dir = join(homedir(), ...segments, "context-mode", "sessions");
      mkdirSync(dir, { recursive: true });
      return dir;
    }
  } catch { /* fall through to .claude fallback */ }
  const dir = join(homedir(), ".claude", "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Project directory detection across supported platforms.
 */
export function getProjectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR
    || process.env.GEMINI_PROJECT_DIR
    || process.env.VSCODE_CWD
    || process.env.OPENCODE_PROJECT_DIR
    || process.env.PI_PROJECT_DIR
    || process.env.IDEA_INITIAL_DIRECTORY
    || process.env.CONTEXT_MODE_PROJECT_DIR
    || process.cwd();
}

/**
 * Resolve a possibly-relative path against the project directory.
 */
export function resolveProjectPath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(getProjectDir(), filePath);
}

/**
 * Consistent project dir hashing across all DB paths.
 */
export function hashProjectDir(): string {
  const projectDir = getProjectDir();
  const normalized = projectDir.replace(/\\/g, "/");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Resolve the per-project SessionDB path.
 */
export function getSessionDbPath(): string {
  return join(
    getSessionDir(),
    `${hashProjectDir()}${getWorktreeSuffix()}.db`,
  );
}

/**
 * Compute a per-project, per-platform persistent path for the ContentStore.
 */
export function getStorePath(): string {
  const hash = hashProjectDir();
  const sessDir = getSessionDir();
  const dir = join(dirname(sessDir), "content");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}.db`);
}

export function getStore(): ContentStore {
  if (!_store) {
    const dbPath = getStorePath();
    _store = new ContentStore(dbPath);

    try {
      const contentDir = dirname(getStorePath());
      cleanupStaleContentDBs(contentDir, 14);
      _store.cleanupStaleSources(14);
      const legacyDir = join(homedir(), ".context-mode", "content");
      if (existsSync(legacyDir)) cleanupStaleContentDBs(legacyDir, 0);
    } catch { /* best-effort */ }

    cleanupStaleDBs();
  }
  maybeIndexSessionEvents(_store);
  return _store;
}

export function resetStore(): void {
  _store = null;
}

export function closeStore(): void {
  if (_store) {
    try { _store.close(); } catch { /* best effort */ }
    _store = null;
  }
}

export function resetVaultStore(): void {
  _vaultStoreCache = null;
  _projectVaultIndexed = false;
  _projectVaultEmpty = false;
}

// ── Session stats ──────────────────────────────────────────

export const sessionStats = {
  calls: {} as Record<string, number>,
  bytesReturned: {} as Record<string, number>,
  bytesIndexed: 0,
  bytesSandboxed: 0,
  cacheHits: 0,
  cacheBytesSaved: 0,
  sessionStart: Date.now(),
};

// ── Version outdated warning ───────────────────────────────

export let _latestVersion: string | null = null;
let _warningBurstCount = 0;
let _lastBurstStart = 0;
const VERSION_BURST_SIZE = 3;
const VERSION_SILENT_MS = 60 * 60 * 1000; // 1 hour

async function fetchLatestVersion(): Promise<string> {
  return new Promise((res) => {
    const req = httpsRequest(
      "https://registry.npmjs.org/context-mode/latest",
      { headers: { Connection: "close" } },
      (resp) => {
        let raw = "";
        resp.on("data", (chunk: Buffer) => { raw += chunk; });
        resp.on("end", () => {
          try {
            const data = JSON.parse(raw) as { version?: string };
            res(data.version ?? "unknown");
          } catch { res("unknown"); }
        });
      },
    );
    req.on("error", () => res("unknown"));
    req.setTimeout(5000, () => { req.destroy(); res("unknown"); });
    req.end();
  });
}

function getUpgradeHint(): string {
  const name = _detectedAdapter?.name;
  if (name === "Claude Code") return "/ctx-upgrade";
  if (name === "OpenClaw") return "npm run install:openclaw";
  if (name === "Pi") return "npm run build";
  return "npm update -g context-mode";
}

function isOutdated(): boolean {
  if (!_latestVersion || _latestVersion === "unknown") return false;
  return semverNewer(_latestVersion, VERSION);
}

function shouldShowVersionWarning(): boolean {
  if (!isOutdated()) return false;
  const now = Date.now();
  if (_warningBurstCount >= VERSION_BURST_SIZE) {
    if (now - _lastBurstStart < VERSION_SILENT_MS) return false;
    _warningBurstCount = 0;
  }
  if (_warningBurstCount === 0) _lastBurstStart = now;
  _warningBurstCount++;
  return true;
}

// ── Self-heal Layer 2: Mid-session registry heal ───────────

let _cacheHealDone = false;
function healCacheMidSession(): void {
  if (_cacheHealDone) return;
  _cacheHealDone = true;
  try {
    const ipPath = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");
    if (!existsSync(ipPath)) return;
    const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
    const cacheRoot = resolve(homedir(), ".claude", "plugins", "cache");
    const pluginRoot = existsSync(resolve(__pkg_dir, "package.json")) ? __pkg_dir : dirname(__pkg_dir);
    for (const [key, entries] of Object.entries((ip.plugins ?? {}) as Record<string, Array<{ installPath?: string }>>)) {
      if (key !== "context-mode@context-mode") continue;
      for (const entry of entries) {
        const rp = entry.installPath;
        if (!rp || existsSync(rp)) continue;
        if (!resolve(rp).startsWith(cacheRoot + sep)) continue;
        try { if (statSync(rp).isSymbolicLink()) unlinkSync(rp); } catch {}
        try { if (existsSync(rp)) unlinkSync(rp); } catch {}
        const parent = dirname(rp);
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
        if (existsSync(pluginRoot)) {
          symlinkSync(pluginRoot, rp, process.platform === "win32" ? "junction" : undefined);
        }
      }
    }
  } catch { /* best effort */ }
}

// ── Response tracking ──────────────────────────────────────

export function trackResponse(toolName: string, response: ToolResult): ToolResult {
  healCacheMidSession();
  if (shouldShowVersionWarning() && response.content.length > 0) {
    const hint = getUpgradeHint();
    response.content[0].text =
      `⚠️ context-mode v${VERSION} outdated → v${_latestVersion} available. Upgrade: ${hint}\n\n` +
      response.content[0].text;
  }

  const bytes = response.content.reduce(
    (sum, c) => sum + Buffer.byteLength(c.text),
    0,
  );
  sessionStats.calls[toolName] = (sessionStats.calls[toolName] || 0) + 1;
  sessionStats.bytesReturned[toolName] =
    (sessionStats.bytesReturned[toolName] || 0) + bytes;

  persistStats();

  setImmediate(() => persistToolCallCounter(getSessionDbPath(), toolName, bytes));
  return response;
}

export function trackIndexed(bytes: number): void {
  sessionStats.bytesIndexed += bytes;
  persistStats();
}

// ── Stats persistence ──────────────────────────────────────

const STATS_PERSIST_THROTTLE_MS = 500;
const STATS_SCHEMA_VERSION = 2;
const LIFETIME_REFRESH_MS = 30_000;
const TOKENS_PER_EVENT = 256;
let _lastStatsPersist = 0;
let _lifetimeCache: { tokens: number; computedAt: number } | undefined;

export function getStatsFilePath(): string {
  const sessionId = process.env.CLAUDE_SESSION_ID || `pid-${process.ppid}`;
  return join(getSessionDir(), `stats-${sessionId}.json`);
}

export function persistStats(bypassThrottle?: boolean): void {
  const now = Date.now();
  if (!bypassThrottle) {
    if (now - _lastStatsPersist < STATS_PERSIST_THROTTLE_MS) return;
  }
  _lastStatsPersist = now;

  try {
    const totalReturned = Object.values(sessionStats.bytesReturned).reduce(
      (a, b) => a + b,
      0,
    );
    const totalCalls = Object.values(sessionStats.calls).reduce(
      (a, b) => a + b,
      0,
    );
    const keptOut =
      sessionStats.bytesIndexed +
      sessionStats.bytesSandboxed +
      sessionStats.cacheBytesSaved;
    const totalProcessed = keptOut + totalReturned;
    const reductionPct =
      totalProcessed > 0
        ? Math.round((1 - totalReturned / totalProcessed) * 100)
        : 0;
    const tokensSaved = Math.round(keptOut / 4);

    let lifetimeTokens = _lifetimeCache?.tokens ?? 0;
    if (!_lifetimeCache || now - _lifetimeCache.computedAt > LIFETIME_REFRESH_MS) {
      try {
        const life = getLifetimeStats({ sessionsDir: getSessionDir() });
        lifetimeTokens = (life?.totalEvents ?? 0) * TOKENS_PER_EVENT;
        _lifetimeCache = { tokens: lifetimeTokens, computedAt: now };
      } catch {
        // best-effort — keep stale cache or 0
      }
    }

    const payload = {
      schemaVersion: STATS_SCHEMA_VERSION,
      version: VERSION,
      updated_at: now,
      session_start: sessionStats.sessionStart,
      uptime_ms: now - sessionStats.sessionStart,
      total_calls: totalCalls,
      bytes_returned: totalReturned,
      bytes_indexed: sessionStats.bytesIndexed,
      bytes_sandboxed: sessionStats.bytesSandboxed,
      cache_hits: sessionStats.cacheHits,
      cache_bytes_saved: sessionStats.cacheBytesSaved,
      kept_out: keptOut,
      total_processed: totalProcessed,
      reduction_pct: reductionPct,
      tokens_saved: tokensSaved,
      dollars_saved_session: +(tokensSaved * OPUS_INPUT_PRICE_PER_TOKEN).toFixed(2),
      tokens_saved_lifetime: lifetimeTokens,
      dollars_saved_lifetime: +(lifetimeTokens * OPUS_INPUT_PRICE_PER_TOKEN).toFixed(2),
      by_tool: Object.fromEntries(
        Object.keys({ ...sessionStats.calls, ...sessionStats.bytesReturned }).map(
          (t) => [
            t,
            {
              calls: sessionStats.calls[t] || 0,
              bytes: sessionStats.bytesReturned[t] || 0,
            },
          ],
        ),
      ),
    };

    const filePath = getStatsFilePath();
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload));
    renameSync(tmpPath, filePath);
  } catch {
    // best-effort — never break tool calls because of stats persistence
  }
}

// ── Version check startup ──────────────────────────────────

export function startVersionCheck(): void {
  fetchLatestVersion().then(v => { if (v !== "unknown") _latestVersion = v; });
  setInterval(() => {
    fetchLatestVersion().then(v => { if (v !== "unknown") _latestVersion = v; });
  }, 60 * 60 * 1000).unref();
}

// ── Stats restore on startup ───────────────────────────────

export function restoreStatsOnStartup(): void {
  try {
    const restored = restoreSessionStats(getSessionDbPath());
    if (restored) {
      for (const [tool, count] of Object.entries(restored.calls)) {
        sessionStats.calls[tool] = count;
      }
      for (const [tool, bytes] of Object.entries(restored.bytesReturned)) {
        sessionStats.bytesReturned[tool] = bytes;
      }
      if (restored.sessionStart > 0) {
        sessionStats.sessionStart = restored.sessionStart;
      }
    }
  } catch { /* best effort — never block startup on a stats restore failure */ }
}

// ── FS read tracking preload for ctx_batch_execute ──────────

export const CM_FS_PRELOAD = join(tmpdir(), `cm-fs-preload-${process.pid}.js`);

export function writeFsPreload(): void {
  writeFileSync(
    CM_FS_PRELOAD,
    `(function(){var __cm_fs=0;process.on('exit',function(){if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch(e){}});try{var f=require('fs');var ors=f.readFileSync;f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};}catch(e){}})();\n`,
  );
}

// ── Snippet extraction helpers ──────────────────────────────

const STX = "\x02";
const ETX = "\x03";

export function positionsFromHighlight(highlighted: string): number[] {
  const positions: number[] = [];
  let cleanOffset = 0;

  let i = 0;
  while (i < highlighted.length) {
    if (highlighted[i] === STX) {
      positions.push(cleanOffset);
      i++;
      while (i < highlighted.length && highlighted[i] !== ETX) {
        cleanOffset++;
        i++;
      }
      if (i < highlighted.length) i++;
    } else {
      cleanOffset++;
      i++;
    }
  }

  return positions;
}

function stripMarkers(highlighted: string): string {
  return highlighted.replaceAll(STX, "").replaceAll(ETX, "");
}

export function extractSnippet(
  content: string,
  query: string,
  maxLen = 1500,
  highlighted?: string,
): string {
  if (content.length <= maxLen) return content;

  const positions: number[] = [];

  if (highlighted) {
    for (const pos of positionsFromHighlight(highlighted)) {
      positions.push(pos);
    }
  }

  if (positions.length === 0) {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const lower = content.toLowerCase();

    for (const term of terms) {
      let idx = lower.indexOf(term);
      while (idx !== -1) {
        positions.push(idx);
        idx = lower.indexOf(term, idx + 1);
      }
    }
  }

  if (positions.length === 0) {
    return content.slice(0, maxLen) + "\n…";
  }

  positions.sort((a, b) => a - b);
  const WINDOW = 300;
  const windows: Array<[number, number]> = [];

  for (const pos of positions) {
    const start = Math.max(0, pos - WINDOW);
    const end = Math.min(content.length, pos + WINDOW);
    if (windows.length > 0 && start <= windows[windows.length - 1][1]) {
      windows[windows.length - 1][1] = end;
    } else {
      windows.push([start, end]);
    }
  }

  const parts: string[] = [];
  let total = 0;
  for (const [start, end] of windows) {
    if (total >= maxLen) break;
    const part = content.slice(start, Math.min(end, start + (maxLen - total)));
    parts.push(
      (start > 0 ? "…" : "") + part + (end < content.length ? "…" : ""),
    );
    total += part.length;
  }

  return parts.join("\n\n");
}

export async function formatBatchQueryResults(
  store: ContentStore,
  queries: string[],
  source: string,
  maxOutput = 80 * 1024,
): Promise<string[]> {
  const sections: string[] = [];
  let outputSize = 0;

  for (const query of queries) {
    if (outputSize > maxOutput) {
      sections.push(`## ${query}\n(output cap reached — use ctx_search(queries: ["${query}"]) for details)\n`);
      continue;
    }

    const results = await store.searchWithFallback(query, 3, source, undefined, "exact");
    sections.push(`## ${query}`);
    sections.push("");
    if (results.length > 0) {
      for (const result of results) {
        const snippet = extractSnippet(result.content, query, 3000, result.highlighted);
        sections.push(`### ${result.title}`);
        sections.push(snippet);
        sections.push("");
        outputSize += snippet.length + result.title.length;
      }
      continue;
    }

    sections.push("No matching sections found.");
    sections.push("");
  }

  sections.push(`\n> **Tip:** Results are scoped to this batch only. To search across all indexed sources, use \`ctx_search(queries: [...])\`.`);

  return sections;
}

// ── Batch execution helpers ────────────────────────────────

export interface BatchCommand { label: string; command: string; }

export interface BatchRunResult {
  outputs: string[];
  timedOut: boolean;
}

export interface BatchRunOptions {
  timeout: number | undefined;
  concurrency: number;
  nodeOptsPrefix: string;
  onFsBytes?: (bytes: number) => void;
}

interface BatchExecutor {
  execute(input: { language: "shell"; code: string; timeout: number | undefined }): Promise<{ stdout: string; timedOut?: boolean }>;
}

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildBatchNodeOptionsPrefix(shellPath: string, preloadPath: string): string {
  const option = `--require ${preloadPath}`;
  const shell = shellPath.toLowerCase();
  const base = shell.split(/[\\/]/).pop() ?? shell;

  if (shell.includes("powershell") || shell.includes("pwsh")) {
    return `$env:NODE_OPTIONS=${quotePowerShellSingle(option)}; `;
  }

  if (base === "cmd" || base === "cmd.exe") {
    return `set "NODE_OPTIONS=${option.replace(/"/g, '""')}" && `;
  }

  return `NODE_OPTIONS=${quotePosixSingle(option)} `;
}

function formatCommandOutput(label: string, raw: string, onFsBytes?: (bytes: number) => void): string {
  let output = raw || "(no output)";
  const fsMatches = output.matchAll(/__CM_FS__:(\d+)/g);
  let cmdFsBytes = 0;
  for (const m of fsMatches) cmdFsBytes += parseInt(m[1]);
  if (cmdFsBytes > 0) {
    onFsBytes?.(cmdFsBytes);
    output = output.replace(/__CM_FS__:\d+\n?/g, "");
  }
  return `# ${label}\n\n${output}\n`;
}

export async function runBatchCommands(
  commands: BatchCommand[],
  opts: BatchRunOptions,
  executor: BatchExecutor,
): Promise<BatchRunResult> {
  const { timeout, concurrency, nodeOptsPrefix, onFsBytes } = opts;

  if (concurrency <= 1) {
    const outputs: string[] = [];
    const startTime = Date.now();
    let timedOut = false;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      let perCmdTimeout: number | undefined;
      if (timeout !== undefined) {
        const elapsed = Date.now() - startTime;
        const remaining = timeout - elapsed;
        if (remaining <= 0) {
          outputs.push(`# ${cmd.label}\n\n(skipped — batch timeout exceeded)\n`);
          timedOut = true;
          continue;
        }
        perCmdTimeout = remaining;
      }
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command} 2>&1`,
        timeout: perCmdTimeout,
      });
      outputs.push(formatCommandOutput(cmd.label, result.stdout, onFsBytes));
      if (result.timedOut) {
        timedOut = true;
        for (let j = i + 1; j < commands.length; j++) {
          outputs.push(`# ${commands[j].label}\n\n(skipped — batch timeout exceeded)\n`);
        }
        break;
      }
    }
    return { outputs, timedOut };
  }

  const { runPool } = await import("../concurrency/runPool.js");
  type PoolJob<T> = import("../concurrency/runPool.js").PoolJob<T>;
  const jobs: PoolJob<{ output: string; timedOut: boolean }>[] = commands.map((cmd) => ({
    run: async () => {
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command} 2>&1`,
        timeout,
      });
      const formatted = formatCommandOutput(cmd.label, result.stdout, onFsBytes);
      const output = result.timedOut
        ? formatted.replace(/\n$/, "") + `\n(timed out after ${timeout ?? "?"}ms)\n`
        : formatted;
      return { output, timedOut: !!result.timedOut };
    },
  }));

  const { settled } = await runPool(jobs, { concurrency });
  const outputs: string[] = new Array(commands.length);
  let timedOut = false;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      outputs[i] = r.value.output;
      if (r.value.timedOut) timedOut = true;
    } else {
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      outputs[i] = `# ${commands[i].label}\n\n(executor error: ${message})\n`;
    }
  }
  return { outputs, timedOut };
}

// ── Security check helpers ─────────────────────────────────

import {
  readBashPolicies,
  evaluateCommandDenyOnly,
  extractShellCommands,
  readToolDenyPatterns,
  evaluateFilePath,
} from "../security.js";

export function checkDenyPolicy(
  command: string,
  toolName: string,
): ToolResult | null {
  try {
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    const result = evaluateCommandDenyOnly(command, policies);
    if (result.decision === "deny") {
      return trackResponse(toolName, {
        content: [{
          type: "text" as const,
          text: `Command blocked by security policy: matches deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      });
    }
  } catch {
    // Security check failed — allow through (fail-open)
  }
  return null;
}

export function checkNonShellDenyPolicy(
  code: string,
  language: string,
  toolName: string,
): ToolResult | null {
  try {
    const commands = extractShellCommands(code, language);
    if (commands.length === 0) return null;
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    for (const cmd of commands) {
      const result = evaluateCommandDenyOnly(cmd, policies);
      if (result.decision === "deny") {
        return trackResponse(toolName, {
          content: [{
            type: "text" as const,
            text: `Command blocked by security policy: embedded shell command "${cmd}" matches deny pattern ${result.matchedPattern}`,
          }],
          isError: true,
        });
      }
    }
  } catch {
    // Fail-open
  }
  return null;
}

export function checkFilePathDenyPolicy(
  filePath: string,
  toolName: string,
): ToolResult | null {
  try {
    const projectDir = getProjectDir();
    const denyGlobs = readToolDenyPatterns("Read", projectDir);
    const result = evaluateFilePath(
      filePath,
      denyGlobs,
      process.platform === "win32",
      projectDir,
    );
    if (result.denied) {
      return trackResponse(toolName, {
        content: [{
          type: "text" as const,
          text: `File access blocked by security policy: path matches Read deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      });
    }
  } catch {
    // Fail-open
  }
  return null;
}

// ── Intent search thresholds ────────────────────────────────

export const INTENT_SEARCH_THRESHOLD = 5_000;
export const LARGE_OUTPUT_THRESHOLD = 102_400;

// ── Coercion helpers for double-serialized params ───────────

export function coerceJsonArray(val: unknown): unknown {
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not valid JSON, let zod handle the error */ }
  }
  return val;
}

export function coerceCommandsArray(val: unknown): unknown {
  const arr = coerceJsonArray(val);
  if (Array.isArray(arr)) {
    return arr.map((item, i) =>
      typeof item === "string" ? { label: `cmd_${i + 1}`, command: item } : item
    );
  }
  return arr;
}

// ── SSRF classification (shared with fetch handler + tests) ─

export function classifyIp(ip: string): "block" | "private" | "public" {
  const lower = ip.toLowerCase();

  if (lower.includes(":")) {
    const v4MappedMatch = lower.match(/^::ffff:([\d.]+)$/);
    if (v4MappedMatch) return classifyIp(v4MappedMatch[1]);
    if (lower === "::") return "block";
    if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
        lower.startsWith("fea") || lower.startsWith("feb")) return "block";
    if (lower.startsWith("ff")) return "block";
    if (lower === "::1") return "private";
    if (lower.startsWith("fc") || lower.startsWith("fd")) return "private";
    return "public";
  }

  if (!ip.includes(".")) return "block";
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return "block";
  const [a, b] = parts;
  if (a === 169 && b === 254) return "block";
  if (a === 0) return "block";
  if (a >= 224) return "block";
  if (a === 127) return "private";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  return "public";
}
