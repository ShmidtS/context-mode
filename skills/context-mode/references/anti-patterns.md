# Anti-Patterns: Common Mistakes with execute / execute_file

Avoid these pitfalls when using context-mode tools.

---

## 1. Using ctx_execute for Small Outputs (< 20 Lines)

`ctx_execute` adds overhead (LLM summarization). For small outputs, Bash is faster.

```
BAD:
  Tool: ctx_execute
  code: "echo $(node --version)"
  language: shell

GOOD:
  Tool: Bash
  command: node --version
```

**Rule:** Output under ~20 lines → Bash. Everything else → `ctx_execute`.

Just-use-Bash examples: `git status`, `ls -la`, `cat .env.example`, `pwd`, `wc -l src/index.ts`

---

## 2. Forgetting to Print Output

`ctx_execute` captures stdout. No print = empty summary.

```javascript
// BAD — no output
const deps = Object.keys(data.dependencies);
// Nothing printed

// GOOD
console.log(`Dependencies (${deps.length}):`);
deps.forEach(d => console.log(`  ${d}: ${data.dependencies[d]}`));
```

```python
# BAD
result = [x for x in data if x['status'] == 'error']
# result is lost

# GOOD
print(f"Found {len(result)} errors:")
for r in result:
    print(f"  {r['id']}: {r['message']}")
```

**Rule:** Every `ctx_execute` script must end with print/console.log.

---

## 3. Using Bash When JS/Python Would Be Cleaner

Complex data processing in Bash is fragile. Use the right language.

```shell
# BAD — inline Python in shell
cat data.json | python3 -c "import sys, json; ..."
```

```javascript
// GOOD — language: javascript
const data = require('./data.json');
data.filter(x => x.status === 'error')
    .forEach(x => console.log(`${x.id}: ${x.message}`));
```

**Switch from shell when:** `python3 -c`/`node -e` inline, 3+ pipes, complex `jq`/`awk`, nested loops, string manipulation beyond `cut`/`sed`.

---

## 4. Loading Entire Files into Context Then Processing

Reading a 10,000-line file with `Read` wastes context. Use `ctx_execute` or `ctx_execute_file` to process and return only the summary.

```
BAD:
  1. Read tool: read 'server.log' (10,000 lines into context)
  2. "Find all errors"

GOOD:
  1. ctx_execute_file(path: 'server.log', language: 'python', code: ...)
     → Only the summary enters context
```

**Rule:** File over 200 lines and you need specific data → `ctx_execute`/`ctx_execute_file`, not `Read`.

---

## 5. Not Using JSON.stringify for Structured Output

Printing objects without serialization gives `[object Object]`.

```javascript
// BAD
console.log(pkg.dependencies); // [object Object]

// GOOD
console.log(JSON.stringify(pkg.dependencies, null, 2));
```

**Rule:** JS: `JSON.stringify(data, null, 2)` or format as table. Python: `json.dumps(data, indent=2)` or `pprint.pprint(data)`.

---

## 6. Timeout Too Short for Network Operations

Default timeout may be too short for API calls, builds, or test suites.

| Operation | timeout_ms |
|-----------|-----------|
| File reading/parsing | 5000 - 10000 |
| Local computation | 10000 |
| Single API request | 15000 - 30000 |
| Paginated API calls | 30000 - 60000 |
| npm install / build | 120000 |
| Full test suite | 120000 - 300000 |

**Rule:** Set `timeout_ms` based on operation type. Network/builds need significantly more time.

---

## 7. Not Using summary_prompt Effectively

Without a good `summary_prompt`, summarization may focus on irrelevant details.

```
BAD:  summary_prompt: "Summarize this"
GOOD: summary_prompt: "Report failing test count, list each failure with file path and error message, identify patterns"
```

**Tips:** Be specific about data points. Ask for counts/metrics, not descriptions. Request actionable insights. Specify desired format.

---

## Summary Checklist

Before using `ctx_execute`, verify:

- [ ] Output will be > 20 lines (otherwise use Bash)
- [ ] Script prints all results to stdout
- [ ] Objects are serialized with JSON.stringify / json.dumps
- [ ] Timeout matches the operation type
- [ ] Language matches the task (JS for JSON/API, Python for data, Shell for pipes)
- [ ] summary_prompt is specific and actionable
- [ ] Not loading a file into context that could be processed in-sandbox
