---
name: ctx-stats
description: |
  Show how much context window context-mode saved this session.
  Displays token consumption, context savings ratio, and per-tool breakdown.
  Read-only — shows stats only, no reset capability.
  To wipe the knowledge base entirely, use ctx_purge instead.
  Trigger: /context-mode:ctx-stats
user-invocable: true
---

# Context Mode Stats

Show context savings for the current session.

## Instructions

1. Call `ctx_stats` (no parameters needed).
2. **CRITICAL**: Copy-paste the ENTIRE tool output as markdown text into your response. Do NOT summarize, collapse, or paraphrase. The user must see full tables without pressing ctrl+o.
3. After the full output, add one sentence highlighting the key savings metric, e.g.: "context-mode saved **12.4x** — 92% of data stayed in sandbox." If no data yet: "No context-mode calls yet this session."

## See Also

- To delete session data, use `/context-mode:ctx-purge`.
