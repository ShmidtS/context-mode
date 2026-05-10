// ─────────────────────────────────────────────────────────
// Shared state, types, and helpers for tool handlers
// Re-exports from decomposed modules for backward compatibility
// ─────────────────────────────────────────────────────────

export {
  // Tool result type
  type ToolResult,
  toolErrorResponse,

  // Package metadata
  __pkg_dir,
  VERSION,

  // Shared mutable state
  _detectedAdapter,
  setDetectedAdapter,
  _insightChild,
  setInsightChild,

  // Platform-aware paths
  getSessionDir,
  getProjectDir,
  resolveProjectPath,
  hashProjectDir,
  getSessionDbPath,
  getStorePath,

  // Content store singleton
  getStore,
  resetStore,
  closeStore,

  // Intent search thresholds
  INTENT_SEARCH_THRESHOLD,
  LARGE_OUTPUT_THRESHOLD,

  // Re-exports from session/db.js
  getWorktreeSuffix,
} from "./paths.js";

export {
  // Session stats
  sessionStats,

  // Version
  _latestVersion,

  // Response tracking
  trackResponse,
  trackIndexed,

  // Stats persistence
  getStatsFilePath,
  persistStats,

  // Version check
  startVersionCheck,

  // Stats restore
  restoreStatsOnStartup,

  // FS preload
  CM_FS_PRELOAD,
  writeFsPreload,

  // Re-exports from session/analytics.js
  getLifetimeStats,
} from "./stats.js";

export {
  // Snippet extraction
  extractSnippet,
  positionsFromHighlight,
} from "./snippet.js";

export {
  // Security checks
  checkDenyPolicy,
  checkNonShellDenyPolicy,
  checkFilePathDenyPolicy,

  // SSRF classification
  classifyIp,
} from "./security-helpers.js";

export {
  // Batch execution
  type BatchCommand,
  type BatchRunResult,
  type BatchRunOptions,
  buildBatchNodeOptionsPrefix,
  runBatchCommands,

  // Batch query formatting
  formatBatchQueryResults,

  // Coercion helpers
  coerceJsonArray,
  coerceCommandsArray,
} from "./batch-helpers.js";

export {
  // Vault store lifecycle
  getSharedVaultStore,
  acquireVaultStores,
  resetVaultStore,
  isProjectVaultEmpty,
} from "./vault-lifecycle.js";
