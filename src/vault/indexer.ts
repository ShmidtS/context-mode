/**
 * indexer — Orchestrate vault indexing.
 *
 * Walks a vault root recursively, parses every .md file, resolves links,
 * and feeds nodes + edges into a VaultGraphStore. Supports incremental
 * re-index by comparing contentHash + mtime.
 */

import { readdirSync, statSync, readFileSync, lstatSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import { createHash } from "node:crypto";
import { parseVaultNote } from "./parser.js";
import { parseCodeFile, type ParsedCodeFile } from "./code-parser.js";
import { resolveLink } from "./resolver.js";
import { normalizePath } from "./path-utils.js";

// ─────────────────────────────────────────────────────────
// File reading with encoding fallback
// ─────────────────────────────────────────────────────────

/**
 * Read a file as text with UTF-8 BOM stripping and encoding fallback.
 *
 * 1. Strip UTF-8 BOM if present (0xEF 0xBB 0xBF).
 * 2. Decode as UTF-8.
 * 3. If >1% of chars are replacement chars (U+FFFD), fall back to latin1
 *    which covers windows-1251, latin1, and other single-byte encodings.
 */
function readFileText(absPath: string): string {
  const buffer = readFileSync(absPath);

  // Strip UTF-8 BOM
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return buffer.subarray(3).toString("utf-8");
  }

  const utf8 = buffer.toString("utf-8");

  // Fallback to latin1 if too many replacement characters
  const replacementCount = (utf8.match(/�/g) ?? []).length;
  if (replacementCount > utf8.length * 0.01) {
    return buffer.toString("latin1");
  }

  return utf8;
}

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface VaultNode {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  contentHash: string;
  mtimeMs: number;
  inDegree: number;
}

export interface VaultEdge {
  sourcePath: string;
  targetPath: string | null; // null = broken link
  linkType: "wikilink" | "embed" | "markdown" | "import" | "reference" | "external";
  alias?: string;
  targetName?: string;
  context: string;
  lineNumber: number;
}

/** Minimal store interface the indexer requires. */
export interface VaultGraphStore {
  getNode(path: string): VaultNode | undefined;
  upsertNode(node: VaultNode): void;
  upsertEdge(edge: VaultEdge): void;
  removeEdgesFrom(sourcePath: string): void;
}

export interface IndexResult {
  indexed: number;
  updated: number;
  skipped: number;
  brokenLinks: number;
}

// ─────────────────────────────────────────────────────────
// File walking
// ─────────────────────────────────────────────────────────

/** Default directories to exclude when walking the vault. */
const DEFAULT_EXCLUDE_DIRS = [".git", "node_modules", ".omc", "dist", "build", "coverage", ".claude", ".obsidian"];

/** File extensions for code files that should be indexed. */
const CODE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs"]);

/** Recursively collect all source file paths relative to vaultRoot.
 *  Collects .md files AND code files (.ts, .js, .mjs, .cjs).
 *  Symlinks are followed ONLY if they resolve within vaultRoot.
 *  Cycle detection prevents infinite recursion.
 */
