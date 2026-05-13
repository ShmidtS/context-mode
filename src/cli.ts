#!/usr/bin/env node
/**
 * context-mode CLI
 *
 * Usage:
 *   context-mode                              → Start MCP server (stdio)
 *   context-mode doctor                       → Diagnose runtime issues, hooks, FTS5, version
 *   context-mode upgrade                      → Fix hooks, permissions, and settings
 *   context-mode hook <platform> <event>      → Dispatch a hook script (used by platform hook configs)
 *
 * Platform auto-detection: CLI detects which platform is running
 * (Claude Code, Gemini CLI, OpenCode, etc.) and uses the appropriate adapter.
 */

import * as p from "@clack/prompts";
import color from "picocolors";
import { execFileSync, execFile as nodeExecFile } from "node:child_process";
import { readFileSync, writeFileSync, cpSync, accessSync, existsSync, readdirSync, rmSync, closeSync, openSync, chmodSync, mkdirSync, constants } from "node:fs";
import { request as httpsRequest } from "node:https";
import { resolve, dirname, join } from "node:path";
import { tmpdir, devNull, homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  detectRuntimes,
  getRuntimeSummary,
  hasBunRuntime,
  getAvailableLanguages,
} from "./runtime.js";

// ── Adapter imports ──────────────────────────────────────
import { detectPlatform, getAdapter } from "./adapters/detect.js";
import type { HookAdapter } from "./adapters/types.js";

/* -------------------------------------------------------
 * Hook dispatcher — `context-mode hook <platform> <event>`
 * ------------------------------------------------------- */

const HOOK_MAP: Record<string, Record<string, string>> = {
  "claude-code": {
    pretooluse: "hooks/pretooluse.mjs",
    posttooluse: "hooks/posttooluse.mjs",
    precompact: "hooks/precompact.mjs",
    sessionstart: "hooks/sessionstart.mjs",
    userpromptsubmit: "hooks/userpromptsubmit.mjs",
  },
  "gemini-cli": {
    beforetool: "hooks/gemini-cli/beforetool.mjs",
    aftertool: "hooks/gemini-cli/aftertool.mjs",
    precompress: "hooks/gemini-cli/precompress.mjs",
    sessionstart: "hooks/gemini-cli/sessionstart.mjs",
  },
  "vscode-copilot": {
    pretooluse: "hooks/vscode-copilot/pretooluse.mjs",
    posttooluse: "hooks/vscode-copilot/posttooluse.mjs",
    precompact: "hooks/vscode-copilot/precompact.mjs",
    sessionstart: "hooks/vscode-copilot/sessionstart.mjs",
  },
  "cursor": {
    pretooluse: "hooks/cursor/pretooluse.mjs",
    posttooluse: "hooks/cursor/posttooluse.mjs",
    sessionstart: "hooks/cursor/sessionstart.mjs",
    stop: "hooks/cursor/stop.mjs",
    afteragentresponse: "hooks/cursor/afteragentresponse.mjs",
  },
  "codex": {
    pretooluse: "hooks/codex/pretooluse.mjs",
    posttooluse: "hooks/codex/posttooluse.mjs",
    sessionstart: "hooks/codex/sessionstart.mjs",
    userpromptsubmit: "hooks/codex/userpromptsubmit.mjs",
    stop: "hooks/codex/stop.mjs",
  },
  "kiro": {
    pretooluse: "hooks/kiro/pretooluse.mjs",
    posttooluse: "hooks/kiro/posttooluse.mjs",
  },
  "jetbrains-copilot": {
    pretooluse: "hooks/jetbrains-copilot/pretooluse.mjs",
    posttooluse: "hooks/jetbrains-copilot/posttooluse.mjs",
    precompact: "hooks/jetbrains-copilot/precompact.mjs",
    sessionstart: "hooks/jetbrains-copilot/sessionstart.mjs",
  },
  "qwen-code": {
    pretooluse: "hooks/pretooluse.mjs",
    posttooluse: "hooks/posttooluse.mjs",
    precompact: "hooks/precompact.mjs",
    sessionstart: "hooks/sessionstart.mjs",
    userpromptsubmit: "hooks/userpromptsubmit.mjs",
  },
};

async function hookDispatch(platform: string, event: string): Promise<void> {
  // Suppress stderr at OS fd level — native C++ modules (better-sqlite3) write
  // directly to fd 2 during initialization, bypassing Node.js process.stderr.
  // Platforms like Claude Code interpret ANY stderr output as hook failure.
  // Cross-platform: os.devNull → /dev/null (Unix) or \\.\NUL (Windows). See: #68
  try {
    closeSync(2);
    openSync(devNull, "w"); // Acquires fd 2 (lowest available)
  } catch {
    process.stderr.write = (() => true) as typeof process.stderr.write;
  }

  const scriptPath = HOOK_MAP[platform]?.[event];
  if (!scriptPath) {
    process.exit(1);
  }
  const pluginRoot = getPluginRoot();
  await import(pathToFileURL(join(pluginRoot, scriptPath)).href);
}

/* -------------------------------------------------------
 * Entry point
 * ------------------------------------------------------- */

const args = process.argv.slice(2);

