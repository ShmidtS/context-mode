// ─────────────────────────────────────────────────────────
// Session stats, persistence, version checking, tracking
// ─────────────────────────────────────────────────────────

import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpsRequest } from "node:https";

import { persistToolCallCounter, restoreSessionStats } from "../session/persist-tool-calls.js";
import { getLifetimeStats, OPUS_INPUT_PRICE_PER_TOKEN } from "../session/analytics.js";
export { getLifetimeStats };
import { semverNewer } from "../lib/semver.js";

import { VERSION, getSessionDir, getSessionDbPath, _detectedAdapter, healCacheMidSession } from "./paths.js";
import type { ToolResult } from "./paths.js";

// ── Session stats ──────────────────────────────────────────

export const sessionStats = {
  calls: {} as Record<string, number>,
  bytesReturned: {} as Record<string, number>,
  bytesIndexed: 0,
  bytesSandboxed: 0,
  cacheHits: 0,
  cacheBytesSaved: 0,
  sessionStart: Date.now(),
};

// ── Version outdated warning ───────────────────────────────

export let _latestVersion: string | null = null;
let _warningBurstCount = 0;
let _lastBurstStart = 0;
const VERSION_BURST_SIZE = 3;
const VERSION_SILENT_MS = 60 * 60 * 1000; // 1 hour

async function fetchLatestVersion(): Promise<string> {
  return new Promise((res) => {
    const req = httpsRequest(
      "https://raw.githubusercontent.com/ShmidtS/context-mode/main/package.json",
      { headers: { Connection: "close" } },
      (resp) => {
        let raw = "";
        resp.on("data", (chunk: Buffer) => { raw += chunk; });
        resp.on("end", () => {
          try {
            const data = JSON.parse(raw) as { version?: string };
            res(data.version ?? "unknown");
          } catch { res("unknown"); }
        });
      },
    );
    req.on("error", () => res("unknown"));
    req.setTimeout(5000, () => { req.destroy(); res("unknown"); });
    req.end();
  });
}

function getUpgradeHint(): string {
  const name = _detectedAdapter?.name;
  if (name === "Claude Code") return "/ctx-upgrade";
  if (name === "OpenClaw") return "npm run install:openclaw";
  if (name === "Pi") return "npm run build";
  return "context-mode upgrade";
}

function isOutdated(): boolean {
  if (!_latestVersion || _latestVersion === "unknown") return false;
  return semverNewer(_latestVersion, VERSION);
}

function shouldShowVersionWarning(): boolean {
  if (!isOutdated()) return false;
  const now = Date.now();
  if (_warningBurstCount >= VERSION_BURST_SIZE) {
    if (now - _lastBurstStart < VERSION_SILENT_MS) return false;
    _warningBurstCount = 0;
  }
  if (_warningBurstCount === 0) _lastBurstStart = now;
  _warningBurstCount++;
  return true;
}

// ── Response tracking ──────────────────────────────────────

export function trackResponse(toolName: string, response: ToolResult): ToolResult {
  healCacheMidSession();
  if (shouldShowVersionWarning() && response.content.length > 0) {
    const hint = getUpgradeHint();
    response.content[0].text =
      `⚠️ context-mode v${VERSION} outdated → v${_latestVersion} available. Upgrade: ${hint}\n\n` +
      response.content[0].text;
  }

  const bytes = response.content.reduce(
    (sum, c) => sum + Buffer.byteLength(c.text),
    0,
  );
  sessionStats.calls[toolName] = (sessionStats.calls[toolName] || 0) + 1;
  sessionStats.bytesReturned[toolName] =
    (sessionStats.bytesReturned[toolName] || 0) + bytes;

  persistStats();

  setImmediate(() => persistToolCallCounter(getSessionDbPath(), toolName, bytes));
  return response;
}

export function trackIndexed(bytes: number): void {
  sessionStats.bytesIndexed += bytes;
  persistStats();
}

// ── Stats persistence ──────────────────────────────────────

const STATS_PERSIST_THROTTLE_MS = 500;
const STATS_SCHEMA_VERSION = 2;
const LIFETIME_REFRESH_MS = 30_000;
const TOKENS_PER_EVENT = 256;
let _lastStatsPersist = 0;
let _lifetimeCache: { tokens: number; computedAt: number } | undefined;

export function getStatsFilePath(): string {
  const sessionId = process.env.CLAUDE_SESSION_ID || `pid-${process.ppid}`;
  return join(getSessionDir(), `stats-${sessionId}.json`);
}

