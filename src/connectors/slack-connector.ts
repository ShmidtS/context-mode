/**
 * slack-connector — Slack connector stub.
 *
 * All methods return empty arrays with a warning log.
 * Full implementation deferred to a future phase.
 */

import type { ConnectorConfig, ConnectorItem, KnowledgeConnector } from './types.js'

export class SlackConnector implements KnowledgeConnector {
  readonly type = 'slack'

  async fetchItems(_config: ConnectorConfig): Promise<ConnectorItem[]> {
    console.warn('Slack connector not yet implemented')
    return []
  }

  transformToNodes(_items: ConnectorItem[]): Array<{ path: string; content: string; metadata: Record<string, unknown> }> {
    console.warn('Slack connector not yet implemented')
    return []
  }

  transformToEdges(_items: ConnectorItem[]): Array<{ fromPath: string; toPath: string; edgeType: string }> {
    console.warn('Slack connector not yet implemented')
    return []
  }
}