if (args[0] === "doctor") {
  doctor().then((code) => process.exit(code));
} else if (args[0] === "upgrade") {
  upgrade();
} else if (args[0] === "hook") {
  hookDispatch(args[1], args[2]);
} else if (args[0] === "insight") {
  insight(args[1] ? Number(args[1]) : 4747);
} else if (args[0] === "statusline") {
  // Status line implementation lives in bin/statusline.mjs to keep it
  // dependency-free and fast. Forward stdin and exit with its result.
  statuslineForward();
} else if (args[0] === "local-index") {
  localIndex(args[1] || ".").then((code) => process.exit(code));
} else if (args[0] === "local-search") {
  if (!args[1]) {
    console.error("Usage: context-mode local-search <query>");
    process.exit(1);
  }
  localSearch(args[1], args[2]).then((code) => process.exit(code));
} else if (args[0] === "local-repos") {
  localRepos().then((code) => process.exit(code));
} else if (args[0] === "local-status") {
  if (!args[1]) {
    console.error("Usage: context-mode local-status <job-id>");
    process.exit(1);
  }
  localStatus(args[1]).then((code) => process.exit(code));
} else {
  // Default: start MCP server
  import("./server.js");
}

/* -------------------------------------------------------
 * Shared helpers
 * ------------------------------------------------------- */

/** Normalize Windows backslash paths to forward slashes for Bash (MSYS2) compatibility. */
export function toUnixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Windows-safe npm execution. On Windows:
 * - "npm" → "npm.cmd" (Node won't resolve via PATHEXT in execFile)
 * - shell: true required (Node v20+ CVE-2024-27980 mitigation)
 * See: https://github.com/ShmidtS/context-mode/issues/344
 */
const isWin = process.platform === "win32";

export function npmExecFile(args: string[], opts: Record<string, unknown> = {}): void {
  execFileSync(isWin ? "npm.cmd" : "npm", args, {
    ...opts,
    ...(isWin ? { shell: true } : {}),
  });
}

export function npmExec(command: string, opts: Record<string, unknown> = {}): void {
  const { execSync: es } = require("node:child_process");
  es(isWin ? command.replace(/^npm /, "npm.cmd ") : command, {
    ...opts,
    ...(isWin ? { shell: true } : {}),
  });
}

/**
 * Open a URL in the user's default browser without invoking a shell.
 *
 * Uses `execFile` with an arg array so the URL cannot be interpreted as
 * shell metacharacters.  Original code used `execSync(`open "${url}"`)`
 * which would shell-interpolate the URL — fragile if the URL ever
 * becomes attacker-controlled (remote, weak port-validation, etc).
 *
 * Best-effort: if the OS opener is missing the function logs a copyable
 * URL hint and returns; it never throws.  `runner` is injectable for
 * tests; default is `child_process.execFile` (callback form, fire-and-
 * forget).
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  opts?: Record<string, unknown>,
) => unknown;

export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  runner: ExecFileFn = nodeExecFile as unknown as ExecFileFn,
): void {
  const opts = { stdio: "ignore" as const };
  const hint = () =>
    console.error(`\nCould not auto-open browser. Open manually: ${url}`);

  try {
    if (platform === "darwin") {
      runner("open", [url], opts);
    } else if (platform === "win32") {
      // `start` is a cmd.exe builtin; first arg after `start` is the
      // window title — pass empty so the URL isn't consumed as a title.
      runner("cmd", ["/c", "start", "", url], opts);
    } else {
      // linux/bsd: try xdg-open, fall back to sensible-browser.
      try {
        runner("xdg-open", [url], opts);
      } catch {
        try {
          runner("sensible-browser", [url], opts);
        } catch {
          hint();
        }
      }
    }
  } catch {
    hint();
  }
}

function defaultPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // build/cli.js or src/cli.ts → go up one level; cli.bundle.mjs at project root → stay here
  if (__dirname.endsWith("/build") || __dirname.endsWith("\\build") ||
      __dirname.endsWith("/src") || __dirname.endsWith("\\src")) {
    return resolve(__dirname, "..");
  }
  return __dirname;
}

// Opencode/Kilocode install plugins from npm into a per-package cache folder.
// Layout (changed silently in late 2024 — see PR #376 / KiloCode#9503):
//   POSIX  : ~/.cache/<platform>/packages/context-mode@latest/node_modules/context-mode
//   Windows: %LOCALAPPDATA%\<platform>\packages\context-mode@latest\node_modules\context-mode
function cachePluginRoot(platform: string): string {
  const subPath = ["packages", "context-mode@latest", "node_modules", "context-mode"];
  if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA;
    if (localApp) return resolve(localApp, platform, ...subPath);
    return resolve(homedir(), "AppData", "Local", platform, ...subPath);
  }
  return resolve(homedir(), ".cache", platform, ...subPath);
}

function getPluginRoot(): string {
  const platform = detectPlatform().platform;
  if (platform === 'opencode' || platform === 'kilo') {
    return cachePluginRoot(platform);
  }
  return defaultPluginRoot();
}

function getLocalVersion(): string {
  const pluginRoot = getPluginRoot();
  const candidates = [
    resolve(pluginRoot, "package.json"),
    resolve(pluginRoot, ".claude-plugin", "plugin.json"),
    resolve(pluginRoot, ".claude-plugin", "marketplace.json"),
  ];
  for (const path of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(path, "utf-8"));
      if (pkg.version) return pkg.version;
    } catch { /* continue */ }
  }
  return "unknown";
}

