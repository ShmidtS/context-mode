/**
 * connectors/registry — Connector registration and persistence.
 *
 * Stores registered connector configs in the shared SQLite DB so they
 * survive restarts. Provides a registry map of connector instances
 * keyed by type.
 */

import type { Database as DatabaseInstance } from 'better-sqlite3'
import type { ConnectorConfig, KnowledgeConnector } from './types.js'
import { GitHubConnector } from './github-connector.js'

// ─────────────────────────────────────────────────────────
// Row shape
// ─────────────────────────────────────────────────────────

interface ConnectorRow {
  id: number
  type: string
  config: string
  last_sync: string | null
  sync_count: number
}

// ─────────────────────────────────────────────────────────
// ConnectorRegistry
// ─────────────────────────────────────────────────────────

export class ConnectorRegistry {
  #db: DatabaseInstance
  #instances: Map<string, KnowledgeConnector>

  constructor(db: DatabaseInstance) {
    this.#db = db
    this.#instances = new Map()
    this.#ensureTables()
    this.#autoRegister()
  }

  // ── Schema ──

  #ensureTables(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS connectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        config TEXT NOT NULL,
        last_sync TEXT,
        sync_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(type, config)
      );
    `)
  }

  // ── Auto-register built-in connectors ──

  #autoRegister(): void {
    this.#instances.set('github', new GitHubConnector())
  }

  // ── CRUD ──

  /** Register a connector config. Insert or ignore if already exists. */
  register(type: string, config: Record<string, unknown>): void {
    this.#db.prepare(
      'INSERT OR IGNORE INTO connectors (type, config) VALUES (?, ?)',
    ).run(type, JSON.stringify(config))
  }

  /** List all registered connector configs. */
  list(): Array<{ id: number; type: string; config: Record<string, unknown>; lastSync: string | null; syncCount: number }> {
    const rows = this.#db.prepare('SELECT * FROM connectors').all() as ConnectorRow[]
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      config: JSON.parse(r.config) as Record<string, unknown>,
      lastSync: r.last_sync,
      syncCount: r.sync_count,
    }))
  }

  /** Update sync metadata after a successful sync. */
  updateSync(id: number): void {
    this.#db.prepare(
      "UPDATE connectors SET last_sync = datetime('now'), sync_count = sync_count + 1 WHERE id = ?",
    ).run(id)
  }

  /** Return the map of registered connector instances keyed by type. */
  getRegistry(): Map<string, KnowledgeConnector> {
    return this.#instances
  }
}
