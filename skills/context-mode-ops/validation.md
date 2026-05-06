# Validation Patterns

Cross-cutting validation rules used by ALL workflows (triage, review, release).

## Problem Verification — FIRST GATE

<problem_verification_enforcement>
This is the FIRST validation step, before anything else. We shipped inheritEnvKeys because
we trusted an LLM claim that Claude Code strips environment variables — it does not.
We got burned shipping a fix for an unverified claim. Never again.
Every bug report, feature request, and behavioral claim MUST be proven true before code is written.
</problem_verification_enforcement>

### For Bug Reports

**Reproduce it or reject it.** Run the exact reproduction steps from the issue. If it doesn't fail, the bug may not exist.

```
Step 1: Extract the claimed reproduction steps from the issue
Step 2: Run them locally (use ctx_execute or a test)
Step 3: Record the ACTUAL output
Step 4: Compare actual vs. claimed behavior
Step 5: VERDICT:
  → REPRODUCED: Bug is real, proceed to fix
  → NOT_REPRODUCED: Ask reporter for ctx-debug.sh output and exact repro steps
  → INVALID: Reporter's environment is misconfigured, help them fix it
```

### For Feature Requests

**Verify the underlying claim.** Feature requests always contain an implicit claim ("X behaves this way", "Y is slow", "Z doesn't support W"). Prove the claim first.

```
Step 1: Identify the claim (e.g., "Claude Code strips env vars from child processes")
Step 2: Find HARD EVIDENCE — official docs, source code, or measured benchmarks
  → Use ctx_fetch_and_index on official docs/repos
  → Use ctx_execute to run actual tests
  → NEVER trust LLM knowledge about platform behavior — LLMs hallucinate this constantly
Step 3: VERDICT:
  → CONFIRMED: Claim is true, proceed to design
  → UNCONFIRMED: Cannot verify — ask reporter for evidence before implementing
  → DEBUNKED: Claim is false — comment on issue explaining the misunderstanding
```

### Requesting Evidence from Reporters

When a claim cannot be verified, comment on the issue BEFORE implementing:

```markdown
We want to address this but need to verify the underlying behavior first.
Could you provide:
1. Output from: `npx context-mode doctor` (or run `ctx-debug.sh`)
2. Exact reproduction steps
3. Platform version, adapter, and OS

We'll investigate as soon as we can confirm the issue. Thanks for reporting!
```

### Evidence Log

Every triage MUST produce a verification entry:

```
CLAIM: "{exact claim}"
SOURCE: {issue number or PR}
EVIDENCE: {link to doc, test output, or benchmark result}
VERDICT: CONFIRMED | UNCONFIRMED | DEBUNKED
ACTION: {proceed | request-info | close-as-invalid}
```

---

## ENV Variable Verification

LLMs frequently hallucinate environment variables. Every ENV var in an issue or PR must be verified.

### Verification Protocol

For EACH environment variable mentioned:

```
Step 1: GREP — Does it exist in context-mode source?
  → rg "{ENV_VAR}" src/
  → If found: VERIFIED (we already use it)
  → If not found: continue to Step 2

Step 2: GREP ADAPTERS — Is it in the adapter detect logic?
  → Read src/adapters/detect.ts
  → Check the verified env vars comment block at the top
  → If listed: VERIFIED (we know about it)

Step 3: WEBSEARCH — Does the platform document it?
  → WebSearch: "{PLATFORM} {ENV_VAR} environment variable"
  → Check official docs, GitHub repos, release notes
  → If found in official source: REAL but we don't use it yet

Step 4: CONTEXT7 — Library documentation check
  → resolve-library-id for the platform
  → query-docs for the ENV var
  → Cross-reference with Step 3

Step 5: VERDICT
  → VERIFIED: We use it and it's real
  → REAL_NEW: Platform has it but we don't use it yet
  → HALLUCINATED: No evidence it exists — flag it
  → DEPRECATED: Used to exist but was removed
```

### Known Verified ENV Vars (Reference)

| Platform | Verified ENV Vars | Source |
|----------|------------------|--------|
| Claude Code | `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID` | src/adapters/detect.ts |
| Gemini CLI | `GEMINI_PROJECT_DIR`, `GEMINI_CLI` | src/adapters/detect.ts |
| OpenCode | `OPENCODE`, `OPENCODE_PID` | src/adapters/detect.ts |
| OpenClaw | `OPENCLAW_HOME`, `OPENCLAW_CLI` | src/adapters/detect.ts |
| Kilo | `KILO`, `KILO_PID` | src/adapters/detect.ts |
| Codex | `CODEX_CI`, `CODEX_THREAD_ID` | src/adapters/detect.ts |
| VS Code Copilot | `VSCODE_PID`, `VSCODE_CWD` | src/adapters/detect.ts |
| Cursor | `CURSOR_TRACE_ID`, `CURSOR_CLI` | src/adapters/detect.ts |
| Override | `CONTEXT_MODE_PLATFORM` | src/adapters/detect.ts |

