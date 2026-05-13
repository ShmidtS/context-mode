/**
 * rerank — Heuristic and ONNX cross-encoder reranking for search results.
 *
 * Priority:
 *   1. ONNX cross-encoder (ms-marco-MiniLM-L-6-v2) if available
 *   2. Heuristic rerank with boosts/penalties
n */

import type { SearchChunk } from "./searcher.js";

const GENERIC_TERMS = new Set([
  "function", "const", "let", "var", "export", "default", "import", "from",
  "class", "interface", "type", "return", "if", "else", "for", "while", "async", "await",
  "new", "this", "try", "catch", "throw", "true", "false", "null", "undefined",
]);

let _session: { run(inputs: Record<string, unknown>): Promise<Record<string, unknown>>; inputNames: string[]; outputNames: string[] } | null = null;

async function loadOnnxReranker(): Promise<boolean> {
  if (_session) return true;
  try {
    const ort = await import("onnxruntime-node");
    const path = `${process.env.HOME}/.context-mode/models/ms-marco-MiniLM-L-6-v2.onnx`;
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) return false;
    _session = await ort.InferenceSession.create(path);
    return true;
  } catch {
    return false;
  }
}

function truncate(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.slice(0, end).toString("utf-8");
}

export async function rerank(query: string, chunks: SearchChunk[], limit = 10): Promise<SearchChunk[]> {
  const onnxOk = await loadOnnxReranker();
  if (onnxOk && _session) {
    const scored: SearchChunk[] = [];
    for (const chunk of chunks) {
      const pair = truncate(`${query} [SEP] ${chunk.content.slice(0, 512)}`, 512);
      const buf = Buffer.from(pair, "utf-8");
      const inputIds = new BigInt64Array(512);
      const attentionMask = new BigInt64Array(512);
      for (let i = 0; i < Math.min(buf.length, 512); i++) {
        inputIds[i] = BigInt(buf[i]);
        attentionMask[i] = 1n;
      }
      try {
        const ort = await import("onnxruntime-node");
        const feeds: Record<string, unknown> = {};
        feeds[_session.inputNames[0]] = new ort.Tensor("int64", inputIds, [1, 512]);
        if (_session.inputNames.length > 1) {
          feeds[_session.inputNames[1]] = new ort.Tensor("int64", attentionMask, [1, 512]);
        }
        const out = await _session.run(feeds);
        const tensor = out[_session.outputNames[0]] as { data: Float32Array };
        const score = Array.from(tensor.data)[0];
        scored.push({ ...chunk, score: chunk.score * 0.3 + score * 0.7 });
      } catch {
        scored.push(chunk);
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // Heuristic rerank
  const qTerms = new Set(query.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  const scored = chunks.map((chunk) => {
    let score = chunk.score;
    const symLower = chunk.symbolName.toLowerCase();
    const pathLower = chunk.filePath.toLowerCase();
    const contentLower = chunk.content.toLowerCase();

    // Boost exact symbol match
    for (const term of qTerms) {
      if (symLower.includes(term)) score += 0.15;
      if (pathLower.includes(term)) score += 0.05;
    }

    // Penalty for long chunks
    const lines = chunk.endLine - chunk.startLine;
    if (lines > 100) score -= 0.05;
    if (lines > 300) score -= 0.1;

    // Penalty for generic-only content
    const words = contentLower.split(/\W+/);
    const genericCount = words.filter((w) => GENERIC_TERMS.has(w)).length;
    const totalWords = words.length || 1;
    if (genericCount / totalWords > 0.5) score -= 0.05;

    return { ...chunk, score: Math.max(0, score) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
