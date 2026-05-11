---
name: improve-codebase-architecture
description: Find deepening opportunities in a codebase, informed by the domain language in CONTEXT.md and the decisions in docs/adr/. Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a codebase more testable and AI-navigable.
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

## Glossary

Use these terms exactly in every suggestion. Consistent language is the point — don't drift into "component," "service," "API," or "boundary." Full definitions in [LANGUAGE.md](LANGUAGE.md).

- **Structure**: Module (interface + implementation), Interface (everything a caller must know), Implementation (the code inside)
- **Value**: Depth (leverage at the interface; deep = high leverage, shallow = interface as complex as implementation), Leverage (what callers get), Locality (what maintainers get: change concentrated in one place)
- **Boundary**: Seam (where an interface lives; not "boundary"), Adapter (concrete thing satisfying an interface at a seam)

Key principles (see [LANGUAGE.md](LANGUAGE.md) for the full list):

- **Deletion test**: imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two adapters = real seam.**

This skill is _informed_ by the project's domain model. The domain language gives names to good seams; ADRs record decisions the skill should not re-litigate.

## Process

### 1. Explore

Read the project's domain glossary and any ADRs in the area you're touching first.

Query the vault graph (`ctx_vault_graph` with `mode: "surprises"` or `mode: "neighbors"`, `ctx_graph_analyze`) to surface code dependencies, god nodes, and cross-module connections that may reveal hidden coupling or shallow seams.

Then use the Agent tool (model=haiku, explore agent) to walk the codebase. Explore organically and note friction:

- Understanding one concept requires bouncing between many small modules?
- Modules **shallow** -- interface nearly as complex as implementation?
- Pure functions extracted for testability, but real bugs hide in how they're called (no **locality**)?
- Tightly-coupled modules leaking across seams?
- Untested or hard-to-test parts?

Apply the **deletion test**: would deleting the module concentrate complexity, or just move it? "Concentrates" is the signal.

### 2. Present candidates

Present a numbered list of deepening opportunities. For each candidate:

- **Files** -- which files/modules are involved
- **Problem** -- why the current architecture causes friction
- **Solution** -- what would change
- **Benefits** -- in terms of locality, leverage, and test improvement

Use CONTEXT.md vocabulary for the domain, [LANGUAGE.md](LANGUAGE.md) for the architecture.

**ADR conflicts**: surface only when friction warrants revisiting the ADR. Mark clearly (e.g. _"contradicts ADR-0007 -- but worth reopening because..."_).

Do NOT propose interfaces yet. Ask the user: "Which of these would you like to explore?"

### 3. Grilling loop

Walk the design tree with the user -- constraints, dependencies, module shape, seam contents, surviving tests.

Side effects inline as decisions crystallize:

- **New concept not in `CONTEXT.md`?** Add it ([CONTEXT-FORMAT.md](../grill-with-docs/CONTEXT-FORMAT.md)). Create file lazily if missing.
- **Fuzzy term sharpened?** Update `CONTEXT.md` immediately.
- **User rejects with a load-bearing reason?** Offer an ADR ([ADR-FORMAT.md](../grill-with-docs/ADR-FORMAT.md)). Only when a future explorer would need it to avoid re-suggesting.
- **Alternative interfaces?** See [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md).


---

_Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) @ `b843cb5` — MIT License. See [skills/UPSTREAM-CREDITS.md](../UPSTREAM-CREDITS.md) for refresh instructions._
