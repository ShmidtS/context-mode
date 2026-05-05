/**
 * code-parser — Parse TypeScript/JavaScript files for import/dependency graph.
 *
 * Extracts import statements, require() calls, dynamic imports, and
 * export-from patterns using regex-based parsing. Resolves relative
 * imports to file paths.
 */

import { createHash } from "node:crypto";
import { join, normalize, relative } from "node:path";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface ImportEntry {
  /** The raw module specifier from the import/require statement. */
  specifier: string;
  /** Resolved file path (relative to vault root) or null if non-relative. */
  resolvedPath: string | null;
  /** 1-based line number in the file. */
  lineNumber: number;
  /** ~120 chars of context around the import. */
  context: string;
  /** Import style: "static", "dynamic", "require", "export-from". */
  kind: "static" | "dynamic" | "require" | "export-from";
  /** True if the specifier is a non-relative (external/bare) module. */
  isExternal: boolean;
}

export interface ParsedCodeFile {
  path: string;
  title: string;
  tags: string[];
  imports: ImportEntry[];
  contentHash: string;
}

// ─────────────────────────────────────────────────────────
// Regex patterns
// ─────────────────────────────────────────────────────────

// import ... from 'module' or import ... from "module"
const STATIC_IMPORT_RE = /import\s+.*?\s+from\s+['"]([^'"]+)['"];?/g;

// import('module') or import("module")
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// require('module') or require("module")
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// export { ... } from 'module' or export * from 'module'
const EXPORT_FROM_RE = /export\s+(?:\{[^}]*\}|(?:type\s+)?\*)\s+from\s+['"]([^'"]+)['"];?/g;

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/** Derive tags from a filepath (e.g. "src/vault/indexer.ts" -> ["vault"]). */
function deriveTagsFromPath(filePath: string): string[] {
  const parts = filePath.replace(/\\/g, "/").split("/");
  // Skip filename (last part) — use directory segments as tags
  const dirParts = parts.slice(0, -1).filter((p) => p.length > 0 && !p.startsWith("."));
  return dirParts;
}

/** Derive title from filename without extension. */
function deriveTitle(filePath: string): string {
  const stem = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  return stem.replace(/\.(ts|js|mjs|cjs)$/, "");
}

/**
 * Try to resolve a relative specifier to an actual file path.
 * Adds .ts/.js/.mjs/.cjs extensions if missing.
 * Returns null for non-relative specifiers (node_modules, builtins).
 */
const CODE_EXTS = [".ts", ".js", ".mjs", ".cjs"];

/** Try resolving a base path against allPaths with extension fallback. */
function tryResolveBase(base: string, allPaths: Set<string>): string | null {
  // Exact match
  if (allPaths.has(base)) return base;

  // If base already has an extension, try replacing it with each code extension
  const hasCodeExt = CODE_EXTS.some((e) => base.endsWith(e));
  if (hasCodeExt) {
    const stem = base.slice(0, base.lastIndexOf("."));
    for (const ext of CODE_EXTS) {
      const candidate = stem + ext;
      if (allPaths.has(candidate)) return candidate;
    }
  }

  // Try appending extensions (for extensionless specifiers)
  for (const ext of CODE_EXTS) {
    const candidate = base + ext;
    if (allPaths.has(candidate)) return candidate;
  }

  // Try index files inside the directory
  for (const ext of CODE_EXTS) {
    const indexPath = normalizePath(join(base, `index${ext}`));
    if (allPaths.has(indexPath)) return indexPath;
  }

  return null;
}

function resolveImportSpecifier(
  specifier: string,
  sourceDir: string,
  allPaths: Set<string>,
  vaultRoot?: string,
): string | null {
  // Relative specifiers: resolve from source directory
  if (specifier.startsWith(".")) {
    const base = normalizePath(join(sourceDir, specifier));
    return tryResolveBase(base, allPaths);
  }

  // Non-relative specifiers: try resolving against vault root
  if (vaultRoot) {
    const absBase = normalizePath(join(vaultRoot, specifier));
    const base = relative(vaultRoot, absBase).replace(/\\/g, "/");
    return tryResolveBase(base, allPaths);
  }

  return null;
}

