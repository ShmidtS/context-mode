---
name: context-mode
description: |
  Use context-mode tools (ctx_execute, ctx_execute_file) instead of Bash/cat when processing
  large outputs. Triggers: "analyze logs", "summarize output", "process data",
  "parse JSON", "filter results", "extract errors", "check build output",
  "analyze dependencies", "process API response", "large file analysis",
  "page snapshot", "browser snapshot", "DOM structure", "inspect page",
  "accessibility tree", "Playwright snapshot",
  "run tests", "test output", "coverage report", "git log", "recent commits",
  "diff between branches", "list containers", "pod status", "disk usage",
  "fetch docs", "API reference", "index documentation",
  "call API", "check response", "query results",
  "find TODOs", "count lines", "codebase statistics", "security audit",
  "outdated packages", "dependency tree", "cloud resources", "CI/CD output".
  Also triggers on ANY MCP tool output that may exceed 20 lines.
  Subagent routing is handled automatically via PreToolUse hook.
  Vault graph (wiki-links, backlinks, tag clusters, code dependencies) is active by default
  for the current project — use ctx_vault_graph to traverse relationships and ctx_graph_analyze
  for architectural insights. Auto-indexes on first access.
---

# Context Mode: Default for All Large Output

## MANDATORY RULE

Default to context-mode for ALL commands. Only use Bash for guaranteed-small-output operations.

Bash whitelist (safe to run directly):
- **File mutations**: `mkdir`, `mv`, `cp`, `rm`, `touch`, `chmod`
- **Git writes**: `git add`, `git commit`, `git push`, `git checkout`, `git branch`, `git merge`
- **Navigation**: `cd`, `pwd`, `which`
- **Process control**: `kill`, `pkill`
- **Package management**: `npm install`, `npm publish`, `pip install`
- **Simple output**: `echo`, `printf`

**Everything else -> `ctx_execute` or `ctx_execute_file`.** Any command that reads, queries, fetches, lists, logs, tests, builds, diffs, inspects, or calls an external service. This includes ALL CLIs (gh, aws, kubectl, docker, terraform, wrangler, fly, heroku, gcloud, etc.).

**When uncertain, use context-mode.** Every KB of unnecessary context reduces the quality and speed of the entire session.

## Decision Tree

```
About to run a command / read a file / call an API?
|
|-- Command is on the Bash whitelist (file mutations, git writes, navigation, echo)?
|   -- Use Bash
|
|-- Output MIGHT be large or you're UNSURE?
|   -- Use context-mode ctx_execute or ctx_execute_file
|
|-- Fetching web documentation or HTML page?
|   -- Use ctx_fetch_and_index -> ctx_search
|
|-- Using Playwright (navigate, snapshot, console, network)?
|   -- ALWAYS use filename parameter to save to file, then:
|       browser_snapshot(filename) -> ctx_index(path) or ctx_execute_file(path)
|       browser_console_messages(filename) -> ctx_execute_file(path)
|       browser_network_requests(filename) -> ctx_execute_file(path)
|       browser_navigate returns a snapshot automatically -- ignore it,
|         use browser_snapshot(filename) for any inspection.
|       Playwright MCP uses a SINGLE browser instance -- NOT parallel-safe.
|         For parallel browser ops, use agent-browser via ctx_execute instead.
|
|-- Using agent-browser (parallel-safe browser automation)?
|   -- Run via ctx_execute (shell) -- each call gets its own subprocess:
|       ctx_execute({ language: "shell", code: "agent-browser open example.com && agent-browser snapshot -i -c" })
|
|-- Exploring relationships between markdown notes, wiki-links, tags, or code dependencies?
|   -- Use ctx_vault_graph (neighbors, backlinks, tag-cluster, surprises, confidence-filter)
|      Project auto-indexes on first access; no manual ctx_vault_index needed for current project.
|      If graph is empty (no markdown notes with wiki-links or tags), fall back to ctx_search.
|   -- Use ctx_graph_analyze for god nodes, community hints, surprise connections, suggested questions.
|
|-- Processing output from another MCP tool (Context7, GitHub API, etc.)?
|   |-- Output already in context from a previous tool call?
|   |   -- Use it directly. Do NOT re-index with ctx_index(content: ...).
|   |-- Need to search the output multiple times?
|   |   -- Save to file via ctx_execute, then ctx_index(path) -> ctx_search
|   -- One-shot extraction?
|       -- Save to file via ctx_execute, then ctx_execute_file(path)
|
-- Reading a file to analyze/summarize (not edit)?
    -- Use ctx_execute_file (file loads into FILE_CONTENT, not context)
```

## When to Use Each Tool