async function fetchLatestVersion(): Promise<string> {
  // Use node:https instead of global fetch to avoid a Windows libuv assertion
  // (UV_HANDLE_CLOSING) caused by undici's connection-pool background threads
  // racing with process.exit() teardown on Node.js v24+.
  return new Promise((resolve) => {
    const req = httpsRequest(
      "https://raw.githubusercontent.com/ShmidtS/context-mode/main/package.json",
      { headers: { Connection: "close" } },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => { raw += chunk; });
        res.on("end", () => {
          try {
            const data = JSON.parse(raw) as { version?: string };
            resolve(data.version ?? "unknown");
          } catch {
            resolve("unknown");
          }
        });
      },
    );
    req.on("error", () => resolve("unknown"));
    req.setTimeout(5000, () => { req.destroy(); resolve("unknown"); });
    req.end();
  });
}

/* -------------------------------------------------------
 * Doctor — adapter-aware diagnostics
 * ------------------------------------------------------- */

async function doctorDetectAndIntro(): Promise<{
  adapter: HookAdapter;
  detection: ReturnType<typeof detectPlatform>;
}> {
  if (process.stdout.isTTY) console.clear();
  const detection = detectPlatform();
  const adapter = await getAdapter(detection.platform);
  p.intro(color.bgMagenta(color.white(" context-mode doctor ")));
  p.log.info(
    `Platform: ${color.cyan(adapter.name)}` +
      color.dim(` (${detection.confidence} confidence — ${detection.reason})`),
  );
  return { adapter, detection };
}

async function doctorGetRuntimes(): Promise<{
  runtimes: ReturnType<typeof detectRuntimes>;
  available: string[];
  partial: boolean;
}> {
  const s = p.spinner();
  s.start("Running diagnostics");
  try {
    const runtimes = detectRuntimes();
    const available = getAvailableLanguages(runtimes);
    s.stop("Diagnostics complete");
    return { runtimes, available, partial: false };
  } catch {
    s.stop("Diagnostics partial");
    p.log.warn(
      color.yellow("Could not detect runtimes") +
        color.dim(" — module may be missing, restart session after upgrade"),
    );
    p.outro(color.yellow("Doctor could not fully run — try again after restarting"));
    return { runtimes: undefined as unknown as ReturnType<typeof detectRuntimes>, available: [], partial: true };
  }
}

function doctorReportRuntimesAndSpeed(
  runtimes: ReturnType<typeof detectRuntimes>,
): void {
  p.note(getRuntimeSummary(runtimes), "Runtimes");
  if (hasBunRuntime()) {
    p.log.success(
      color.green("Performance: FAST") + " — Bun detected for JS/TS execution",
    );
  } else {
    p.log.warn(
      color.yellow("Performance: NORMAL") +
        " — Using Node.js (install Bun for 3-5x speed boost)",
    );
  }
}

function doctorCheckLanguageCoverage(available: string[]): number {
  const total = 11;
  const pct = ((available.length / total) * 100).toFixed(0);
  if (available.length < 2) {
    p.log.error(
      color.red(`Language coverage: ${available.length}/${total} (${pct}%)`) +
        " — too few runtimes detected" +
        color.dim(` — ${available.join(", ") || "none"}`),
    );
    return 1;
  }
  p.log.info(
    `Language coverage: ${available.length}/${total} (${pct}%)` +
      color.dim(` — ${available.join(", ")}`),
  );
  return 0;
}

async function doctorTestServer(
  runtimes: ReturnType<typeof detectRuntimes>,
): Promise<number> {
  p.log.step("Testing server initialization...");
  try {
    const { PolyglotExecutor } = await import("./executor.js");
    const executor = new PolyglotExecutor({ runtimes });
    const result = await executor.execute({
      language: "javascript",
      code: 'console.log("ok");',
      timeout: 5000,
    });
    if (result.exitCode === 0 && result.stdout.trim() === "ok") {
      p.log.success(color.green("Server test: PASS"));
      return 0;
    }
    const detail = result.stderr?.trim()
      ? ` (${result.stderr.trim().slice(0, 200)})`
      : "";
    p.log.error(
      color.red("Server test: FAIL") + ` — exit ${result.exitCode}${detail}`,
    );
    return 1;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("Cannot find module") ||
      message.includes("MODULE_NOT_FOUND")
    ) {
      p.log.warn(
        color.yellow("Server test: SKIP") +
          color.dim(" — module not available (restart session after upgrade)"),
      );
      return 0;
    }
    p.log.error(color.red("Server test: FAIL") + ` — ${message}`);
    return 1;
  }
}

function doctorCheckHooks(adapter: HookAdapter, pluginRoot: string): void {
  p.log.step(`Checking ${adapter.name} hooks configuration...`);
  const hookResults = adapter.validateHooks(pluginRoot);
  for (const result of hookResults) {
    if (result.status === "pass") {
      p.log.success(
        color.green(`${result.check}: PASS`) + ` — ${result.message}`,
      );
    } else {
      p.log.error(
        color.red(`${result.check}: FAIL`) +
          ` — ${result.message}` +
          (result.fix ? color.dim(`\n  Run: ${result.fix}`) : ""),
      );
    }
  }
}

function doctorCheckHookScript(pluginRoot: string): void {
  p.log.step("Checking hook script...");
  const hookScriptPath = resolve(pluginRoot, "hooks", "pretooluse.mjs");
  try {
    accessSync(hookScriptPath, constants.R_OK);
    p.log.success(
      color.green("Hook script exists: PASS") +
        color.dim(` — ${hookScriptPath}`),
    );
  } catch {
    p.log.error(
      color.red("Hook script exists: FAIL") +
        color.dim(` — not found at ${hookScriptPath}`),
    );
  }
}