/** Extract context (~120 chars) around a match position. */
function extractContext(line: string, matchIndex: number, matchLength: number): string {
  const ctxStart = Math.max(0, matchIndex - 60);
  const ctxEnd = Math.min(line.length, matchIndex + matchLength + 60);
  return line.slice(ctxStart, ctxEnd);
}

// ─────────────────────────────────────────────────────────
// Main parser
// ─────────────────────────────────────────────────────────

/**
 * Parse a TypeScript/JavaScript file for import/dependency information.
 *
 * @param filePath — Relative path to the code file.
 * @param content  — Raw file content.
 * @param allPaths — Set of all known file paths (for resolving relative imports).
 *                   If not provided, imports are not resolved.
 */
export function parseCodeFile(
  filePath: string,
  content: string,
  allPaths?: Set<string>,
  vaultRoot?: string,
): ParsedCodeFile {
  const contentHash = createHash("sha256").update(content).digest("hex");
  const title = deriveTitle(filePath);
  const tags = deriveTagsFromPath(filePath);
  const imports: ImportEntry[] = [];

  const lines = content.split("\n");
  const sourceDir = filePath.includes("/")
    ? filePath.substring(0, filePath.lastIndexOf("/"))
    : "";

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];

    // Static imports: import ... from '...'
    let match: RegExpExecArray | null;
    const staticRe = new RegExp(STATIC_IMPORT_RE.source, STATIC_IMPORT_RE.flags);
    while ((match = staticRe.exec(lineText)) !== null) {
      const specifier = match[1];
      const resolvedPath = allPaths ? resolveImportSpecifier(specifier, sourceDir, allPaths, vaultRoot) : null;
      imports.push({
        specifier,
        resolvedPath,
        lineNumber: i + 1,
        context: extractContext(lineText, match.index, match[0].length),
        kind: "static",
        isExternal: !specifier.startsWith('.') && resolvedPath === null,
      });
    }

    // Dynamic imports: import('...')
    const dynamicRe = new RegExp(DYNAMIC_IMPORT_RE.source, DYNAMIC_IMPORT_RE.flags);
    while ((match = dynamicRe.exec(lineText)) !== null) {
      const specifier = match[1];
      const resolvedPath = allPaths ? resolveImportSpecifier(specifier, sourceDir, allPaths, vaultRoot) : null;
      imports.push({
        specifier,
        resolvedPath,
        lineNumber: i + 1,
        context: extractContext(lineText, match.index, match[0].length),
        kind: "dynamic",
        isExternal: !specifier.startsWith('.') && resolvedPath === null,
      });
    }

    // require() calls
    const requireRe = new RegExp(REQUIRE_RE.source, REQUIRE_RE.flags);
    while ((match = requireRe.exec(lineText)) !== null) {
      const specifier = match[1];
      const resolvedPath = allPaths ? resolveImportSpecifier(specifier, sourceDir, allPaths, vaultRoot) : null;
      imports.push({
        specifier,
        resolvedPath,
        lineNumber: i + 1,
        context: extractContext(lineText, match.index, match[0].length),
        kind: "require",
        isExternal: !specifier.startsWith('.') && resolvedPath === null,
      });
    }

    // export-from: export { ... } from '...' or export * from '...'
    const exportRe = new RegExp(EXPORT_FROM_RE.source, EXPORT_FROM_RE.flags);
    while ((match = exportRe.exec(lineText)) !== null) {
      const specifier = match[1];
      const resolvedPath = allPaths ? resolveImportSpecifier(specifier, sourceDir, allPaths, vaultRoot) : null;
      imports.push({
        specifier,
        resolvedPath,
        lineNumber: i + 1,
        context: extractContext(lineText, match.index, match[0].length),
        kind: "export-from",
        isExternal: !specifier.startsWith('.') && resolvedPath === null,
      });
    }
  }

  return {
    path: filePath,
    title,
    tags,
    imports,
    contentHash,
  };
}

// ─────────────────────────────────────────────────────────
// Helpers (shared)
// ─────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return normalize(p).replace(/\\/g, "/");
}
