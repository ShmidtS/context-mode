/**
 * fs — File-system utilities for local code indexing.
 *
 * Provides recursive file walking, SHA-256 hashing, and Merkle-style
 * diff against a known database state. Adapted from Optiq approaches.
 */

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, normalize, sep } from "node:path";
import { createHash } from "node:crypto";

export const IGNORE_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "coverage",
  ".claude", ".omc", ".openclaw-plugin", ".pi", ".vscode",
  "__pycache__", ".pytest_cache", ".mypy_cache", "*.egg-info",
]);

export const IGNORE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot",
  ".mp3", ".mp4", ".webm", ".ogg", ".wav",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib",
  ".db", ".sqlite", ".sqlite3",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".o", ".obj", ".a", ".lib",
]);

export interface FileMeta {
  path: string;
  relPath: string;
  mtime: number;
  size: number;
}

function shouldIgnoreDir(name: string): boolean {
  return IGNORE_DIRS.has(name);
}

function shouldIgnoreFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return IGNORE_EXTENSIONS.has(ext);
}

function containsNullBytes(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 4096); i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function collectFileMetas(dirPath: string, repoId: string): FileMeta[] {
  const metas: FileMeta[] = [];
  const absRoot = normalize(dirPath);

  function walk(current: string) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(current, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!shouldIgnoreDir(entry)) walk(full);
      } else if (st.isFile()) {
        if (shouldIgnoreFile(entry)) continue;
        const rel = relative(absRoot, full);
        if (sep === "\\") {
          metas.push({ path: full.replace(/\\/g, "/"), relPath: rel.replace(/\\/g, "/"), mtime: st.mtimeMs, size: st.size });
        } else {
          metas.push({ path: full, relPath: rel, mtime: st.mtimeMs, size: st.size });
        }
      }
    }
  }

  walk(absRoot);
  return metas;
}

export function computeFileHash(path: string): string {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

export interface DiffResult {
  toUpload: FileMeta[];
  toDelete: string[];
  unchanged: FileMeta[];
}

export function diffWithDb(
  metas: FileMeta[],
  dbFiles: Array<{ path: string; mtime: number; size: number; sha256: string }>,
): DiffResult {
  const dbMap = new Map<string, { mtime: number; size: number; sha256: string }>();
  for (const f of dbFiles) dbMap.set(f.path, f);

  const toUpload: FileMeta[] = [];
  const unchanged: FileMeta[] = [];

  for (const meta of metas) {
    const db = dbMap.get(meta.relPath);
    if (!db) {
      toUpload.push(meta);
    } else if (db.mtime !== meta.mtime || db.size !== meta.size) {
      toUpload.push(meta);
    } else {
      unchanged.push(meta);
    }
    dbMap.delete(meta.relPath);
  }

  const toDelete = Array.from(dbMap.keys());
  return { toUpload, toDelete, unchanged };
}

export function readFilesByPath(dirPath: string, relPaths: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const absRoot = normalize(dirPath);
  for (const rel of relPaths) {
    const full = join(absRoot, rel);
    try {
      const buf = readFileSync(full);
      if (containsNullBytes(buf)) continue;
      result.set(rel, buf.toString("utf-8"));
    } catch {
      // skip unreadable
    }
  }
  return result;
}

export function normalizePath(p: string): string {
  return normalize(p).replace(/\\/g, "/");
}
