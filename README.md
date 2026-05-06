# Context Mode

**The other half of the context problem.**

[![users](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2FShmidtS%2Fcontext-mode%40main%2Fstats.json&query=%24.message&label=users&color=brightgreen)](https://www.npmjs.com/package/context-mode) [![npm](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2FShmidtS%2Fcontext-mode%40main%2Fstats.json&query=%24.npm&label=npm&color=blue)](https://www.npmjs.com/package/context-mode) [![marketplace](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2FShmidtS%2Fcontext-mode%40main%2Fstats.json&query=%24.marketplace&label=marketplace&color=blue)](https://github.com/ShmidtS/context-mode) [![GitHub stars](https://img.shields.io/github/stars/ShmidtS/context-mode?style=flat&color=yellow)](https://github.com/ShmidtS/context-mode/stargazers) [![GitHub forks](https://img.shields.io/github/forks/ShmidtS/context-mode?style=flat&color=blue)](https://github.com/ShmidtS/context-mode/network/members) [![Last commit](https://img.shields.io/github/last-commit/ShmidtS/context-mode?color=green)](https://github.com/ShmidtS/context-mode/commits) [![License: ELv2](https://img.shields.io/badge/License-ELv2-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/discord/1478479412700909750?label=Discord&logo=discord&color=5865f2)](https://discord.gg/DCN9jUgN5v)
[![Hacker News #1](https://img.shields.io/badge/Hacker%20News-%231%20%E2%80%A2%20570%2B%20points-ff6600?logo=ycombinator&logoColor=white)](https://news.ycombinator.com/item?id=47193064)

## The Problem

Every MCP tool call dumps raw data into your context window. A Playwright snapshot costs 56 KB. Twenty GitHub issues cost 59 KB. One access log — 45 KB. After 30 minutes, 40% of your context is gone. And when the agent compacts the conversation to free space, it forgets which files it was editing, what tasks are in progress, and what you last asked for.

### How Context Mode Solves It

1. **Context Saving** — Sandbox tools keep raw data out of the context window. 315 KB becomes 5.4 KB. 98% reduction.
2. **Session Continuity** — Every file edit, git operation, task, error, and user decision is tracked in SQLite. When the conversation compacts, context-mode doesn't dump this data back into context — it indexes events into FTS5 and retrieves only what's relevant via BM25 search. The model picks up exactly where you left off.
3. **Think in Code** — The LLM should program the analysis, not compute it. One script replaces ten tool calls and saves 100x context.
4. **Output Compression** — Terse like caveman. Technical substance exact. Only fluff die. ~65-75% output token reduction.

## Install

**Claude Code** (marketplace, fully automatic):

```bash
/plugin marketplace add ShmidtS/context-mode
/plugin install context-mode@context-mode
```

**All platforms** (from source):

```bash
git clone https://github.com/ShmidtS/context-mode.git
cd context-mode && npm install && npm run build
```

Then link the binary or use `node ./start.mjs` as the MCP server command.

See [docs/platform-support.md](docs/platform-support.md) for platform-specific setup (Cursor, Copilot, Gemini CLI, Codex, OpenCode, Zed, and 8 more).

## Tools

| Tool | What it does |
|---|---|
| `ctx_batch_execute` | Run multiple commands + search multiple queries in ONE call. |
| `ctx_execute` | Run code in 11 languages. Only stdout enters context. |
| `ctx_execute_file` | Process files in sandbox. Raw content never leaves. |
| `ctx_index` | Chunk markdown into FTS5 with BM25 ranking. |
| `ctx_search` | Query indexed content with multiple queries in one call. |
| `ctx_fetch_and_index` | Fetch URL, chunk and index. 24h TTL cache. |
| `ctx_stats` | Show context savings, call counts, and session statistics. |
| `ctx_doctor` | Diagnose installation: runtimes, hooks, FTS5, versions. |
| `ctx_upgrade` | Upgrade to latest version from GitHub, rebuild, reconfigure hooks. |
| `ctx_purge` | Permanently deletes all indexed content from the knowledge base. |

**Utility commands** (type in any AI session or terminal):

```
ctx stats       → context savings, call counts, session report
ctx doctor      → diagnose runtimes, hooks, FTS5, versions
ctx upgrade     → update from GitHub, rebuild, reconfigure hooks
ctx purge       → permanently delete all indexed content
ctx insight     → personal analytics dashboard (opens local web UI)
```

## How It Works

**Sandbox** — Each `ctx_execute` call spawns an isolated subprocess. Scripts can't access each other's memory or state. Eleven language runtimes are available: JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, and Elixir. Bun is auto-detected for 3-5x faster JS/TS execution.

**Knowledge Base** — The `ctx_index` tool chunks markdown content by headings while keeping code blocks intact, then stores them in a **SQLite FTS5** virtual table. Search uses **BM25 ranking** with Porter stemming and trigram substring matching merged via Reciprocal Rank Fusion (RRF). A 24-hour TTL cache avoids re-fetching URLs. 14-day auto-cleanup keeps the database lean.

**Session Continuity** — When the context window fills up, the agent compacts the conversation — dropping older messages to make room. Context Mode captures every meaningful event during your session and persists them in a per-project SQLite database. When the conversation compacts (or you resume with `--continue`), your working state is rebuilt automatically — the model continues from your last prompt without asking you to repeat anything.

## Security

Context Mode enforces the same permission rules you already use — but extends them to the MCP sandbox. If you block `sudo`, it's also blocked inside `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute`.

Zero setup required. If you haven't configured any permissions, nothing changes. This only activates when you add rules.

```json
{
  "permissions": {
    "deny": [
      "Bash(sudo *)",
      "Bash(rm -rf /*)",
      "Read(.env)",
      "Read(*/.env*)"
    ],
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)"
    ]
  }
}
```

Add this to your project's `.claude/settings.json` (or `~/.claude/settings.json` for global rules). All platforms read security policies from Claude Code's settings format.

`ctx_fetch_and_index` blocks dangerous URL targets by default (cloud metadata, link-local, multicast, non-HTTP schemes). Set `CTX_FETCH_STRICT=1` to also block loopback and RFC1918 ranges. Tool input for any `mcp__*` tool call is redacted before persistence — keys matching `authorization`, `token`, `secret`, `password`, `api_key`, `cookie`, `signature`, `private_key` get masked to `[REDACTED]`.

## Benchmarks

| Scenario | Raw | Context | Saved |
|---|---|---|---|
| Playwright snapshot | 56.2 KB | 299 B | 99% |
| GitHub Issues (20) | 58.9 KB | 1.1 KB | 98% |
| Access log (500 requests) | 45.1 KB | 155 B | 100% |
| Context7 React docs | 5.9 KB | 261 B | 96% |
| Analytics CSV (500 rows) | 85.5 KB | 222 B | 100% |
| Git log (153 commits) | 11.6 KB | 107 B | 99% |
| Test output (30 suites) | 6.0 KB | 337 B | 95% |
| Repo research (subagent) | 986 KB | 62 KB | 94% |

Over a full session: 315 KB of raw output becomes 5.4 KB. Session time extends from ~30 minutes to ~3 hours.

[Full benchmark data with 21 scenarios →](BENCHMARK.md)

## Privacy & Architecture

Context Mode is not a CLI output filter or a cloud analytics dashboard. It operates at the MCP protocol layer — raw data stays in a sandboxed subprocess and never enters your context window.

**Nothing leaves your machine.** No telemetry, no cloud sync, no usage tracking, no account required. Your code, your prompts, your session data — all local. The SQLite databases live in your home directory and die when you're done.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and TDD guidelines.

```bash
git clone https://github.com/ShmidtS/context-mode.git
cd context-mode && npm install && npm test
```

## License

Licensed under [Elastic License 2.0](LICENSE) (source-available).
