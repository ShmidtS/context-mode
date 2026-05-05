/**
 * path-utils — Shared path normalization for vault modules.
 */

import { normalize } from "node:path";

/** Normalise path separators to forward-slash. */
export function normalizePath(p: string): string {
  return normalize(p).replace(/\\/g, "/");
}
