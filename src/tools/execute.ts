// ─────────────────────────────────────────────────────────
// Tool handlers: ctx_execute + ctx_execute_file
// ─────────────────────────────────────────────────────────

import { z } from "zod";
import { Buffer } from "node:buffer";
import { type PolyglotExecutor } from "../executor.js";
import {
  trackResponse,
  trackIndexed,
  getStore,
  checkDenyPolicy,
  checkNonShellDenyPolicy,
  checkFilePathDenyPolicy,
  INTENT_SEARCH_THRESHOLD,
  LARGE_OUTPUT_THRESHOLD,
  type ToolResult,
} from "./shared.js";
import { classifyNonZeroExit } from "../exit-classify.js";
import { getAvailableLanguages, hasBunRuntime } from "../runtime.js";
import { detectRuntimes } from "../runtime.js";

const runtimes = detectRuntimes();
const available = getAvailableLanguages(runtimes);
const langList = available.join(", ");
const bunNote = hasBunRuntime()
  ? " (Bun detected — JS/TS runs 3-5x faster)"
  : "";

// ── Intent-driven search + indexStdout helpers ─────────────

async function intentSearch(
  stdout: string,
  intent: string,
  source: string,
  maxResults: number = 5,
): Promise<string> {
  const { getStore } = await import("./shared.js");
  const totalLines = stdout.split("\n").length;
  const totalBytes = Buffer.byteLength(stdout);

  const persistent = getStore();
  const indexed = persistent.indexPlainText(stdout, source);

  let results = await persistent.searchWithFallback(intent, maxResults, source);

  const distinctiveTerms = persistent.getDistinctiveTerms(indexed.sourceId);

  if (results.length === 0) {
    return `Indexed ${indexed.totalChunks} sections from ${source} (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB).\nNo sections matched "${intent}".\n\nUse ctx_search(queries: ["${intent}"], source: "${source}") for follow-up queries.`;
  }

  const { extractSnippet } = await import("./shared.js");
  const sections = results.map((r) => {
    const snippet = extractSnippet(r.content, intent, 3000, r.highlighted);
    return `### ${r.title}\n${snippet}`;
  });

  const header = `Indexed ${indexed.totalChunks} sections from ${source}. Top ${results.length} results for "${intent}":`;
  const termsLine = distinctiveTerms.length > 0
    ? `\nSearchable terms for follow-up: ${distinctiveTerms.join(", ")}`
    : "";

  return [header, "", ...sections, termsLine].join("\n");
}

function indexStdout(
  stdout: string,
  source: string,
): { content: Array<{ type: "text"; text: string }> } {
  const store = getStore();
  trackIndexed(Buffer.byteLength(stdout));
  const indexed = store.index({ content: stdout, source });
  return {
    content: [
      {
        type: "text" as const,
        text: `Indexed ${indexed.totalChunks} sections (${indexed.codeChunks} with code) from: ${indexed.label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${indexed.label}" to scope results.`,
      },
    ],
  };
}

// ── ctx_execute handler ─────────────────────────────────────

