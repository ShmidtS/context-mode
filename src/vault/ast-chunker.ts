/**
 * ast-chunker — Symbol-boundary chunking for TypeScript/TSX files.
 *
 * Creates one chunk per CodeSymbol extracted by ast-parser, with metadata
 * for symbol name, kind, scope, byte/line ranges, and content hash.
 * Falls back to empty array when tree-sitter is unavailable, allowing
 * callers to use heading-based chunking as a fallback.
 */

import { parseSymbols, canParse } from './ast-parser.js'
import type { AstChunk } from '../types.js'

/**
 * Chunk a source file by symbol boundaries.
 * Each returned AstChunk corresponds to one CodeSymbol.
 *
 * @param source  — Raw file content.
 * @param filePath — Relative file path (used to determine parseability).
 * @param baseMetadata — Additional metadata to merge into each chunk.
 * @returns AstChunk[] — one per symbol. Empty if tree-sitter unavailable.
 */
export function chunkBySymbols(
  source: string,
  filePath: string,
  baseMetadata: Record<string, unknown> = {},
): AstChunk[] {
  if (!canParse(filePath)) return []

  const symbols = parseSymbols(source, filePath)
  if (symbols.length === 0) return []

  return symbols.map((sym) => {
    const content = source.substring(sym.byteStart, sym.byteEnd)
    const title = sym.scope
      ? `${sym.scope}.${sym.name}`
      : sym.name

    return {
      title,
      content,
      contentType: 'code' as const,
      metadata: {
        ...baseMetadata,
        symbolName: sym.name,
        symbolKind: sym.kind,
        scope: sym.scope,
        byteStart: sym.byteStart,
        byteEnd: sym.byteEnd,
        lineStart: sym.lineStart,
        lineEnd: sym.lineEnd,
        contentHash: sym.contentHash,
      },
    }
  })
}
