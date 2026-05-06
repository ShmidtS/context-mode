---
name: ctx-insight
description: |
  Open the context-mode Insight analytics dashboard in the browser.
  Shows personal metrics: session activity, tool usage, error rate,
  parallel work patterns, project focus, and actionable insights.
  First run installs dependencies (~30s). Subsequent runs open instantly.
  Trigger: /context-mode:ctx-insight
user-invocable: true
---

# Context Mode Insight

Open the personal analytics dashboard in the browser.

## Instructions

1. Call `ctx_insight`. Optional params: `port` (default 4747), `sessionDir`/`insightSessionDir`, `contentDir`/`insightContentDir`.
2. First run installs dependencies (~30s); subsequent runs open instantly.
3. Display the tool's output verbatim — it contains the dashboard URL.
4. Tell the user: dashboard URL (default http://localhost:4747), refresh for updated metrics, stops when Claude exits (kill PID to stop sooner).
