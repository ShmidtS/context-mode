# Context Mode: Claude Code Integration

For general context-mode concepts, tools, and rules, see [SKILL.md](./SKILL.md).

## Platform Overview

Claude Code has the most complete context-mode integration. All hook types are supported with full argument modification and output injection capabilities.

## Hook Events

| Hook Event | Supported | Notes |
|------------|-----------|-------|
| PreToolUse | Yes | Full support: deny, modify args, inject context, ask user |
| PostToolUse | Yes | Inject additional context after tool output |
| PreCompact | Yes | Inject context before compaction to preserve across context window |
| SessionStart | Yes | Inject routing instructions and session context at startup |
| UserPromptSubmit | Yes | Process user prompts before model sees them |

## Capabilities

- **canModifyArgs**: Yes -- PreToolUse can rewrite tool input arguments
- **canModifyOutput**: Yes -- PostToolUse can modify tool output
- **canInjectSessionContext**: Yes -- SessionStart and PreCompact can inject context

## Configuration

| Setting | Path |
|---------|------|
| Settings | `~/.claude/settings.json` |
| Session DB | `~/.claude/context-mode/sessions/{hash}.db` |
| Session Events | `~/.claude/context-mode/sessions/{hash}-events.md` |
| Plugin Registry | `~/.claude/plugins/installed_plugins.json` |
| Plugin Hooks | `{pluginRoot}/hooks/hooks.json` or `{pluginRoot}/.claude-plugin/hooks/hooks.json` |
| Instruction Files | `CLAUDE.md` |
| Memory Dir | `~/.claude/memory` |

## Hook Registration

Hooks are registered in `settings.json` under the `hooks` key. Each hook entry has a `matcher` (tool name pattern) and `hooks` array with `type: "command"` entries.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|WebFetch|Read|Grep|Task|mcp__plugin_context-mode_context-mode__ctx_execute",
        "hooks": [{ "type": "command", "command": "node {pluginRoot}/hooks/pretooluse.mjs" }]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "node {pluginRoot}/hooks/sessionstart.mjs" }]
      }
    ]
  }
}
```

Plugin installs use `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}` variable instead of hardcoded paths.

## Session ID Resolution

Priority order:
1. `transcript_path` UUID (extracted from `.jsonl` filename)
2. `session_id` field
3. `CLAUDE_SESSION_ID` environment variable
4. `pid-{ppid}` fallback

## Wire Protocol

JSON on stdin, JSON on stdout.

### PreToolUse Response

```json
{ "decision": "allow" | "deny" | "modify" | "context" | "ask", "reason": "...", "updatedInput": {...} }
```

### PostToolUse Response

```json
{ "additionalContext": "..." }
```

## Project Directory

Resolved from `CLAUDE_PROJECT_DIR` environment variable.

## PreToolUse Matchers

The PreToolUse hook matches on these tool names:
- `Bash`, `WebFetch`, `Read`, `Grep`, `Task`
- `mcp__plugin_context-mode_context-mode__ctx_execute`
- `mcp__plugin_context-mode_context-mode__ctx_execute_file`
- `mcp__plugin_context-mode_context-mode__ctx_batch_execute`

## Subagent Routing

Claude Code supports subagents. The PreToolUse hook automatically routes context-mode triggers to the appropriate subagent based on tool name patterns. Subagent routing is handled transparently -- no manual configuration needed.

## Hook Scripts

Located in `{pluginRoot}/hooks/`:
- `pretooluse.mjs` -- Routes large-output tools to context-mode
- `posttooluse.mjs` -- Indexes tool output, injects context
- `precompact.mjs` -- Preserves context across compaction
- `sessionstart.mjs` -- Injects routing instructions at session start
- `userpromptsubmit.mjs` -- Processes user prompts
- `routing.mjs` -- Core routing logic
