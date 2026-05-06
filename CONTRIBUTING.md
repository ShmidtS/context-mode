# Contributing to context-mode

Licensed under Elastic License 2.0.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- Node.js 20+ or [Bun](https://bun.sh/)

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

## Development Workflow

| Command | Purpose |
|---------|---------|
| `npm run build` | TypeScript + esbuild |
| `npm test` | Vitest run (parallel) |
| `npm run typecheck` | Type checking only |
| `npm run test:watch` | Watch mode |

| Changed | Rebuild? |
|---------|----------|
| `hooks/*.mjs` | No |
| `src/*.ts` | Yes |
| `configs/*` | No |

## TDD Workflow

Red -> Green -> Refactor.

1. Write a failing test in an existing test file. Do NOT create new test files.
2. Write the minimum code to make it pass.
3. Refactor while keeping tests green.

| Domain | Test File |
|--------|-----------|
| Adapters | `tests/adapters/<platform>.test.ts` |
| Search & FTS5 | `tests/core/search.test.ts` |
| Server & tools | `tests/core/server.test.ts` |
| CLI & bundle | `tests/core/cli.test.ts` |
| Session DB/extract/snapshot | `tests/session/session-*.test.ts` |
| Executor | `tests/executor.test.ts` |
| Store | `tests/store.test.ts` |
| Security | `tests/security.test.ts` |

If your change doesn't fit an existing file, discuss with the maintainer first.

## Submitting a PR

1. Fork and create a feature branch from `next`
2. Follow the local development setup above
3. Write tests first (TDD)
4. Run `npm test` and `npm run typecheck`
5. Test in a live Claude Code session
6. Open a PR using the template
