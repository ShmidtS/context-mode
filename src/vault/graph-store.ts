/**
 * VaultGraphStore — SQLite-backed graph storage for Obsidian vault nodes and edges.
 *
 * Stores vault_nodes, vault_edges, vault_tags, and vault_frontmatter_keys
 * in the same SQLite DB as ContentStore. Receives the shared DatabaseInstance
 * in the constructor so graph tables coexist with FTS5 tables.
 *
 * Uses in_degree (not PageRank) as the authority signal in v1.
 */

import type { Database as DatabaseInstance } from "better-sqlite3";
import type { PreparedStatement } from "../db-base.js";
import type { VaultNode, VaultEdge, VaultTag, VaultFrontmatterKey } from "../types.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** Row shape from vault_nodes queries. */
type NodeRow = {
  id: number;
  vault_path: string;
  note_path: string;
  title: string;
  frontmatter: string | null;
  content_hash: string;
  file_mtime: number;
  out_degree: number;
  in_degree: number;
  source_id: number | null;
  indexed_at: string;
  source_type: string;
  connector_meta: string | null;
};

/** Row shape from vault_edges queries. */
type EdgeRow = {
  id: number;
  source_id: number;
  target_id: number | null;
  target_name: string;
  alias: string | null;
  line_number: number | null;
  context: string | null;
  edge_type: string;
};

/** Row shape from vault_tags queries. */
type TagRow = {
  id: number;
  tag: string;
  node_id: number;
};

/** Row shape from vault_frontmatter_keys queries. */
type FMKRow = {
  id: number;
  node_id: number;
  key: string;
  value: string;
};

// ─────────────────────────────────────────────────────────
// VaultGraphStore
// ─────────────────────────────────────────────────────────

export class VaultGraphStore {
  #db: DatabaseInstance;

  // ── Prepared Statements ──

  // Node writes
  #stmtUpsertNode!: PreparedStatement;
  #stmtDeleteEdgesBySource!: PreparedStatement;
  #stmtDeleteTagsByNode!: PreparedStatement;
  #stmtDeleteFMKByNode!: PreparedStatement;
  #stmtInsertEdge!: PreparedStatement;
  #stmtInsertTag!: PreparedStatement;
  #stmtInsertFMK!: PreparedStatement;

  // Node reads
  #stmtGetNodeById!: PreparedStatement;
  #stmtGetNodeByPath!: PreparedStatement;
  #stmtGetNodeByNotePath!: PreparedStatement;
  #stmtGetNodeByTitle!: PreparedStatement;
  #stmtGetEdgesBySource!: PreparedStatement;
  #stmtGetEdgesByTarget!: PreparedStatement;
  #stmtGetTagsByNode!: PreparedStatement;
  #stmtGetFMKByNode!: PreparedStatement;
  #stmtGetNodesByTag!: PreparedStatement;
  #stmtGetAllEdges!: PreparedStatement;

  // Degree updates
  #stmtUpdateOutDegree!: PreparedStatement;
  #stmtUpdateInDegree!: PreparedStatement;

  // Stats
  #stmtNodeCount!: PreparedStatement;
  #stmtEdgeCount!: PreparedStatement;

  constructor(db: DatabaseInstance) {
    this.#db = db;
    this.#initSchema();
    this.#prepareStatements();
  }

  // ── Schema ──

  #initSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS vault_nodes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_path  TEXT NOT NULL,
        note_path   TEXT NOT NULL,
        title       TEXT NOT NULL,
        frontmatter TEXT,
        content_hash TEXT NOT NULL,
        file_mtime  REAL NOT NULL,
        out_degree  INTEGER NOT NULL DEFAULT 0,
        in_degree   INTEGER NOT NULL DEFAULT 0,
        source_id   INTEGER,
        indexed_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(vault_path, note_path)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_nodes_path ON vault_nodes(vault_path, note_path);
      CREATE INDEX IF NOT EXISTS idx_vault_nodes_note_path ON vault_nodes(note_path);
      CREATE INDEX IF NOT EXISTS idx_vault_nodes_title ON vault_nodes(title);
      CREATE INDEX IF NOT EXISTS idx_vault_nodes_in_degree ON vault_nodes(in_degree DESC);