function doctorCheckPluginRegistration(adapter: HookAdapter): void {
  p.log.step(`Checking ${adapter.name} plugin registration...`);
  const pluginCheck = adapter.checkPluginRegistration();
  if (pluginCheck.status === "pass") {
    p.log.success(
      color.green("Plugin enabled: PASS") +
        color.dim(` — ${pluginCheck.message}`),
    );
  } else {
    p.log.warn(
      color.yellow("Plugin enabled: WARN") + ` — ${pluginCheck.message}`,
    );
  }
}

async function doctorCheckFTS5(): Promise<number> {
  p.log.step("Checking FTS5 / SQLite...");
  try {
    const Database = (await import("./db-base.js")).loadDatabase();
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
    db.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
    const row = db
      .prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'")
      .get() as { content: string } | undefined;
    db.close();
    if (row && row.content === "hello world") {
      p.log.success(
        color.green("FTS5 / SQLite: PASS") + " — native module works",
      );
      return 0;
    }
    p.log.error(
      color.red("FTS5 / SQLite: FAIL") + " — query returned unexpected result",
    );
    return 1;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("Cannot find module") ||
      message.includes("MODULE_NOT_FOUND")
    ) {
      p.log.warn(
        color.yellow("FTS5 / better-sqlite3: SKIP") +
          color.dim(" — module not available (restart session after upgrade)"),
      );
      return 0;
    }
    // Detect better-sqlite3 native bindings-missing pattern (issue #408).
    const isBindingsMissing =
      /Could not locate the bindings file/i.test(message) ||
      /bindings\.node/i.test(message) ||
      /\bbindings\b/i.test(message);
    if (isBindingsMissing && process.platform === "win32") {
      p.log.error(
        color.red("FTS5 / better-sqlite3: FAIL") +
          ` — ${message}` +
          color.dim(
            "\n  Root cause: prebuild-install was likely not on PATH, so install fell through to node-gyp without an MSVC toolchain (Windows)." +
            "\n  Try (primary): npm install better-sqlite3   # re-resolves the dep tree and re-links the prebuild-install bin shim to fetch a prebuilt binary" +
            "\n  Try (fallback): npm rebuild better-sqlite3",
          ),
      );
    } else {
      p.log.error(
        color.red("FTS5 / better-sqlite3: FAIL") +
          ` — ${message}` +
          color.dim("\n  Try: npm rebuild better-sqlite3"),
      );
    }
    return 1;
  }
}

async function doctorCheckVersions(adapter: HookAdapter): Promise<void> {
  p.log.step("Checking versions...");
  const localVersion = getLocalVersion();
  const latestVersion = await fetchLatestVersion();
  const installedVersion = adapter.getInstalledVersion();

  if (latestVersion === "unknown") {
    p.log.warn(
      color.yellow("remote: WARN") +
        ` — local v${localVersion}, could not reach GitHub`,
    );
  } else if (localVersion === latestVersion) {
    p.log.success(
      color.green("remote: PASS") + ` — v${localVersion}`,
    );
  } else {
    p.log.warn(
      color.yellow("remote: WARN") +
        ` — local v${localVersion}, latest v${latestVersion}` +
        color.dim("\n  Run: /context-mode:ctx-upgrade"),
    );
  }

  if (installedVersion === "not installed") {
    p.log.info(
      color.dim(`${adapter.name}: not installed`) +
        " — using standalone MCP mode",
    );
  } else if (latestVersion !== "unknown" && installedVersion === latestVersion) {
    p.log.success(
      color.green(`${adapter.name}: PASS`) + ` — v${installedVersion}`,
    );
  } else if (latestVersion !== "unknown") {
    p.log.warn(
      color.yellow(`${adapter.name}: WARN`) +
        ` — v${installedVersion}, latest v${latestVersion}` +
        color.dim("\n  Run: /context-mode:ctx-upgrade"),
    );
  } else {
    p.log.info(
      `${adapter.name}: v${installedVersion}` +
        color.dim(" — could not verify against GitHub"),
    );
  }
}

function doctorSummary(available: string[], criticalFails: number): number {
  if (criticalFails > 0) {
    p.outro(
      color.red(`Diagnostics failed — ${criticalFails} critical issue(s) found`),
    );
    return 1;
  }
  p.outro(
    available.length >= 4
      ? color.green("Diagnostics complete!")
      : color.yellow("Some checks need attention — see above for details"),
  );
  return 0;
}

async function doctor(): Promise<number> {
  const { adapter } = await doctorDetectAndIntro();
  const { runtimes, available, partial } = await doctorGetRuntimes();
  if (partial) return 1;

  doctorReportRuntimesAndSpeed(runtimes);

  let criticalFails = 0;
  criticalFails += doctorCheckLanguageCoverage(available);
  criticalFails += await doctorTestServer(runtimes);
  doctorCheckHooks(adapter, getPluginRoot());
  doctorCheckHookScript(getPluginRoot());
  doctorCheckPluginRegistration(adapter);
  criticalFails += await doctorCheckFTS5();
  await doctorCheckVersions(adapter);

  return doctorSummary(available, criticalFails);
}

/* -------------------------------------------------------
 * Insight — analytics dashboard
 * ------------------------------------------------------- */