function collectSourceFiles(
  vaultRoot: string,
  dir: string,
  visited: Set<string> = new Set(),
  acc: string[] = [],
  excludePatterns?: string[],
): string[] {
  const excludeDirs = new Set(excludePatterns ?? DEFAULT_EXCLUDE_DIRS);
  const resolvedDir = resolve(dir);
  if (visited.has(resolvedDir)) return acc;
  visited.add(resolvedDir);

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    // Skip excluded directories (check before recursing)
    if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    const resolvedPath = resolve(fullPath);

    // Reject paths that escape vaultRoot (path traversal defense)
    if (!resolvedPath.startsWith(resolvedDir) && !resolvedPath.startsWith(resolve(vaultRoot))) {
      continue;
    }

    // Use lstatSync to detect symlinks — do NOT follow symlinks by default
    let lstat;
    try {
      lstat = lstatSync(fullPath);
    } catch {
      continue;
    }

    if (lstat.isSymbolicLink()) {
      // Follow symlinks ONLY if they resolve within vaultRoot
      let realTarget: string;
      try {
        realTarget = resolve(fullPath);
      } catch {
        continue;
      }
      const vaultRootResolved = resolve(vaultRoot);
      if (!realTarget.startsWith(vaultRootResolved)) continue;

      // Check if symlink points to a directory
      let targetStat;
      try {
        targetStat = statSync(fullPath); // follows symlink
      } catch {
        continue;
      }
      if (targetStat.isDirectory()) {
        collectSourceFiles(vaultRoot, fullPath, visited, acc, excludePatterns);
      } else if (targetStat.isFile()) {
        const ext = extname(entry.name);
        if (entry.name.endsWith(".md") || CODE_EXTENSIONS.has(ext)) {
          acc.push(relative(vaultRoot, fullPath).replace(/\\/g, "/"));
        }
      }
    } else if (lstat.isDirectory()) {
      collectSourceFiles(vaultRoot, fullPath, visited, acc, excludePatterns);
    } else if (lstat.isFile()) {
      const ext = extname(entry.name);
      if (entry.name.endsWith(".md") || CODE_EXTENSIONS.has(ext)) {
        acc.push(relative(vaultRoot, fullPath).replace(/\\/g, "/"));
      }
    }
  }

  return acc;
}

// ─────────────────────────────────────────────────────────
// Main indexer
// ─────────────────────────────────────────────────────────

/**
 * Index an Obsidian vault into the given store.
 *
 * @param vaultRoot — Absolute path to the vault root directory.
 * @param store     — VaultGraphStore implementation to receive nodes/edges.
 * @param opts      — Optional indexing options (exclude patterns).
 */
export interface IndexOpts {
  /** Directory names to exclude from traversal. Defaults to DEFAULT_EXCLUDE_DIRS. */
  excludePatterns?: string[];
}

