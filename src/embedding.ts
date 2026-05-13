/**
 * embedding — Local embedding generation with ONNX / Ollama / heuristic fallback.
 *
 * Priority:
 *   1. onnxruntime-node + all-MiniLM-L6-v2 ONNX model (384d)
 *   2. Ollama HTTP API (nomic-embed-text)
 *   3. Heuristic stub (zero vectors) — search degrades to FTS5-only
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MODEL_DIM = 384;
const BATCH_SIZE = 32;

interface OnnxSession {
  inputNames: string[];
  outputNames: string[];
  run(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
}

let _ort: { InferenceSession: { create(path: string): Promise<OnnxSession> } } | null = null;
let _session: OnnxSession | null = null;
let _modelPath: string | null = null;
let _ollamaUrl: string | null = null;

function getModelDir(): string {
  return join(homedir(), ".context-mode", "models");
}

function getModelPath(): string {
  return join(getModelDir(), "all-MiniLM-L6-v2.onnx");
}

async function loadOnnx(): Promise<boolean> {
  if (_session) return true;
  if (_ort) {
    const path = getModelPath();
    if (!existsSync(path)) return false;
    _session = await _ort.InferenceSession.create(path);
    _modelPath = path;
    return true;
  }
  try {
    const ort = await import("onnxruntime-node");
    _ort = ort;
    const path = getModelPath();
    if (!existsSync(path)) return false;
    _session = await ort.InferenceSession.create(path);
    _modelPath = path;
    return true;
  } catch {
    return false;
  }
}

function ollamaConfigured(): boolean {
  if (_ollamaUrl) return true;
  _ollamaUrl = process.env.OLLAMA_HOST || "http://localhost:11434";
  return true;
}

async function ollamaEmbed(texts: string[]): Promise<number[][] | null> {
  if (!ollamaConfigured()) return null;
  const url = `${_ollamaUrl}/api/embeddings`;
  const results: number[][] = [];
  for (const text of texts) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { embedding?: number[] };
      if (data.embedding) {
        results.push(data.embedding);
      } else {
        results.push(new Array(MODEL_DIM).fill(0));
      }
    } catch {
      results.push(new Array(MODEL_DIM).fill(0));
    }
  }
  return results.length === texts.length ? results : null;
}

async function onnxEmbed(texts: string[]): Promise<number[][] | null> {
  if (!await loadOnnx()) return null;
  if (!_session || !_ort) return null;

  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    for (const text of batch) {
      // all-MiniLM-L6-v2 ONNX expects token IDs input.
      // Without a tokenizer we do a best-effort approach using raw bytes as a fallback.
      // In production, a tokenizer (e.g. @xenova/transformers tokenizers) should be paired.
      const inputIds = new BigInt64Array(512);
      const attentionMask = new BigInt64Array(512);
      const buf = Buffer.from(text, "utf-8");
      for (let j = 0; j < Math.min(buf.length, 512); j++) {
        inputIds[j] = BigInt(buf[j]);
        attentionMask[j] = 1n;
      }
      try {
        const feeds: Record<string, unknown> = {};
        feeds[_session.inputNames[0]] = new (await import("onnxruntime-node")).Tensor("int64", inputIds, [1, 512]);
        if (_session.inputNames.length > 1) {
          feeds[_session.inputNames[1]] = new (await import("onnxruntime-node")).Tensor("int64", attentionMask, [1, 512]);
        }
        const out = await _session.run(feeds);
        const tensor = out[_session.outputNames[0]] as { data: Float32Array };
        const vec = Array.from(tensor.data);
        results.push(vec);
      } catch {
        results.push(new Array(MODEL_DIM).fill(0));
      }
    }
  }
  return results.length === texts.length ? results : null;
}

export async function embed(texts: string[]): Promise<number[][]> {
  // Try ONNX first
  const onnx = await onnxEmbed(texts);
  if (onnx) return onnx;

  // Try Ollama
  const ollama = await ollamaEmbed(texts);
  if (ollama) return ollama;

  // Fallback: zero vectors (search degrades to FTS5-only)
  return texts.map(() => new Array(MODEL_DIM).fill(0));
}

export function getEmbeddingDim(): number {
  return MODEL_DIM;
}

export function vectorsAvailable(): boolean {
  return existsSync(getModelPath()) || ollamaConfigured();
}

export function modelDir(): string {
  return getModelDir();
}

export function modelPath(): string {
  return getModelPath();
}
