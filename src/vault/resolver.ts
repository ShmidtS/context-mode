/**
 * resolver — Resolve wiki-link targets to actual file paths.
 *
 * Implements Obsidian's link resolution strategy:
 *   1. Exact match: targetName.md in vaultRoot (case-insensitive on Windows)
 *   2. Path suffix match: any file ending with /targetName.md
 *   3. If ambiguous: prefer shortest path, then alphabetically first
 *   4. No match → null (broken link)
 */

import { normalize, sep } from "node:path";

// ─────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────

/**
 * Resolve a wiki-link target name to an actual vault file path.
 *
 * @param targetName  — The bare name from `[[Target]]` (no .md extension).
 * @param sourceDir   — Directory of the source note (unused in v1 but kept for API stability).
 * @param vaultRoot   — Absolute path to the vault root.
 * @param allPaths    — Set of all normalised .md file paths in the vault (relative to vaultRoot).
 * @returns Normalised relative path (forward-slash) or null if broken.
 */
export function resolveLink(
  targetName: string,
  sourceDir: string,
  vaultRoot: string,
  allPaths: Set<string>,
): string | null {
  const isWin = sep === "\\";

  // Normalise target: strip any leading/trailing slashes
  const target = targetName.replace(/^\/+|\/+$/g, "");

  // 1. Exact match: target.md at vault root or as a direct path
  const exactRelative = `${target}.md`;
  const exactRelativeNorm = normalizePath(exactRelative);

  for (const p of allPaths) {
    if (pathEquals(p, exactRelativeNorm, isWin)) {
      return p;
    }
  }

  // Also try the target as a full relative path (e.g. "folder/Sub Note")
  const targetAsPath = target.replace(/\\/g, "/") + ".md";
  for (const p of allPaths) {
    if (pathEquals(p, targetAsPath, isWin)) {
      return p;
    }
  }

  // 2. Suffix match: any file ending with /target.md
  const suffix = `/${target}.md`;
  const suffixNorm = normalizePath(suffix);
  const candidates: string[] = [];

  for (const p of allPaths) {
    const normalised = isWin ? p.toLowerCase() : p;
    const suffixNormCi = isWin ? suffixNorm.toLowerCase() : suffixNorm;
    if (normalised.endsWith(suffixNormCi)) {
      candidates.push(p);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // 3. Disambiguate: shortest path first, then alphabetical
  candidates.sort((a, b) => {
    const depthA = a.split("/").length;
    const depthB = b.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });

  return candidates[0];
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/** Normalise path separators to forward-slash. */
function normalizePath(p: string): string {
  return normalize(p).replace(/\\/g, "/");
}

/** Compare paths with case-insensitivity on Windows. */
function pathEquals(a: string, b: string, isWin: boolean): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return isWin ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}
