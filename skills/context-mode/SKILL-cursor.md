# Context Mode: Cursor Integration

For general context-mode concepts, tools, and rules, see [SKILL.md](./SKILL.md).

## Platform Overview

Cursor uses native hooks with lower-camel event names and project-scoped configuration under `.cursor/`. Hook commands use a CLI dispatcher pattern rather than direct node script paths.

## Hook Events

| Hook Event | Supported | Notes |
|------------|-----------|-------|
| preToolUse | Yes | Full support: deny, modify args, inject context |
| postToolUse | Yes | Inject additional context after tool output |
| sessionStart | Yes | Inject routing instructions at session start |
| stop | Yes | Session end processing with optional followup message |
| afterAgentResponse | Yes | Process agent response text |
| preCompact | No | Not supported by Cursor |

## Capabilities

- **canModifyArgs**: Yes -- PreToolUse can rewrite tool input
- **canModifyOutput**: No -- PostToolUse cannot modify output
- **canInjectSessionContext**: Yes -- Via sessionStart hook

## Configuration

| Setting | Path |
|---------|------|
| Hooks Config | `.cursor/hooks.json` (project) or `~/.cursor/hooks.json` (global) |
| MCP Config | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) |
| Session DB | `~/.cursor/context-mode/sessions/{hash}.db` |
| Session Events | `~/.cursor/context-mode/sessions/{hash}-events.md` |
| Instruction Files | `context-mode.mdc` |
| Config Dir | `.cursor/` (project-scoped) |

## Hook Registration

Hooks use native Cursor format with `type: "command"` entries and `loop_limit`/`failClosed` options:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "command": "context-mode hook preToolUse",
        "matcher": "Bash|Read|Grep|WebFetch",
        "loop_limit": null,
        "failClosed": false
      }
    ],
    "postToolUse": [
      {
        "type": "command",
        "command": "context-mode hook postToolUse",
        "loop_limit": null,
        "failClosed": false
      }
    ],
    "sessionStart": [...],
    "stop": [...],
    "afterAgentResponse": [...]
  }
}
```

MCP registration in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "context-mode": {
      "command": "context-mode"
    }
  }
}
```

## Wire Protocol

JSON on stdin, JSON on stdout. Key difference: Cursor rejects empty stdout as "no valid response", so all hooks must emit valid JSON even for no-op cases.

### PreToolUse Response

```json
{ "permission": "deny", "user_message": "Blocked by context-mode hook" }
```

For arg modification:

```json
{ "updated_input": { ... } }
```

For context injection:

```json
{ "agent_message": "additional context here" }
```

### PostToolUse Response

Always emit `additional_context` even when empty:

```json
{ "additional_context": "" }
```

### SessionStart Response

```json
{ "additional_context": "routing instructions..." }
```

## Session ID Resolution

Priority order:
1. `conversation_id` field
2. `session_id` field
3. `CURSOR_SESSION_ID` environment variable
4. `CURSOR_TRACE_ID` environment variable
5. `pid-{ppid}` fallback

## Project Directory

Resolved from: `input.cwd` > `input.workspace_roots[0]` > `CURSOR_CWD` env > `process.cwd()`

## Hook Scripts

Located in `{pluginRoot}/hooks/cursor/`:
- `pretooluse.mjs` -- Cursor-specific PreToolUse handler
- `posttooluse.mjs` -- Cursor-specific PostToolUse handler
- `sessionstart.mjs` -- Cursor-specific SessionStart handler
- `stop.mjs` -- Session end with optional followup message
- `afteragentresponse.mjs` -- Agent response processing

## Enterprise Hook Config

macOS enterprise installations may have read-only hooks at:
`/Library/Application Support/Cursor/hooks.json`

This is an informational layer only -- context-mode validates its presence but does not modify it.

## Limitations

- PostToolUse cannot modify tool output (only inject context)
- No PreCompact support
- Config is project-scoped (`.cursor/`), not user-scoped like Claude Code
- Claude compatibility hooks detected as a warning during diagnostics
