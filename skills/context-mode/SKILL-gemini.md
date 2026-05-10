# Context Mode: Gemini CLI Integration

For general context-mode concepts, tools, and rules, see [SKILL.md](./SKILL.md).

## Platform Overview

Gemini CLI uses JSON stdin/stdout hooks similar to Claude Code but with different hook names (BeforeTool/AfterTool), advisory-only PreCompress, and no `decision: "ask"` support.

## Hook Events

| Hook Event | Supported | Notes |
|------------|-----------|-------|
| BeforeTool | Yes | Arg modification via `hookSpecificOutput.tool_input` |
| AfterTool | Yes | Context injection via `hookSpecificOutput.additionalContext` |
| PreCompress | Yes (advisory) | Async, cannot block -- context injection only |
| SessionStart | Yes | Inject routing instructions at session start |
| UserPromptSubmit | No | Not supported |
| Stop | No | Not supported |

## Capabilities

- **canModifyArgs**: Yes -- via `hookSpecificOutput.tool_input` (merged with original)
- **canModifyOutput**: Yes -- `decision: "deny"` + reason replaces output
- **canInjectSessionContext**: Yes -- Via AfterTool, PreCompress, SessionStart

## Configuration

| Setting | Path |
|---------|------|
| User Settings | `~/.gemini/settings.json` |
| Project Settings | `.gemini/settings.json` |
| Session DB | `~/.gemini/context-mode/sessions/{hash}.db` |
| Session Events | `~/.gemini/context-mode/sessions/{hash}-events.md` |
| Instruction Files | `GEMINI.md` |
| Config Dir | `~/.gemini/` |

## Hook Registration

Hooks are registered in `~/.gemini/settings.json` under the `hooks` key:

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "Bash|Read|WebFetch|Grep",
        "hooks": [{ "type": "command", "command": "node {pluginRoot}/hooks/gemini-cli/beforetool.mjs" }]
      }
    ],
    "AfterTool": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "node {pluginRoot}/hooks/gemini-cli/aftertool.mjs" }]
      }
    ]
  }
}
```

## Wire Protocol

JSON on stdin, JSON on stdout. Key differences from Claude Code:

- Blocking uses `decision: "deny"` in response (NOT `permissionDecision`)
- Output modification: `decision: "deny"` + reason replaces tool output entirely
- Context append: `hookSpecificOutput.additionalContext` appends to output
- Arg modification: `hookSpecificOutput.tool_input` is merged with original args
- PreCompress is advisory only (async, cannot block execution)

### BeforeTool Response

```json
{ "decision": "deny", "reason": "Blocked by context-mode hook" }
```

For arg modification:

```json
{ "hookSpecificOutput": { "tool_input": { "modified_key": "modified_value" } } }
```

### AfterTool Response

```json
{ "hookSpecificOutput": { "additionalContext": "injected context" } }
```

## Session ID Resolution

Priority order:
1. `session_id` field
2. `pid-{ppid}` fallback

## Project Directory

Resolved from: `GEMINI_PROJECT_DIR` env (also supports `CLAUDE_PROJECT_DIR` as alias)

## Hook Scripts

Located in `{pluginRoot}/hooks/gemini-cli/`:
- `beforetool.mjs` -- Gemini-specific BeforeTool handler
- `aftertool.mjs` -- Gemini-specific AfterTool handler
- `precompress.mjs` -- Advisory PreCompress handler
- `sessionstart.mjs` -- Gemini-specific SessionStart handler

## Limitations

- Hooks don't fire for subagents yet
- No `decision: "ask"` support (cannot prompt user for confirmation)
- PreCompress is advisory only -- cannot block or delay execution
- No UserPromptSubmit or Stop hook events
