/**
 * symbol-graph — AST-level edge extraction for TypeScript/TSX files.
 *
 * Walks the tree-sitter AST to find inter-symbol relationships:
 * calls, inherits, implements, type-ref, decorates.
 * Returns edges with targetSymbol names (targetPath resolved later).
 * Gracefully degrades when tree-sitter is unavailable.
 */

import { canParse } from './ast-parser.js'

// ─────────────────────────────────────────────────────────
// Optional tree-sitter import (shared with ast-parser)
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
// Types
// ─────────────────────────────────────────────────────────

export interface SymbolEdge {
  targetPath?: string
  targetSymbol?: string
  edgeType: 'calls' | 'inherits' | 'implements' | 'type-ref' | 'decorates'
}

// ─────────────────────────────────────────────────────────
// AST walking
// ─────────────────────────────────────────────────────────

/** Extract the text of an identifier or member_expression node. */
function extractName(node: any): string {
  if (!node) return ''
  if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'property_identifier') {
    return node.text as string
  }
  if (node.type === 'member_expression') {
    const obj = extractName(node.childForFieldName('object'))
    const prop = extractName(node.childForFieldName('property'))
    return obj ? `${obj}.${prop}` : prop
  }
  // For call_expression, the function child may be nested
  if (node.type === 'call_expression') {
    const func = node.childForFieldName('function')
    return extractName(func)
  }
  return ''
}

function walkForEdges(node: any, edges: SymbolEdge[]): void {
  const kind = node.type as string

  // call_expression → 'calls'
  if (kind === 'call_expression') {
    const func = node.childForFieldName('function')
    const name = extractName(func)
    if (name) {
      // Use the base name (before dot) as targetSymbol for resolution
      const baseName = name.includes('.') ? name.split('.').pop()! : name
      edges.push({
        targetSymbol: baseName,
        edgeType: 'calls',
      })
    }
  }

  // class_declaration → check extends / implements
  if (kind === 'class_declaration') {
    // extends_clause
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child && child.type === 'class_heritage') {
        for (let j = 0; j < child.childCount; j++) {
          const clause = child.child(j)
          if (!clause) continue

          if (clause.type === 'extends_clause') {
            // There may be multiple extends targets (rare but possible)
            for (let k = 0; k < clause.childCount; k++) {
              const target = clause.child(k)
              if (target && (target.type === 'type_identifier' || target.type === 'generic_type')) {
                const name = target.childForFieldName('name')
                edges.push({
                  targetSymbol: name ? name.text : target.text,
                  edgeType: 'inherits',
                })
              }
            }
          }

          if (clause.type === 'implements_clause') {
            for (let k = 0; k < clause.childCount; k++) {
              const target = clause.child(k)
              if (target && (target.type === 'type_identifier' || target.type === 'generic_type')) {
                const name = target.childForFieldName('name')
                edges.push({
                  targetSymbol: name ? name.text : target.text,
                  edgeType: 'implements',
                })
              }
            }
          }
        }
      }
    }
  }

  // type_annotation → 'type-ref'
  if (kind === 'type_annotation') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child && child.type === 'type_identifier') {
        edges.push({
          targetSymbol: child.text as string,
          edgeType: 'type-ref',
        })
      }
      // Also check generic_type children for type_identifier
      if (child && child.type === 'generic_type') {
        const name = child.childForFieldName('name')
        if (name) {
          edges.push({
            targetSymbol: name.text as string,
            edgeType: 'type-ref',
          })
        }
      }
      // union_type / intersection_type may contain type_identifiers
      if (child && (child.type === 'union_type' || child.type === 'intersection_type')) {
        collectTypeIdentifiers(child, edges)
      }
    }
  }

  // decorator → 'decorates'
  if (kind === 'decorator') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child) continue
      // @expression — the identifier after @
      if (child.type === 'identifier') {
        edges.push({
          targetSymbol: child.text as string,
          edgeType: 'decorates',
        })
      }
      // @expr.call() — get the member_expression or identifier before parens
      if (child.type === 'call_expression') {
        const name = extractName(child)
        if (name) {
          edges.push({
            targetSymbol: name.includes('.') ? name.split('.').pop()! : name,
            edgeType: 'decorates',
          })
        }
      }
    }
  }

  // Recurse into children
  for (let i = 0; i < node.childCount; i++) {
    walkForEdges(node.child(i), edges)
  }
}

/** Collect type_identifier nodes from compound types (union/intersection/generic). */
function collectTypeIdentifiers(node: any, edges: SymbolEdge[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === 'type_identifier') {
      edges.push({
        targetSymbol: child.text as string,
        edgeType: 'type-ref',
      })
    }
    if (child.type === 'generic_type') {
      const name = child.childForFieldName('name')
      if (name) {
        edges.push({
          targetSymbol: name.text as string,
          edgeType: 'type-ref',
        })
      }
    }
    if (child.type === 'union_type' || child.type === 'intersection_type') {
      collectTypeIdentifiers(child, edges)
    }
  }
}

// ─────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────

/**
 * Extract symbol-level edges from a TypeScript/TSX source file.
 * Returns empty array if tree-sitter is unavailable.
 *
 * @param source   — Raw file content.
 * @param filePath — Relative file path.
 * @param nodeId   — The vault node ID for this file (used later for edge insertion).
 */
export function extractSymbolEdges(
  source: string,
  filePath: string,
  nodeId: number,
): SymbolEdge[] {
  if (!Parser || !TypeScriptLang) return []
  if (!canParse(filePath)) return []

  const ext = filePath.substring(filePath.lastIndexOf('.'))
  const lang = ext === '.tsx' ? (tsxLang ?? TypeScriptLang) : TypeScriptLang

  try {
    const parser = new Parser()
    parser.setLanguage(lang)
    const tree = parser.parse(source)
    if (!tree) return []

    const edges: SymbolEdge[] = []
    walkForEdges(tree.rootNode, edges)
    tree.delete()
    return edges
  } catch {
    return []
  }
}