export function persistStats(bypassThrottle?: boolean): void {
  const now = Date.now();
  if (!bypassThrottle) {
    if (now - _lastStatsPersist < STATS_PERSIST_THROTTLE_MS) return;
  }
  _lastStatsPersist = now;

  try {
    const totalReturned = Object.values(sessionStats.bytesReturned).reduce(
      (a, b) => a + b,
      0,
    );
    const totalCalls = Object.values(sessionStats.calls).reduce(
      (a, b) => a + b,
      0,
    );
    const keptOut =
      sessionStats.bytesIndexed +
      sessionStats.bytesSandboxed +
      sessionStats.cacheBytesSaved;
    const totalProcessed = keptOut + totalReturned;
    const reductionPct =
      totalProcessed > 0
        ? Math.round((1 - totalReturned / totalProcessed) * 100)
        : 0;
    const tokensSaved = Math.round(keptOut / 4);

    let lifetimeTokens = _lifetimeCache?.tokens ?? 0;
    if (!_lifetimeCache || now - _lifetimeCache.computedAt > LIFETIME_REFRESH_MS) {
      try {
        const life = getLifetimeStats({ sessionsDir: getSessionDir() });
        lifetimeTokens = (life?.totalEvents ?? 0) * TOKENS_PER_EVENT;
        _lifetimeCache = { tokens: lifetimeTokens, computedAt: now };
      } catch (err) {
        console.warn("getLifetimeStats failed", err);
      }
    }

    const payload = {
      schemaVersion: STATS_SCHEMA_VERSION,
      version: VERSION,
      updated_at: now,
      session_start: sessionStats.sessionStart,
      uptime_ms: now - sessionStats.sessionStart,
      total_calls: totalCalls,
      bytes_returned: totalReturned,
      bytes_indexed: sessionStats.bytesIndexed,
      bytes_sandboxed: sessionStats.bytesSandboxed,
      cache_hits: sessionStats.cacheHits,
      cache_bytes_saved: sessionStats.cacheBytesSaved,
      kept_out: keptOut,
      total_processed: totalProcessed,
      reduction_pct: reductionPct,
      tokens_saved: tokensSaved,
      dollars_saved_session: +(tokensSaved * OPUS_INPUT_PRICE_PER_TOKEN).toFixed(2),
      tokens_saved_lifetime: lifetimeTokens,
      dollars_saved_lifetime: +(lifetimeTokens * OPUS_INPUT_PRICE_PER_TOKEN).toFixed(2),
      by_tool: Object.fromEntries(
        Object.keys({ ...sessionStats.calls, ...sessionStats.bytesReturned }).map(
          (t) => [
            t,
            {
              calls: sessionStats.calls[t] || 0,
              bytes: sessionStats.bytesReturned[t] || 0,
            },
          ],
        ),
      ),
    };

    const filePath = getStatsFilePath();
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload));
    renameSync(tmpPath, filePath);
  } catch (err) {
    console.warn("renameSync failed", err);
  }
}

// ── Version check startup ──────────────────────────────────

export function startVersionCheck(): void {
  fetchLatestVersion().then(v => { if (v !== "unknown") _latestVersion = v; });
  setInterval(() => {
    fetchLatestVersion().then(v => { if (v !== "unknown") _latestVersion = v; });
  }, 60 * 60 * 1000).unref();
}

// ── Stats restore on startup ───────────────────────────────

export function restoreStatsOnStartup(): void {
  try {
    const restored = restoreSessionStats(getSessionDbPath());
    if (restored) {
      for (const [tool, count] of Object.entries(restored.calls)) {
        sessionStats.calls[tool] = count;
      }
      for (const [tool, bytes] of Object.entries(restored.bytesReturned)) {
        sessionStats.bytesReturned[tool] = bytes;
      }
      if (restored.sessionStart > 0) {
        sessionStats.sessionStart = restored.sessionStart;
      }
    }
  } catch (e) { console.warn("restoreStatsOnStartup failed", e) }
}

// ── FS read tracking preload for ctx_batch_execute ──────────

export const CM_FS_PRELOAD = join(tmpdir(), `cm-fs-preload-${process.pid}.js`);

export function writeFsPreload(): void {
  writeFileSync(
    CM_FS_PRELOAD,
    `(function(){var __cm_fs=0;process.on('exit',function(){if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch(e){}});try{var f=require('fs');var ors=f.readFileSync;f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};}catch(e){}})();\n`,
  );
}
