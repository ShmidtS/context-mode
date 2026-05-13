/**
 * result-formatter — Tiktoken-aware truncation and JSON formatting of search results.
 */

import type { SearchChunk } from "./searcher.js";

export interface FormattedChunk {
  path: string;
  symbol: string;
  lines: string;
  content: string;
  score: number;
}

let _encoder: { encode: (text: string) => number[]; decode: (tokens: number[]) => string } | null = null;

function getEncoder(): { encode: (text: string) => number[]; decode: (tokens: number[]) => string } | null {
  if (_encoder) return _encoder;
  try {
    const { get_encoding } = require("tiktoken");
    _encoder = get_encoding("cl100k_base");
    return _encoder;
  } catch {
    return null;
  }
}

export function formatResults(chunks: SearchChunk[], maxTokens = 2000): FormattedChunk[] {
  const enc = getEncoder();
  const results: FormattedChunk[] = [];

  for (const chunk of chunks) {
    let content = chunk.content;

    if (enc) {
      const tokens = enc.encode(content);
      if (tokens.length > maxTokens) {
        const decoded = enc.decode(tokens.slice(0, maxTokens)) as unknown;
        const decodedText = typeof decoded === "string" ? decoded : Buffer.from(decoded as Uint8Array).toString("utf-8");
        content = decodedText + "\n... (truncated)";
      }
    } else {
      // Rough fallback: ~4 chars per token for latin text
      const approxChars = maxTokens * 4;
      if (content.length > approxChars) {
        content = content.slice(0, approxChars) + "\n... (truncated)";
      }
    }

    results.push({
      path: chunk.filePath,
      symbol: chunk.symbolName || "(anonymous)",
      lines: `${chunk.startLine}-${chunk.endLine}`,
      content,
      score: chunk.score,
    });
  }

  return results;
}
