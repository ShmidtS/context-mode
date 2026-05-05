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
 * Extract import/dependency entries from a source file based on its language.
 * Dispatches to language-specific regexes.
 */
function extractImports(
  ext: string,
  lines: string[],
  sourceDir: string,
  allPaths: Set<string> | undefined,
  vaultRoot: string | undefined,
): ImportEntry[] {
  const imports: ImportEntry[] = [];

  const isJsLike = [".ts", ".js", ".mjs", ".cjs"].includes(ext);
  const isPy = [".py", ".pyi", ".pyw"].includes(ext);
  const isGo = ext === ".go";
  const isRust = ext === ".rs";
  const isJavaLike = [".java", ".kt", ".kts", ".scala", ".sc"].includes(ext);
  const isCs = ext === ".cs";
  const isSwift = ext === ".swift";
  const isC = [".c", ".h", ".cpp", ".cxx", ".cc", ".hpp", ".hxx"].includes(ext);
  const isRuby = [".rb", ".rbx", ".ru"].includes(ext);
  const isPhp = [".php", ".phtml", ".php3", ".php4", ".php5", ".phps"].includes(ext);
  const isLua = ext === ".lua";
  const isShell = [".sh", ".bash", ".zsh", ".fish", ".ksh", ".csh", ".tcsh"].includes(ext);
  const isPs = [".ps1", ".psm1", ".psd1"].includes(ext);
  const isHtml = [".html", ".htm", ".xhtml"].includes(ext);
  const isCss = [".css", ".scss", ".sass", ".less", ".styl", ".stylus"].includes(ext);

  if (!isJsLike && !isPy && !isGo && !isRust && !isJavaLike && !isCs && !isSwift && !isC && !isRuby && !isPhp && !isLua && !isShell && !isPs && !isHtml && !isCss) {
    return imports;
  }

  const staticRe = isJsLike ? new RegExp(STATIC_IMPORT_RE.source, STATIC_IMPORT_RE.flags) : null;
  const dynamicRe = isJsLike ? new RegExp(DYNAMIC_IMPORT_RE.source, DYNAMIC_IMPORT_RE.flags) : null;
  const requireRe = isJsLike ? new RegExp(REQUIRE_RE.source, REQUIRE_RE.flags) : null;
  const exportRe = isJsLike ? new RegExp(EXPORT_FROM_RE.source, EXPORT_FROM_RE.flags) : null;
  const pyRe = isPy ? new RegExp(PYTHON_IMPORT_RE.source, PYTHON_IMPORT_RE.flags) : null;
  const goRe = isGo ? new RegExp(GO_IMPORT_RE.source, GO_IMPORT_RE.flags) : null;
  const rustUseRe = isRust ? new RegExp(RUST_USE_RE.source, RUST_USE_RE.flags) : null;
  const rustExternRe = isRust ? new RegExp(RUST_EXTERN_RE.source, RUST_EXTERN_RE.flags) : null;
  const rustModRe = isRust ? new RegExp(RUST_MOD_RE.source, RUST_MOD_RE.flags) : null;
  const javaRe = (isJavaLike || isCs) ? new RegExp(JAVA_IMPORT_RE.source, JAVA_IMPORT_RE.flags) : null;
  const cRe = isC ? new RegExp(C_INCLUDE_RE.source, C_INCLUDE_RE.flags) : null;
  const phpIncludeRe = isPhp ? new RegExp(PHP_INCLUDE_RE.source, PHP_INCLUDE_RE.flags) : null;
  const phpUseRe = isPhp ? new RegExp(PHP_USE_RE.source, PHP_USE_RE.flags) : null;
  const rubyRe = isRuby ? new RegExp(RUBY_REQUIRE_RE.source, RUBY_REQUIRE_RE.flags) : null;
  const luaRe = isLua ? new RegExp(LUA_REQUIRE_RE.source, LUA_REQUIRE_RE.flags) : null;
  const shellRe = isShell ? new RegExp(SHELL_SOURCE_RE.source, SHELL_SOURCE_RE.flags) : null;
  const htmlSrcRe = isHtml ? new RegExp(HTML_SRC_RE.source, HTML_SRC_RE.flags) : null;
  const htmlHrefRe = isHtml ? new RegExp(HTML_HREF_RE.source, HTML_HREF_RE.flags) : null;
  const cssImportRe = isCss ? new RegExp(CSS_IMPORT_RE.source, CSS_IMPORT_RE.flags) : null;
  const cssUseRe = isCss ? new RegExp(CSS_USE_RE.source, CSS_USE_RE.flags) : null;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    let match: RegExpExecArray | null;

    // Reset lastIndex before each line
    if (staticRe) staticRe.lastIndex = 0;
    if (dynamicRe) dynamicRe.lastIndex = 0;
    if (requireRe) requireRe.lastIndex = 0;
    if (exportRe) exportRe.lastIndex = 0;
    if (pyRe) pyRe.lastIndex = 0;
    if (goRe) goRe.lastIndex = 0;
    if (rustUseRe) rustUseRe.lastIndex = 0;
    if (rustExternRe) rustExternRe.lastIndex = 0;
    if (rustModRe) rustModRe.lastIndex = 0;
    if (javaRe) javaRe.lastIndex = 0;
    if (cRe) cRe.lastIndex = 0;
    if (phpIncludeRe) phpIncludeRe.lastIndex = 0;
    if (phpUseRe) phpUseRe.lastIndex = 0;
    if (rubyRe) rubyRe.lastIndex = 0;
    if (luaRe) luaRe.lastIndex = 0;
    if (shellRe) shellRe.lastIndex = 0;
    if (htmlSrcRe) htmlSrcRe.lastIndex = 0;
    if (htmlHrefRe) htmlHrefRe.lastIndex = 0;
    if (cssImportRe) cssImportRe.lastIndex = 0;
    if (cssUseRe) cssUseRe.lastIndex = 0;

    // JS/TS static imports
    while (staticRe && (match = staticRe.exec(lineText)) !== null) {
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

    // JS/TS dynamic imports
    while (dynamicRe && (match = dynamicRe.exec(lineText)) !== null) {
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

    // JS/TS require() calls
    while (requireRe && (match = requireRe.exec(lineText)) !== null) {
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

    // JS/TS export-from
    while (exportRe && (match = exportRe.exec(lineText)) !== null) {
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

    // Python imports (from x import y, import x)
    while (pyRe && (match = pyRe.exec(lineText)) !== null) {
      const specifier = match[1] ?? match[2];
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

    // Go imports
    while (goRe && (match = goRe.exec(lineText)) !== null) {
      const specifier = match[1] ?? match[2];
      const resolvedPath = allPaths ? resolveImportSpecifier(specifier, sourceDir, allPaths, vaultRoot) : null;
      imports.push({
        specifier,
        resolvedPath,
        lineNumber: i + 1,
        context: extractContext(lineText, match.index, match[0].length),
        kind: "static",
        isExternal: true,
      });
    }

    // Rust use statements
    while (rustUseRe && (match = rustUseRe.exec(lineText)) !== null) {
      const specifier = match[1];
      imports.push({
        specifier,
        resolvedPath: null,
        lineNumber: i + 1,
        context: extractContext(lineText, match.index, match[0].length),
        kind: "static",
        isExternal: true,
      });
    }

    // Rust extern crate
    while (rustExternRe && (match = rustExternRe.exec(lineText)) !== null) {
      const specifier = match[1];
      imports.push({
        specifier,
        resolvedPath: null,
        lineNumber: i + 1,
        context: extractContext(lineText, match.index, match[0].length),
        kind: "static",
        isExternal: true,
      });
    }

    // Rust mod statements
    while (rustModRe && (match = rustModRe.exec(lineText)) !== null) {
      const specifier = match[1];
      const resolvedPath = allPaths ? resolveImportSpecifier(specifier, sourceDir, allPaths, vaultRoot) : null;
      imports.push({
        specifier,
        resolvedPath,
        lineNumber: i + 1,
        context: extractContext(lineText, match.index, match[0].length),
        kind: "static",
        isExternal: false,
      });
    }

    // Java / C# / Kotlin / Scala imports
    while (javaRe && (match = javaRe.exec(lineText)) !== null) {
      const specifier = match[1];
      imports.push({
        specifier,
        resolvedPath: null,
        lineNumber: i + 1,
        context: extractContext(lineText, match.index, match[0].length),
        kind: "static",
        isExternal: true,
      });
    }

    // C / C++ includes
    while (cRe && (match = cRe.exec(lineText)) !== null) {
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

    // PHP include/require
    while (phpIncludeRe && (match = phpIncludeRe.exec(lineText)) !== null) {
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

    // PHP use statements
    while (phpUseRe && (match = phpUseRe.exec(lineText)) !== null) {
      const specifier = match[1];
      imports.push({
        specifier,
        resolvedPath: null,
        lineNumber: i + 1,
        context: extractContext(lineText, match.index, match[0].length),
        kind: "static",
        isExternal: true,
      });
    }

    // Ruby require/load
    while (rubyRe && (match = rubyRe.exec(lineText)) !== null) {
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

    // Lua require/dofile
    while (luaRe && (match = luaRe.exec(lineText)) !== null) {
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

    // Shell source
    while (shellRe && (match = shellRe.exec(lineText)) !== null) {
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

    // HTML src references
    while (htmlSrcRe && (match = htmlSrcRe.exec(lineText)) !== null) {
      const specifier = match[1];
      const resolvedPath = allPaths ? resolveImportSpecifier(specifier, sourceDir, allPaths, vaultRoot) : null;
      imports.push({
        specifier,
        resolvedPath,
        lineNumber: i + 1,
        context: extractContext(lineText, match.index, match[0].length),
        kind: "static",
        isExternal: false,
      });
    }

    // HTML href references
    while (htmlHrefRe && (match = htmlHrefRe.exec(lineText)) !== null) {
      const specifier = match[1];
      const resolvedPath = allPaths ? resolveImportSpecifier(specifier, sourceDir, allPaths, vaultRoot) : null;
      imports.push({
        specifier,
        resolvedPath,
        lineNumber: i + 1,
        context: extractContext(lineText, match.index, match[0].length),
        kind: "static",
        isExternal: false,
      });
    }

    // CSS @import / @use / @forward
    while (cssImportRe && (match = cssImportRe.exec(lineText)) !== null) {
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

    while (cssUseRe && (match = cssUseRe.exec(lineText)) !== null) {
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

