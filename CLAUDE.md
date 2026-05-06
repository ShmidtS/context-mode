# context-mode

Raw tool output floods context window. Use context-mode MCP tools to keep raw data in sandbox.

## Think in Code

Analyze/count/filter/compare/search/parse/transform data: **write code** via `ctx_execute(language, code)`, `console.log()` only the answer. Do NOT read raw data into context. One script replaces ten tool calls.

## Build & Test

| Command | Purpose |
|---------|---------|
| `npm run build` | TypeScript + esbuild bundle |
| `npm run dev` | Dev server via tsx |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest run |
| `npm run benchmark` | `tests/benchmark.ts` |

## Vault Graph

- `ctx_vault_index({ vaultPath })` — builds graph of notes, wiki-links, tags, frontmatter.
- `ctx_vault_graph({ mode, nodePath|tag, limit })` — modes: `neighbors` (BFS), `backlinks` (reverse), `tag-cluster`.

Prefer `ctx_search` for code queries; vault graph for markdown document relationships.

For tool selection, decision trees, and critical rules see [context-mode skill](skills/context-mode/SKILL.md).
