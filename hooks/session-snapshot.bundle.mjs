function d(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}var x=10;function m(t,n=4){return[...new Set(t.filter(o=>o.length>0))].slice(0,n).map(o=>o.length>80?o.slice(0,80):o)}function S(t,n){if(n.length===0)return"";let r=n.map(e=>`"${d(e)}"`).join(", ");return`
    For full details:
    ${d(t)}(
      queries: [${r}],
      source: "session-events"
    )`}function R(t,n){if(t.length===0)return"";let r=new Map;for(let a of t){let h=a.data,p=r.get(h);p||(p={ops:new Map},r.set(h,p));let f;a.type==="file_write"?f="write":a.type==="file_read"?f="read":a.type==="file_edit"?f="edit":f=a.type,p.ops.set(f,(p.ops.get(f)??0)+1)}let o=Array.from(r.entries()).slice(-x),c=[],u=[];for(let[a,{ops:h}]of o){let p=Array.from(h.entries()).map(([v,y])=>`${v}\xD7${y}`).join(", "),f=a.split("/").pop()??a;c.push(`    ${d(f)} (${d(p)})`),u.push(`${f} ${Array.from(h.keys()).join(" ")}`)}let s=m(u);return[`  <files count="${r.size}">`,...c,S(n,s),"  </files>"].join(`
`)}function b(t,n,r,e=!1){if(t.length===0)return"";let o=e?new Set:void 0,c=[],u=[];for(let a of t)o?.has(a.data)||(o?.add(a.data),c.push(`    ${d(a.data)}`),u.push(a.data));if(c.length===0)return"";let s=m(u);return[`  <${n} count="${c.length}">`,...c,S(r,s),`  </${n}>`].join(`
`)}function F(t,n){return b(t,"errors",n)}function B(t,n){return b(t,"decisions",n,!0)}function J(t,n){return b(t,"rules",n,!0)}function X(t,n){return b(t,"git",n)}function z(t){if(t.length===0)return"";let n=[],r={};for(let s of t)try{let i=JSON.parse(s.data);typeof i.subject=="string"?n.push(i.subject):typeof i.taskId=="string"&&typeof i.status=="string"&&(r[i.taskId]=i.status)}catch{}if(n.length===0)return"";let e=new Set(["completed","deleted","failed"]),o=Object.keys(r).sort((s,i)=>Number(s)-Number(i)),c=[];for(let s=0;s<n.length;s++){let i=o[s],a=i?r[i]??"pending":"pending";e.has(a)||c.push(n[s])}if(c.length===0)return"";let u=[];for(let s of c)u.push(`    [pending] ${d(s)}`);return u.join(`
`)}function U(t,n){let r=z(t);if(!r)return"";let e=[];for(let s of t)try{let i=JSON.parse(s.data);typeof i.subject=="string"&&e.push(i.subject)}catch{}let o=m(e);return[`  <task_state count="${r.split(`
`).length}">`,r,S(n,o),"  </task_state>"].join(`
`)}function V(t,n,r){if(t.length===0&&n.length===0)return"";let e=[],o=[];if(t.length>0){let s=t[t.length-1];e.push(`    cwd: ${d(s.data)}`),o.push("working directory")}for(let s of n)e.push(`    ${d(s.data)}`),o.push(s.data);let c=m(o);return["  <environment>",...e,S(r,c),"  </environment>"].join(`
`)}function G(t,n){if(t.length===0)return"";let r=[],e=[];for(let u of t){let s=u.type==="subagent_completed"?"completed":u.type==="subagent_launched"?"launched":"unknown";r.push(`    [${s}] ${d(u.data)}`),e.push(`subagent ${u.data}`)}let o=m(e);return[`  <subagents count="${t.length}">`,...r,S(n,o),"  </subagents>"].join(`
`)}function P(t,n){if(t.length===0)return"";let r=new Map;for(let s of t){let i=s.data.split(":")[0].trim();r.set(i,(r.get(i)??0)+1)}let e=[],o=[];for(let[s,i]of r)e.push(`    ${d(s)} (${i}\xD7)`),o.push(`skill ${s} invocation`);let c=m(o);return[`  <skills count="${t.length}">`,...e,S(n,c),"  </skills>"].join(`
`)}function Q(t,n){return b(t,"roles",n,!0)}function H(t){if(t.length===0)return"";let n=t[t.length-1];return`  <intent mode="${d(n.data)}"/>`}function Y(t,n){let r=n?.compactCount??1,e=n?.searchTool??"ctx_search",o=new Date().toISOString(),c=[],u=[],s=[],i=[],a=[],h=[],p=[],f=[],v=[],y=[],k=[],E=[];for(let l of t)switch(l.category){case"file":c.push(l);break;case"task":u.push(l);break;case"rule":s.push(l);break;case"decision":i.push(l);break;case"cwd":a.push(l);break;case"error":h.push(l);break;case"env":p.push(l);break;case"git":f.push(l);break;case"subagent":v.push(l);break;case"intent":y.push(l);break;case"skill":k.push(l);break;case"role":E.push(l);break;default:process.env.NODE_ENV!=="production"&&console.warn(`[snapshot] Unhandled category: ${l.category}`);break}let g=[];g.push(`  <how_to_search>
  Each section below contains a summary of prior work.
  For FULL DETAILS, run the exact tool call shown under each section.
  Do NOT ask the user to re-explain prior work. Search first.
  Do NOT invent your own queries \u2014 use the ones provided.
  </how_to_search>`);let $=R(c,e);$&&g.push($);let w=F(h,e);w&&g.push(w);let _=B(i,e);_&&g.push(_);let L=J(s,e);L&&g.push(L);let j=X(f,e);j&&g.push(j);let q=U(u,e);q&&g.push(q);let T=V(a,p,e);T&&g.push(T);let N=G(v,e);N&&g.push(N);let O=P(k,e);O&&g.push(O);let C=Q(E,e);C&&g.push(C);let I=H(y);I&&g.push(I);let M=`<session_resume events="${t.length}" compact_count="${r}" generated_at="${o}">`,A="</session_resume>",D=g.join(`

`);return D?`${M}

${D}

${A}`:`${M}
${A}`}export{Y as buildResumeSnapshot,z as renderTaskState};
