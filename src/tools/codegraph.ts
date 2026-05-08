// ─────────────────────────────────────────────────────────
// Tool handlers: ctx_dead_code + ctx_complexity + ctx_dep_graph
// Phase 2C: real implementations backed by graph analysis
// ─────────────────────────────────────────────────────────

import { z } from 'zod'
import { writeFileSync, realpathSync, existsSync } from 'node:fs'
import { dirname, basename, join, resolve, relative, sep, isAbsolute } from 'node:path'
import { trackResponse, getSharedVaultStore } from './shared.js'
import { DeadCodeAnalyzer } from '../analysis/dead-code.js'
import { ComplexityAnalyzer } from '../analysis/complexity.js'
import { GraphVisualizer } from '../analysis/visualize.js'

const safeRealpathForCreate = (p: string): string => {
  const abs = resolve(p)
  let cur = abs
  const missing: string[] = []
  while (!existsSync(cur)) {
    missing.unshift(basename(cur))
    const parent = dirname(cur)
    if (parent === cur) throw new Error(`No existing parent for path: ${p}`)
    cur = parent
  }
  return join(realpathSync(cur), ...missing)
}


const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child)
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function registerCodeGraphTools(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
): void {

  // ── ctx_dead_code ──────────────────────────────────────

  server.registerTool(
    'ctx_dead_code',
    {
      title: 'Dead Code Analysis',
      description:
        'Analyze codebase for unreachable (dead) code. Requires a symbol graph built from AST parsing. ' +
        'Identifies functions, classes, and modules that are never referenced from entry points.',
      inputSchema: z.object({
        vaultPath: z.string().describe('Absolute path to the project root to analyze'),
        entryPoints: z.array(z.string()).optional()
          .describe('Entry point files (e.g., ["src/index.ts"]). Defaults to common conventions.'),
        includeTests: z.boolean().optional().default(false)
          .describe('Include test files as potential references (default: false)'),
      }),
    },
    async (params) => {
      try {
        const { vaultPath, entryPoints, includeTests } = params as {
          vaultPath: string
          entryPoints?: string[]
          includeTests?: boolean
        }

        const { store } = await getSharedVaultStore()
        const analyzer = new DeadCodeAnalyzer(store)
        const dead = analyzer.detect(vaultPath, entryPoints, includeTests)

        const result = {
          total: dead.length,
          dead,
          vaultPath,
          entryPoints: entryPoints ?? analyzer.listEntryPoints(vaultPath).map((e) => e.notePath),
          includeTests: includeTests ?? false,
        }

        return trackResponse('ctx_dead_code', {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return trackResponse('ctx_dead_code', {
          content: [{ type: 'text' as const, text: `Dead code error: ${message}` }],
          isError: true,
        })
      }
    },
  )

  // ── ctx_complexity ─────────────────────────────────────

  server.registerTool(
    'ctx_complexity',
    {
      title: 'Complexity Analysis',
      description:
        'Analyze cyclomatic complexity of code symbols. Requires AST parsing. ' +
        'Returns symbols exceeding a complexity threshold, sorted by complexity or path.',
      inputSchema: z.object({
        vaultPath: z.string().describe('Absolute path to the project root to analyze'),
        threshold: z.number().optional().default(10)
          .describe('Minimum complexity to report (default: 10)'),
        sortBy: z.enum(['complexity', 'path']).optional().default('complexity')
          .describe('Sort results by complexity (default) or path'),
      }),
    },
    async (params) => {
      try {
        const { vaultPath, threshold, sortBy } = params as {
          vaultPath: string
          threshold?: number
          sortBy?: 'complexity' | 'path'
        }

        const { store } = await getSharedVaultStore()
        const analyzer = new ComplexityAnalyzer()
        const allResults = analyzer.analyzeVault(vaultPath, store)

        // Filter by threshold
        const minComplexity = threshold ?? 10
        const filtered = allResults.filter((r) => r.complexity >= minComplexity)

        // Sort
        const sort = sortBy ?? 'complexity'
        if (sort === 'path') {
          filtered.sort((a, b) => a.path.localeCompare(b.path) || a.symbol.localeCompare(b.symbol))
        } else {
          filtered.sort((a, b) => b.complexity - a.complexity)
        }

        const result = {
          results: filtered,
          total: allResults.length,
          aboveThreshold: filtered.length,
          vaultPath,
          threshold: minComplexity,
          sortBy: sort,
        }

        return trackResponse('ctx_complexity', {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return trackResponse('ctx_complexity', {
          content: [{ type: 'text' as const, text: `Complexity error: ${message}` }],
          isError: true,
        })
      }
    },
  )

  // ── ctx_dep_graph ──────────────────────────────────────

  server.registerTool(
    'ctx_dep_graph',
    {
      title: 'Dependency Graph',
      description:
        'Generate a dependency graph visualization for the project. Requires indexed vault edges. ' +
        'Supports DOT, Mermaid, and HTML output formats.',
      inputSchema: z.object({
        vaultPath: z.string().describe('Absolute path to the project root'),
        format: z.enum(['dot', 'mermaid', 'html']).describe('Output format for the graph'),
        edgeTypes: z.array(z.string()).optional()
          .describe('Edge types to include (e.g., ["import", "calls", "inherits"])'),
        maxNodes: z.number().optional().default(100)
          .describe('Maximum nodes to render (default: 100)'),
        outputPath: z.string().optional()
          .describe('Write output to this file path instead of returning inline'),
      }),
    },
    async (params) => {
      try {
        const { vaultPath, format, edgeTypes, maxNodes, outputPath } = params as {
          vaultPath: string
          format: 'dot' | 'mermaid' | 'html'
          edgeTypes?: string[]
          maxNodes?: number
          outputPath?: string
        }

        const { store } = await getSharedVaultStore()
        const visualizer = new GraphVisualizer(store)

        const options = {
          edgeTypes,
          maxNodes: maxNodes ?? 100,
        }

        let graph: string
        switch (format) {
          case 'dot':
            graph = visualizer.toDOT(vaultPath, options)
            break
          case 'mermaid':
            graph = visualizer.toMermaid(vaultPath, options)
            break
          case 'html':
            graph = visualizer.toHTML(vaultPath, options)
            break
        }

        // Write to file if outputPath specified
        if (outputPath) {
          const resolvedOutput = safeRealpathForCreate(outputPath)
          const resolvedVault = realpathSync(resolve(vaultPath))
          const norm = (p: string) =>
            process.platform === 'win32' ? p.toLowerCase() : p
          if (!isInside(norm(resolvedOutput), norm(resolvedVault))) {
            throw new Error(
              `outputPath escapes project directory: ${outputPath}`,
            )
          }
          writeFileSync(resolvedOutput, graph, 'utf8')
          const result = {
            format,
            edgeTypes: edgeTypes ?? [],
            maxNodes: maxNodes ?? 100,
            outputPath,
            sizeBytes: graph.length,
          }
          return trackResponse('ctx_dep_graph', {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          })
        }

        const result = {
          graph,
          format,
          edgeTypes: edgeTypes ?? [],
          maxNodes: maxNodes ?? 100,
        }

        return trackResponse('ctx_dep_graph', {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return trackResponse('ctx_dep_graph', {
          content: [{ type: 'text' as const, text: `Dependency graph error: ${message}` }],
          isError: true,
        })
      }
    },
  )
}
