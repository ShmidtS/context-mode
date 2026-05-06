/**
 * notion-connector — Notion connector stub.
 *
 * All methods return empty arrays with a warning log.
 * Full implementation deferred to a future phase.
 */

import type { ConnectorConfig, ConnectorItem, KnowledgeConnector } from './types.js'

export class NotionConnector implements KnowledgeConnector {
  readonly type = 'notion'

  async fetchItems(_config: ConnectorConfig): Promise<ConnectorItem[]> {
    console.warn('Notion connector not yet implemented')
    return []
  }

  transformToNodes(_items: ConnectorItem[]): Array<{ path: string; content: string; metadata: Record<string, unknown> }> {
    console.warn('Notion connector not yet implemented')
    return []
  }

  transformToEdges(_items: ConnectorItem[]): Array<{ fromPath: string; toPath: string; edgeType: string }> {
    console.warn('Notion connector not yet implemented')
    return []
  }
}
