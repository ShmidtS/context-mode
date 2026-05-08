import{createRequire as I}from"node:module";import{existsSync as k,unlinkSync as N,renameSync as U}from"node:fs";import{tmpdir as M}from"node:os";import{join as x}from"node:path";var T=class{#t;constructor(t){this.#t=t}pragma(t){let n=this.#t.prepare(`PRAGMA ${t}`).all();if(!n||n.length===0)return;if(n.length>1)return n;let r=Object.values(n[0]);return r.length===1?r[0]:n[0]}exec(t){let e="",n=null;for(let i=0;i<t.length;i++){let a=t[i];if(n)e+=a,a===n&&(n=null);else if(a==="'"||a==='"')e+=a,n=a;else if(a===";"){let c=e.trim();c&&this.#t.prepare(c).run(),e=""}else e+=a}let r=e.trim();return r&&this.#t.prepare(r).run(),this}prepare(t){let e=this.#t.prepare(t);return{run:(...n)=>e.run(...n),get:(...n)=>{let r=e.get(...n);return r===null?void 0:r},all:(...n)=>e.all(...n),iterate:(...n)=>e.iterate(...n)}}transaction(t){return this.#t.transaction(t)}close(){this.#t.close()}},h=class{#t;constructor(t){this.#t=t}pragma(t){let n=this.#t.prepare(`PRAGMA ${t}`).all();if(!n||n.length===0)return;if(n.length>1)return n;let r=Object.values(n[0]);return r.length===1?r[0]:n[0]}exec(t){return this.#t.exec(t),this}prepare(t){let e=this.#t.prepare(t);return{run:(...n)=>e.run(...n),get:(...n)=>e.get(...n),all:(...n)=>e.all(...n),iterate:(...n)=>typeof e.iterate=="function"?e.iterate(...n):e.all(...n)[Symbol.iterator]()}}transaction(t){return(...e)=>{this.#t.exec("BEGIN");try{let n=t(...e);return this.#t.exec("COMMIT"),n}catch(n){throw this.#t.exec("ROLLBACK"),n}}}close(){this.#t.close()}},d=null;function B(){if(!d){let o=I(import.meta.url);if(globalThis.Bun){let t=o(["bun","sqlite"].join(":")).Database;d=function(n,r){let i=new t(n,{readonly:r?.readonly,create:!0}),a=new T(i);return r?.timeout&&a.pragma(`busy_timeout = ${r.timeout}`),a}}else if(process.platform==="linux")try{let{DatabaseSync:t}=o(["node","sqlite"].join(":"));d=function(n,r){let i=new t(n,{readOnly:r?.readonly??!1});return new h(i)}}catch{d=o("better-sqlite3")}else d=o("better-sqlite3")}return d}function R(o){o.pragma("journal_mode = WAL"),o.pragma("synchronous = NORMAL");try{o.pragma("mmap_size = 268435456")}catch(t){console.warn("applyWALPragmas mmap_size failed",t)}}function w(o){if(!k(o))for(let t of["-wal","-shm"])try{N(o+t)}catch(e){console.warn("cleanOrphanedWALFiles unlink failed",e)}}function F(o){for(let t of["","-wal","-shm"])try{N(o+t)}catch(e){console.warn("deleteDBFiles unlink failed",e)}}function f(o){try{o.pragma("wal_checkpoint(TRUNCATE)")}catch(t){console.warn("closeDB wal_checkpoint failed",t)}try{o.close()}catch(t){console.warn("closeDB db.close failed",t)}}function v(o="context-mode"){return x(M(),`${o}-${process.pid}.db`)}function P(o,t=[100,500,2e3]){let e;for(let n=0;n<=t.length;n++)try{return o()}catch(r){let i=r instanceof Error?r.message:String(r);if(!i.includes("SQLITE_BUSY")&&!i.includes("database is locked"))throw r;if(e=r instanceof Error?r:new Error(i),n<t.length){let a=t[n];Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,a)}}throw new Error(`SQLITE_BUSY: database is locked after ${t.length} retries. Original error: ${e?.message}`)}function j(o){return o.includes("SQLITE_CORRUPT")||o.includes("SQLITE_NOTADB")||o.includes("database disk image is malformed")||o.includes("file is not a database")}function X(o){let t=Date.now();for(let e of["","-wal","-shm"])try{U(o+e,`${o}${e}.corrupt-${t}`)}catch(n){console.warn("renameCorruptDB rename failed",n)}}var m=Symbol.for("__context_mode_live_dbs__"),g=(()=>{let o=globalThis;return o[m]||(o[m]=new Set,process.on("exit",()=>{for(let t of o[m])f(t);o[m].clear()})),o[m]})(),p=class{_dbPath;_db;constructor(t){let e=B();this._dbPath=t,w(t);let n;try{n=new e(t,{timeout:3e4}),R(n)}catch(r){let i=r instanceof Error?r.message:String(r);if(j(i)){X(t),w(t);try{n=new e(t,{timeout:3e4}),R(n)}catch(a){throw new Error(`Failed to create fresh DB after renaming corrupt file: ${a instanceof Error?a.message:String(a)}`)}}else throw r}this._db=n,g.add(this._db),this.initSchema(),this.prepareStatements()}get db(){return this._db}get dbPath(){return this._dbPath}close(){g.delete(this._db),f(this._db)}withRetry(t){return P(t)}cleanup(){g.delete(this._db),f(this._db),F(this._dbPath)}};import{createHash as S}from"node:crypto";import{execFileSync as W}from"node:child_process";var l;function z(){let o=process.env.CONTEXT_MODE_SESSION_SUFFIX,t=process.cwd();if(l&&l.cwd===t&&l.envSuffix===o)return l.suffix;let e="";if(o!==void 0)e=o?`__${o}`:"";else try{let n=W("git",["worktree","list","--porcelain"],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).split(/\r?\n/).find(r=>r.startsWith("worktree "))?.replace("worktree ","")?.trim();n&&t!==n&&(e=`__${S("sha256").update(t).digest("hex").slice(0,8)}`)}catch(n){console.warn("getWorktreeSuffix failed",n)}return l={cwd:t,envSuffix:o,suffix:e},e}function J(){l=void 0}var D=1e3,C=5,s={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",getLatestAttributedProject:"getLatestAttributedProject",checkDuplicate:"checkDuplicate",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",incrementCompactCount:"incrementCompactCount",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",claimLatestUnconsumedResume:"claimLatestUnconsumedResume",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions",searchEvents:"searchEvents",incrementToolCall:"incrementToolCall",getToolCallTotals:"getToolCallTotals",getToolCallByTool:"getToolCallByTool"},O=class extends p{constructor(t){super(t?.dbPath??v("session"))}stmt(t){return this.stmts.get(t)}initSchema(){try{let e=this.db.pragma("table_xinfo(session_events)").find(n=>n.name==="data_hash");e&&e.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch(t){console.warn("initSchema table_xinfo failed",t)}this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        attribution_source TEXT NOT NULL DEFAULT 'unknown',
        attribution_confidence REAL NOT NULL DEFAULT 0,
        source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        data_hash TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_resume (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, tool)
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    `);try{let t=this.db.pragma("table_xinfo(session_events)"),e=new Set(t.map(n=>n.name));e.has("project_dir")||this.db.exec("ALTER TABLE session_events ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''"),e.has("attribution_source")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'unknown'"),e.has("attribution_confidence")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_confidence REAL NOT NULL DEFAULT 0"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)")}catch(t){console.warn("session_events failed",t)}}prepareStatements(){this.stmts=new Map;let t=(e,n)=>{this.stmts.set(e,this.db.prepare(n))};t(s.insertEvent,`INSERT INTO session_events (
         session_id, type, category, priority, data,
         project_dir, attribution_source, attribution_confidence,
         source_hook, data_hash
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),t(s.getEvents,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`),t(s.getEventsByType,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`),t(s.getEventsByPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(s.getEventsByTypeAndPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(s.getEventCount,"SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?"),t(s.getLatestAttributedProject,`SELECT project_dir
       FROM session_events
       WHERE session_id = ? AND project_dir != ''
       ORDER BY id DESC
       LIMIT 1`),t(s.checkDuplicate,`SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`),t(s.evictLowestPriority,`DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`),t(s.updateMetaLastEvent,`UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`),t(s.ensureSession,"INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)"),t(s.getSessionStats,`SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`),t(s.incrementCompactCount,"UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?"),t(s.upsertResume,`INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`),t(s.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),t(s.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),t(s.claimLatestUnconsumedResume,`UPDATE session_resume
       SET consumed = 1
       WHERE id = (
         SELECT id FROM session_resume
         WHERE consumed = 0
           AND session_id != ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       RETURNING session_id, snapshot`),t(s.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),t(s.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),t(s.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),t(s.searchEvents,`SELECT id, session_id, category, type, data, created_at
       FROM session_events
       WHERE project_dir = ?
         AND (data LIKE '%' || ? || '%' ESCAPE '\\' OR category LIKE '%' || ? || '%' ESCAPE '\\')
         AND (? IS NULL OR category = ?)
       ORDER BY id ASC
       LIMIT ?`),t(s.getOldSessions,"SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')"),t(s.incrementToolCall,`INSERT INTO tool_calls (session_id, tool, calls, bytes_returned)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id, tool) DO UPDATE SET
         calls = calls + 1,
         bytes_returned = bytes_returned + excluded.bytes_returned,
         updated_at = datetime('now')`),t(s.getToolCallTotals,`SELECT COALESCE(SUM(calls), 0) AS calls,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM tool_calls WHERE session_id = ?`),t(s.getToolCallByTool,`SELECT tool, calls, bytes_returned
       FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`)}insertEvent(t,e,n="PostToolUse",r){let i=S("sha256").update(e.data).digest("hex").slice(0,16).toUpperCase(),a=String(r?.projectDir??e.project_dir??"").trim(),c=String(r?.source??e.attribution_source??"unknown"),u=Number(r?.confidence??e.attribution_confidence??0),_=Number.isFinite(u)?Math.max(0,Math.min(1,u)):0,E=this.db.transaction(()=>{if(this.stmt(s.checkDuplicate).get(t,C,e.type,i))return;this.stmt(s.getEventCount).get(t).cnt>=D&&this.stmt(s.evictLowestPriority).run(t),this.stmt(s.insertEvent).run(t,e.type,e.category,e.priority,e.data,a,c,_,n,i),this.stmt(s.updateMetaLastEvent).run(t)});this.withRetry(()=>E())}bulkInsertEvents(t,e,n="PostToolUse",r){if(!e||e.length===0)return;if(e.length===1){this.insertEvent(t,e[0],n,r?.[0]);return}let i=e.map((c,u)=>{let _=S("sha256").update(c.data).digest("hex").slice(0,16).toUpperCase(),E=r?.[u],b=String(E?.projectDir??c.project_dir??"").trim(),y=String(E?.source??c.attribution_source??"unknown"),L=Number(E?.confidence??c.attribution_confidence??0),A=Number.isFinite(L)?Math.max(0,Math.min(1,L)):0;return{event:c,dataHash:_,projectDir:b,attributionSource:y,attributionConfidence:A}}),a=this.db.transaction(()=>{let c=this.stmt(s.getEventCount).get(t).cnt;for(let u of i)this.stmt(s.checkDuplicate).get(t,C,u.event.type,u.dataHash)||(c>=D?this.stmt(s.evictLowestPriority).run(t):c++,this.stmt(s.insertEvent).run(t,u.event.type,u.event.category,u.event.priority,u.event.data,u.projectDir,u.attributionSource,u.attributionConfidence,n,u.dataHash));this.stmt(s.updateMetaLastEvent).run(t)});this.withRetry(()=>a())}getEvents(t,e){let n=e?.limit??1e3,r=e?.type,i=e?.minPriority;return r&&i!==void 0?this.stmt(s.getEventsByTypeAndPriority).all(t,r,i,n):r?this.stmt(s.getEventsByType).all(t,r,n):i!==void 0?this.stmt(s.getEventsByPriority).all(t,i,n):this.stmt(s.getEvents).all(t,n)}getEventCount(t){return this.stmt(s.getEventCount).get(t).cnt}getLatestAttributedProjectDir(t){return this.stmt(s.getLatestAttributedProject).get(t)?.project_dir||null}searchEvents(t,e,n,r){try{let i=t.replace(/[%_]/g,c=>"\\"+c),a=r??null;return this.stmt(s.searchEvents).all(n,i,i,a,a,e)}catch{return[]}}ensureSession(t,e){this.stmt(s.ensureSession).run(t,e)}getSessionStats(t){return this.stmt(s.getSessionStats).get(t)??null}incrementCompactCount(t){this.stmt(s.incrementCompactCount).run(t)}upsertResume(t,e,n){this.stmt(s.upsertResume).run(t,e,n??0)}getResume(t){return this.stmt(s.getResume).get(t)??null}markResumeConsumed(t){this.stmt(s.markResumeConsumed).run(t)}claimLatestUnconsumedResume(t){let e=this.stmt(s.claimLatestUnconsumedResume).get(t);return e?{sessionId:e.session_id,snapshot:e.snapshot}:null}getLatestSessionId(){try{return this.db.prepare("SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1").get()?.session_id??null}catch{return null}}incrementToolCall(t,e,n=0){let r=Number.isFinite(n)&&n>0?Math.round(n):0;try{this.stmt(s.incrementToolCall).run(t,e,r)}catch(i){console.warn("safeBytes failed",i)}}getToolCallStats(t){try{let e=this.stmt(s.getToolCallTotals).get(t),n=this.stmt(s.getToolCallByTool).all(t),r={};for(let i of n)r[i.tool]={calls:i.calls,bytesReturned:i.bytes_returned};return{totalCalls:e?.calls??0,totalBytesReturned:e?.bytes_returned??0,byTool:r}}catch{return{totalCalls:0,totalBytesReturned:0,byTool:{}}}}deleteSession(t){this.db.transaction(()=>{this.stmt(s.deleteEvents).run(t),this.stmt(s.deleteResume).run(t),this.stmt(s.deleteMeta).run(t)})()}cleanupOldSessions(t=7){let e=`-${t}`,n=this.stmt(s.getOldSessions).all(e);for(let{session_id:r}of n)this.deleteSession(r);return n.length}};export{O as SessionDB,J as _resetWorktreeSuffixCacheForTests,z as getWorktreeSuffix};
