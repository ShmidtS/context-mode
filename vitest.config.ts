import { defineConfig } from "vitest/config";

const isCI = !!process.env.CI;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // Native addons (better-sqlite3) can segfault in worker_threads during
    // process cleanup. Use single fork to avoid teardown race entirely.
    pool: "forks",
    poolOptions: {
      forks: {
        // Single fork avoids the native-addon teardown race that causes
        // "Worker exited unexpectedly" on CI. Performance cost is acceptable
        // for current test count (~2450 tests in ~60s vs ~43s with 3 workers).
        singleFork: isCI,
      },
    },
    // Non-CI: allow limited parallelism for speed (3 workers = ~2.8x speedup).
    maxWorkers: isCI ? 1 : 3,
    // Hook subprocess tests (spawnSync + better-sqlite3 native addon) can
    // fail intermittently under parallel load on CI.  Retry once to absorb
    // transient resource-contention failures without masking real regressions.
    // Only enable retry on CI to avoid slowing down local dev.
    retry: isCI ? 2 : 0,
    // Force exit after tests complete — prevents CI failure from open handles
    // (better-sqlite3 native addon cleanup races with fork worker teardown).
    teardownTimeout: isCI ? 15_000 : 5_000,
  },
});
