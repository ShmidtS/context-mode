# context-mode

Raw tool output floods context window. Use context-mode MCP tools to keep raw data in sandbox.

## Think in Code — MANDATORY

Analyze/count/filter/compare/search/parse/transform data: **write code** via `ctx_execute(language, code)`, `console.log()` only the answer. Do NOT read raw data into context. PROGRAM the analysis, not COMPUTE it. Pure JavaScript — Node.js built-ins only (`fs`, `path`, `child_process`). `try/catch`, handle `null`/`undefined`. One script replaces ten tool calls.

## Tool Selection

1. **GATHER**: `ctx_batch_execute(commands, queries)` — runs all commands, auto-indexes, searches. ONE call replaces many steps.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — all follow-up questions, ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — sandbox, only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url)` then `ctx_search(queries)` — never dump raw HTML.
5. **VAULT GRAPH**: `ctx_vault_index(vaultPath)` + `ctx_vault_graph(mode, nodePath|tag)` — index Obsidian vault or project directory, then traverse the graph (neighbors, backlinks, tag-cluster).

## Vault Graph Tools

When working with a knowledge base of markdown notes (or any project directory containing `.md` files):

- **Index first**: `ctx_vault_index({ vaultPath: "absolute/path/to/vault" })` — builds a graph of notes, wiki-links `[[...]]`, tags `#tag`, and frontmatter.
- **Query after indexing**:
  - `ctx_vault_graph({ mode: "neighbors", nodePath: "Note.md", limit: 10 })` — BFS outward from a note up to 3 hops.
  - `ctx_vault_graph({ mode: "backlinks", nodePath: "Note.md", limit: 10 })` — notes that link TO this note.
  - `ctx_vault_graph({ mode: "tag-cluster", tag: "security", limit: 10 })` — all notes with tag + 1-hop neighbors.

Use vault graph when the user asks about relationships between notes, finding related topics, or exploring a knowledge base. Prefer `ctx_search` for code-level queries; vault graph is for markdown document relationships.

## Rules

- DO NOT use Bash for >20 lines output — use `ctx_execute` or `ctx_batch_execute`.
- DO NOT use Read for analysis — use `ctx_execute_file`. Read IS correct for Edit.
- DO NOT use WebFetch — use `ctx_fetch_and_index`.
- DO NOT use curl/wget in Bash — use `ctx_execute` or `ctx_fetch_and_index`.
- Bash ONLY for git, mkdir, rm, mv, navigation, short commands.

## Output

Terse like caveman. Technical substance exact. Only fluff die.
Drop: articles, filler (just/really/basically), pleasantries, hedging. Fragments OK. Short synonyms. Code unchanged.
Pattern: [thing] [action] [reason]. [next step]. Auto-expand for: security warnings, irreversible actions, user confusion.
Write artifacts to FILES — never inline. Return: file path + 1-line description.
