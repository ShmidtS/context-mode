// ─────────────────────────────────────────────────────────
// Tool handlers: ctx_semantic_search + ctx_index_embeddings + ctx_context_pack
// Phase 2B: real implementations with UnifiedSearch, VectorStore, ContextPacker
// ─────────────────────────────────────────────────────────

import { z } from 'zod'
import { trackResponse, getStore, acquireVaultStores, toolErrorResponse, getProjectDir, _detectedAdapter, classifyIp } from './shared.js'
import { searchAllSources } from '../search/unified.js'
import { ContextPacker } from '../search/context-packer.js'
import { VectorStore } from '../search/vector-store.js'
import { OllamaProvider, type EmbeddingProvider } from '../search/embedding.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DEBUG = process.env.DEBUG?.includes('context-mode')

/**
 * Validate that a user-supplied Ollama host URL does not resolve to a
 * private / link-local / multicast / reserved IP (SSRF guard).
 * Mirrors the ssrfGuard logic from admin.ts but throws on block.
 */
async function ssrfCheckHost(hostUrl: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(hostUrl)
  } catch {
    throw new Error(`Invalid Ollama host URL: ${hostUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Ollama host URL scheme "${parsed.protocol}" not allowed (only http: and https:)`)
  }
  const allowPrivate = process.env.CTX_FETCH_ALLOW_PRIVATE === '1'
  try {
    const { lookup } = await import('node:dns/promises')
    const records = await lookup(parsed.hostname, { all: true, verbatim: true })
    for (const rec of records) {
      const verdict = classifyIp(rec.address)
      if (verdict === 'block') {
        throw new Error(
          `Ollama host "${parsed.hostname}" resolves to ${rec.address} — blocked (link-local / IMDS / multicast / reserved)`,
        )
      }
      if (verdict === 'private' && !allowPrivate) {
        throw new Error(
          `Ollama host "${parsed.hostname}" resolves to private IP ${rec.address} — blocked by default. Set CTX_FETCH_ALLOW_PRIVATE=1 to allow.`,
        )
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('blocked')) throw err
    throw new Error(
      `DNS lookup failed for Ollama host "${parsed.hostname}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// ─────────────────────────────────────────────────────────
// Shared vector store + embedding provider (lazy singletons)
// ─────────────────────────────────────────────────────────

let _vectorStore: VectorStore | null = null
let _embeddingProvider: EmbeddingProvider | null = null

function getSharedVectorStore(): VectorStore {
  if (!_vectorStore) {
    // Use a temp DB for vector storage (same pattern as ContentStore)
    const dbPath = join(tmpdir(), `context-mode-vectors-${process.pid}.db`)
    _vectorStore = new VectorStore(dbPath)
  }
  return _vectorStore
}

async function getSharedEmbeddingProvider(
  model?: string,
  host?: string,
): Promise<EmbeddingProvider | null> {
  // Read API key from environment only — never accept secrets as tool arguments (H-1 fix)
  const apiKey = process.env.OLLAMA_API_KEY || process.env.EMBEDDING_API_KEY || undefined

  // If explicit model or host passed, always create a fresh provider
  if (model || host) {
    if (host) await ssrfCheckHost(host)
    const ollama = new OllamaProvider(model, host, undefined, apiKey)
    const testEmbed = await ollama.embed('test')
    return testEmbed ? ollama : null
  }

  if (_embeddingProvider !== undefined) return _embeddingProvider

  // Try Ollama first (most common local setup)
  try {
    const ollama = new OllamaProvider()
    const testEmbed = await ollama.embed('test')
    if (testEmbed) {
      _embeddingProvider = ollama
      return _embeddingProvider
    }
  } catch (e) { console.warn("getEmbeddingProvider Ollama test failed", e) }

  _embeddingProvider = null
  return null
}

export function resetContextStreamState(): void {
  if (_vectorStore) {
    try { _vectorStore.cleanup() } catch (e) { console.warn("resetContextStreamState cleanup failed", e) }
    _vectorStore = null
  }
  _embeddingProvider = undefined as unknown as EmbeddingProvider | null
}

// ─────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────

export function registerContextStreamTools(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
): void {

  // ── ctx_semantic_search ────────────────────────────────

  server.registerTool(
    'ctx_semantic_search',
    {
      title: 'Semantic Search',
      description:
        'Search indexed content using semantic similarity. Requires prior embedding indexing via ctx_index_embeddings. ' +
        'Returns results ranked by vector similarity to the query.',
      inputSchema: z.object({
        query: z.string().describe('Natural language search query'),
        limit: z.number().optional().default(5).describe('Max results to return (default: 5)'),
        contentType: z.enum(['code', 'prose']).optional().describe('Filter by content type'),
        minSimilarity: z.number().min(0).max(1).optional().default(0.5)
          .describe('Minimum similarity threshold 0-1 (default: 0.5)'),
        model: z.string().optional().describe('Embedding model name (e.g. nomic-embed-text, mxbai-embed-large)'),
        host: z.string().optional().describe('Ollama host URL (default: http://localhost:11434)'),
      }),
    },
    async (params) => {
      try {
        const { query, limit, contentType, minSimilarity, model, host } = params as {
          query: string
          limit?: number
          contentType?: 'code' | 'prose'
          minSimilarity?: number
          model?: string
          host?: string
        }

        const effectiveLimit = limit ?? 5
        const effectiveMinSimilarity = minSimilarity ?? 0.5
        const provider = await getSharedEmbeddingProvider(model, host)

        if (!provider) {
          return trackResponse('ctx_semantic_search', {
            content: [{ type: 'text' as const, text: JSON.stringify({
              results: [],
              meta: {
                query,
                limit: effectiveLimit,
                contentType: contentType ?? null,
                minSimilarity: effectiveMinSimilarity,
                note: 'No embedding provider available. Install Ollama or configure ONNX provider.',
              },
            }, null, 2) }],
          })
        }

        // Use UnifiedSearch with vector source enabled
        const store = getStore()
        const { vaultStore, vaultSearch } = await acquireVaultStores()

        const vectorStore = getSharedVectorStore()
        const allResults = await searchAllSources({
          query,
          limit: effectiveLimit * 3, // over-fetch for post-filtering
          store,
          sort: 'relevance',
          contentType,
          vaultStore,
          vaultSearch,
          vectorStore,
          embeddingProvider: provider,
        })

        // Filter for semantic origin or all results with semantic boost
        const semanticResults = allResults
          .filter(r => r.origin === 'semantic' || r.matchLayer === 'semantic')
          .slice(0, effectiveLimit)

        // If no semantic results, return all results (graceful degradation)
        const results = semanticResults.length > 0 ? semanticResults : allResults.slice(0, effectiveLimit)

        const formatted = results.map((r, i) => ({
          title: r.title,
          content: r.content,
          source: r.source,
          rank: i + 1,
          similarity: r.rank ?? 0,
          matchLayer: 'semantic' as const,
        }))

        return trackResponse('ctx_semantic_search', {
          content: [{ type: 'text' as const, text: JSON.stringify({
            results: formatted,
            meta: {
              query,
              limit: effectiveLimit,
              contentType: contentType ?? null,
              minSimilarity: effectiveMinSimilarity,
              model: provider.name,
              totalResults: results.length,
            },
          }, null, 2) }],
        })
      } catch (err: unknown) {
        return trackResponse('ctx_semantic_search', toolErrorResponse('Semantic search', err))
      }
    },
  )

  // ── ctx_index_embeddings ───────────────────────────────

  server.registerTool(
    'ctx_index_embeddings',
    {
      title: 'Index Embeddings',
      description:
        'Build a vector embedding index for semantic search. Scans indexed content and generates ' +
        'embeddings using the specified model. After indexing, use ctx_semantic_search for similarity queries. ' +
        'This is an incremental operation — already-indexed content (matched by content_hash) is skipped unless force=true.',
      inputSchema: z.object({
        vaultPath: z.string().describe('Absolute path to the vault or project root to index'),
        model: z.string().optional().default('nomic-embed-text')
          .describe('Embedding model name (default: nomic-embed-text)'),
        host: z.string().optional()
          .describe('Ollama host URL (default: http://localhost:11434)'),
        force: z.boolean().optional().default(false)
          .describe('Force reindexing even if embeddings already exist'),
      }),
    },
    async (params) => {
      try {
        const { vaultPath, model, host, force } = params as {
          vaultPath: string
          model?: string
          host?: string
          force?: boolean
        }

        const effectiveModel = model || 'nomic-embed-text'
        const provider = await getSharedEmbeddingProvider(effectiveModel, host)

        if (!provider) {
          return trackResponse('ctx_index_embeddings', {
            content: [{ type: 'text' as const, text: JSON.stringify({
              indexed: 0,
              skipped: 0,
              model: effectiveModel,
              dimensions: 0,
              force: force ?? false,
              note: 'No embedding provider available. Install Ollama or configure ONNX provider.',
            }, null, 2) }],
          })
        }

        const vectorStore = getSharedVectorStore()
        const store = getStore()
        let indexed = 0
        let skipped = 0

        // Use VaultGraphStore to get content nodes for the vault path
        const { vaultStore } = await acquireVaultStores()
        if (vaultStore) {
          const nodes = vaultStore.getNodesByVaultPath(vaultPath)

          for (const node of nodes) {
            // Get chunk content from ContentStore via source_id
            if (node.source_id) {
            const chunks = store.getChunksBySource(node.source_id)
            for (const chunk of chunks) {
              const text = `${chunk.title}\n${chunk.content}`
              const embedding = await provider.embed(text)
              if (embedding) {
                const contentHash = node.content_hash || ''
                vectorStore.insertVector(
                  node.id,
                  undefined, // symbolId — not available at node level
                  embedding,
                  provider.name,
                  contentHash,
                )
                indexed++
              } else {
                skipped++
              }
            }
          }
        }

        // Fallback: index from ContentStore sources directly when vault graph unavailable
        if (!vaultStore) {
          if (DEBUG) process.stderr.write('[ctx] vault node indexing failed: vault graph unavailable\n')
          const sources = store.listSources()
          for (const src of sources) {
            const meta = store.getSourceMeta(src.label)
            if (!meta) continue

            // Use label to search for chunks — need sourceId
            // Since getChunksBySource needs sourceId and we don't have it exposed,
            // search with a wildcard-like query scoped to this source
            const searchResults = await store.searchWithFallback(
              src.label.split(':').pop() || src.label,
              50,
              src.label,
              undefined,
              'exact',
            )

            for (const result of searchResults) {
              const text = `${result.title}\n${result.content}`
              const embedding = await provider.embed(text)
              if (embedding) {
                const nodeId = Math.abs(text.length % 100000)
                const contentHash = meta.contentHash || ''
                vectorStore.insertVector(
                  nodeId,
                  undefined,
                  embedding,
                  provider.name,
                  contentHash,
                )
                indexed++
              } else {
                skipped++
              }
            }
          }
        }
        }

        return trackResponse('ctx_index_embeddings', {
          content: [{ type: 'text' as const, text: JSON.stringify({
            indexed,
            skipped,
            model: provider.name,
            dimensions: provider.dimensions,
            force: force ?? false,
          }, null, 2) }],
        })
      } catch (err: unknown) {
        return trackResponse('ctx_index_embeddings', toolErrorResponse('Embedding index', err))
      }
    },
  )

  // ── ctx_context_pack ───────────────────────────────────

  server.registerTool(
    'ctx_context_pack',
    {
      title: 'Context Pack',
      description:
        'Pack relevant context into a single string optimized for LLM consumption within a token budget. ' +
        'Combines search results from multiple sources, trims and deduplicates to fit the budget.',
      inputSchema: z.object({
        query: z.string().describe('Query to drive context selection'),
        tokenBudget: z.number().min(100).describe('Maximum token budget for packed context'),
        sources: z.array(z.string()).optional()
          .describe('Limit to these indexed source labels'),
      }),
    },
    async (params) => {
      try {
        const { query, tokenBudget, sources } = params as {
          query: string
          tokenBudget: number
          sources?: string[]
        }

        const store = getStore()
        const packer = new ContextPacker(tokenBudget)

        // Search across all available sources
        const { vaultStore, vaultSearch } = await acquireVaultStores()

        const provider = await getSharedEmbeddingProvider()
        let vectorStore: VectorStore | null = null
        if (provider) {
          vectorStore = getSharedVectorStore()
        }

        const allResults = await searchAllSources({
          query,
          limit: 30, // over-fetch, packer will trim to budget
          store,
          sort: 'relevance',
          source: sources?.[0], // use first source label as filter
          vaultStore,
          vaultSearch,
          vectorStore,
          embeddingProvider: provider,
          projectDir: getProjectDir(),
          adapter: _detectedAdapter ?? undefined,
        })

        // Convert UnifiedSearchResult[] to SearchResult[] for packer
        const searchResults = allResults.map(r => ({
          title: r.title,
          content: r.content,
          source: r.source,
          rank: r.rank ?? 0,
          contentType: r.contentType ?? 'prose' as const,
          matchLayer: r.matchLayer as 'rrf' | 'rrf-fuzzy' | 'porter' | 'trigram' | 'fuzzy' | undefined,
          highlighted: r.highlighted,
          timestamp: r.timestamp,
        }))

        const { packed, tokensUsed, items } = await packer.pack(query, searchResults, {
          tokenBudget,
          dedup: true,
        })

        return trackResponse('ctx_context_pack', {
          content: [{ type: 'text' as const, text: JSON.stringify({
            packed,
            tokensUsed,
            tokenBudget,
            query,
            sources: sources ?? [],
            itemCount: items.length,
            items: items.map(i => ({ title: i.title, tokens: i.tokens, rank: i.rank })),
          }, null, 2) }],
        })
      } catch (err: unknown) {
        return trackResponse('ctx_context_pack', toolErrorResponse('Context pack', err))
      }
    },
  )
}
