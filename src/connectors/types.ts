/**
 * connectors/types — Connector interface and shared types for external
 * knowledge source integration (GitHub, etc.).
 */

// ─────────────────────────────────────────────────────────
// Connector config
// ─────────────────────────────────────────────────────────

export interface ConnectorConfig {
  type: 'github'
  config: Record<string, unknown>
}

// ─────────────────────────────────────────────────────────
// Connector item
// ─────────────────────────────────────────────────────────

export interface ConnectorItem {
  id: string
  source: string
  title: string
  content: string
  url?: string
  updatedAt?: string
  metadata?: Record<string, unknown>
}

// ─────────────────────────────────────────────────────────
// Connector interface
// ─────────────────────────────────────────────────────────

export interface KnowledgeConnector {
  readonly type: string
  fetchItems(config: ConnectorConfig): Promise<ConnectorItem[]>
  transformToNodes(items: ConnectorItem[]): Array<{ path: string; content: string; metadata: Record<string, unknown> }>
  transformToEdges?(items: ConnectorItem[]): Array<{ fromPath: string; toPath: string; edgeType: string }>
}