export function indexVault(vaultRoot: string, store: VaultGraphStore, opts?: IndexOpts): IndexResult {
  const result: IndexResult = { indexed: 0, updated: 0, skipped: 0, brokenLinks: 0 };

  const allFiles = collectSourceFiles(vaultRoot, vaultRoot, new Set(), [], opts?.excludePatterns);
  const allPaths = new Set<string>(allFiles);

  const mdFiles = allFiles.filter((f) => f.endsWith(".md"));
  const codeFiles = allFiles.filter((f) => {
    const ext = extname(f);
    return CODE_EXTENSIONS.has(ext);
  });

  // ── Pass 1a: upsert all markdown nodes ──
  const toIndex: Array<{ relPath: string; absPath: string; stat: { mtimeMs: number }; parsed: ReturnType<typeof parseVaultNote>; existing?: VaultNode }> = [];

  for (const relPath of mdFiles) {
    const absPath = join(vaultRoot, relPath);
    let stat: { mtimeMs: number };
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }

    const existing = store.getNode(relPath);
    if (existing && existing.mtimeMs === stat.mtimeMs) {
      result.skipped++;
      continue;
    }

    let content: string;
    try {
      content = readFileText(absPath);
    } catch {
      continue;
    }

    const parsed = parseVaultNote(relPath, content);

    if (existing && existing.contentHash === parsed.contentHash) {
      store.upsertNode({ ...existing, mtimeMs: stat.mtimeMs });
      result.skipped++;
      continue;
    }

    toIndex.push({ relPath, absPath, stat, parsed, existing });
  }

  // Upsert all markdown nodes first so that every target path resolves to a DB row
  for (const item of toIndex) {
    const inDegree = item.existing?.inDegree ?? 0;
    store.upsertNode({
      path: item.parsed.path,
      title: item.parsed.title,
      frontmatter: item.parsed.frontmatter,
      tags: item.parsed.tags,
      contentHash: item.parsed.contentHash,
      mtimeMs: item.stat.mtimeMs,
      inDegree,
    });

    if (item.existing) {
      result.updated++;
    } else {
      result.indexed++;
    }
  }

  // ── Pass 1b: upsert all code file nodes ──
  const codeToIndex: Array<{ relPath: string; stat: { mtimeMs: number }; parsed: ParsedCodeFile; existing?: VaultNode }> = [];

  for (const relPath of codeFiles) {
    const absPath = join(vaultRoot, relPath);
    let stat: { mtimeMs: number };
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }

    const existing = store.getNode(relPath);
    if (existing && existing.mtimeMs === stat.mtimeMs) {
      result.skipped++;
      continue;
    }

    let content: string;
    try {
      content = readFileText(absPath);
    } catch {
      continue;
    }

    const parsed = parseCodeFile(relPath, content, allPaths, vaultRoot);
    const contentHash = createHash("sha256").update(content).digest("hex");

    if (existing && existing.contentHash === contentHash) {
      store.upsertNode({ ...existing, mtimeMs: stat.mtimeMs });
      result.skipped++;
      continue;
    }

    codeToIndex.push({ relPath, stat, parsed, existing });
  }

  // Upsert all code nodes
  for (const item of codeToIndex) {
    const inDegree = item.existing?.inDegree ?? 0;
    store.upsertNode({
      path: item.parsed.path,
      title: item.parsed.title,
      frontmatter: null as unknown as Record<string, unknown>,
      tags: item.parsed.tags,
      contentHash: item.parsed.contentHash,
      mtimeMs: item.stat.mtimeMs,
      inDegree,
    });

    if (item.existing) {
      result.updated++;
    } else {
      result.indexed++;
    }
  }

  // ── Pass 2: resolve and insert edges (all target nodes now exist) ──
  for (const item of toIndex) {
    const { relPath, parsed } = item;

    // Remove old edges before re-inserting
    store.removeEdgesFrom(relPath);

    const sourceDir = relPath.includes("/")
      ? relPath.substring(0, relPath.lastIndexOf("/"))
      : "";

    for (const wl of parsed.wikiLinks) {
      const targetPath = resolveLink(wl.target, sourceDir, vaultRoot, allPaths);
      if (targetPath === null) {
        result.brokenLinks++;
      }

      store.upsertEdge({
        sourcePath: relPath,
        targetPath,
        linkType: wl.type === "embed" ? "embed" : "wikilink",
        alias: wl.alias,
        context: wl.context,
        lineNumber: wl.lineNumber,
      });
    }

    for (const ml of parsed.markdownLinks) {
      const mdTarget = normalizePath(join(sourceDir, ml.target));
      const resolved = allPaths.has(mdTarget) ? mdTarget : null;

      if (resolved === null) {
        result.brokenLinks++;
      }

      // Determine linkType: "reference" for markdown->code, "markdown" for markdown->markdown
      const isCodeLink = CODE_EXTENSIONS.has(extname(ml.target));

      store.upsertEdge({
        sourcePath: relPath,
        targetPath: resolved,
        linkType: isCodeLink ? "reference" : "markdown",
        context: ml.context,
        lineNumber: ml.lineNumber,
      });
    }
  }

  // ── Pass 2b: insert import edges from code files ──
  for (const item of codeToIndex) {
    const { relPath, parsed } = item;

    // Remove old edges before re-inserting
    store.removeEdgesFrom(relPath);

    for (const imp of parsed.imports) {
      if (imp.resolvedPath !== null) {
        store.upsertEdge({
          sourcePath: relPath,
          targetPath: imp.resolvedPath,
          linkType: "import",
          context: imp.context,
          lineNumber: imp.lineNumber,
        });
      } else if (imp.isExternal) {
        store.upsertEdge({
          sourcePath: relPath,
          targetPath: null,
          linkType: "external",
          targetName: imp.specifier,
          context: imp.context,
          lineNumber: imp.lineNumber,
        });
      } else {
        store.upsertEdge({
          sourcePath: relPath,
          targetPath: null,
          linkType: "import",
          targetName: imp.specifier,
          context: imp.context,
          lineNumber: imp.lineNumber,
        });
      }
    }
  }

  return result;
}