async function insightPrepareCache(
  insightSource: string,
  cacheDir: string,
): Promise<void> {
  const { statSync } = await import("node:fs");
  const srcMtime = statSync(join(insightSource, "server.mjs")).mtimeMs;
  const cacheMtime = existsSync(join(cacheDir, "server.mjs"))
    ? statSync(join(cacheDir, "server.mjs")).mtimeMs
    : 0;
  if (srcMtime > cacheMtime) {
    console.log("Copying Insight source...");
    cpSync(insightSource, cacheDir, { recursive: true, force: true });
  }

  if (!existsSync(join(cacheDir, "node_modules"))) {
    console.log("Installing dependencies (first run)...");
    try {
      npmExec("npm install --production=false", {
        cwd: cacheDir,
        stdio: "inherit",
        timeout: 300000,
      });
    } catch {
      try {
        rmSync(join(cacheDir, "node_modules"), { recursive: true, force: true });
      } catch (e) { console.warn("rmSync node_modules failed", e) }
      throw new Error("npm install failed — please retry");
    }
    if (
      !existsSync(join(cacheDir, "node_modules", "vite")) ||
      !existsSync(join(cacheDir, "node_modules", "better-sqlite3"))
    ) {
      rmSync(join(cacheDir, "node_modules"), { recursive: true, force: true });
      throw new Error("npm install incomplete — please retry");
    }
  }
}

async function insightBuildDashboard(cacheDir: string): Promise<void> {
  const { execSync } = await import("node:child_process");
  console.log("Building dashboard...");
  execSync("npx vite build", { cwd: cacheDir, stdio: "pipe", timeout: 60000 });
}