export function registerCtxExecute(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  executor: PolyglotExecutor,
): void {
  server.registerTool(
    "ctx_execute",
    {
      title: "Execute Code",
      description: `MANDATORY: Use for any command where output exceeds 20 lines. Execute code in a sandboxed subprocess. Only stdout enters context — raw data stays in the subprocess.${bunNote} Available: ${langList}.\n\nPREFER THIS OVER BASH for: API calls (gh, curl, aws), test runners (npm test, pytest), git queries (git log, git diff), data processing, and ANY CLI command that may produce large output. Bash should only be used for file mutations, git writes, and navigation.\n\nTHINK IN CODE: When you need to analyze, count, filter, compare, or process data — write code that does the work and console.log() only the answer. Do NOT read raw data into context to process mentally. Program the analysis, don't compute it in your reasoning. Write robust, pure JavaScript (no npm dependencies). Use only Node.js built-ins (fs, path, child_process). Always wrap in try/catch. Handle null/undefined. Works on both Node.js and Bun.\n\nWhen reporting results — terse like caveman. Technical substance exact. Only fluff die. Pattern: [thing] [action] [reason]. [next step].`,
      inputSchema: z.object({
        language: z
          .enum([
            "javascript",
            "typescript",
            "python",
            "shell",
            "ruby",
            "go",
            "rust",
            "php",
            "perl",
            "r",
            "elixir",
          ])
          .describe("Runtime language"),
        code: z
          .string()
          .describe(
            "Source code to execute. Use console.log (JS/TS), print (Python/Ruby/Perl/R), echo (Shell), echo (PHP), fmt.Println (Go), or IO.puts (Elixir) to output a summary to context.",
          ),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs (which is the right layer for this policy). Pass an explicit value for long-running builds (Gradle/Maven/SBT)."),
        background: z
          .boolean()
          .optional()
          .default(false)
          .describe("Keep process running after timeout (for servers/daemons). Returns partial output without killing the process. IMPORTANT: Do NOT add setTimeout/self-close timers in background scripts — the process must stay alive until the timeout detaches it. For server+fetch patterns, prefer putting both server and fetch in ONE ctx_execute call instead of using background."),
        intent: z
          .string()
          .optional()
          .describe(
            "What you're looking for in the output. When provided and output is large (>5KB), " +
            "indexes output into knowledge base and returns section titles + previews — not full content. " +
            "Use ctx_search(queries: [...]) to retrieve specific sections. Example: 'failing tests', 'HTTP 500 errors'." +
            "\n\nTIP: Use specific technical terms, not just concepts. Check 'Searchable terms' in the response for available vocabulary.",
          ),
      }),
    },
    async ({ language, code, timeout, background, intent }) => {
      if (language === "shell") {
        const denied = checkDenyPolicy(code, "execute");
        if (denied) return denied;
      } else {
        const denied = checkNonShellDenyPolicy(code, language, "execute");
        if (denied) return denied;
      }

      try {
        let instrumentedCode = code;
        if (language === "javascript" || language === "typescript") {
          instrumentedCode = `
let __cm_fs=0;
process.on('exit',()=>{if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch{}});
(function(){
  try{
    var f=typeof require!=='undefined'?require('fs'):null;
    if(!f)return;
    var ors=f.readFileSync;
    f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};
    var orf=f.readFile;
    if(orf)f.readFile=function(){var a=Array.from(arguments),cb=a.pop();orf.apply(this,a.concat([function(e,d){if(!e&&d){if(Buffer.isBuffer(d))__cm_fs+=d.length;else if(typeof d==='string')__cm_fs+=Buffer.byteLength(d);}cb(e,d);}]));};
  }catch{}
})();
let __cm_net=0;
process.on('exit',()=>{if(__cm_net>0)try{process.stderr.write('__CM_NET__:'+__cm_net+'\\n')}catch{}});
;(function(__cm_req){
const __cm_f=globalThis.fetch;
globalThis.fetch=async(...a)=>{const r=await __cm_f(...a);
try{const cl=r.clone();const b=await cl.arrayBuffer();__cm_net+=b.byteLength}catch{}
return r};
const __cm_hc=new Map();
const __cm_hm=new Set(['http','https','node:http','node:https']);
function __cm_wf(m,origFn){return function(...a){
  const li=a.length-1;
  if(li>=0&&typeof a[li]==='function'){const oc=a[li];a[li]=function(res){
    res.on('data',function(c){__cm_net+=c.length});oc(res);};}
  const req=origFn.apply(m,a);
  const oOn=req.on.bind(req);
  req.on=function(ev,cb,...r){
    if(ev==='response'){return oOn(ev,function(res){
      res.on('data',function(c){__cm_net+=c.length});cb(res);
    },...r);}
    return oOn(ev,cb,...r);
  };
  return req;
}}
var require=__cm_req?function(id){
  const m=__cm_req(id);
  if(!__cm_hm.has(id))return m;
  const k=id.replace('node:','');
  if(__cm_hc.has(k))return __cm_hc.get(k);
  const w=Object.create(m);
  if(typeof m.get==='function')w.get=__cm_wf(m,m.get);
  if(typeof m.request==='function')w.request=__cm_wf(m,m.request);
  __cm_hc.set(k,w);return w;
}:__cm_req;
if(__cm_req){if(__cm_req.resolve)require.resolve=__cm_req.resolve;
if(__cm_req.cache)require.cache=__cm_req.cache;}
async function __cm_main(){
${code}
}
__cm_main().catch(e=>{console.error(e);process.exitCode=1});${background ? '\nsetInterval(()=>{},2147483647);' : ''}
})(typeof require!=='undefined'?require:null);`;
        }
        const result = await executor.execute({ language, code: instrumentedCode, timeout, background });

        const { sessionStats } = await import("./shared.js");
        const netMatch = result.stderr?.match(/__CM_NET__:(\d+)/);
        if (netMatch) {
          sessionStats.bytesSandboxed += parseInt(netMatch[1]);
          result.stderr = result.stderr.replace(/\n?__CM_NET__:\d+\n?/g, "");
        }

        const fsMatch = result.stderr?.match(/__CM_FS__:(\d+)/);
        if (fsMatch) {
          sessionStats.bytesSandboxed += parseInt(fsMatch[1]);
          result.stderr = result.stderr.replace(/\n?__CM_FS__:\d+\n?/g, "");
        }

        if (result.timedOut) {
          const partialOutput = result.stdout?.trim();
          if (result.backgrounded && partialOutput) {
            return trackResponse("ctx_execute", {
              content: [
                {
                  type: "text" as const,
                  text: `${partialOutput}\n\n_(process backgrounded after ${timeout}ms — still running)_`,
                },
              ],
            });
          }
          if (partialOutput) {
            return trackResponse("ctx_execute", {
              content: [
                {
                  type: "text" as const,
                  text: `${partialOutput}\n\n_(timed out after ${timeout}ms — partial output shown above)_`,
                },
              ],
            });
          }
          return trackResponse("ctx_execute", {
            content: [
              {
                type: "text" as const,
                text: `Execution timed out after ${timeout}ms\n\nstderr:\n${result.stderr}`,
              },
            ],
            isError: true,
          });
        }

        if (result.exitCode !== 0) {
          const { isError, output } = classifyNonZeroExit({
            language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
          });
          if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
            trackIndexed(Buffer.byteLength(output));
            return trackResponse("ctx_execute", {
              content: [
                { type: "text" as const, text: await intentSearch(output, intent, isError ? `execute:${language}:error` : `execute:${language}`) },
              ],
              isError,
            });
          }
          if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
            trackIndexed(Buffer.byteLength(output));
            return trackResponse("ctx_execute", {
              content: [
                { type: "text" as const, text: await intentSearch(output, "errors failures exceptions", isError ? `execute:${language}:error` : `execute:${language}`) },
              ],
              isError,
            });
          }
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: output },
            ],
            isError,
          });
        }

        const stdout = result.stdout || "(no output)";

        if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(stdout));
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: await intentSearch(stdout, intent, `execute:${language}`) },
            ],
          });
        }

        if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
          return trackResponse("ctx_execute", indexStdout(stdout, `execute:${language}`));
        }

        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: stdout },
          ],
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: `Runtime error: ${message}` },
          ],
          isError: true,
        });
      }
    },
  );

  // ── ctx_execute_file handler ──────────────────────────────

  server.registerTool(
    "ctx_execute_file",
    {
      title: "Execute File Processing",
      description:
        "Read a file and process it without loading contents into context. The file is read into a FILE_CONTENT variable inside the sandbox. Only your printed summary enters context.\n\nPREFER THIS OVER Read/cat for: log files, data files (CSV, JSON, XML), large source files for analysis, and any file where you need to extract specific information rather than read the entire content.\n\nTHINK IN CODE: Write code that processes FILE_CONTENT and console.log() only the answer. Don't read files into context to analyze mentally. Write robust, pure JavaScript — no npm deps, try/catch, null-safe. Node.js + Bun compatible.\n\nWhen reporting results — terse like caveman. Technical substance exact. Only fluff die. Pattern: [thing] [action] [reason]. [next step].",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute file path or relative to project root"),
        language: z
          .enum([
            "javascript",
            "typescript",
            "python",
            "shell",
            "ruby",
            "go",
            "rust",
            "php",
            "perl",
            "r",
            "elixir",
          ])
          .describe("Runtime language"),
        code: z
          .string()
          .describe(
            "Code to process FILE_CONTENT (file_content in Elixir). Print summary via console.log/print/echo/IO.puts.",
          ),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs."),
        intent: z
          .string()
          .optional()
          .describe(
            "What you're looking for in the output. When provided and output is large (>5KB), " +
            "returns only matching sections via BM25 search instead of truncated output.",
          ),
      }),
    },
    async ({ path, language, code, timeout, intent }) => {
      const pathDenied = checkFilePathDenyPolicy(path, "execute_file");
      if (pathDenied) return pathDenied;

      if (language === "shell") {
        const codeDenied = checkDenyPolicy(code, "execute_file");
        if (codeDenied) return codeDenied;
      } else {
        const codeDenied = checkNonShellDenyPolicy(code, language, "execute_file");
        if (codeDenied) return codeDenied;
      }

      try {
        const result = await executor.executeFile({
          path,
          language,
          code,
          timeout,
        });

        if (result.timedOut) {
          return trackResponse("ctx_execute_file", {
            content: [
              {
                type: "text" as const,
                text: `Timed out processing ${path} after ${timeout}ms`,
              },
            ],
            isError: true,
          });
        }

        if (result.exitCode !== 0) {
          const { isError, output } = classifyNonZeroExit({
            language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
          });
          if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
            trackIndexed(Buffer.byteLength(output));
            return trackResponse("ctx_execute_file", {
              content: [
                { type: "text" as const, text: await intentSearch(output, intent, isError ? `file:${path}:error` : `file:${path}`) },
              ],
              isError,
            });
          }
          if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
            trackIndexed(Buffer.byteLength(output));
            return trackResponse("ctx_execute_file", {
              content: [
                { type: "text" as const, text: await intentSearch(output, "errors failures exceptions", isError ? `file:${path}:error` : `file:${path}`) },
              ],
              isError,
            });
          }
          return trackResponse("ctx_execute_file", {
            content: [
              { type: "text" as const, text: output },
            ],
            isError,
          });
        }

        const stdout = result.stdout || "(no output)";

        if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(stdout));
          return trackResponse("ctx_execute_file", {
            content: [
              { type: "text" as const, text: await intentSearch(stdout, intent, `file:${path}`) },
            ],
          });
        }

        if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
          return trackResponse("ctx_execute_file", indexStdout(stdout, `file:${path}`));
        }

        return trackResponse("ctx_execute_file", {
          content: [
            { type: "text" as const, text: stdout },
          ],
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return trackResponse("ctx_execute_file", {
          content: [
            { type: "text" as const, text: `Runtime error: ${message}` },
          ],
          isError: true,
        });
      }
    },
  );
}
