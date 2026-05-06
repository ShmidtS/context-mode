# Communication Templates

Tone: warm, professional, technical, grateful. Testing responsibility on the contributor.

## Issue Comments

### After Fix

```markdown
Hey @{author}! 👋
We investigated this and pushed a fix in #{PR_NUMBER}.
**Root cause:** {1-2 sentence explanation}
**Fix:** {1-2 sentence description}
**Affected area:** `{adapter/module path}`
This lands on `next` and ships in the next release. Could you test it once it's out? 🙏
```
npm update -g context-mode
# or: /context-mode:ctx-upgrade
```
Thanks for reporting!
```

### Needs More Information

```markdown
Hey @{author}, thanks for opening this!
To investigate further, could you share:
- Platform (Claude Code / Gemini CLI / OpenCode / etc.)
- context-mode version (`ctx doctor` or `npm list -g context-mode`)
- Exact command or action that triggers this
- Any error messages or unexpected output
This will help us reproduce and fix faster. 🙏
```

### Working As Intended

```markdown
Hey @{author}, thanks for raising this!
This is actually working as intended — {technical explanation}.
{If workaround exists:} You can achieve this by: {workaround}
{If reasonable feature request:} I'll re-label as feature request for community discussion.
```

### Duplicate Issue

```markdown
Hey @{author}, this is a duplicate of #{ORIGINAL_NUMBER}. Closing to keep discussion in one place — please follow #{ORIGINAL_NUMBER} for updates.
If your case differs, reopen and let us know!
```

### LLM Hallucination (Feature/ENV Doesn't Exist)

```markdown
Hey @{author}, after investigation, `{CLAIMED_FEATURE/ENV}` doesn't exist in {PLATFORM}. This is common with AI assistant suggestions.
- {What we checked}
- {Official docs reference}
**What actually works:** {correct approach}
No worries — let us know if you need help with the correct approach.
```

## PR Comments

### After Merge (Clean)

```markdown
Thanks for this contribution, @{author}! 🎉
Merged into `next` — ships in the next release.
Could you test it once the release is out? Your verification is valuable. 🙏
```

### After Merge (With Follow-Up Fixes)

```markdown
Thanks @{author}! Merged into `next`.
Made adjustments in {commit_sha}:
- **{change}:** {reason}
Could you review those and test the flow? 🙏
```

### After Merge (Significant Fixes Needed)

```markdown
Hey @{author}, merged into `next` with adjustments:
- {change 1}: {reason}
- {change 2}: {reason}
Could you thoroughly test this in your environment? You're closest to this use case. 🙏
```

### Closing Without Merge (Rare)

```markdown
Hey @{author}, thanks for the effort!
Can't merge as-is:
- **{reason}:** {explanation}
{IF salvageable:} To make this mergeable: {guidance}
{IF not:} The direction with {area} is {explanation}.
Hope to see more PRs from you!
```

### PR Has Hallucinated Features

```markdown
Hey @{author}, `{CLAIMED_FEATURE}` doesn't appear to exist in {PLATFORM}'s actual implementation.
This is a common AI assistant suggestion issue.
{IF core logic valid:} The rest looks solid — I'll merge and remove the non-existent parts.
{IF whole PR depends on it:} We'd need an alternative approach. {suggestion}
```

## Release Comments

```markdown
Released in **v{VERSION}**!
```
npm update -g context-mode
# or: /context-mode:ctx-upgrade
```
Let us know if this resolves your issue!
```

GitHub release body: `gh release create --generate-notes` handles this. Add manual notes only for: breaking changes, migration steps, notable new features.

## Tone Guidelines

DO: Start with gratitude, use names, be specific/technical, give clear next steps, use emoji sparingly (at most), frame responsibility kindly.
DON'T: Be passive-aggressive, use corporate speak, leave ambiguity, promise timelines, blame contributors, use excessive emoji, write walls of text.
