/**
 * adapter — Creates a VaultGraphStore (indexer interface) adapter
 * over the SQLite-backed VaultGraphStore (graph-store.ts).
 *
 * Single source of truth for the adapter logic, eliminating
 * duplication between server.ts getSharedVaultStore and ctx_vault_index handler.
 */

import type { VaultGraphStore as GraphStore } from "./graph-store.js";
import type { VaultGraphStore as IndexerStore } from "./indexer.js";

/**
 * Wrap a graph-store.ts VaultGraphStore into the indexer's VaultGraphStore interface.
 *
 * @param store   — The SQLite-backed graph store.
 * @param vaultPath — Absolute vault path used as vault_path in DB rows.
 */
export function createVaultAdapter(
  store: GraphStore,
  vaultPath: string,
): IndexerStore {
  return {
    getNode: (path: string) => {
      const n = store.getNodeByPath(vaultPath, path);
      return n
        ? {
            path: n.note_path,
            title: n.title,
            frontmatter: n.frontmatter ? JSON.parse(n.frontmatter) : {},
            tags: store.getTagsByNode(n.id).map((t: { tag: string }) => t.tag),
            contentHash: n.content_hash,
            mtimeMs: n.file_mtime,
            inDegree: n.in_degree,
          }
        : undefined;
    },
    upsertNode: (node) => {
      const fm =
        node.frontmatter && Object.keys(node.frontmatter).length > 0
          ? JSON.stringify(node.frontmatter)
          : null;
      const id = store.upsertNode(
        vaultPath,
        node.path,
        node.title,
        fm,
        node.contentHash,
        node.mtimeMs,
        null,
      );
      store.deleteTagsByNode(id);
      for (const tag of node.tags ?? []) {
        store.insertTag(tag, id);
      }
    },
    upsertEdge: (edge) => {
      const sourceNode = store.getNodeByPath(vaultPath, edge.sourcePath);
      const targetNode = edge.targetPath ? store.getNodeByPath(vaultPath, edge.targetPath) : null;
      if (!sourceNode) return;
      store.insertEdge(
        sourceNode.id,
        targetNode?.id ?? null,
        edge.targetName ?? edge.targetPath ?? edge.sourcePath,
        edge.alias ?? null,
        edge.lineNumber,
        edge.context ?? null,
        edge.linkType,
        edge.confidence ?? "EXTRACTED",
      );
    },
    removeEdgesFrom: (sourcePath: string) => {
      const node = store.getNodeByPath(vaultPath, sourcePath);
      if (node) store.deleteEdgesBySource(node.id);
    },
  };
}
