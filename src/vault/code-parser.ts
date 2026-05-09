/**
 * code-parser — Parse TypeScript/JavaScript files for import/dependency graph.
 *
 * Extracts import statements, require() calls, dynamic imports, and
 * export-from patterns using regex-based parsing. Resolves relative
 * imports to file paths.
 */

import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { normalizePath } from "./path-utils.js";

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

// ── Language-specific import regexes ──

// Python: from x import y, import x, import x as y
const PYTHON_IMPORT_RE = /\b(?:from\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s+import|import\s+([a-zA-Z_][a-zA-Z0-9_.]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_.]*)*))/g;

// Go: import "x", import alias "x", import ( ... "x" ... )
const GO_IMPORT_RE = /import\s+(?:\(\s*(?:[_a-zA-Z][a-zA-Z0-9_]*\s+)?"([^"]+)"[^)]*\)|(?:[_a-zA-Z][a-zA-Z0-9_]*\s+)?"([^"]+)")/g;

// Rust: use x::y;, extern crate x;, mod x;
const RUST_USE_RE = /\buse\s+([a-zA-Z_][a-zA-Z0-9_:]*)\s*;/g;
const RUST_EXTERN_RE = /\bextern\s+crate\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/g;
const RUST_MOD_RE = /\bmod\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/g;

// Java / C# / Kotlin / Scala
const JAVA_IMPORT_RE = /\bimport\s+([a-zA-Z_][a-zA-Z0-9_.*]*)\s*;/g;

// C / C++: #include "x" or #include <x>
const C_INCLUDE_RE = /#include\s+[<"]([^>"]+)[>"]/g;

// PHP
const PHP_INCLUDE_RE = /\b(?:include|require|include_once|require_once)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g;
const PHP_USE_RE = /\buse\s+([a-zA-Z_][a-zA-Z0-9_\\]*)\s*;/g;

// Ruby
const RUBY_REQUIRE_RE = /\b(?:require|require_relative|load)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g;

// Lua
const LUA_REQUIRE_RE = /\b(?:require|dofile|loadfile)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Shell: source x, . x
const SHELL_SOURCE_RE = /(?:^|\n)\s*(?:source|\.\s)\s+([^;\s&|><]+)/g;

// HTML: src="x", href="x"
const HTML_SRC_RE = /<(?:script|img|video|audio|source|iframe)\s+[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*>/g;
const HTML_HREF_RE = /<(?:link|a|area)\s+[^>]*\b(?:href|xlink:href)\s*=\s*['"]([^'"]+)['"][^>]*>/g;

// CSS/SCSS/SASS/LESS
const CSS_IMPORT_RE = /@import\s+(?:url\s*\(\s*)?['"]([^'"]+)['"]\s*\)?/g;
const CSS_USE_RE = /@(?:use|forward)\s+['"]([^'"]+)['"]/g;

// ─────────────────────────────────────────────────────────
// Handler table
// ─────────────────────────────────────────────────────────

type IsExternalMode = "auto" | true | false;

interface ImportHandler {
  /** Source regex pattern — cloned per invocation to avoid shared lastIndex. */
  readonly re: RegExp;
  /** File extensions this handler applies to. */
  readonly extensions: readonly string[];
  /** If true, specifier comes from match[1] ?? match[2]; otherwise match[1]. */
  readonly multiCapture: boolean;
  /** Import kind for produced entries. */
  readonly kind: ImportEntry["kind"];
  /** If true, resolve specifier via resolveImportSpecifier; otherwise force null. */
  readonly resolvePath: boolean;
  /** How to determine isExternal: "auto" = computed, true/false = fixed. */
  readonly isExternal: IsExternalMode;
}

const IMPORT_HANDLERS: readonly ImportHandler[] = [
  // JS/TS
  { re: STATIC_IMPORT_RE, extensions: [".ts", ".js", ".mjs", ".cjs"], multiCapture: false, kind: "static", resolvePath: true, isExternal: "auto" },
  { re: DYNAMIC_IMPORT_RE, extensions: [".ts", ".js", ".mjs", ".cjs"], multiCapture: false, kind: "dynamic", resolvePath: true, isExternal: "auto" },
  { re: REQUIRE_RE, extensions: [".ts", ".js", ".mjs", ".cjs"], multiCapture: false, kind: "require", resolvePath: true, isExternal: "auto" },
  { re: EXPORT_FROM_RE, extensions: [".ts", ".js", ".mjs", ".cjs"], multiCapture: false, kind: "export-from", resolvePath: true, isExternal: "auto" },
  // Python
  { re: PYTHON_IMPORT_RE, extensions: [".py", ".pyi", ".pyw"], multiCapture: true, kind: "static", resolvePath: true, isExternal: "auto" },
  // Go
  { re: GO_IMPORT_RE, extensions: [".go"], multiCapture: true, kind: "static", resolvePath: true, isExternal: true },
  // Rust
  { re: RUST_USE_RE, extensions: [".rs"], multiCapture: false, kind: "static", resolvePath: false, isExternal: true },
  { re: RUST_EXTERN_RE, extensions: [".rs"], multiCapture: false, kind: "static", resolvePath: false, isExternal: true },
  { re: RUST_MOD_RE, extensions: [".rs"], multiCapture: false, kind: "static", resolvePath: true, isExternal: false },
  // Java / C# / Kotlin / Scala
  { re: JAVA_IMPORT_RE, extensions: [".java", ".kt", ".kts", ".scala", ".sc", ".cs"], multiCapture: false, kind: "static", resolvePath: false, isExternal: true },
  // C / C++
  { re: C_INCLUDE_RE, extensions: [".c", ".h", ".cpp", ".cxx", ".cc", ".hpp", ".hxx"], multiCapture: false, kind: "static", resolvePath: true, isExternal: "auto" },
  // PHP
  { re: PHP_INCLUDE_RE, extensions: [".php", ".phtml", ".php3", ".php4", ".php5", ".phps"], multiCapture: false, kind: "require", resolvePath: true, isExternal: "auto" },
  { re: PHP_USE_RE, extensions: [".php", ".phtml", ".php3", ".php4", ".php5", ".phps"], multiCapture: false, kind: "static", resolvePath: false, isExternal: true },
  // Ruby
  { re: RUBY_REQUIRE_RE, extensions: [".rb", ".rbx", ".ru"], multiCapture: false, kind: "require", resolvePath: true, isExternal: "auto" },
  // Lua
  { re: LUA_REQUIRE_RE, extensions: [".lua"], multiCapture: false, kind: "require", resolvePath: true, isExternal: "auto" },
  // Shell
  { re: SHELL_SOURCE_RE, extensions: [".sh", ".bash", ".zsh", ".fish", ".ksh", ".csh", ".tcsh"], multiCapture: false, kind: "require", resolvePath: true, isExternal: "auto" },
  // HTML
  { re: HTML_SRC_RE, extensions: [".html", ".htm", ".xhtml"], multiCapture: false, kind: "static", resolvePath: true, isExternal: false },
  { re: HTML_HREF_RE, extensions: [".html", ".htm", ".xhtml"], multiCapture: false, kind: "static", resolvePath: true, isExternal: false },
  // CSS / SCSS / SASS / LESS
  { re: CSS_IMPORT_RE, extensions: [".css", ".scss", ".sass", ".less", ".styl", ".stylus"], multiCapture: false, kind: "static", resolvePath: true, isExternal: "auto" },
  { re: CSS_USE_RE, extensions: [".css", ".scss", ".sass", ".less", ".styl", ".stylus"], multiCapture: false, kind: "static", resolvePath: true, isExternal: "auto" },
];

/** Extensions with no handler but still recognized as supported (placeholder for future support). */
const PLACEHOLDER_EXTS: readonly string[] = [".swift", ".ps1", ".psm1", ".psd1"];

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

/**
 * Collect all file extensions covered by any handler or placeholder.
 * Used for the early-return check when the file extension is unsupported.
 */
const ALL_SUPPORTED_EXTS: ReadonlySet<string> = new Set([
  ...IMPORT_HANDLERS.flatMap((h) => h.extensions),
  ...PLACEHOLDER_EXTS,
]);

function computeIsExternal(mode: IsExternalMode, specifier: string, resolvedPath: string | null): boolean {
  if (mode === "auto") return !specifier.startsWith(".") && resolvedPath === null;
  return mode;
}

/**
 * Extract import/dependency entries from a source file based on its language.
 * Dispatches to language-specific regexes via a table-driven approach.
 */
function extractImports(
  ext: string,
  lines: string[],
  sourceDir: string,
  allPaths: Set<string> | undefined,
  vaultRoot: string | undefined,
): ImportEntry[] {
  if (!ALL_SUPPORTED_EXTS.has(ext)) return [];

  // Filter handlers applicable to this file extension, cloning their regexes
  // to avoid shared lastIndex across invocations.
  const active = IMPORT_HANDLERS
    .filter((h) => h.extensions.includes(ext))
    .map((h) => ({
      ...h,
      re: new RegExp(h.re.source, h.re.flags),
    }));

  const imports: ImportEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];

    for (const handler of active) {
      handler.re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = handler.re.exec(lineText)) !== null) {
        const specifier = handler.multiCapture
          ? (match[1] ?? match[2])
          : match[1];
        const resolvedPath = handler.resolvePath && allPaths
          ? resolveImportSpecifier(specifier, sourceDir, allPaths, vaultRoot)
          : null;

        imports.push({
          specifier,
          resolvedPath,
          lineNumber: i + 1,
          context: extractContext(lineText, match.index, match[0].length),
          kind: handler.kind,
          isExternal: computeIsExternal(handler.isExternal, specifier, resolvedPath),
        });
      }
    }
  }

  return imports;
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

  const ext = filePath.substring(filePath.lastIndexOf("."));
  imports.push(...extractImports(ext, lines, sourceDir, allPaths, vaultRoot));

  return {
    path: filePath,
    title,
    tags,
    imports,
    contentHash,
  };
}

