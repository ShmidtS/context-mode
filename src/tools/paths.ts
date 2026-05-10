// ─────────────────────────────────────────────────────────
// Platform-aware paths, store singleton, shared state
// ─────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, mkdirSync, unlinkSync, statSync, symlinkSync } from "node:fs";
import { join, dirname, resolve, sep, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ContentStore, cleanupStaleDBs, cleanupStaleContentDBs } from "../store.js";
import { getWorktreeSuffix } from "../session/db.js";
export { getWorktreeSuffix };
import { detectPlatform, getSessionDirSegments } from "../adapters/detect.js";
import { type HookAdapter } from "../adapters/types.js";

// ── Package metadata ──────────────────────────────────────

function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === "context-mode") return dir;
      } catch { /* continue */ }
    }
    dir = dirname(dir);
  }
  return startDir;
}
const __pkg_dir = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
// Re-export for tools that need it
export { __pkg_dir };

export const VERSION: string = (() => {
  const p = resolve(__pkg_dir, "package.json");
  if (existsSync(p)) {
    try { return JSON.parse(readFileSync(p, "utf8")).version; } catch (e) { console.warn("VERSION read failed", e) }
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

// ── Self-heal Layer 2: Mid-session registry heal ───────────

let _cacheHealDone = false;
export function healCacheMidSession(): void {
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
        try { if (statSync(rp).isSymbolicLink()) unlinkSync(rp); } catch (e) { console.warn("fixPluginSymlinks stat/unlink failed", e) }
        try { if (existsSync(rp)) unlinkSync(rp); } catch (e) { console.warn("fixPluginSymlinks unlink failed", e) }
        const parent = dirname(rp);
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
        if (existsSync(pluginRoot)) {
          symlinkSync(pluginRoot, rp, process.platform === "win32" ? "junction" : undefined);
        }
      }
    }
  } catch (e) { console.warn("fixPluginSymlinks failed", e) }
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
  } catch (e) { console.warn("getSessionDir detectPlatform failed", e) }
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

// ── Content store singleton ────────────────────────────────

// Lazy singleton — no DB overhead unless index/search is used
let _store: ContentStore | null = null;

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
      } catch (e) { console.warn("maybeIndexSessionEvents index failed", e) }
    }
  } catch (e) { console.warn("maybeIndexSessionEvents failed", e) }
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
    } catch (e) { console.warn("getStore cleanupStaleContentDBs failed", e) }

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
    try { _store.close(); } catch (e) { console.warn("closeStore failed", e) }
    _store = null;
  }
}

// ── Intent search thresholds ────────────────────────────────

export const INTENT_SEARCH_THRESHOLD = 5_000;
export const LARGE_OUTPUT_THRESHOLD = 102_400;
