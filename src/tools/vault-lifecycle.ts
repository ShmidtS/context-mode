// ─────────────────────────────────────────────────────────
// Vault store lifecycle: getSharedVaultStore, acquire, reset
// ─────────────────────────────────────────────────────────

import { loadDatabase } from "../db-base.js";

import { getStorePath, getProjectDir } from "./paths.js";

// Shared vault graph store (same DB as ContentStore, separate connection)
let _vaultStoreCache: { store: import("../vault/graph-store.js").VaultGraphStore; search: import("../vault/search.js").VaultGraphSearch } | null = null;
let _projectVaultIndexed = false;
let _projectVaultEmpty = false;
const DEBUG_VAULT = process.env.DEBUG?.includes("context-mode");

export function isProjectVaultEmpty(): boolean { return _projectVaultEmpty; }

// Lazy import — used by getSharedVaultStore and ctx_vault_index handler
let _createVaultAdapter: typeof import("../vault/adapter.js").createVaultAdapter | null = null;
async function getVaultAdapter() {
  if (!_createVaultAdapter) {
    const mod = await import("../vault/adapter.js");
    _createVaultAdapter = mod.createVaultAdapter;
  }
  return _createVaultAdapter;
}

/**
 * Open (or reuse) the shared vault graph store. Auto-indexes the current
 * project directory as a vault on first access if no vault_nodes exist.
 */
export async function getSharedVaultStore(): Promise<{
  store: import("../vault/graph-store.js").VaultGraphStore;
  search: import("../vault/search.js").VaultGraphSearch;
}> {
  if (_vaultStoreCache) return _vaultStoreCache;

  const Database = loadDatabase();
  const db = new Database(getStorePath());
  db.pragma("journal_mode = WAL");
  const { VaultGraphStore } = await import("../vault/graph-store.js");
  const { VaultGraphSearch } = await import("../vault/search.js");
  const store = new VaultGraphStore(db);
  const search = new VaultGraphSearch(store);
  _vaultStoreCache = { store, search };

  // Auto-index current project as vault on first access (once per session)
  if (!_projectVaultIndexed && process.env.CTX_AUTO_INDEX_PROJECT !== "0") {
    _projectVaultIndexed = true;
    try {
      const projectDir = getProjectDir();
      const cnt = store.countNodesByVaultPath(projectDir);
      if (cnt === 0) {
        const { indexVault } = await import("../vault/indexer.js");
        const { addVaultConfig } = await import("../vault/config.js");
        const createVaultAdapter = await getVaultAdapter();
        const adapter = createVaultAdapter(store, projectDir);
        const result = indexVault(projectDir, adapter);
        // Recalc degrees only for nodes belonging to this project
        const nodeIds = store.getNodeIdsByVaultPath(projectDir);
        for (const { id } of nodeIds) {
          store.recalcDegrees(id);
        }
        addVaultConfig({
          vaultPath: projectDir,
          lastIndexedAt: new Date().toISOString(),
          noteCount: result.indexed + result.updated,
          edgeCount: store.getEdgeCount(),
        });
        if (nodeIds.length === 0) {
          _projectVaultEmpty = true;
        }
        if (DEBUG_VAULT)
          process.stderr.write(
            `[ctx] Auto-indexed project vault: ${projectDir} (${result.indexed + result.updated} nodes, ${result.brokenLinks} broken links)\n`,
          );
      }
    } catch (e) {
      if (DEBUG_VAULT)
        process.stderr.write(`[ctx] auto-index project vault: ${e}\n`);
    }
  }

  return _vaultStoreCache;
}

/** Acquire the shared vault graph store pair, returning nulls on failure. */
export async function acquireVaultStores(): Promise<{
  vaultStore: import("../vault/graph-store.js").VaultGraphStore | null;
  vaultSearch: import("../vault/search.js").VaultGraphSearch | null;
}> {
  try {
    const { store, search } = await getSharedVaultStore();
    return { vaultStore: store, vaultSearch: search };
  } catch {
    return { vaultStore: null, vaultSearch: null };
  }
}

export function resetVaultStore(): void {
  _vaultStoreCache = null;
  _projectVaultIndexed = false;
  _projectVaultEmpty = false;
}
