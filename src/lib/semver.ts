/**
 * Semver comparison utility — shared between server.ts and analytics.ts.
 */

/**
 * Returns true if semver string `a` is strictly newer than `b`.
 * Compares up to 3 segments (major.minor.patch), missing segments default to 0.
 */
export function semverNewer(a: string, b: string): boolean {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}