async function insightStartServer(
  cacheDir: string,
  port: number,
  contentDir: string,
  sessDir: string,
): Promise<{ url: string; child: ReturnType<typeof import("node:child_process").spawn> }> {
  const { spawn } = await import("node:child_process");
  const url = `http://localhost:${port}`;

  const child = spawn("node", [join(cacheDir, "server.mjs")], {
    cwd: cacheDir,
    env: {
      ...process.env,
      PORT: String(port),
      INSIGHT_SESSION_DIR: sessDir,
      INSIGHT_CONTENT_DIR: contentDir,
    },
    stdio: "inherit",
  });
  child.on("error", () => {});

  await new Promise((r) => setTimeout(r, 1500));

  try {
    const { request } = await import("node:http");
    await new Promise<void>((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${port}/api/overview`,
        { timeout: 3000 },
        (res) => {
          resolve();
          res.resume();
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.end();
    });
  } catch {
    console.error(
      `\nError: Port ${port} appears to be in use. Either a previous dashboard is still running, or another service is using this port.`,
    );
    console.error(`\nTo fix:`);
    console.error(
      `  Kill the existing process: ${process.platform === "win32" ? `netstat -ano | findstr :${port}` : `lsof -ti:${port} | xargs kill`}`,
    );
    console.error(`  Or use a different port:   context-mode insight ${port + 1}`);
    child.kill();
    process.exit(1);
  }

  return { url, child };
}

async function insight(port: number) {
  try {
    const insightSource = resolve(getPluginRoot(), "insight");
    if (!existsSync(join(insightSource, "server.mjs"))) {
      console.error(
        "Error: Insight source not found. Try upgrading context-mode.",
      );
      process.exit(1);
    }

    const detection = detectPlatform();
    const adapter = await getAdapter(detection.platform);
    const sessDir = adapter.getSessionDir();
    const contentDir = join(dirname(sessDir), "content");
    const cacheDir = join(dirname(sessDir), "insight-cache");

    mkdirSync(cacheDir, { recursive: true });
    await insightPrepareCache(insightSource, cacheDir);
    await insightBuildDashboard(cacheDir);

    const { url, child } = await insightStartServer(
      cacheDir,
      port,
      contentDir,
      sessDir,
    );
    console.log(`\n  context-mode Insight\n  ${url}\n`);
    openInBrowser(url);

    process.on("SIGINT", () => {
      child.kill();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      child.kill();
      process.exit(0);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nInsight error: ${msg}`);
    process.exit(1);
  }
}

/* -------------------------------------------------------
 * Upgrade — adapter-aware hook configuration
 * ------------------------------------------------------- */

async function upgradeSyncMarketplace(
  s: ReturnType<typeof p.spinner>,
  changes: string[],
): Promise<void> {
  const marketplaceDir = resolve(
    homedir(),
    ".claude",
    "plugins",
    "marketplaces",
    "context-mode",
  );
  if (!existsSync(join(marketplaceDir, ".git"))) return;

  const EXPECTED_REPO = "ShmidtS/context-mode";

  // Verify remote points to the correct repository
  try {
    const currentUrl = execFileSync(
      "git",
      ["-C", marketplaceDir, "remote", "get-url", "origin"],
      { stdio: "pipe", encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (!currentUrl.includes(EXPECTED_REPO)) {
      s.start("Updating marketplace remote");
      execFileSync(
        "git",
        ["-C", marketplaceDir, "remote", "set-url", "origin", `https://github.com/${EXPECTED_REPO}.git`],
        { stdio: "pipe", timeout: 10000 },
      );
      s.stop(color.green("Marketplace remote updated"));
      changes.push("Marketplace remote switched to " + EXPECTED_REPO);
    }
  } catch { /* ignore if no remote or git fails */ }

  s.start("Syncing marketplace clone");
  try {
    const statusOut = execFileSync(
      "git",
      ["-C", marketplaceDir, "status", "--porcelain"],
      { stdio: "pipe", encoding: "utf-8", timeout: 5000 },
    );
    if (statusOut.trim()) {
      s.stop(
        color.yellow("Marketplace clone has local edits — skipping git pull"),
      );
      p.log.info(
        color.dim(
          `  Run manually: git -C "${marketplaceDir}" stash && git pull --ff-only`,
        ),
      );
    } else {
      execFileSync(
        "git",
        ["-C", marketplaceDir, "fetch", "--tags", "origin"],
        { stdio: "pipe", timeout: 30000 },
      );
      execFileSync(
        "git",
        ["-C", marketplaceDir, "reset", "--hard", "origin/HEAD"],
        { stdio: "pipe", timeout: 10000 },
      );
      s.stop(color.green("Marketplace clone synced"));
      changes.push("Marketplace clone updated to upstream");
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop(color.yellow("Marketplace sync skipped"));
    p.log.warn(
      color.yellow("git refresh on marketplace failed") + ` — ${message}`,
    );
    p.log.info(
      color.dim("  Continuing — cache dir update will still happen."),
    );
  }
}

async function upgradePullBuildAndInstall(
  localVersion: string,
  pluginRoot: string,
  adapter: HookAdapter,
  detection: ReturnType<typeof detectPlatform>,
  s: ReturnType<typeof p.spinner>,
  changes: string[],
): Promise<{ success: boolean; upToDate: boolean }> {
  p.log.step("Pulling latest from GitHub...");
  const tmpDir = join(tmpdir(), `context-mode-upgrade-${Date.now()}`);

  s.start("Cloning ShmidtS/context-mode");
  try {
    execFileSync(
      "git", ["clone", "--depth", "1", "https://github.com/ShmidtS/context-mode.git", tmpDir],
      { stdio: "pipe", timeout: 30000 },
    );
    s.stop("Downloaded");

    const newPkg = JSON.parse(
      readFileSync(resolve(tmpDir, "package.json"), "utf-8"),
    );
    const newVersion = newPkg.version ?? "unknown";

    if (newVersion === localVersion) {
      p.log.success(color.green("Already on latest") + ` — v${localVersion}`);
      rmSync(tmpDir, { recursive: true, force: true });
      return { success: true, upToDate: true };
    }

    p.log.info(
      `Update available: ${color.yellow("v" + localVersion)} → ${color.green("v" + newVersion)}`,
    );

    s.start("Installing dependencies & building");
    npmExecFile(["install", "--no-audit", "--no-fund"], {
      cwd: tmpDir,
      stdio: "pipe",
      timeout: 120000,
    });
    npmExecFile(["run", "build"], {
      cwd: tmpDir,
      stdio: "pipe",
      timeout: 60000,
    });
    s.stop("Built successfully");

    s.start("Updating files in-place");
    const clonedPkg = JSON.parse(
      readFileSync(resolve(tmpDir, "package.json"), "utf-8"),
    );
    const items = [...(clonedPkg.files || []), "src", "package.json"];
    for (const item of items) {
      try {
        rmSync(resolve(pluginRoot, item), { recursive: true, force: true });
        cpSync(resolve(tmpDir, item), resolve(pluginRoot, item), {
          recursive: true,
        });
      } catch (e) { console.warn("copyUpgradeFiles failed", e) }
    }

    const mcpConfig = {
      mcpServers: {
        "context-mode": {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"],
        },
      },
    };
    writeFileSync(
      resolve(pluginRoot, ".mcp.json"),
      JSON.stringify(mcpConfig, null, 2) + "\n",
    );
    s.stop(color.green(`Updated in-place to v${newVersion}`));

    adapter.updatePluginRegistry(pluginRoot, newVersion);
    p.log.info(color.dim("  Registry synced to " + pluginRoot));

    s.start("Installing production dependencies");
    npmExecFile(["install", "--production", "--no-audit", "--no-fund"], {
      cwd: pluginRoot,
      stdio: "pipe",
      timeout: 60000,
    });
    s.stop("Dependencies ready");

    if (
      detection.platform !== "opencode" &&
      detection.platform !== "kilo"
    ) {
      s.start("Rebuilding native addons");
      const bsqBindingPath = resolve(
        pluginRoot,
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
        "better_sqlite3.node",
      );
      if (existsSync(bsqBindingPath)) {
        s.stop(
          color.green("Native addons OK") +
            color.dim(" — binding present"),
        );
        changes.push("better-sqlite3 binding already present (no rebuild needed)");
      } else {
        try {
          const healUrl = pathToFileURL(
            resolve(pluginRoot, "scripts", "heal-better-sqlite3.mjs"),
          ).href;
          const { healBetterSqlite3Binding } = await import(healUrl);
          const result = healBetterSqlite3Binding(pluginRoot);
          if (result?.healed) {
            s.stop(
              color.green("Native addons healed") +
                color.dim(` (${result.reason})`),
            );
            changes.push(`Healed better-sqlite3 binding via ${result.reason}`);
          } else {
            s.stop(
              color.yellow("Native addon heal needs manual step"),
            );
            p.log.warn(
              color.dim(
                `  Run: cd "${pluginRoot}" && npm install better-sqlite3`,
              ),
            );
          }
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : String(err);
          s.stop(color.yellow("Native addon heal unavailable"));
          p.log.warn(
            color.yellow("better-sqlite3 heal helper missing") +
              ` — ${message}` +
              color.dim(
                `\n  Try manually: cd "${pluginRoot}" && npm rebuild better-sqlite3`,
              ),
          );
        }
      }
    }

    s.start("Updating npm global package");
    try {
      npmExecFile(
        ["install", "-g", pluginRoot, "--no-audit", "--no-fund"],
        { stdio: "pipe", timeout: 30000 },
      );
      s.stop(color.green("npm global updated"));
      changes.push("Updated npm global package");
    } catch {
      s.stop(color.yellow("npm global update skipped"));
      p.log.info(
        color.dim(
          "  Could not update global npm — may need sudo or standalone install",
        ),
      );
    }

    rmSync(tmpDir, { recursive: true, force: true });

    try {
      const registryPath = resolve(
        homedir(),
        ".claude",
        "plugins",
        "installed_plugins.json",
      );
      if (existsSync(registryPath)) {
        const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
        const entries =
          registry?.plugins?.["context-mode@context-mode"];
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            const installPath = entry.installPath;
            if (
              installPath &&
              installPath !== pluginRoot &&
              existsSync(installPath)
            ) {
              const srcSkills = resolve(tmpDir, "skills");
              if (existsSync(srcSkills)) {
                cpSync(srcSkills, resolve(installPath, "skills"), {
                  recursive: true,
                });
                changes.push(`Synced skills to active install path`);
              }
            }
          }
        }
      }
    } catch (e) { console.warn("syncSkills registry read failed", e) }

    changes.push(`Updated v${localVersion} → v${newVersion}`);
    p.log.success(
      color.green("Plugin reinstalled from GitHub!") +
        color.dim(` — v${newVersion}`),
    );
    return { success: true, upToDate: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop(color.red("Update failed"));
    p.log.error(color.red("GitHub pull failed") + ` — ${message}`);
    p.log.info(color.dim("Continuing with hooks/settings fix..."));
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) { console.warn("chmodSync failed", e) }
    return { success: false, upToDate: false };
  }
}

function upgradeBackupSettings(
  adapter: HookAdapter,
  changes: string[],
): void {
  p.log.step(`Backing up ${adapter.name} settings...`);
  const backupPath = adapter.backupSettings();
  if (backupPath?.endsWith(".bak")) {
    p.log.success(
      color.green("Backup created") + color.dim(" -> " + backupPath),
    );
    changes.push("Backed up settings");
  } else if (backupPath) {
    p.log.success(
      color.green("Backup skipped") + color.dim(" — no changes needed"),
    );
  } else {
    p.log.warn(
      color.yellow("No existing settings to backup") +
        " — a new one will be created",
    );
  }
}

function upgradeConfigureHooks(
  adapter: HookAdapter,
  pluginRoot: string,
  changes: string[],
): void {
  p.log.step(`Configuring ${adapter.name} hooks...`);
  const hookChanges = adapter.configureAllHooks(pluginRoot);
  for (const change of hookChanges) {
    p.log.info(color.dim(`  ${change}`));
    changes.push(change);
  }
  p.log.success(
    color.green("Hooks configured") + color.dim(` — ${adapter.name}`),
  );

  const mcpChanges = adapter.configureMcpServer(pluginRoot);
  if (mcpChanges.length > 0) {
    p.log.step(`Registering ${adapter.name} MCP server...`);
    for (const change of mcpChanges) {
      p.log.info(color.dim(`  ${change}`));
      changes.push(change);
    }
    p.log.success(
      color.green("MCP server registered") + color.dim(` — ${adapter.name}`),
    );
  }
}

function upgradeSetPermissions(
  adapter: HookAdapter,
  pluginRoot: string,
  changes: string[],
): void {
  p.log.step("Setting hook script permissions...");
  const permSet = adapter.setHookPermissions(pluginRoot);
  if (process.platform !== "win32") {
    for (const bin of ["build/cli.js", "cli.bundle.mjs"]) {
      const binPath = resolve(pluginRoot, bin);
      try {
        accessSync(binPath, constants.F_OK);
        chmodSync(binPath, 0o755);
        permSet.push(binPath);
      } catch (e) { console.warn("setPermissions accessSync failed", e) }
    }
  }
  if (permSet.length > 0) {
    p.log.success(
      color.green("Permissions set") +
        color.dim(` — ${permSet.length} hook script(s)`),
    );
    changes.push(`Set ${permSet.length} hook scripts as executable`);
  } else {
    p.log.error(
      color.red("No hook scripts found") +
        color.dim(" — expected in " + resolve(pluginRoot, "hooks")),
    );
  }
}

function upgradeReportChanges(changes: string[]): void {
  if (changes.length > 0) {
    p.note(
      changes.map((c) => color.green("  + ") + c).join("\n"),
      "Changes Applied",
    );
  } else {
    p.log.info(color.dim("No changes were needed."));
  }
}

function upgradeRestartNotice(adapter: HookAdapter): void {
  const restartHint =
    adapter.name === "Claude Code"
      ? "/reload-plugins, new terminal, or restart session"
      : "new terminal or restart session";
  p.log.warn(
    color.yellow("Restart for new MCP tools to take effect.") +
      color.dim(` (${restartHint})`),
  );
}

async function upgradeRunDoctor(
  pluginRoot: string,
  adapter: HookAdapter,
): Promise<void> {
  p.log.step("Running doctor to verify...");
  console.log();
  try {
    const cliBundlePath = resolve(pluginRoot, "cli.bundle.mjs");
    const cliBuildPath = resolve(pluginRoot, "build", "cli.js");
    const cliPath = existsSync(cliBundlePath)
      ? cliBundlePath
      : cliBuildPath;
    execFileSync("node", [cliPath, "doctor"], {
      stdio: "inherit",
      timeout: 30000,
      cwd: pluginRoot,
    });
  } catch {
    p.log.warn(
      color.yellow("Doctor had warnings") +
        color.dim(` — restart your ${adapter.name} session to pick up the new version`),
    );
  }
}

async function upgrade() {
  if (process.stdout.isTTY) console.clear();

  const detection = detectPlatform();
  const adapter = await getAdapter(detection.platform);

  p.intro(color.bgCyan(color.black(" context-mode upgrade ")));
  p.log.info(
    `Platform: ${color.cyan(adapter.name)}` +
      color.dim(` (${detection.confidence} confidence)`),
  );

  const pluginRoot = getPluginRoot();
  const changes: string[] = [];
  const s = p.spinner();

  await upgradeSyncMarketplace(s, changes);

  const localVersion = getLocalVersion();
  const pullResult = await upgradePullBuildAndInstall(
    localVersion,
    pluginRoot,
    adapter,
    detection,
    s,
    changes,
  );
  if (pullResult.upToDate) return;

  upgradeBackupSettings(adapter, changes);
  upgradeConfigureHooks(adapter, pluginRoot, changes);
  upgradeSetPermissions(adapter, pluginRoot, changes);
  upgradeReportChanges(changes);
  upgradeRestartNotice(adapter);
  await upgradeRunDoctor(pluginRoot, adapter);
}

/* -------------------------------------------------------
 * Local code indexing — CLI commands
 * ------------------------------------------------------- */

async function localIndex(pathArg: string): Promise<number> {
  try {
    const { LocalIndexer } = await import("./local-indexer.js");
    const { resolve } = await import("node:path");
    const dir = resolve(pathArg);
    const repoId = dir.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "repo";
    const indexer = new LocalIndexer();
    const result = await indexer.indexRepository(dir, repoId);
    indexer.close();
    if (result.status === "completed") {
      console.log(`Indexed ${result.filesIndexed} files (${result.chunksIndexed} chunks). Job: ${result.id}`);
      return 0;
    }
    console.error(`Index failed: ${result.error || "unknown"}`);
    return 1;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`local-index error: ${message}`);
    return 1;
  }
}

async function localSearch(query: string, repoId?: string): Promise<number> {
  try {
    const { LocalSearcher } = await import("./searcher.js");
    const { rerank } = await import("./rerank.js");
    const { formatResults } = await import("./result-formatter.js");
    const searcher = new LocalSearcher();
    const results = await searcher.search(query, repoId, 10);
    searcher.close();
    const reranked = await rerank(query, results, 10);
    const formatted = formatResults(reranked, 2000);
    console.log(JSON.stringify(formatted, null, 2));
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`local-search error: ${message}`);
    return 1;
  }
}

