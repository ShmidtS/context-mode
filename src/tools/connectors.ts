// ─────────────────────────────────────────────────────────
// Tool handlers: ctx_connector_add + ctx_connector_sync + ctx_connector_list
// ─────────────────────────────────────────────────────────

import { z } from 'zod'
import { trackResponse } from './shared.js'

// In-memory connector registry (Phase 1 stub)
const connectors: Array<{
  connectorId: number
  type: 'github'
  config: Record<string, unknown>
  lastSyncAt: string | null
}> = []

let nextConnectorId = 1

export function registerConnectorTools(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
): void {

  // ── ctx_connector_add ──────────────────────────────────

  server.registerTool(
    'ctx_connector_add',
    {
      title: 'Add Connector',
      description:
        'Register an external connector (GitHub) for syncing content into the knowledge graph. ' +
        'After adding, use ctx_connector_sync to pull data.',
      inputSchema: z.object({
        type: z.enum(['github'])
          .describe('Connector type'),
        config: z.record(z.unknown())
          .describe('Connector configuration (e.g., { repo: "org/repo" } for GitHub)'),
      }),
    },
    async (params) => {
      try {
        const { type, config } = params as {
          type: 'github'
          config: Record<string, unknown>
        }

        const connectorId = nextConnectorId++
        connectors.push({
          connectorId,
          type,
          config,
          lastSyncAt: null,
        })

        const result = {
          connectorId,
          type,
        }

        return trackResponse('ctx_connector_add', {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return trackResponse('ctx_connector_add', {
          content: [{ type: 'text' as const, text: `Connector add error: ${message}` }],
          isError: true,
        })
      }
    },
  )

  // ── ctx_connector_sync ─────────────────────────────────

  server.registerTool(
    'ctx_connector_sync',
    {
      title: 'Sync Connector',
      description:
        'Sync content from a registered connector into the knowledge graph. ' +
        'Pulls new and updated items since the last sync.',
      inputSchema: z.object({
        connectorId: z.number().describe('ID of the connector to sync'),
        force: z.boolean().optional().default(false)
          .describe('Force full sync instead of incremental'),
      }),
    },
    async (params) => {
      try {
        const { connectorId, force } = params as {
          connectorId: number
          force?: boolean
        }

        const connector = connectors.find((c) => c.connectorId === connectorId)
        if (!connector) {
          return trackResponse('ctx_connector_sync', {
            content: [{
              type: 'text' as const,
              text: `Connector not found: ${connectorId}`,
            }],
            isError: true,
          })
        }

        // Phase 1 stub: registry integration not yet available
        const result = {
          synced: 0,
          newNodes: 0,
          newEdges: 0,
          connectorId,
          force: force ?? false,
          note: 'Connector sync requires registry integration.',
        }

        return trackResponse('ctx_connector_sync', {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return trackResponse('ctx_connector_sync', {
          content: [{ type: 'text' as const, text: `Connector sync error: ${message}` }],
          isError: true,
        })
      }
    },
  )

  // ── ctx_connector_list ─────────────────────────────────

  server.registerTool(
    'ctx_connector_list',
    {
      title: 'List Connectors',
      description:
        'List all registered connectors with their sync status.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const result = {
          connectors: connectors.map((c) => ({
            connectorId: c.connectorId,
            type: c.type,
            lastSyncAt: c.lastSyncAt,
          })),
        }

        return trackResponse('ctx_connector_list', {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return trackResponse('ctx_connector_list', {
          content: [{ type: 'text' as const, text: `Connector list error: ${message}` }],
          isError: true,
        })
      }
    },
  )
}