Any ENV var NOT in this table must go through the full verification protocol.

## Adapter Test Matrix

```shell
# Run ALL adapter tests
npx vitest run tests/adapters/

# Individual adapter
npx vitest run tests/adapters/{adapter}.test.ts
# adapters: claude-code, gemini-cli, opencode, openclaw, kilo, codex,
#           vscode-copilot, cursor, antigravity, kiro, pi, zed

# Detection logic
npx vitest run tests/adapters/detect.test.ts
npx vitest run tests/adapters/client-map.test.ts
```

### Report Format

```
ADAPTER TEST MATRIX
═══════════════════
claude-code     ✓ 5/5    gemini-cli      ✓ 4/4
opencode        ✓ 6/6    openclaw        ✓ 3/3
kilo            ✓ 4/4    codex           ✓ 3/3
vscode-copilot  ✓ 4/4    cursor          ✓ 3/3
antigravity     ✓ 2/2    kiro            ✓ 3/3
pi              ✓ 2/2    zed             ✓ 2/2
detect          ✓ 8/8    client-map      ✓ 6/6
───────────────────────────────────────────
TOTAL: {N}/{N} passed | 0 failed
```

## Core Module Tests

```shell
# Core
npx vitest run tests/core/          # routing, search, server, cli

# Modules
npx vitest run tests/store.test.ts tests/executor.test.ts tests/security.test.ts tests/formatters.test.ts

# Hooks
npx vitest run tests/hooks/

# Full suite
npm test
```

## OS Compatibility Checks

### Path Handling

```javascript
// WRONG — breaks on Windows
const configPath = homedir + "/.config/opencode/config.json";
// CORRECT — works everywhere
const configPath = path.join(homedir(), ".config", "opencode", "config.json");
```

```shell
rg "homedir\(\)\s*\+" src/     # string concat with paths
rg 'path\s*=.*"/' src/ --type ts  # direct slash in paths
```

### Temp Directory

```javascript
// WRONG — hardcoded /tmp
const tmpFile = "/tmp/context-mode-output.txt";
// CORRECT — OS temp dir
const tmpFile = path.join(os.tmpdir(), "context-mode-output.txt");
```

```shell
rg '"/tmp/' src/    # hardcoded temp paths
```

### Native Bindings / Process Spawn

`better-sqlite3` MUST be in `optionalDependencies` (not `dependencies`):

```shell
rg "better-sqlite3" src/ --type ts
rg "optionalDependencies" package.json
```

Process spawn must use explicit shell selection:

```javascript
// WRONG
spawn("command", { shell: true });
// CORRECT
spawn("command", { shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh" });
```

## Hook Format Validation

Each platform has different hook formats. Verify changes match:

| Platform | Hook Format | Key Differences |
|----------|------------|-----------------|
| Claude Code | `hooks.json` in plugin dir | `PreToolUse`, `PostToolUse`, `PreCompact`, `SessionStart` |
| Gemini CLI | `~/.gemini/settings.json` | `BeforeTool`, `AfterTool`, `PreCompress`, `SessionStart` + `matcher` |
| VS Code Copilot | `.github/hooks/*.json` | Same as Claude Code but separate file |
| Cursor | `.cursor/hooks.json` | No `SessionStart` (injects via file instead) |
| OpenCode | `opencode.json` | Uses `agents` section, not traditional hooks |
| OpenClaw | `openclaw.plugin.json` | Extension model, not hook-based |

## Security Checks

```shell
# Sandbox escape: file writing through ctx_execute
rg "writeFile\|appendFile\|createWriteStream" src/executor.ts

# Path traversal
rg "\.\.\/" src/ --type ts

# Command injection
rg "exec\(.*\$\{" src/ --type ts
rg "spawn\(.*\$\{" src/ --type ts

# Information disclosure
rg "process\.env\b" src/ --type ts | grep -v "test"
rg "homedir\(\)" src/ --type ts
```

## TypeScript Validation

```bash
# Full type check
npm run typecheck

# Should report 0 errors
# If errors exist, they MUST be fixed before shipping
```

## Pre-Ship Checklist

Every change, regardless of workflow, must pass:

- [ ] **Problem verified** — CLAIM_VERDICT is CONFIRMED with hard evidence (this is gate zero)
- [ ] `npm run typecheck` — 0 errors
- [ ] `npm test` — all pass
- [ ] Adapter tests — all 12 pass (or N/A if untouched)
- [ ] ENV vars — all verified against real platform source
- [ ] Path handling — no hardcoded separators
- [ ] Hook format — matches target platform's schema
- [ ] No security regressions