async function localRepos(): Promise<number> {
  try {
    const { LocalIndexer } = await import("./local-indexer.js");
    const indexer = new LocalIndexer();
    const repos = indexer.listRepos();
    indexer.close();
    if (repos.length === 0) {
      console.log("No repositories indexed.");
    } else {
      for (const r of repos) {
        console.log(`${r.repoId}: ${r.files} files`);
      }
    }
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`local-repos error: ${message}`);
    return 1;
  }
}

async function localStatus(jobId: string): Promise<number> {
  try {
    const { LocalIndexer } = await import("./local-indexer.js");
    const indexer = new LocalIndexer();
    const job = indexer.getJobStatus(jobId);
    indexer.close();
    if (!job) {
      console.error(`Job not found: ${jobId}`);
      return 1;
    }
    console.log(`status: ${job.status}`);
    console.log(`files: ${job.filesIndexed}`);
    console.log(`chunks: ${job.chunksIndexed}`);
    if (job.error) console.log(`error: ${job.error}`);
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`local-status error: ${message}`);
    return 1;
  }
}

/* -------------------------------------------------------
 * statusline — forward to bin/statusline.mjs
 * ------------------------------------------------------- */

function statuslineForward(): void {
  // Try multiple plugin-root candidates in priority order. After ctx-upgrade,
  // getPluginRoot() can resolve to a cache dir that sessionstart.mjs (#181)
  // already cleaned, leaving bin/statusline.mjs missing. Falling back to the
  // marketplace clone (#418-synced, stable across upgrades) and to the path
  // Claude Code itself loads from (installed_plugins.json) keeps the bar
  // alive instead of silently going blank.
  const candidates: string[] = [
    resolve(getPluginRoot(), "bin", "statusline.mjs"),
    resolve(homedir(), ".claude", "plugins", "marketplaces", "context-mode", "bin", "statusline.mjs"),
  ];

  // installed_plugins.json may list one or more install paths CC actually
  // loads from. Prefer those if they exist.
  try {
    const registryPath = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");
    if (existsSync(registryPath)) {
      const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
      const entries = registry?.plugins?.["context-mode@context-mode"];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const installPath = entry?.installPath;
          if (typeof installPath === "string" && installPath) {
            candidates.push(resolve(installPath, "bin", "statusline.mjs"));
          }
        }
      }
    }
  } catch (e) { console.warn("readStatuslinePath registry failed", e) }

  const scriptPath = candidates.find((c) => existsSync(c));
  if (!scriptPath) {
    // Statusline output is the user-facing status bar; stderr surfaces visibly
    // in some terminals. Exit silently — the bar simply stays empty until the
    // next /ctx-upgrade or restart resolves the path.
    process.exit(0);
  }
  // Re-exec via dynamic import so stdin/stdout are inherited cleanly.
  import(pathToFileURL(scriptPath).href).catch(() => {
    process.exit(0);
  });
}

