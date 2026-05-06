---
name: ctx-purge
description: |
  Purge the context-mode knowledge base. Permanently deletes all indexed content
  and resets session stats. This is destructive and cannot be undone.
  Trigger: /context-mode:ctx-purge
user-invocable: true
---

# Context Mode Purge

Permanently deletes ALL session data: FTS5 knowledge base, session events, analytics, stats. Irreversible.

## Instructions

1. **Warn the user**: This is irreversible. Deleted items:
   - FTS5 knowledge base (all indexed content)
   - Session events DB and markdown file
   - In-memory session stats
2. Call `ctx_purge` with `confirm: true`.
3. Report the result — the response lists what was deleted.

## Notes

- Use when: KB has stale content polluting results, or switching between unrelated projects.
- `ctx_purge` is the **only** way to delete session data. No undo.
- `/clear` and `/compact` do NOT affect context-mode data.
