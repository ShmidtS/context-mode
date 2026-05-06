# Context Mode

**The other half of the context problem.**

[![users](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2FShmidtS%2Fcontext-mode%40main%2Fstats.json&query=%24.message&label=users&color=brightgreen)](https://www.npmjs.com/package/context-mode) [![npm](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2FShmidtS%2Fcontext-mode%40main%2Fstats.json&query=%24.npm&label=npm&color=blue)](https://www.npmjs.com/package/context-mode) [![marketplace](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2FShmidtS%2Fcontext-mode%40main%2Fstats.json&query=%24.marketplace&label=marketplace&color=blue)](https://github.com/ShmidtS/context-mode) [![GitHub stars](https://img.shields.io/github/stars/ShmidtS/context-mode?style=flat&color=yellow)](https://github.com/ShmidtS/context-mode/stargazers) [![GitHub forks](https://img.shields.io/github/forks/ShmidtS/context-mode?style=flat&color=blue)](https://github.com/ShmidtS/context-mode/network/members) [![Last commit](https://img.shields.io/github/last-commit/ShmidtS/context-mode?color=green)](https://github.com/ShmidtS/context-mode/commits) [![License: ELv2](https://img.shields.io/badge/License-ELv2-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/discord/1478479412700909750?label=Discord&logo=discord&color=5865f2)](https://discord.gg/DCN9jUgN5v)
[![Hacker News #1](https://img.shields.io/badge/Hacker%20News-%231%20%E2%80%A2%20570%2B%20points-ff6600?logo=ycombinator&logoColor=white)](https://news.ycombinator.com/item?id=47193064)

## Features

1. **Context Saving** — Sandbox tools keep raw data out of context. 315 KB becomes 5.4 KB (98%).
2. **Session Continuity** — Tracks every edit, git op, task, error in SQLite. Rebuilds state on compact/resume.
3. **Think in Code** — Program the analysis, not compute it. One script replaces ten tool calls.
4. **Output Compression** — Terse output. ~65-75% token reduction.

## Install

**Claude Code** (marketplace):

```bash
/plugin marketplace add ShmidtS/context-mode
/plugin install context-mode@context-mode
```

**All platforms** (from source):

```bash
git clone https://github.com/ShmidtS/context-mode.git
cd context-mode && npm install && npm run build
```

See [platform-specific setup](docs/platform-support.md) (Cursor, Copilot, Gemini CLI, Codex, OpenCode, Zed, and 8 more).

## Tools

| Tool | Purpose |
|------|---------|
| `ctx_batch_execute` | Run commands + search queries in one call |
| `ctx_execute` | Run code in 11 languages (sandbox) |
| `ctx_execute_file` | Process files in sandbox |
| `ctx_search` | Query indexed content (BM25) |
| `ctx_index` | Chunk markdown into FTS5 |
| `ctx_fetch_and_index` | Fetch URL, index, 24h cache |
| `ctx_doctor` | Diagnose installation |

Utility commands: `ctx stats`, `ctx upgrade`, `ctx purge`, `ctx insight`.

## How It Works

- **Sandbox** — Isolated subprocess per `ctx_execute`. 11 runtimes (JS, TS, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, Elixir).
- **Knowledge Base** — FTS5 BM25 with Porter stemming + trigram matching via RRF. 14-day auto-cleanup.
- **Session Continuity** — Per-project SQLite DB. Compacts and resumes without repeating context.

## Security

Enforces your existing permission rules in the sandbox. Block `sudo` -> also blocked inside `ctx_execute`. Add rules to `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Bash(sudo *)", "Bash(rm -rf /*)", "Read(.env)", "Read(*/.env*)"],
    "allow": ["Bash(git:*)", "Bash(npm:*)"]
  }
}
```

`ctx_fetch_and_index` blocks dangerous URL targets by default. Tool input redacts keys matching `authorization`, `token`, `secret`, `password`, `api_key`.

## Benchmarks

Over a full session: 315 KB raw -> 5.4 KB context. 94% more context available for problem solving.

[Full 21-scenario benchmark ->](BENCHMARK.md)

## Privacy

Not a cloud service. MCP protocol layer — raw data stays in sandboxed subprocess. No telemetry, no cloud sync, no account. SQLite databases live locally and die when you're done.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and TDD guidelines.

```bash
git clone https://github.com/ShmidtS/context-mode.git
cd context-mode && npm install && npm test
```

## License

Licensed under [Elastic License 2.0](LICENSE) (source-available).