      CREATE TABLE IF NOT EXISTS vault_edges (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id   INTEGER NOT NULL,
        target_id   INTEGER,
        target_name TEXT NOT NULL,
        alias       TEXT,
        line_number INTEGER,
        context     TEXT,
        edge_type   TEXT NOT NULL DEFAULT 'wikilink',
        FOREIGN KEY (source_id) REFERENCES vault_nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_vault_edges_source ON vault_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_vault_edges_target ON vault_edges(target_id);

      CREATE TABLE IF NOT EXISTS vault_tags (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        tag     TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        FOREIGN KEY (node_id) REFERENCES vault_nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_vault_tags_tag ON vault_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_vault_tags_node ON vault_tags(node_id);

      CREATE TABLE IF NOT EXISTS vault_frontmatter_keys (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        UNIQUE (node_id, key),
        FOREIGN KEY (node_id) REFERENCES vault_nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_vault_fmk_key_value ON vault_frontmatter_keys(key, value);
    `);

    // Migrate: add source_type and connector_meta columns (safe for existing DBs)
    this.#addColumnIfMissing('vault_nodes', 'source_type', "TEXT NOT NULL DEFAULT 'vault'")
    this.#addColumnIfMissing('vault_nodes', 'connector_meta', 'TEXT')
  }

  /** Add a column to a table if it does not already exist. O(1) in SQLite. */
  #addColumnIfMissing(table: string, column: string, definition: string): void {
    try {
      this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    } catch {
      // Column already exists — safe to ignore
    }
  }

  #prepareStatements(): void {
    // Node writes
    this.#stmtUpsertNode = this.#db.prepare(`
      INSERT INTO vault_nodes (vault_path, note_path, title, frontmatter, content_hash, file_mtime, out_degree, in_degree, source_id, source_type, connector_meta)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
      ON CONFLICT(vault_path, note_path) DO UPDATE SET
        title = excluded.title,
        frontmatter = excluded.frontmatter,
        content_hash = excluded.content_hash,
        file_mtime = excluded.file_mtime,
        source_id = excluded.source_id,
        source_type = excluded.source_type,
        connector_meta = excluded.connector_meta,
        indexed_at = datetime('now')
      RETURNING id
    `);

    this.#stmtDeleteEdgesBySource = this.#db.prepare(
      "DELETE FROM vault_edges WHERE source_id = ?"
    );
    this.#stmtDeleteTagsByNode = this.#db.prepare(
      "DELETE FROM vault_tags WHERE node_id = ?"
    );
    this.#stmtDeleteFMKByNode = this.#db.prepare(
      "DELETE FROM vault_frontmatter_keys WHERE node_id = ?"
    );
    this.#stmtInsertEdge = this.#db.prepare(
      "INSERT INTO vault_edges (source_id, target_id, target_name, alias, line_number, context, edge_type) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    this.#stmtInsertTag = this.#db.prepare(
      "INSERT INTO vault_tags (tag, node_id) VALUES (?, ?)"
    );
    this.#stmtInsertFMK = this.#db.prepare(
      "INSERT OR REPLACE INTO vault_frontmatter_keys (node_id, key, value) VALUES (?, ?, ?)"
    );

    // Node reads
    this.#stmtGetNodeById = this.#db.prepare(
      "SELECT * FROM vault_nodes WHERE id = ?"
    );
    this.#stmtGetNodeByPath = this.#db.prepare(
      "SELECT * FROM vault_nodes WHERE vault_path = ? AND note_path = ?"
    );
    this.#stmtGetNodeByNotePath = this.#db.prepare(
      "SELECT * FROM vault_nodes WHERE note_path = ?"
    );
    this.#stmtGetNodeByTitle = this.#db.prepare(
      "SELECT * FROM vault_nodes WHERE title = ? COLLATE NOCASE"
    );
    this.#stmtGetEdgesBySource = this.#db.prepare(
      "SELECT * FROM vault_edges WHERE source_id = ?"
    );
    this.#stmtGetEdgesByTarget = this.#db.prepare(
      "SELECT * FROM vault_edges WHERE target_id = ?"
    );
    this.#stmtGetTagsByNode = this.#db.prepare(
      "SELECT * FROM vault_tags WHERE node_id = ?"
    );
    this.#stmtGetFMKByNode = this.#db.prepare(
      "SELECT * FROM vault_frontmatter_keys WHERE node_id = ?"
    );
    this.#stmtGetNodesByTag = this.#db.prepare(
      "SELECT n.* FROM vault_nodes n JOIN vault_tags t ON t.node_id = n.id WHERE t.tag = ?"
    );
    this.#stmtGetAllEdges = this.#db.prepare(
      "SELECT * FROM vault_edges"
    );

    // Degree updates
    this.#stmtUpdateOutDegree = this.#db.prepare(
      "UPDATE vault_nodes SET out_degree = (SELECT COUNT(*) FROM vault_edges WHERE source_id = ?) WHERE id = ?"
    );
    this.#stmtUpdateInDegree = this.#db.prepare(
      "UPDATE vault_nodes SET in_degree = (SELECT COUNT(*) FROM vault_edges WHERE target_id = ?) WHERE id = ?"
    );

    // Stats
    this.#stmtNodeCount = this.#db.prepare(
      "SELECT COUNT(*) as count FROM vault_nodes"
    );
    this.#stmtEdgeCount = this.#db.prepare(
      "SELECT COUNT(*) as count FROM vault_edges"
    );
  }

  // ── Node CRUD ──

  /** Upsert a node, returning its ID. */
  upsertNode(
    vaultPath: string,
    notePath: string,
    title: string,
    frontmatter: string | null,
    contentHash: string,
    fileMtime: number,
    sourceId: number | null,
    sourceType: string = 'vault',
    connectorMeta: string | null = null,
  ): number {
    const row = this.#stmtUpsertNode.get(
      vaultPath, notePath, title, frontmatter, contentHash, fileMtime, sourceId, sourceType, connectorMeta
    ) as { id: number } | undefined;
    return row?.id ?? 0;
  }

  /** Get a node by its ID. */
  getNodeById(id: number): VaultNode | null {
    const row = this.#stmtGetNodeById.get(id) as NodeRow | undefined;
    return row ? this.#mapNode(row) : null;
  }

  /** Get a node by its vault_path and note_path. */
  getNodeByPath(vaultPath: string, notePath: string): VaultNode | null {
    const row = this.#stmtGetNodeByPath.get(vaultPath, notePath) as NodeRow | undefined;
    return row ? this.#mapNode(row) : null;
  }

  /** Get a node by note_path only (no vault filter — returns first match). */
  getNodeByNotePath(notePath: string): VaultNode | null {
    const row = this.#stmtGetNodeByNotePath.get(notePath) as NodeRow | undefined;
    return row ? this.#mapNode(row) : null;
  }

  /** Get a node by title (case-insensitive). */
  getNodeByTitle(title: string): VaultNode | null {
    const row = this.#stmtGetNodeByTitle.get(title) as NodeRow | undefined;
    return row ? this.#mapNode(row) : null;
  }

  /** Search nodes by query tokens in note_path or title. */
  searchNodes(query: string): VaultNode[] {
    const tokens = query
      .split(/\s+/)
      .map((t) => t.replace(/[^a-zA-Z0-9_./-]/g, ""))
      .filter((t) => t.length >= 3);
    if (tokens.length === 0) return [];

    const conditions = tokens.map(() => "note_path LIKE ? OR title LIKE ?").join(" OR ");
    const params = tokens.flatMap((t) => [`%${t}%`, `%${t}%`]);
    const rows = this.#db.prepare(
      `SELECT * FROM vault_nodes WHERE ${conditions}`
    ).all(...params) as NodeRow[];
    return rows.map((r) => this.#mapNode(r));
  }

  /** Get all nodes for a specific vault path. */
  getNodesByVaultPath(vaultPath: string): VaultNode[] {
    const rows = this.#db.prepare(
      "SELECT * FROM vault_nodes WHERE vault_path = ?"
    ).all(vaultPath) as NodeRow[];
    return rows.map((r) => this.#mapNode(r));
  }

  /** Get all nodes that have a specific tag. */
  getNodesByTag(tag: string): VaultNode[] {
    const rows = this.#stmtGetNodesByTag.all(tag) as NodeRow[];
    return rows.map((r) => this.#mapNode(r));
  }

  /** Get all nodes matching a tag or its hierarchy children (e.g. "parent" matches "parent/child"). */
  getNodesByTagHierarchy(tag: string): VaultNode[] {
    const rows = this.#db.prepare(
      "SELECT n.* FROM vault_nodes n JOIN vault_tags t ON t.node_id = n.id WHERE t.tag = ? OR t.tag LIKE ?"
    ).all(tag, `${tag}/%`) as NodeRow[];
    return rows.map((r) => this.#mapNode(r));
  }

  /** Recalculate out_degree and in_degree for a given node. */
  recalcDegrees(nodeId: number): void {
    this.#stmtUpdateOutDegree.run(nodeId, nodeId);
    this.#stmtUpdateInDegree.run(nodeId, nodeId);
  }

  // ── Edge CRUD ──

  /** Insert a single edge. */
  insertEdge(
    sourceId: number,
    targetId: number | null,
    targetName: string,
    alias: string | null,
    lineNumber: number | null,
    context: string | null,
    edgeType: string = "wikilink",
  ): void {
    this.#stmtInsertEdge.run(sourceId, targetId, targetName, alias, lineNumber, context, edgeType);
  }

  /** Delete all edges originating from a node. */
  deleteEdgesBySource(sourceId: number): void {
    this.#stmtDeleteEdgesBySource.run(sourceId);
  }

  /** Get all edges originating from a node. */
  getEdgesBySource(sourceId: number): VaultEdge[] {
    const rows = this.#stmtGetEdgesBySource.all(sourceId) as EdgeRow[];
    return rows.map((r) => this.#mapEdge(r));
  }

  /** Get all edges pointing TO a node (backlinks). */
  getEdgesByTarget(targetId: number): VaultEdge[] {
    const rows = this.#stmtGetEdgesByTarget.all(targetId) as EdgeRow[];
    return rows.map((r) => this.#mapEdge(r));
  }

  /** Get all edges in the graph. */
  getAllEdges(): VaultEdge[] {
    const rows = this.#stmtGetAllEdges.all() as EdgeRow[];
    return rows.map((r) => this.#mapEdge(r));
  }

  // ── Tag CRUD ──

  /** Insert a tag for a node. */
  insertTag(tag: string, nodeId: number): void {
    this.#stmtInsertTag.run(tag, nodeId);
  }

  /** Delete all tags for a node. */
  deleteTagsByNode(nodeId: number): void {
    this.#stmtDeleteTagsByNode.run(nodeId);
  }

  /** Get tags for a node. */
  getTagsByNode(nodeId: number): VaultTag[] {
    const rows = this.#stmtGetTagsByNode.all(nodeId) as TagRow[];
    return rows.map((r) => ({ id: r.id, tag: r.tag, node_id: r.node_id }));
  }

  // ── Frontmatter CRUD ──

  /** Insert or update a frontmatter key-value pair for a node. */
  insertFrontmatterKey(nodeId: number, key: string, value: string): void {
    this.#stmtInsertFMK.run(nodeId, key, value);
  }

  /** Delete all frontmatter keys for a node. */
  deleteFMKByNode(nodeId: number): void {
    this.#stmtDeleteFMKByNode.run(nodeId);
  }

  /** Get frontmatter keys for a node. */
  getFMKByNode(nodeId: number): VaultFrontmatterKey[] {
    const rows = this.#stmtGetFMKByNode.all(nodeId) as FMKRow[];
    return rows.map((r) => ({ id: r.id, node_id: r.node_id, key: r.key, value: r.value }));
  }

  // ── Stats ──

  getNodeCount(): number {
    const row = this.#stmtNodeCount.get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  getEdgeCount(): number {
    const row = this.#stmtEdgeCount.get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  // ── Raw DB access (for search module) ──

  /** Expose the raw DB instance for search operations that need custom SQL. */
  get db(): DatabaseInstance {
    return this.#db;
  }

  // ── Row mappers ──

  #mapNode(r: NodeRow): VaultNode {
    return {
      id: r.id,
      vault_path: r.vault_path,
      note_path: r.note_path,
      title: r.title,
      frontmatter: r.frontmatter,
      content_hash: r.content_hash,
      file_mtime: r.file_mtime,
      out_degree: r.out_degree,
      in_degree: r.in_degree,
      source_id: r.source_id,
      indexed_at: r.indexed_at,
      source_type: r.source_type,
      connector_meta: r.connector_meta,
    };
  }

  #mapEdge(r: EdgeRow): VaultEdge {
    return {
      id: r.id,
      source_id: r.source_id,
      target_id: r.target_id,
      target_name: r.target_name,
      alias: r.alias,
      line_number: r.line_number,
      context: r.context,
      edge_type: r.edge_type,
    };
  }
}
