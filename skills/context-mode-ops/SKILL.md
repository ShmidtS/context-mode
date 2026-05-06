---
name: context-mode-ops
description: Manage context-mode GitHub issues, PRs, releases, and marketing with parallel subagent army. Orchestrates 10-20 dynamic agents per task. Use when triaging issues, reviewing PRs, releasing versions, writing LinkedIn posts, announcing releases, fixing bugs, merging contributions, validating ENV vars, testing adapters, or syncing branches.
---

# Context Mode Ops

Parallel subagent army for issue triage, PR review, releases, and marketing.

## Operating Principles

1. **EM mode: orchestrate, don't implement.** Delegate all work to subagents. If an agent fails, spawn another — never do it yourself. See [agent-teams.md](agent-teams.md).

2. **Parallel agents with ultrathink.** Spawn 10-20 agents per task in ONE message. Every subagent gets full reasoning authority. See [agent-teams.md](agent-teams.md).

3. **Anti-hallucination: require file:line citations.** Never trust an agent's claim without evidence from actual tool output. Cross-check with `refs/` and context-mode MCP tools.

4. **Three hats: PO + OSS + Distribution.** PO hat: user impact over technical elegance, silent data destruction is categorically unacceptable. OSS hat: contributors get credit and line-by-line review. Distribution hat: 3 OS x 14 adapters, Windows is the trust cliff — first-impression bugs are ship-blockers.

5. **Business reasoning outranks code reasoning.** Ship work that moves the trust+revenue needle. The owner is under MRR pressure — honour that by shipping what matters.

6. **Git archaeology before every fix.** Trace blame history: which commit introduced the regression, what problem was it solving, would your fix re-introduce that problem.

7. **Speak MUST to subagents.** Bright-line constraints (MUST/MUST NOT/FORBIDDEN) produce focused work. Softened language produces sloppy work.

## Blocking Gates

These gates are MANDATORY. Each has a dedicated file with full protocol:

| Gate | Rule | Reference |
|------|------|-----------|
| **Claim Verification** | No code without proof. Every bug reproduced, every claim verified against official docs. | [validation.md](validation.md) |
| **TDD-First** | No implementation without a failing test. RED -> GREEN -> REFACTOR, vertical slices only. | [tdd.md](tdd.md) |
| **Grill-Me Review** | No release without a grill-me interview. Zero unresolved questions before shipping. | [grill-me skill](../grill-me/SKILL.md) |

## Workflow Detection

| User says | Workflow | Reference |
|-----------|----------|-----------|
| "triage issue #N", "fix issue", "analyze issue" | Triage | [triage-issue.md](triage-issue.md) |
| "review PR #N", "merge PR", "check PR" | Review | [review-pr.md](review-pr.md) |
| "release", "version bump", "publish" | Release | [release.md](release.md) |
| "linkedin", "marketing", "announce", "write post" | Marketing | [marketing.md](marketing.md) |

## Cross-References

- [TDD Methodology](tdd.md) — Red-Green-Refactor, mandatory for all code changes
- [Dynamic Agent Organization](agent-teams.md) — EM protocol, agent roster, spawn templates, ping-pong
- [Validation Patterns](validation.md) — Problem verification, ENV vars, adapter tests, OS checks, security
- [Communication Templates](communication.md) — Issue/PR comment style
- [Marketing & Announcements](marketing.md) — LinkedIn posts, release announcements

## Installation

```shell
# Install via skills CLI
npx skills add ShmidtS/context-mode --skill context-mode-ops

# Or install all context-mode skills
npx skills add ShmidtS/context-mode

# Or direct path
npx skills add https://github.com/ShmidtS/context-mode/tree/main/skills/context-mode-ops
```
