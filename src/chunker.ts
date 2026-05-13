/**
 * chunker — Semantic code chunking via tree-sitter AST or tiktoken fallback.
 *
 * Extracts named declarations (functions, classes, interfaces, methods)
 * as individual chunks bounded by AST nodes. Falls back to token-based
 * chunking when tree-sitter is unavailable.
 */

import type { AstChunk } from "./types.js";

interface TreeSitterNode {
  type: string;
  startPosition: { row: number };
  endPosition: { row: number };
  text: string;
  children: TreeSitterNode[];
}

const SYMBOL_TYPES = new Map<string, string>([
  ["function_declaration", "function"],
  ["method_definition", "method"],
  ["class_declaration", "class"],
  ["interface_declaration", "interface"],
  ["type_alias_declaration", "type"],
  ["arrow_function", "function"],
  ["function_expression", "function"],
  ["method_signature", "method"],
  ["class_definition", "class"],
]);

let _Parser: unknown | null = null;
let _TypeScript: unknown | null = null;

function loadTreeSitter(): { Parser: unknown; TypeScript: unknown } | null {
  if (_Parser) return { Parser: _Parser, TypeScript: _TypeScript };
  try {
    const { Parser } = require("tree-sitter");
    const TypeScript = require("tree-sitter-typescript");
    _Parser = Parser;
    _TypeScript = TypeScript;
    return { Parser, TypeScript };
  } catch {
    return null;
  }
}

function extractName(node: TreeSitterNode): string | undefined {
  for (const child of node.children || []) {
    if (child.type === "identifier" || child.type === "type_identifier" || child.type === "property_identifier") {
      return child.text;
    }
    const nested = extractName(child);
    if (nested) return nested;
  }
  return undefined;
}

function walkNodes(node: TreeSitterNode, cb: (n: TreeSitterNode) => void): void {
  cb(node);
  for (const child of node.children || []) walkNodes(child, cb);
}

function isTopLevel(node: TreeSitterNode, root: TreeSitterNode): boolean {
  let depth = 0;
  let cur: TreeSitterNode | undefined = node;
  while (cur && cur !== root) {
    cur = (cur as unknown as { parent?: TreeSitterNode }).parent;
    depth++;
  }
  return depth <= 2;
}

export function parseFile(content: string, filePath: string): AstChunk[] {
  const ts = loadTreeSitter();
  if (!ts) return tokenChunk(content, filePath);

  const { Parser, TypeScript } = ts as Record<string, any>;
  const parser = new Parser();
  let language: unknown;
  try {
    if (TypeScript.typescript) language = TypeScript.typescript;
    else if (TypeScript.TypeScript) language = TypeScript.TypeScript;
    else language = TypeScript;
  } catch {
    return tokenChunk(content, filePath);
  }

  try {
    (parser as any).setLanguage(language);
  } catch {
    return tokenChunk(content, filePath);
  }

  const tree = parser.parse(content);
  const root = tree.rootNode as TreeSitterNode;
  const chunks: AstChunk[] = [];

  walkNodes(root, (node) => {
    const symbolType = SYMBOL_TYPES.get(node.type);
    if (!symbolType) return;

    // Only top-level declarations (avoid nested function expressions inside other functions unless top-level arrow)
    if (!isTopLevel(node, root) && node.type !== "arrow_function") return;

    const name = extractName(node) ?? "anonymous";
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    // Include 3 lines of context before/after when available
    const lines = content.split("\n");
    const ctxStart = Math.max(0, startLine - 4);
    const ctxEnd = Math.min(lines.length, endLine + 3);
    const snippet = lines.slice(ctxStart, ctxEnd).join("\n");

    chunks.push({
      title: `${name} (${symbolType})`,
      content: snippet,
      contentType: "code",
      metadata: {
        symbolName: name,
        symbolKind: symbolType,
        byteStart: 0,
        byteEnd: 0,
        lineStart: startLine,
        lineEnd: endLine,
        contentHash: "",
      },
    });
  });

  if (chunks.length === 0) {
    return tokenChunk(content, filePath);
  }

  return chunks;
}

function tokenChunk(content: string, filePath: string): AstChunk[] {
  // Fallback: tiktoken-based chunking ~512 tokens each
  let enc: { encode: (text: string) => number[]; decode: (tokens: number[]) => string } | null = null;
  try {
    const { get_encoding } = require("tiktoken");
    enc = get_encoding("cl100k_base");
  } catch {
    // tiktoken unavailable — split by lines
    return [{
      title: filePath,
      content: content.slice(0, 8000),
      contentType: "code",
      metadata: {
        symbolName: filePath,
        symbolKind: "file",
        byteStart: 0,
        byteEnd: 0,
        lineStart: 1,
        lineEnd: content.split("\n").length,
        contentHash: "",
      },
    }];
  }

  if (!enc) return tokenChunk(content, filePath);
  const tokens = enc.encode(content);
  const CHUNK_SIZE = 512;
  const OVERLAP = 64;
  const chunks: AstChunk[] = [];

  for (let i = 0; i < tokens.length; i += CHUNK_SIZE - OVERLAP) {
    const slice = tokens.slice(i, i + CHUNK_SIZE);
    const decoded = enc.decode(slice) as unknown;
    const text = typeof decoded === "string" ? decoded : Buffer.from(decoded as Uint8Array).toString("utf-8");
    const lineOffset = content.slice(0, content.indexOf(text)).split("\n").length;
    chunks.push({
      title: `${filePath} (chunk ${chunks.length + 1})`,
      content: text,
      contentType: "code",
      metadata: {
        symbolName: "",
        symbolKind: "token_chunk",
        byteStart: 0,
        byteEnd: 0,
        lineStart: lineOffset + 1,
        lineEnd: lineOffset + text.split("\n").length,
        contentHash: "",
      },
    });
  }

  return chunks;
}