| Situation | Tool | Example |
|-----------|------|---------|
| Hit an API endpoint | `ctx_execute` | `fetch('http://localhost:3000/api/orders')` |
| Run CLI that returns data | `ctx_execute` | `gh pr list`, `aws s3 ls`, `kubectl get pods` |
| Run tests | `ctx_execute` | `npm test`, `pytest`, `go test ./...` |
| Git operations | `ctx_execute` | `git log --oneline -50`, `git diff HEAD~5` |
| Docker/K8s inspection | `ctx_execute` | `docker stats --no-stream`, `kubectl describe pod` |
| Read a log file | `ctx_execute_file` | Parse access.log, error.log, build output |
| Read a data file | `ctx_execute_file` | Analyze CSV, JSON, YAML, XML |
| Read source code to analyze | `ctx_execute_file` | Count functions, find patterns, extract metrics |
| Fetch web docs | `ctx_fetch_and_index` | Index React/Next.js/Zod docs, then search |
| Playwright snapshot | `browser_snapshot(filename)` -> `ctx_index(path)` -> `ctx_search` | Save to file, index server-side, query |
| Playwright snapshot (one-shot) | `browser_snapshot(filename)` -> `ctx_execute_file(path)` | Save to file, extract in sandbox |
| Playwright console/network | `browser_*(filename)` -> `ctx_execute_file(path)` | Save to file, analyze in sandbox |
| MCP output (already in context) | Use directly | Don't re-index -- it's already loaded |
| MCP output (need multi-query) | `ctx_execute` to save -> `ctx_index(path)` -> `ctx_search` | Save to file first, index server-side |
| Wipe indexed KB content | `ctx_purge(confirm: true)` | Permanently deletes all indexed content |
| Explore note relationships / wiki-links | `ctx_vault_graph` | `ctx_vault_graph({mode:"neighbors", nodePath:"...", maxHops:2})` |
| Analyze knowledge graph structure | `ctx_graph_analyze` | `ctx_graph_analyze({godNodeLimit:10, surpriseLimit:10})` — returns god nodes, communities, surprising links with plain-English explanations, suggested questions, markdown report, and approximate token-reduction estimate. |
| Index external vault manually | `ctx_vault_index` | `ctx_vault_index({vaultPath:"/abs/path"})` — only for non-project vaults |

## Automatic Triggers

Use context-mode for ANY of these, without being asked:

1. **API debugging**: "hit endpoint", "call API", "check response"
2. **Log & test analysis**: "check logs", "what errors", "run tests", "test suite output"
3. **Git history**: "recent commits", "git log", "diff between branches"
4. **Data inspection & metrics**: "CSV", "JSON", "config", "count lines", "find TODOs"
5. **Infrastructure & builds**: "list containers", "check pods", "build project", "compile errors"
6. **Dependency audit**: "check dependencies", "outdated packages", "security audit"
7. **Web docs lookup**: "look up docs", "API reference", "fetch documentation"
8. **Knowledge graph exploration**: "related notes", "wiki-links", "backlinks", "tag cluster", "obsidian", "vault graph", "note dependencies", "code dependencies"

## Language Selection

| Situation | Language | Why |
|-----------|----------|-----|
| HTTP/API calls, JSON | `javascript` | Native fetch, JSON.parse, async/await |
| Data analysis, CSV, stats | `python` | csv, statistics, collections, re |
| Shell commands with pipes | `shell` | grep, awk, jq, native tools |
| File pattern matching | `shell` | find, wc, sort, uniq |

## Search Query Strategy

- BM25 uses **OR semantics** -- results matching more terms rank higher automatically
- Use 2-4 specific technical terms per query
- **Always use `source` parameter** when multiple docs are indexed to avoid cross-source contamination
  - Partial match works: `source: "Node"` matches `"Node.js v22 CHANGELOG"`
- **Always use `queries` array** -- batch ALL search questions in ONE call:
  - `ctx_search(queries: ["transform pipe", "refine superRefine", "coerce codec"], source: "Zod")`
  - NEVER make multiple separate ctx_search() calls -- put all queries in one array

## Critical Rules

1. **Print analyzed findings, not raw data.** stdout is all that enters context. No output = wasted call. Don't `console.log(JSON.stringify(data))` -- analyze first.
2. **Be specific.** Bug IDs, line numbers, exact values -- not just counts.
3. **For EDIT: use Read tool.** context-mode is for analysis, not editing.
4. **Bash whitelist only.** File mutations, git writes, navigation, echo. Everything else -> context-mode.
5. **Never `ctx_index(content: large_data)`.** Use `ctx_index(path: ...)` to read server-side. The `content` parameter sends data through context.
6. **Always use `filename` on Playwright.** `browser_snapshot`, `browser_console_messages`, `browser_network_requests` -- without it, output floods context.
7. **Don't re-index data already in context.** If an MCP tool returned data, use it directly or save to file first.
8. **Vault auto-indexes on first use.** `ctx_vault_graph` and `ctx_graph_analyze` automatically index the current project directory when first called in a session. No need to call `ctx_vault_index` for the current project.
9. **Empty vault -> fall back to `ctx_search`.** If the project has no markdown notes with wiki-links or tags, `ctx_vault_graph` returns empty results. Use `ctx_search` for code-level queries instead.

## Platform-Specific Skills

Context-mode integrates with multiple AI coding platforms via hooks. For platform-specific hook configuration, capabilities, and integration details, see:

- [Claude Code](./SKILL-claude.md) -- Full hook support: PreToolUse, PostToolUse, PreCompact, SessionStart, UserPromptSubmit
- [Codex CLI](./SKILL-codex.md) -- JSON stdin/stdout hooks, TOML config, limited arg modification
- [Cursor](./SKILL-cursor.md) -- Native hooks with lower-camel names, project-scoped config
- [Gemini CLI](./SKILL-gemini.md) -- BeforeTool/AfterTool hooks, advisory PreCompress
- [VS Code Copilot](./SKILL-copilot.md) -- Extension-based, .github scoped hooks

## Reference Files

- [JavaScript/TypeScript Patterns](./references/patterns-javascript.md)
- [Python Patterns](./references/patterns-python.md)
- [Shell Patterns](./references/patterns-shell.md)
- [Anti-Patterns & Common Mistakes](./references/anti-patterns.md)
