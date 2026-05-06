/**
 * Embedding provider abstraction for semantic search.
 *
 * Defines the EmbeddingProvider interface and ships an Ollama-based
 * implementation that calls the /api/embeddings endpoint. An ONNX
 * stub is provided for future local-inference support.
 */

const DEBUG = process.env.DEBUG?.includes('context-mode')

// ─────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  readonly name: string
  readonly dimensions: number
  embed(text: string): Promise<Float32Array | null>
}

// ─────────────────────────────────────────────────────────
// Ollama provider
// ─────────────────────────────────────────────────────────

const MODEL_DIMS: Record<string, number> = {
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'all-minilm-l6-v2': 384,
  'snowflake-arctic-embed': 768,
  'snowflake-arctic-embed-l': 1024,
}

export class OllamaProvider implements EmbeddingProvider {
  readonly name: string
  readonly dimensions: number
  readonly #host: string
  readonly #apiKey?: string

  constructor(model = 'nomic-embed-text', host = 'http://localhost:11434', dimensions?: number, apiKey?: string) {
    this.name = model
    this.#host = host
    this.dimensions = dimensions ?? MODEL_DIMS[model] ?? 768
    this.#apiKey = apiKey
  }

  async embed(text: string): Promise<Float32Array | null> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.#apiKey) headers['Authorization'] = `Bearer ${this.#apiKey}`
      const res = await fetch(`${this.#host}/api/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.name, prompt: text }),
      })
      if (!res.ok) {
        if (DEBUG) process.stderr.write(`[ctx] Ollama embed HTTP ${res.status}\n`)
        return null
      }
      const json = await res.json() as { embedding?: number[] }
      const arr = json.embedding
      if (!arr || !Array.isArray(arr) || arr.length === 0) {
        if (DEBUG) process.stderr.write('[ctx] Ollama embed returned empty embedding\n')
        return null
      }
      return new Float32Array(arr)
    } catch (e) {
      if (DEBUG) process.stderr.write(`[ctx] Ollama embed failed: ${e}\n`)
      return null
    }
  }
}

// ─────────────────────────────────────────────────────────
// ONNX provider (stub)
// ─────────────────────────────────────────────────────────

export class ONNXProvider implements EmbeddingProvider {
  readonly name: string
  readonly dimensions: number
  readonly #modelPath: string

  constructor(modelPath: string) {
    this.#modelPath = modelPath
    this.name = 'onnx-local'
    this.dimensions = 0
  }

  async embed(_text: string): Promise<Float32Array | null> {
    throw new Error('ONNX provider not yet implemented')
  }
}

// ─────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────

export function createEmbeddingProvider(
  type: 'ollama' | 'onnx',
  config?: Record<string, unknown>,
): EmbeddingProvider | null {
  if (type === 'ollama') {
    return new OllamaProvider(
      (config?.model as string) ?? undefined,
      (config?.host as string) ?? undefined,
      (config?.dimensions as number) ?? undefined,
      (config?.apiKey as string) ?? undefined,
    )
  }
  if (type === 'onnx') {
    if (!config?.modelPath) return null
    return new ONNXProvider(config.modelPath as string)
  }
  return null
}
