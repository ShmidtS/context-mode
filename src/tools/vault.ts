// ─────────────────────────────────────────────────────────
// Tool handlers: ctx_vault_index + ctx_vault_graph
// ─────────────────────────────────────────────────────────

import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import {
  trackResponse,
  getSharedVaultStore,
  isProjectVaultEmpty,
  type ToolResult,
} from "./shared.js";
import { loadDatabase } from "../db-base.js";

export function registerVaultTools(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
): void {

  // ── ctx_vault_index ──────────────────────────────────────

  server.registerTool(
    "ctx_vault_index",
    {
      title: "Index Obsidian Vault",
      description:
        "Index an Obsidian vault into a searchable graph store. Scans markdown notes, " +
        "extracts wikilinks, tags, and frontmatter, and builds a navigable knowledge graph. " +
        "After indexing, use ctx_vault_graph to traverse the graph (neighbors, backlinks, tag clusters).",
      inputSchema: z.object({
        vaultPath: z.string().describe("Absolute path to the Obsidian vault root directory"),
        options: z.object({
          reindex: z.boolean().optional().describe("Force full reindex even if no changes detected"),
        }).optional(),
      }),
    },
    async (args) => {
      const { vaultPath } = args;

      let stats;
      try {
        stats = statSync(vaultPath);
      } catch {
        stats = null;
      }
      if (!stats || !stats.isDirectory()) {
        return trackResponse("ctx_vault_index", {
          content: [{
            type: "text" as const,
            text: `Vault path does not exist or is not a directory: ${vaultPath}`,
          }],
          isError: true,
        });
      }

      const resolvedVaultPath = resolve(vaultPath);
      if (!isAbsolute(resolvedVaultPath) || resolvedVaultPath.includes("..") || resolvedVaultPath.includes("..\\")) {
        return trackResponse("ctx_vault_index", {
          content: [{
            type: "text" as const,
            text: `Invalid vault path: ${vaultPath}`,
          }],
          isError: true,
        });
      }

      try {
        const { indexVault } = await import("../vault/indexer.js");
        const { addVaultConfig } = await import("../vault/config.js");
        const { createVaultAdapter } = await import("../vault/adapter.js");

        const Database = loadDatabase();
        const { getSessionDir } = await import("./shared.js");
        const { join, dirname } = await import("node:path");
        const { mkdirSync } = await import("node:fs");

        // Create a dedicated DB connection for this vault index operation
        const { getStorePath } = await import("./shared.js");
        const dbPath = getStorePath();
        const db = new Database(dbPath);
        db.pragma("journal_mode = WAL");

        try {
          const { VaultGraphStore } = await import("../vault/graph-store.js");
          const store = new VaultGraphStore(db);
          const adapter = createVaultAdapter(store, resolvedVaultPath);
          const result = indexVault(resolvedVaultPath, adapter);

          // Recalculate degrees for all indexed nodes
          const nodeIds = store.db
            .prepare("SELECT id FROM vault_nodes WHERE vault_path = ?")
            .all(resolvedVaultPath) as { id: number }[];
          for (const { id } of nodeIds) {
            store.recalcDegrees(id);
          }

          const edgeCount = store.getEdgeCount();

          addVaultConfig({
            vaultPath: resolvedVaultPath,
            lastIndexedAt: new Date().toISOString(),
            noteCount: result.indexed + result.updated,
            edgeCount,
          });

          return trackResponse("ctx_vault_index", {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          });
        } finally {
          db.close();
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return trackResponse("ctx_vault_index", {
          content: [{ type: "text" as const, text: `Vault index error: ${message}` }],
          isError: true,
        });
      }
    },
  );

  // ── ctx_vault_graph ──────────────────────────────────────

  server.registerTool(
    "ctx_vault_graph",
    {
      title: "Query Vault Graph",
      description:
        "Traverse the indexed Obsidian vault graph. Requires prior indexing via ctx_vault_index.\n\n" +
        "Modes:\n" +
        "  - neighbors: find notes within N hops of a given note\n" +
        "  - backlinks: find all notes that link to a given note\n" +
        "  - tag-cluster: find all notes sharing a given tag",
      inputSchema: z.object({
        mode: z.enum(["neighbors", "backlinks", "tag-cluster"]).describe("Graph traversal mode"),
        nodePath: z.string().optional().describe("Note path (relative to vault root). Required for neighbors/backlinks."),
        tag: z.string().optional().describe("Tag to search. Required for tag-cluster."),
        vaultPath: z.string().optional().describe("Vault path (required when multiple vaults are indexed)"),
        maxHops: z.number().min(1).max(5).optional().default(1).describe("Max hops for neighbor traversal"),
        limit: z.number().min(1).max(100).optional().default(20).describe("Max results"),
        edgeType: z.string().optional().describe("Filter edges by type: wikilink, embed, markdown, calls, inherits, implements, type-ref, decorates"),
      }),
    },
    async (args) => {
      try {
        const { store, search } = await getSharedVaultStore();

        if (isProjectVaultEmpty()) {
          return trackResponse("ctx_vault_graph", {
            content: [{ type: "text" as const, text: "Vault graph is empty: this project contains no markdown notes with wiki-links, tags, or backlinks. Further ctx_vault_graph calls will not yield results." }],
            isError: true,
          });
        }

        const resolveNode = (nodePath: string) =>
          args.vaultPath
            ? store.getNodeByPath(args.vaultPath, nodePath)
            : store.getNodeByNotePath(nodePath);

        let results: import("../types.js").GraphSearchResult[] = [];

        if (args.mode === "neighbors" && args.nodePath) {
          const node = resolveNode(args.nodePath);
          if (!node) {
            return trackResponse("ctx_vault_graph", {
              content: [{ type: "text" as const, text: `Node not found: ${args.nodePath}` }],
              isError: true,
            });
          }
          results = search.neighbors(node.id, args.maxHops, args.edgeType).slice(0, args.limit);
        } else if (args.mode === "backlinks" && args.nodePath) {
          const node = resolveNode(args.nodePath);
          if (!node) {
            return trackResponse("ctx_vault_graph", {
              content: [{ type: "text" as const, text: `Node not found: ${args.nodePath}` }],
              isError: true,
            });
          }
          results = search.backlinks(node.id, args.edgeType).slice(0, args.limit);
        } else if (args.mode === "tag-cluster" && args.tag) {
          results = search.tagCluster(args.tag).slice(0, args.limit);
        } else {
          return trackResponse("ctx_vault_graph", {
            content: [{ type: "text" as const, text: "Invalid mode or missing required parameter" }],
            isError: true,
          });
        }

        return trackResponse("ctx_vault_graph", {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return trackResponse("ctx_vault_graph", {
          content: [{ type: "text" as const, text: `Vault graph error: ${message}` }],
          isError: true,
        });
      }
    },
  );
}
