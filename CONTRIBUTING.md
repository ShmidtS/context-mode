# Contributing to context-mode

Licensed under Elastic License 2.0. Every issue, PR, and idea matters. Don't overthink it — just send it.

## Architecture Overview

Flat `src/` structure:

```
src/
  server.ts        → MCP server, tool handlers
  store.ts         → FTS5 content store
  executor.ts      → Polyglot code executor
  security.ts      → Permission enforcement
  runtime.ts       → Runtime detection
  cli.ts           → CLI commands
  session/         → Event storage, extractors, snapshots
  adapters/        → 12 platform adapters
hooks/             → Plain JS hooks (no build needed)
configs/           → Per-platform install files
```

`tsc` compiles `src/` → `build/`. `start.mjs` loads `server.bundle.mjs` (CI-built) if present, otherwise falls back to `build/server.js`.

> **Critical:** Delete `server.bundle.mjs` in your local clone or `build/server.js` changes won't load:
> ```bash
> rm server.bundle.mjs
> ```

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- Node.js 20+ or [Bun](https://bun.sh/)
- context-mode plugin installed via marketplace

## Local Development Setup

```bash
git clone https://github.com/ShmidtS/context-mode.git
cd context-mode
npm install
npm run build
```

**Symlink the cache** so Claude Code loads your local clone instead of the marketplace version:

```bash
ls ~/.claude/plugins/cache/context-mode/context-mode/
# Replace 0.9.23 with your actual version
mv ~/.claude/plugins/cache/context-mode/context-mode/0.9.23 \
   ~/.claude/plugins/cache/context-mode/context-mode/0.9.23.bak
ln -s /path/to/your/clone/context-mode \
   ~/.claude/plugins/cache/context-mode/context-mode/0.9.23
```

Override PreToolUse in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Read|Grep|WebFetch|Agent|mcp__plugin_context-mode_context-mode__ctx_execute|mcp__plugin_context-mode_context-mode__ctx_execute_file|mcp__plugin_context-mode_context-mode__ctx_batch_execute",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/your/clone/context-mode/hooks/pretooluse.mjs"
          }
        ]
      }
    ]
  }
}
```

> Do NOT add PostToolUse, PreCompact, SessionStart, or UserPromptSubmit to `settings.json` — they are already registered in `hooks.json` via the symlink. Adding them to both causes double invocations and SQLite locking errors.

Bump version in `package.json`, `src/server.ts`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`, then `npm run build`. Run `/context-mode:ctx-doctor` to verify.

To restore the marketplace version, remove the symlink and restore the backup.

## Development Workflow

| Command | Purpose |
|---|---|
| `npm run build` | TypeScript compilation |
| `npm test` | Run all tests (Vitest, parallel) |
| `npm run typecheck` | Type checking only |
| `npm run test:watch` | Watch mode |

**What needs rebuild?**

| Changed | Rebuild? |
|---|---|
| `hooks/*.mjs` | No |
| `src/*.ts` | Yes |
| `src/session/*.ts` | Yes |
| `src/adapters/**/*.ts` | Yes |
| `configs/*` | No |

## TDD Workflow

Red → Green → Refactor.

1. Write a failing test in the existing file that covers your domain. Do NOT create new test files.
2. Write the minimum code to make it pass.
3. Refactor while keeping tests green.

| Domain | Test File |
|---|---|
| Adapters | `tests/adapters/<platform>.test.ts` |
| Search & FTS5 | `tests/core/search.test.ts` |
| Server & tools | `tests/core/server.test.ts` |
| CLI & bundle | `tests/core/cli.test.ts` |
| Session DB | `tests/session/session-db.test.ts` |
| Session extract | `tests/session/session-extract.test.ts` |
| Session snapshot | `tests/session/session-snapshot.test.ts` |
| Executor | `tests/executor.test.ts` |
| Store/Search | `tests/store.test.ts` |
| Security | `tests/security.test.ts` |

If your change doesn't fit any existing file, discuss with the maintainer before creating a new one.

## Submitting a Pull Request

1. Fork the repository
2. Create a feature branch from `next`
3. Follow the local development setup above
4. Write tests first (TDD)
5. Run `npm test` and `npm run typecheck`
6. Test in a live Claude Code session
7. Compare output quality before/after
8. Open a PR using the template

## Quick Reference

| Task | Command |
|---|---|
| Check version | `/context-mode:ctx-doctor` |
| Upgrade plugin | `/context-mode:ctx-upgrade` |
| View session stats | `/context-mode:ctx-stats` |
| Purge knowledge base | `/context-mode:ctx-purge` |
| Run diagnostics | `bash scripts/ctx-debug.sh` |
| Rebuild after changes | `npm run build` |
| Run all tests | `npm test` |
| Watch mode | `npm run test:watch` |
