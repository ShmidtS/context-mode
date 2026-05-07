/**
 * types — Shared type definitions for context-mode packages.
 *
 * Contains interfaces that are genuinely shared between the core (ContentStore,
 * PolyglotExecutor) and the session domain (SessionDB, event extraction).
 * Import from "./types.js".
 */

// ─────────────────────────────────────────────────────────
// Session event types
// ─────────────────────────────────────────────────────────

/** Tool call representation used during event extraction from Claude messages. */
export interface ToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse?: string;
  isError?: boolean;
}

/** User message representation used during event extraction. */
export interface UserMessage {
  content: string;
  timestamp?: string;
}

/**
 * Session event as stored in SessionDB.
 * Each event captures a discrete unit of session activity (tool use, user
 * message, assistant response summary, etc.) for later resume-snapshot
 * reconstruction.
 */
export type EventCategory =
  | "file" | "rule" | "cwd" | "error" | "git" | "task" | "plan"
  | "env" | "skill" | "constraint" | "subagent" | "mcp" | "mcp_tool_call"
  | "decision" | "agent-finding" | "external-ref" | "blocked-on" | "data"
  | "error-resolution" | "iteration-loop" | "intent" | "role"
  | "prompt" | "user-prompt" | "openclaw" | "pi"
  | "tool" | "config" | "test" | "compaction" | "rejected-approach" | "session-resume"
  | "status" | "deploy" | "log"
  | "latency" | "permission";

export interface SessionEvent {
  type: string;
  category: EventCategory;
  data: string;
  priority: number;
  data_hash: string;
  /**
   * Best-effort project attribution for this event.
   * Empty string means unattributed/unknown.
   */
  project_dir?: string;
  attribution_source?: string;
  /** 0..1 confidence score for project attribution. */
  attribution_confidence?: number;
}

// ─────────────────────────────────────────────────────────
// Execution result
// ─────────────────────────────────────────────────────────

/**
 * Result returned by PolyglotExecutor after running a code snippet.
 * Shared here so SessionDB can record execution outcomes without importing
 * the full executor module.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** Process was detached and continues running in the background. */
  backgrounded?: boolean;
}

// ─────────────────────────────────────────────────────────
// Content store shared types
// ─────────────────────────────────────────────────────────

/**
 * Result returned after indexing content into the knowledge base.
 * Shared so session tooling can record what was indexed without importing
 * ContentStore.
 */
export interface IndexResult {
  sourceId: number;
  label: string;
  totalChunks: number;
  codeChunks: number;
}

/**
 * A single search result returned from FTS5 BM25-ranked lookup.
 * Shared for consumers that display or log results outside of ContentStore.
 */
export interface SearchResult {
  title: string;
  content: string;
  source: string;
  rank: number;
  contentType: "code" | "prose";
  matchLayer?: "porter" | "trigram" | "fuzzy" | "rrf" | "rrf-fuzzy" | "rrf-3way" | "semantic" | "hybrid";
  highlighted?: string;
  timestamp?: string;
}

/**
 * Aggregate statistics for a ContentStore instance.
 */
export interface StoreStats {
  sources: number;
  chunks: number;
  codeChunks: number;
}

// ─────────────────────────────────────────────────────────
// Resume snapshot
// ─────────────────────────────────────────────────────────

/**
 * Structured representation of a session resume snapshot, suitable for
 * injecting into a new conversation as context. Generated from stored
 * SessionEvents by the snapshot builder.
 */
export interface ResumeSnapshot {
  /** ISO-8601 timestamp of when the snapshot was generated. */
  generatedAt: string;
  /** Human-readable summary of the session to this point. */
  summary: string;
  /** Ordered list of events selected for the snapshot (priority-filtered). */
  events: SessionEvent[];
}

// ─────────────────────────────────────────────────────────
// Priority constants
// ─────────────────────────────────────────────────────────

/**
 * Priority levels for SessionEvent records. Higher numbers are more important
 * and are retained when the snapshot budget is tight.
 */
export const EventPriority = {
  LOW: 1,
  NORMAL: 2,
  HIGH: 3,
  CRITICAL: 4,
} as const;

export type EventPriorityLevel = (typeof EventPriority)[keyof typeof EventPriority];

// ─────────────────────────────────────────────────────────
// Vault graph types
// ─────────────────────────────────────────────────────────

/**
 * A node representing an Obsidian note in the vault graph.
 */
export interface VaultNode {
  id: number;
  vault_path: string;
  note_path: string;
  title: string;
  frontmatter: string | null;
  content_hash: string;
  file_mtime: number;
  out_degree: number;
  in_degree: number;
  source_id: number | null;
  indexed_at: string;
  source_type: string;
  connector_meta: string | null;
}

/**
 * A directed edge between two vault nodes (e.g. wikilink).
 */
export interface VaultEdge {
  id: number;
  source_id: number;
  target_id: number | null;
  target_name: string;
  alias: string | null;
  line_number: number | null;
  context: string | null;
  edge_type: string;
}

/**
 * A tag associated with a vault node.
 */
export interface VaultTag {
  id: number;
  tag: string;
  node_id: number;
}

/**
 * A frontmatter key-value pair on a vault node.
 */
export interface VaultFrontmatterKey {
  id: number;
  node_id: number;
  key: string;
  value: string;
}

/**
 * Persisted configuration for a registered Obsidian vault.
 */
export interface VaultConfig {
  vaultPath: string;
  lastIndexedAt: string;
  noteCount: number;
  edgeCount: number;
}

// ─────────────────────────────────────────────────────────
// AST symbol types (Phase 1A — ContextStream + CodeGraphContext)
// ─────────────────────────────────────────────────────────

/**
 * A code symbol extracted by tree-sitter AST walking.
 * Represents a named declaration: function, class, method, interface, etc.
 */
export interface CodeSymbol {
  name: string
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'constant'
  scope?: string
  byteStart: number
  byteEnd: number
  lineStart: number
  lineEnd: number
  contentHash: string
}

/**
 * A chunk produced by symbol-boundary chunking.
 * Each chunk corresponds to one CodeSymbol's source text.
 */
export interface AstChunk {
  title: string
  content: string
  contentType: 'code'
  metadata: {
    symbolName: string
    symbolKind: string
    scope?: string
    byteStart: number
    byteEnd: number
    lineStart: number
    lineEnd: number
    contentHash: string
  }
}

/**
 * Result from vector similarity search over code symbols.
 * Placeholder for future embedding-based retrieval.
 */
export interface VectorSearchResult {
  nodeId: number
  symbolId?: number
  similarity: number
  score: number
}

/**
 * Result from graph-aware search over vault nodes.
 * Uses in_degree (not PageRank) as the authority signal in v1.
 */
export interface GraphSearchResult {
  id: number;
  title: string;
  path: string;
  hopDistance?: number;
  textRank?: number;
  fusionScore?: number;
  pageRank?: number;
  frontmatter?: Record<string, string>;
  tags?: string[];
  backlinkCount?: number;
  snippet?: string;
  matchLayer?: "bfs" | "backlinks" | "tag-cluster" | "rrf-graph";
  source?: string;
  origin?: "vault-graph";
}
