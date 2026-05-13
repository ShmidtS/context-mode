/**
 * watcher — Debounced file watcher for auto-reindexing local code repositories.
 *
 * Uses fs.watch with recursive option. Accumulates changed file paths and
 * triggers incremental reindex after a 1-second debounce. Persists watched
 * paths to disk for restoration across MCP server restarts.
 */

import { watch, type FSWatcher } from "node:fs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { LocalIndexer } from "./local-indexer.js";

const WATCH_CONFIG = join(homedir(), ".context-mode", "watched.json");
const DEBOUNCE_MS = 1000;

interface WatchEntry {
  dirPath: string;
  repoId: string;
  dbPath?: string;
}

const watchers = new Map<string, FSWatcher>();
const pendingFiles = new Map<string, Set<string>>(); // repoId -> files
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getWatchedConfig(): WatchEntry[] {
  if (!existsSync(WATCH_CONFIG)) return [];
  try {
    return JSON.parse(readFileSync(WATCH_CONFIG, "utf-8")) as WatchEntry[];
  } catch {
    return [];
  }
}

function saveWatchedConfig(entries: WatchEntry[]): void {
  try {
    mkdirSync(dirname(WATCH_CONFIG), { recursive: true });
    writeFileSync(WATCH_CONFIG, JSON.stringify(entries, null, 2));
  } catch { /* ignore */ }
}

function isIgnorable(path: string): boolean {
  const parts = path.split(/[\\/]/);
  const ignoreDirs = new Set([
    ".git", "node_modules", ".next", "dist", "build", "coverage",
    ".claude", ".omc", ".openclaw-plugin", ".pi", ".vscode",
  ]);
  for (const part of parts) {
    if (ignoreDirs.has(part)) return true;
    if (part.startsWith(".")) return true;
  }
  return false;
}

async function reindexPending(dirPath: string, repoId: string, dbPath?: string): Promise<void> {
  const files = pendingFiles.get(repoId);
  if (!files || files.size === 0) return;
  pendingFiles.set(repoId, new Set());

  try {
    const indexer = new LocalIndexer(dbPath);
    await indexer.indexRepository(dirPath, repoId, { batchSize: 64 });
    indexer.close();
  } catch (e) {
    console.warn(`[watcher] Reindex failed for ${repoId}:`, e);
  }
}

export function startWatching(dirPath: string, repoId: string, dbPath?: string): void {
  if (watchers.has(repoId)) return;

  const absPath = resolve(dirPath);
  if (!existsSync(absPath)) {
    console.warn(`[watcher] Directory not found: ${absPath}`);
    return;
  }

  pendingFiles.set(repoId, new Set());

  const watcher = watch(absPath, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const fullPath = join(absPath, filename);
    if (isIgnorable(fullPath)) return;
    if (eventType !== "change" && eventType !== "rename") return;

    const set = pendingFiles.get(repoId);
    if (!set) return;
    set.add(filename);

    const existing = debounceTimers.get(repoId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      debounceTimers.delete(repoId);
      reindexPending(absPath, repoId, dbPath).catch(() => {});
    }, DEBOUNCE_MS);
    debounceTimers.set(repoId, timer);
  });

  watchers.set(repoId, watcher);

  // Persist
  const config = getWatchedConfig();
  const filtered = config.filter((e) => e.repoId !== repoId);
  filtered.push({ dirPath: absPath, repoId, dbPath });
  saveWatchedConfig(filtered);
}

export function stopWatching(repoId: string): void {
  const w = watchers.get(repoId);
  if (w) {
    w.close();
    watchers.delete(repoId);
  }
  const t = debounceTimers.get(repoId);
  if (t) clearTimeout(t);
  debounceTimers.delete(repoId);
  pendingFiles.delete(repoId);

  const config = getWatchedConfig();
  saveWatchedConfig(config.filter((e) => e.repoId !== repoId));
}

export function restoreWatchers(): void {
  const config = getWatchedConfig();
  for (const entry of config) {
    if (existsSync(entry.dirPath)) {
      startWatching(entry.dirPath, entry.repoId, entry.dbPath);
    }
  }
}

export function stopAllWatchers(): void {
  for (const [repoId] of watchers) {
    stopWatching(repoId);
  }
}

process.on("exit", () => {
  stopAllWatchers();
});
