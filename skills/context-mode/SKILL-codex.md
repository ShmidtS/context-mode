# Context Mode: Codex CLI Integration

For general context-mode concepts, tools, and rules, see [SKILL.md](./SKILL.md).

## Platform Overview

Codex CLI uses the same JSON stdin/stdout wire protocol as Claude Code but with different hook names, TOML-based configuration, and limited argument modification support.

## Hook Events

| Hook Event | Supported | Notes |
|------------|-----------|-------|
| PreToolUse | Yes | Deny works; input rewriting blocked on upstream (track: openai/codex#18491) |
| PostToolUse | Yes | Context injection via `hookSpecificOutput` |
| SessionStart | Yes | Context injection via `hookSpecificOutput` |
| UserPromptSubmit | Yes | Process user prompts |
| Stop | Yes | Session end processing |
| PreCompact | No | Not supported by Codex CLI |

## Capabilities

- **canModifyArgs**: No -- upstream `updatedInput` support pending
- **canModifyOutput**: No
- **canInjectSessionContext**: Yes -- via PostToolUse and SessionStart

## Configuration

| Setting | Path |
|---------|------|
| Hooks Config | `~/.codex/hooks.json` |
| MCP Config | `~/.codex/config.toml` (TOML format) |
| Session DB | `~/.codex/context-mode/sessions/{hash}.db` |
| Session Events | `~/.codex/context-mode/sessions/{hash}-events.md` |
| Instruction Files | `AGENTS.md`, `AGENTS.override.md` |
| Memory Dir | `~/.codex/memories` (note: plural) |

## Hook Registration

Hooks are registered in `~/.codex/hooks.json`. The matcher uses pipe-separated tool names:

```json
{
  "PreToolUse": [
    {
      "matcher": "local_shell|shell|shell_command|exec_command|container.exec|Bash|Shell|grep_files|mcp__plugin_context-mode_context-mode__ctx_execute",
      "hooks": [{ "type": "command", "command": "node {pluginRoot}/hooks/pretooluse.mjs" }]
    }
  ]
}
```

MCP server registration goes in `~/.codex/config.toml`:

```toml
[mcp_servers.context-mode]
command = "context-mode"
```

## Wire Protocol

JSON on stdin, JSON on stdout. All responses wrapped in `hookSpecificOutput`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Blocked by context-mode hook"
  }
}
```

### Key Differences from Claude Code

- Responses use `hookSpecificOutput` wrapper (not top-level keys)
- PreToolUse `additionalContext` injection does not work (fails open)
- Context injection works via PostToolUse and SessionStart instead
- No `decision: "ask"` support
- No plugin marketplace or registry

## Session ID Resolution

Priority order:
1. `session_id` field
2. `pid-{ppid}` fallback

## Project Directory

Resolved from: `input.cwd` > `CODEX_PROJECT_DIR` env > `process.cwd()`

## Hook Scripts

Located in `{pluginRoot}/hooks/codex/`:
- `pretooluse.mjs` -- Codex-specific PreToolUse handler
- `posttooluse.mjs` -- Codex-specific PostToolUse handler
- `sessionstart.mjs` -- Codex-specific SessionStart handler
- `userpromptsubmit.mjs` -- User prompt processing
- `stop.mjs` -- Session end handler

## Limitations

- TOML config must be edited manually or via `codex` CLI (no programmatic write)
- No plugin registry -- MCP server must be configured manually
- `updatedInput` blocked on upstream support
- Hooks don't fire for subagents
