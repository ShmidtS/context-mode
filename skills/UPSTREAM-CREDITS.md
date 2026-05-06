# Upstream Skill Credits

Vendored operating-discipline skills from [mattpocock/skills](https://github.com/mattpocock/skills), used as mandatory tools by [`context-mode-ops`](context-mode-ops/SKILL.md).

## Source

- **Repository:** https://github.com/mattpocock/skills
- **License:** MIT (Copyright 2026 Matt Pocock)
- **Commit:** `b843cb5ea74b1fe5e58a0fc23cddef9e66076fb8` (vendored 2026-05-04)

## Vendored skills

| Skill | Upstream | Local |
|-------|----------|-------|
| `/diagnose` | `skills/engineering/diagnose/` | `skills/diagnose/` |
| `/tdd` | `skills/engineering/tdd/` | `skills/tdd/` |
| `/grill-me` | `skills/productivity/grill-me/` | `skills/grill-me/` |
| `/grill-with-docs` | `skills/engineering/grill-with-docs/` | `skills/grill-with-docs/` |
| `/improve-codebase-architecture` | `skills/engineering/improve-codebase-architecture/` | `skills/improve-codebase-architecture/` |

## Why vendor

`context-mode-ops` treats these as mandatory, not advisory. Vendoring guarantees they ship with every install.

## Refresh

```bash
git clone --depth 1 https://github.com/mattpocock/skills /tmp/mattpocock-skills-update
for d in diagnose tdd grill-me grill-with-docs improve-codebase-architecture; do
  src=$(find /tmp/mattpocock-skills-update/skills -maxdepth 3 -type d -name "$d" | head -1)
  cp -R "$src/." "skills/$d/"
done
# Update the commit SHA above and run the full test suite.
```

## License

MIT terms preserved upstream. Each vendored `SKILL.md` has a footer linking here. No relicensing.
