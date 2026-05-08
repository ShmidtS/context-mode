function d(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}var D=10;function m(t,e=4){return[...new Set(t.filter(i=>i.length>0))].slice(0,e).map(i=>i.length>80?i.slice(0,80):i)}function S(t,e){if(e.length===0)return"";let r=e.map(n=>`"${d(n)}"`).join(", ");return`
    For full details:
    ${d(t)}(
      queries: [${r}],
      source: "session-events"
    )`}function J(t,e){if(t.length===0)return"";let r=new Map;for(let a of t){let h=a.data,p=r.get(h);p||(p={ops:new Map},r.set(h,p));let g;a.type==="file_write"?g="write":a.type==="file_read"?g="read":a.type==="file_edit"?g="edit":g=a.type,p.ops.set(g,(p.ops.get(g)??0)+1)}let i=Array.from(r.entries()).slice(-D),c=[],u=[];for(let[a,{ops:h}]of i){let p=Array.from(h.entries()).map(([v,y])=>`${v}\xD7${y}`).join(", "),g=a.split("/").pop()??a;c.push(`    ${d(g)} (${d(p)})`),u.push(`${g} ${Array.from(h.keys()).join(" ")}`)}let s=m(u);return[`  <files count="${r.size}">`,...c,S(e,s),"  </files>"].join(`
`)}function b(t,e,r,n=!1){if(t.length===0)return"";let i=n?new Set:void 0,c=[],u=[];for(let a of t)i?.has(a.data)||(i?.add(a.data),c.push(`    ${d(a.data)}`),u.push(a.data));if(c.length===0)return"";let s=m(u);return[`  <${e} count="${c.length}">`,...c,S(r,s),`  </${e}>`].join(`
`)}function R(t,e){return b(t,"errors",e)}function F(t,e){return b(t,"decisions",e,!0)}function B(t,e){return b(t,"rules",e,!0)}function X(t,e){return b(t,"git",e)}function z(t){if(t.length===0)return"";let e=[],r={};for(let s of t)try{let o=JSON.parse(s.data);typeof o.subject=="string"?e.push(o.subject):typeof o.taskId=="string"&&typeof o.status=="string"&&(r[o.taskId]=o.status)}catch(o){console.warn("parseCreateEvents JSON parse failed",o)}if(e.length===0)return"";let n=new Set(["completed","deleted","failed"]),i=Object.keys(r).sort((s,o)=>Number(s)-Number(o)),c=[];for(let s=0;s<e.length;s++){let o=i[s],a=o?r[o]??"pending":"pending";n.has(a)||c.push(e[s])}if(c.length===0)return"";let u=[];for(let s of c)u.push(`    [pending] ${d(s)}`);return u.join(`
`)}function Q(t,e){let r=z(t);if(!r)return"";let n=[];for(let s of t)try{let o=JSON.parse(s.data);typeof o.subject=="string"&&n.push(o.subject)}catch(o){console.warn("extractQueryTerms JSON parse failed",o)}let i=m(n);return[`  <task_state count="${r.split(`
`).length}">`,r,S(e,i),"  </task_state>"].join(`
`)}function U(t,e,r){if(t.length===0&&e.length===0)return"";let n=[],i=[];if(t.length>0){let s=t[t.length-1];n.push(`    cwd: ${d(s.data)}`),i.push("working directory")}for(let s of e)n.push(`    ${d(s.data)}`),i.push(s.data);let c=m(i);return["  <environment>",...n,S(r,c),"  </environment>"].join(`
`)}function V(t,e){if(t.length===0)return"";let r=[],n=[];for(let u of t){let s=u.type==="subagent_completed"?"completed":u.type==="subagent_launched"?"launched":"unknown";r.push(`    [${s}] ${d(u.data)}`),n.push(`subagent ${u.data}`)}let i=m(n);return[`  <subagents count="${t.length}">`,...r,S(e,i),"  </subagents>"].join(`
`)}function G(t,e){if(t.length===0)return"";let r=new Map;for(let s of t){let o=s.data.split(":")[0].trim();r.set(o,(r.get(o)??0)+1)}let n=[],i=[];for(let[s,o]of r)n.push(`    ${d(s)} (${o}\xD7)`),i.push(`skill ${s} invocation`);let c=m(i);return[`  <skills count="${t.length}">`,...n,S(e,c),"  </skills>"].join(`
`)}function P(t,e){return b(t,"roles",e,!0)}function H(t){if(t.length===0)return"";let e=t[t.length-1];return`  <intent mode="${d(e.data)}"/>`}function Y(t,e){let r=e?.compactCount??1,n=e?.searchTool??"ctx_search",i=new Date().toISOString(),c=[],u=[],s=[],o=[],a=[],h=[],p=[],g=[],v=[],y=[],k=[],E=[];for(let l of t)switch(l.category){case"file":c.push(l);break;case"task":u.push(l);break;case"rule":s.push(l);break;case"decision":o.push(l);break;case"cwd":a.push(l);break;case"error":h.push(l);break;case"env":p.push(l);break;case"git":g.push(l);break;case"subagent":v.push(l);break;case"intent":y.push(l);break;case"skill":k.push(l);break;case"role":E.push(l);break;default:process.env.NODE_ENV!=="production"&&console.warn(`[snapshot] Unhandled category: ${l.category}`);break}let f=[];f.push(`  <how_to_search>
  Each section below contains a summary of prior work.
  For FULL DETAILS, run the exact tool call shown under each section.
  Do NOT ask the user to re-explain prior work. Search first.
  Do NOT invent your own queries \u2014 use the ones provided.
  </how_to_search>`);let $=J(c,n);$&&f.push($);let w=R(h,n);w&&f.push(w);let _=F(o,n);_&&f.push(_);let L=B(s,n);L&&f.push(L);let j=X(g,n);j&&f.push(j);let q=Q(u,n);q&&f.push(q);let T=U(a,p,n);T&&f.push(T);let N=V(v,n);N&&f.push(N);let O=G(k,n);O&&f.push(O);let C=P(E,n);C&&f.push(C);let I=H(y);I&&f.push(I);let M=`<session_resume events="${t.length}" compact_count="${r}" generated_at="${i}">`,x="</session_resume>",A=f.join(`

`);return A?`${M}

${A}

${x}`:`${M}
${x}`}export{Y as buildResumeSnapshot,z as renderTaskState};
