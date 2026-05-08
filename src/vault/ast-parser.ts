/**
 * ast-parser — tree-sitter AST walker for TypeScript/TSX files.
 *
 * Extracts named declarations (functions, classes, methods, interfaces,
 * types, variables, constants) with byte ranges and line numbers.
 * Gracefully degrades when tree-sitter is unavailable.
 */

import { createHash } from 'node:crypto'
import type { CodeSymbol } from '../types.js'

// ─────────────────────────────────────────────────────────
// Optional tree-sitter import
// ─────────────────────────────────────────────────────────

let Parser: any = null
let TypeScriptLang: any = null
let tsxLang: any = null

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Parser = require('tree-sitter')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tsModule = require('tree-sitter-typescript')
  TypeScriptLang = tsModule.typescript
  tsxLang = tsModule.tsx
} catch (err) {
  console.warn("tsModule failed", err);
}

// ─────────────────────────────────────────────────────────
// Language detection
// ─────────────────────────────────────────────────────────

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])

/**
 * Whether this file can be parsed by the AST walker.
 * Only TypeScript/TSX files when tree-sitter is available.
 */
export function canParse(filePath: string): boolean {
  if (!Parser || !TypeScriptLang) return false
  const ext = filePath.substring(filePath.lastIndexOf('.'))
  return TS_EXTENSIONS.has(ext)
}

// ─────────────────────────────────────────────────────────
// AST walking
// ─────────────────────────────────────────────────────────

/** Node types that map to CodeSymbol.kind values. */
const DECL_KIND_MAP: Record<string, CodeSymbol['kind']> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  method_definition: 'method',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  abstract_method_declaration: 'method',
}

/**
 * Walk the tree-sitter AST and extract named declarations.
 * For method_definitions, the enclosing class name becomes the scope.
 */
function walkTree(tree: any, source: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = []
  const lines = source.split('\n')

  // Precompute byte offset for each line start
  const lineOffsets: number[] = [0]
  for (const line of lines) {
    lineOffsets.push(lineOffsets[lineOffsets.length - 1] + line.length + 1)
  }

  function byteToLine(byte: number): number {
    for (let i = lineOffsets.length - 1; i >= 0; i--) {
      if (lineOffsets[i] <= byte) return i
    }
    return 0
  }

  function visit(node: any, scope?: string): void {
    const kind = node.type as string

    // Named declarations
    if (DECL_KIND_MAP[kind]) {
      const nameNode = node.childForFieldName('name')
      if (nameNode) {
        const name = nameNode.text as string
        const symbolKind = DECL_KIND_MAP[kind]
        const byteStart = node.startIndex as number
        const byteEnd = node.endIndex as number
        const lineStart = node.startPosition.row as number
        const lineEnd = node.endPosition.row as number
        const content = source.substring(byteStart, byteEnd)
        const contentHash = createHash('md5').update(content).digest('hex')

        symbols.push({
          name,
          kind: symbolKind,
          scope: kind === 'method_definition' || kind === 'abstract_method_declaration'
            ? scope
            : undefined,
          byteStart,
          byteEnd,
          lineStart,
          lineEnd,
          contentHash,
        })
      }

      // Recurse children, tracking class scope for methods
      const childScope = kind === 'class_declaration' && nameNode
        ? (nameNode.text as string)
        : scope
      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i), childScope)
      }
      return
    }

    // Variable declarations at top level or class body
    if (kind === 'variable_declarator') {
      const nameNode = node.childForFieldName('name')
      if (nameNode) {
        const name = nameNode.text as string
        // Determine constant vs variable from parent lexical_declaration
        const parent = node.parent
        let symbolKind: CodeSymbol['kind'] = 'variable'
        if (parent && parent.type === 'lexical_declaration') {
          const valDecl = parent.childForFieldName('value')
          // Check if the declaration keyword is 'const'
          // tree-sitter-typescript: lexical_declaration has firstChild as 'const' or 'let'
          for (let c = 0; c < parent.childCount; c++) {
            const child = parent.child(c)
            if (child && child.type === 'const') {
              symbolKind = 'constant'
              break
            }
          }
        }

        const byteStart = node.startIndex as number
        const byteEnd = node.endIndex as number
        const lineStart = node.startPosition.row as number
        const lineEnd = node.endPosition.row as number
        const content = source.substring(byteStart, byteEnd)
        const contentHash = createHash('md5').update(content).digest('hex')

        symbols.push({
          name,
          kind: symbolKind,
          scope,
          byteStart,
          byteEnd,
          lineStart,
          lineEnd,
          contentHash,
        })
      }
    }

    // Recurse children
    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i), scope)
    }
  }

  visit(tree.rootNode, undefined)
  return symbols
}

// ─────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────

/**
 * Parse a TypeScript/TSX source file and extract named declarations.
 * Returns empty array if tree-sitter is unavailable.
 */
export function parseSymbols(source: string, filePath: string): CodeSymbol[] {
  if (!Parser || !TypeScriptLang) return []

  const ext = filePath.substring(filePath.lastIndexOf('.'))
  const lang = ext === '.tsx' ? (tsxLang ?? TypeScriptLang) : TypeScriptLang

  try {
    const parser = new Parser()
    parser.setLanguage(lang)
    const tree = parser.parse(source)
    if (!tree) return []
    const result = walkTree(tree, source)
    tree.delete()
    return result
  } catch {
    return []
  }
}
