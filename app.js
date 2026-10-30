(function () {
"use strict";
const $ = s => document.querySelector(s);
const CFG = window.APP_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const WD = ["Svētdiena","Pirmdiena","Otrdiena","Trešdiena","Ceturtdiena","Piektdiena","Sestdiena"];
const MON = ["janvāris","februāris","marts","aprīlis","maijs","jūnijs","jūlijs","augusts","septembris","oktobris","novembris","decembris"];
const KIND = { basal:"Ilgais insulīns", bolus:"Īsais insulīns", meal:"Ēdiens", glucose:"Cukurs", tablets:"Glikozes tabl.", note:"Piezīme" };
const ROLE = { owner:"Īpašniece", family:"Ģimene", caregiver:"Aprūpētājs" };
const LO = 3.9, HI = 10;

let booted = false;
let user = null, memberships = [], child = null, role = null, members = {}, gPerMv = 12;
let cur = todayStr(), entries = [], cgmDay = null, channel = null, view = "day";
let period = { from: shift(todayStr(), -6), to: todayStr() }, pEntries = [], pByDay = {}, pCgm = {};

/* ---------- helpers ---------- */
function pad(n){ return String(n).padStart(2,"0"); }
function todayStr(d){ d = d || new Date(); return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); }
function nowTime(){ const d = new Date(); return pad(d.getHours())+":"+pad(d.getMinutes()); }
function shift(ds,n){ const [y,m,d] = ds.split("-").map(Number); return todayStr(new Date(y,m-1,d+n)); }
function num(v){ if (v === null || v === undefined || v === "") return null; const n = parseFloat(String(v).replace(",",".")); return isNaN(n) ? null : n; }
function fmt(n,dp){ if (n === null || n === undefined || isNaN(n)) return ""; const f = Math.pow(10, dp === undefined ? 2 : dp); return String(Math.round(n*f)/f).replace(".",","); }
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function prettyDate(ds){ const [y,m,d] = ds.split("-").map(Number); const dt = new Date(y,m-1,d); return WD[dt.getDay()]+", "+d+". "+MON[m-1]; }
function shortDate(ds){ return ds.slice(8)+"."+ds.slice(5,7)+"."; }
function toast(t){ const el = document.createElement("div"); el.className = "toast"; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 2600); }
function show(id){ ["scrAuth","scrOnboard","scrMain"].forEach(s => $("#"+s).hidden = s !== id); }
function canEdit(e){ return role === "owner" || role === "family" || (e && e.created_by === user.id); }
function canCgm(){ return role === "owner" || role === "family"; }
async function fnError(error){
  try { const j = await error.context.json(); return j.error || "Kļūda"; } catch (_) { return (error && error.message) || "Kļūda"; }
}

/* ---------- invite link handling ---------- */
function tokenFrom(s){ const m = String(s||"").match(/invite=([a-f0-9]{32,80})/i) || String(s||"").trim().match(/^([a-f0-9]{32,80})$/i); return m ? m[1] : null; }
(function grabInvite(){
  const t = tokenFrom(location.search);
  if (t) {
    try { localStorage.setItem("pendingInvite", t); } catch (_) {}
    history.replaceState(null, "", location.pathname);
  }
})();
function pendingInvite(){ try { return localStorage.getItem("pendingInvite"); } catch (_) { return null; } }
function clearInvite(){ try { localStorage.removeItem("pendingInvite"); } catch (_) {} }

/* ---------- auth ---------- */
let mode = "in";
function setMode(m){
  mode = m;
  $("#tabIn").setAttribute("aria-selected", m === "in");
  $("#tabUp").setAttribute("aria-selected", m === "up");
  $("#lblName").hidden = m !== "up";
  $("#aPass").autocomplete = m === "up" ? "new-password" : "current-password";
  $("#aSubmit").textContent = m === "up" ? "Izveidot kontu" : "Pieslēgties";
  $("#aMsg").textContent = ""; $("#aMsg").className = "formmsg";
}
$("#tabIn").onclick = () => setMode("in");
$("#tabUp").onclick = () => setMode("up");
$("#authForm").onsubmit = async ev => {
  ev.preventDefault();
  const email = $("#aEmail").value.trim().toLowerCase(), password = $("#aPass").value;
  const msg = $("#aMsg"); msg.className = "formmsg";
  if (!email || password.length < 8) { msg.textContent = "Ievadi e-pastu un paroli (vismaz 8 simboli)."; return; }
  const btn = $("#aSubmit"); btn.disabled = true;
  try {
    if (mode === "up") {
      const name = $("#aName").value.trim();
      if (!name) { msg.textContent = "Ievadi savu vārdu."; return; }
      try { localStorage.setItem("myName", name); } catch (_) {}
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (!data.session) { msg.className = "formmsg ok"; msg.textContent = "Konts izveidots. Pārbaudi e-pastu un apstiprini to, tad pieslēdzies."; }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (e) {
    const m = (e && e.message) || "";
    msg.textContent = /invalid login/i.test(m) ? "Nepareizs e-pasts vai parole."
      : /already registered/i.test(m) ? "Šim e-pastam jau ir konts — pieslēdzies."
      : /email not confirmed/i.test(m) ? "E-pasts vēl nav apstiprināts."
      : /rate limit/i.test(m) ? "Pārāk daudz mēģinājumu, pagaidi brīdi."
      : "Neizdevās: " + m;
  } finally { btn.disabled = false; }
};

sb.auth.onAuthStateChange((evt, session) => {
  const u = session ? session.user : null;
  if (booted && (u && u.id) === (user && user.id)) return;
  booted = true; user = u;
  setTimeout(boot, 0);
});

async function boot(){
  if (!user) {
    $("#authInviteNote").hidden = !pendingInvite();
    if (pendingInvite()) setMode("up");
    show("scrAuth"); return;
  }
  const inv = pendingInvite();
  if (inv) {
    const nm = myDefaultName();
    const { error } = await sb.rpc("accept_invite", { p_token: inv, p_display_name: nm });
    clearInvite();
    if (error) toast("Ielūgums nav derīgs vai ir beidzies"); else toast("Ielūgums pieņemts");
  }
  await loadMemberships();
  if (!memberships.length) { show("scrOnboard"); $("#obMe").value = myDefaultName(); return; }
  let pick = null; try { pick = localStorage.getItem("child"); } catch (_) {}
  const m = memberships.find(x => x.child_id === pick) || memberships[0];
  await selectChild(m.child_id);
  show("scrMain");
}
function myDefaultName(){
  let n = ""; try { n = localStorage.getItem("myName") || ""; } catch (_) {}
  return n || (user && user.user_metadata && user.user_metadata.display_name) || "";
}

async function loadMemberships(){
  const { data, error } = await sb.from("members").select("child_id, role, display_name, children(name, g_per_mv, ai_enabled)").eq("user_id", user.id);
  memberships = error ? [] : (data || []);
}

/* ---------- onboarding ---------- */
$("#obForm").onsubmit = async ev => {
  ev.preventDefault();
  const name = $("#obChild").value.trim(), me = $("#obMe").value.trim();
  if (!name || !me) return;
  try { localStorage.setItem("myName", me); } catch (_) {}
  const { error } = await sb.rpc("create_child", { p_name: name, p_display_name: me });
  if (error) { $("#obMsg").textContent = "Neizdevās izveidot: " + error.message; return; }
  boot();
};
$("#obInvForm").onsubmit = async ev => {
  ev.preventDefault();
  const t = tokenFrom($("#obInv").value);
  if (!t) { $("#obMsg").textContent = "Saitē neatradu ielūgumu. Ielīmē visu saiti."; return; }
  try { localStorage.setItem("pendingInvite", t); } catch (_) {}
  boot();
};
$("#obSignOut").onclick = () => sb.auth.signOut();

/* ---------- child selection ---------- */
async function selectChild(id){
  const m = memberships.find(x => x.child_id === id);
  child = { id, name: m.children.name, ai: !!m.children.ai_enabled };
  $("#cam").hidden = !child.ai;
  $("#hint").textContent = child.ai ? "Runā vai raksti brīvā formā. Diktēšanai spied mikrofonu uz telefona tastatūras." : "Ieraksti brīvā formā un pēc tam pieskaries ierakstam, lai norādītu veidu un vērtības."; role = m.role; gPerMv = num(m.children.g_per_mv) || 12;
  try { localStorage.setItem("child", id); } catch (_) {}
  $("#childName").textContent = child.name;
  $("#roleLabel").textContent = (m.display_name ? m.display_name + " · " : "") + ROLE[role];
  const sel = $("#childSel");
  sel.hidden = memberships.length < 2;
  sel.innerHTML = memberships.map(x => `<option value="${x.child_id}" ${x.child_id === id ? "selected" : ""}>${esc(x.children.name)}</option>`).join("");
  $("#cgmImportCard").hidden = !canCgm();
  await loadMembers();
  subscribeRealtime();
  await loadDay();
  if (view === "stats") loadPeriod();
  if (view === "family") renderFamily();
}
$("#childSel").onchange = e => selectChild(e.target.value);

async function loadMembers(){
  const { data } = await sb.from("members").select("user_id, role, display_name, email").eq("child_id", child.id);
  members = {}; (data || []).forEach(r => members[r.user_id] = r);
}

/* ---------- realtime ---------- */
function subscribeRealtime(){
  if (channel) { sb.removeChannel(channel); channel = null; }
  channel = sb.channel("entries-" + child.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "entries", filter: "child_id=eq." + child.id }, p => {
      const d = (p.new && p.new.date) || (p.old && p.old.date);
      if (!d || d === cur || p.eventType === "DELETE") loadDay(true);
    })
    .subscribe();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && child) { if (cur !== todayStr() && lastToday !== todayStr()) { cur = todayStr(); } lastToday = todayStr(); loadDay(true); } });
let lastToday = todayStr();

/* ---------- day ---------- */
function renderDate(){
  const [y,m,d] = cur.split("-").map(Number); const dt = new Date(y,m-1,d);
  $("#wd").textContent = (cur === todayStr() ? "Šodien · " : "") + WD[dt.getDay()];
  $("#dayLabel").textContent = d + ". " + MON[m-1];
  $("#datePick").value = cur;
}
async function loadDay(quiet){
  renderDate();
  if (!quiet) $("#log").innerHTML = `<div class="empty"><strong>Ielādē…</strong></div>`;
  const want = cur;
  const [e, c] = await Promise.all([
    sb.from("entries").select("*").eq("child_id", child.id).eq("date", want),
    sb.from("cgm_days").select("t,v").eq("child_id", child.id).eq("date", want).maybeSingle()
  ]);
  if (want !== cur) return;
  if (e.error) { $("#log").innerHTML = `<div class="empty"><strong>Neizdevās ielādēt</strong>${esc(e.error.message)}</div>`; return; }
  entries = e.data || [];
  cgmDay = c.data ? { t: c.data.t.map(Number), v: c.data.v.map(Number) } : null;
  renderLog(); renderCgm();
}
$("#prev").onclick = () => { cur = shift(cur,-1); loadDay(); };
$("#next").onclick = () => { cur = shift(cur,1); loadDay(); };
$("#dateBtn").onclick = () => { const p = $("#datePick"); try { p.showPicker(); } catch (_) { p.focus(); p.click(); } };
$("#datePick").onchange = e => { if (e.target.value) { cur = e.target.value; loadDay(); } };

function sortE(a){ return a.slice().sort((x,y) => (x.time||"99").localeCompare(y.time||"99") || String(x.created_at||"").localeCompare(String(y.created_at||""))); }
function withMv(e){
  if (e.kind === "meal" && (e.mv === null || e.mv === undefined) && Array.isArray(e.items)) {
    const oh = e.items.reduce((s,i) => s + (num(i.oh)||0), 0);
    if (oh > 0) { e.mv = Math.round(oh/gPerMv*10)/10; e.mv_est = true; }
  }
  return e;
}
function lineFor(e, opts){
  const k = e.kind || "note"; let main = "";
  if (k === "basal" || k === "bolus") main = `<span class="big">${esc(e.insulin||"")} ${fmt(e.units)} v</span>`;
  else if (k === "meal") main = `<span class="big">${esc(e.meal||"Ēdienreize")}</span>${e.mv!=null?` <span class="big" style="color:var(--meal)">${e.mv_est?"≈":""}${fmt(e.mv,1)} MV</span>`:""}`;
  else if (k === "glucose") main = `<span class="big">${fmt(e.glucose,1)} mmol/l</span>`;
  else if (k === "tablets") main = `<span class="big">${fmt(e.count||1)} tab.</span>`;
  let items = "";
  if (k === "meal" && Array.isArray(e.items) && e.items.length) items = `<ul class="items">${e.items.map(i => {
    const r = []; if (i.g!=null && i.g!=="") r.push(esc(fmt(i.g,0))+" g"); if (i.oh!=null && i.oh!=="") r.push(esc(fmt(i.oh,0))+" g OH");
    return `<li><span>${esc(i.n)}</span><span>${r.join(" · ")}</span></li>`; }).join("")}</ul>`;
  const note = e.note ? `<div class="note">${esc(e.note)}</div>` : "";
  let bg = (k !== "glucose" && e.bg != null) ? ` <span class="bg">cukurs ${fmt(e.bg,1)}</span>` : "";
  if (!opts || !opts.preview) { const dx = cgmNear(e.time); if (dx != null) bg += ` <span class="bg dex">Dexcom ${fmt(dx,1)}</span>`; }
  const who = (!opts || !opts.preview) && Object.keys(members).length > 1 && e.created_by && members[e.created_by] ? `<div class="who">pievienoja ${esc(members[e.created_by].display_name || members[e.created_by].email || "")}</div>` : "";
  return `<div class="tm">${esc(e.time||"—")}</div><div class="body"><div class="line1"><span class="chip">${KIND[k]||k}</span>${main}${bg}</div>${items}${note}${who}</div>`;
}
function dayTotals(list){
  let bas=0,bol=0,mv=0,tab=0,gs=[];
  list.forEach(e => {
    if (e.kind==="basal") bas += num(e.units)||0;
    if (e.kind==="bolus") bol += num(e.units)||0;
    if (e.kind==="meal") mv += num(e.mv)||0;
    if (e.kind==="tablets") tab += num(e.count)||1;
    const g = e.kind==="glucose" ? num(e.glucose) : num(e.bg); if (g!=null) gs.push(g);
  });
  return { bas, bol, tdd: bas+bol, mv, tab, gAvg: gs.length ? gs.reduce((a,b)=>a+b,0)/gs.length : null, gN: gs.length };
}
function renderLog(){
  const log = $("#log"); const list = sortE(entries);
  if (!list.length) log.innerHTML = `<div class="empty"><strong>Šai dienai vēl nav ierakstu</strong>Nodiktē pirmo ierakstu apakšā, piemēram: “8:25 cukurs 7,2, Apidra viena vienība”, vai nofotografē glikometru.</div>`;
  else {
    log.innerHTML = "";
    list.forEach(e => { const b = document.createElement("button"); b.type = "button"; b.className = "row k-"+(e.kind||"note"); b.innerHTML = lineFor(e); b.onclick = () => openEdit(e); log.appendChild(b); });
  }
  const t = dayTotals(list);
  $("#tBasal").textContent = fmt(t.bas); $("#tBolus").textContent = fmt(t.bol); $("#tMv").textContent = fmt(t.mv,1); $("#tTab").textContent = fmt(t.tab);
}

/* ---------- Dexcom CGM ---------- */
function cgmNear(time){
  if (!cgmDay || !time) return null;
  const [h,m] = time.split(":").map(Number); const t = h*60+m; let best = null, bd = 8;
  cgmDay.t.forEach((x,i) => { const d = Math.abs(x-t); if (d < bd) { bd = d; best = cgmDay.v[i]; } });
  return best;
}
function cgmStats(list){
  let all = []; list.forEach(c => { if (c && Array.isArray(c.v)) all = all.concat(c.v.map(Number)); });
  if (!all.length) return null; const n = all.length;
  const lo = all.filter(v => v < LO).length, hi = all.filter(v => v > HI).length;
  return { n, avg: all.reduce((a,b)=>a+b,0)/n, tir: (n-lo-hi)/n*100, lo: lo/n*100, hi: hi/n*100, min: Math.min.apply(null,all), max: Math.max.apply(null,all) };
}
function fingerMarks(list){
  const out = []; list.forEach(e => { const g = e.kind==="glucose" ? num(e.glucose) : num(e.bg); if (g!=null && e.time) { const [h,m] = e.time.split(":").map(Number); out.push([h*60+m,g]); } }); return out;
}
function cgmSvg(c, marks, P){
  const W=600,H=170,L=30,R=8,T=8,B=20,ymin=2,ymax=20;
  const x = t => L+(t/1440)*(W-L-R), y = v => T+(1-(Math.min(Math.max(v,ymin),ymax)-ymin)/(ymax-ymin))*(H-T-B);
  let g = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Dexcom glikozes līkne">`;
  g += `<rect x="${L}" y="${y(HI)}" width="${W-L-R}" height="${y(LO)-y(HI)}" style="fill:${P.band}"/>`;
  [LO,HI].forEach(v => { g += `<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" style="stroke:${P.grid};stroke-width:1;stroke-dasharray:3 3"/><text x="${L-4}" y="${y(v)+4}" text-anchor="end" style="fill:${P.muted};font-size:11px">${fmt(v,1)}</text>`; });
  [0,6,12,18,24].forEach(hh => { g += `<line x1="${x(hh*60)}" x2="${x(hh*60)}" y1="${T}" y2="${H-B}" style="stroke:${P.grid};stroke-width:1"/><text x="${Math.min(Math.max(x(hh*60),L+14),W-R-16)}" y="${H-5}" text-anchor="middle" style="fill:${P.muted};font-size:11px">${pad(hh)}:00</text>`; });
  if (c && c.t) {
    let seg = [], prev = -99; const segs = [];
    c.t.forEach((t,i) => { if (t-prev > 16 && seg.length) { segs.push(seg); seg = []; } seg.push([t, Number(c.v[i])]); prev = t; }); if (seg.length) segs.push(seg);
    segs.forEach(sg => { g += `<polyline points="${sg.map(p => x(p[0]).toFixed(1)+","+y(p[1]).toFixed(1)).join(" ")}" style="fill:none;stroke:${P.line};stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>`; });
    c.t.forEach((t,i) => { const v = Number(c.v[i]); if (v < LO) g += `<circle cx="${x(t).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.2" style="fill:${P.low}"/>`; });
  }
  (marks||[]).forEach(m => { g += `<circle cx="${x(m[0]).toFixed(1)}" cy="${y(m[1]).toFixed(1)}" r="4.5" style="fill:${P.finger};stroke:${P.bg};stroke-width:1.5"/>`; });
  return g + `</svg>`;
}
const PAL_PAGE = { band:"var(--meal-soft)", grid:"var(--rule)", muted:"var(--muted)", line:"var(--blue)", low:"var(--danger)", finger:"var(--sugar)", bg:"var(--sheet)" };
const PAL_PRINT = { band:"#e3f2e8", grid:"#e6d8c2", muted:"#6b5d4f", line:"#2f6fc0", low:"#b42318", finger:"#bf4d23", bg:"#ffffff" };
function renderCgm(){
  const el = $("#cgmCard");
  if (!cgmDay || !cgmDay.v.length) { el.hidden = true; el.innerHTML = ""; return; }
  const S = cgmStats([cgmDay]); el.hidden = false;
  el.innerHTML = `<div class="cgmhead"><b>Dexcom</b><span class="cgmline">vid. <strong>${fmt(S.avg,1)}</strong> · diapazonā <strong>${fmt(S.tir,0)}%</strong> · zem 3,9 <strong>${fmt(S.lo,0)}%</strong> · virs 10 <strong>${fmt(S.hi,0)}%</strong></span></div>${cgmSvg(cgmDay, fingerMarks(entries), PAL_PAGE)}<div class="cgmline">Zaļā josla 3,9–10 mmol/l · oranžie punkti ir mērījumi no pirksta</div>`;
}
function splitCsv(line,d){
  const out = []; let c = "", q = false;
  for (let i = 0; i < line.length; i++) { const ch = line[i];
    if (q) { if (ch === '"') { if (line[i+1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true; else if (ch === d) { out.push(c); c = ""; } else c += ch; }
  out.push(c); return out;
}
function parseClarity(text){
  const lines = text.replace(/^﻿/,"").split(/\r?\n/);
  const hi = lines.findIndex(l => /timestamp/i.test(l) && /glucose/i.test(l));
  if (hi < 0) throw new Error("Failā neatradu Dexcom Clarity kolonnas (Timestamp, Glucose Value).");
  const head = lines[hi]; const d = head.split(";").length > head.split(",").length ? ";" : ",";
  const cols = splitCsv(head,d).map(c => c.trim());
  const ti = cols.findIndex(c => /timestamp/i.test(c)), gi = cols.findIndex(c => /glucose value/i.test(c)), ei = cols.findIndex(c => /event type/i.test(c));
  if (ti < 0 || gi < 0) throw new Error("Failā neatradu laika vai glikozes kolonnu.");
  const mg = /mg\/dl/i.test(cols[gi]); const by = {}; let n = 0;
  for (let i = hi+1; i < lines.length; i++) {
    if (!lines[i].trim()) continue; const r = splitCsv(lines[i], d);
    if (ei >= 0 && r[ei] && !/^\s*egv\s*$/i.test(r[ei])) continue;
    const m = (r[ti]||"").match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/); if (!m) continue;
    const raw = (r[gi]||"").trim(); if (!raw) continue; let v;
    if (/low/i.test(raw)) v = 2.2; else if (/high/i.test(raw)) v = 22.2; else { v = num(raw); if (v == null) continue; if (mg || v > 35) v = v/18.016; }
    v = Math.round(v*10)/10;
    const day = m[1]+"-"+m[2]+"-"+m[3], t = Number(m[4])*60+Number(m[5]);
    (by[day] = by[day] || {})[t] = v; n++;
  }
  return { by, n };
}
$("#cgmImport").onclick = () => $("#cgmFile").click();
$("#cgmFile").onchange = async ev => {
  const f = ev.target.files && ev.target.files[0]; ev.target.value = ""; if (!f) return;
  const st = $("#cgmImpStatus"), btn = $("#cgmImport"); btn.disabled = true;
  try {
    const { by, n } = parseClarity(await f.text());
    const days = Object.keys(by).sort();
    if (!days.length) throw new Error("Failā nav sensora mērījumu.");
    st.textContent = "Saglabā…";
    const { data: old } = await sb.from("cgm_days").select("date,t,v").eq("child_id", child.id).gte("date", days[0]).lte("date", days[days.length-1]);
    const oldBy = {}; (old || []).forEach(o => oldBy[o.date] = o);
    const rows = days.map(day => {
      const merged = {}; const o = oldBy[day]; if (o) o.t.forEach((t,i) => merged[t] = Number(o.v[i]));
      Object.assign(merged, by[day]);
      const ts = Object.keys(merged).map(Number).sort((a,b) => a-b);
      return { child_id: child.id, date: day, t: ts, v: ts.map(t => merged[t]), imported_at: new Date().toISOString() };
    });
    for (let i = 0; i < rows.length; i += 20) {
      const { error } = await sb.from("cgm_days").upsert(rows.slice(i, i+20), { onConflict: "child_id,date" });
      if (error) throw error;
      st.textContent = `Saglabā… ${Math.min(i+20, rows.length)} / ${rows.length} dienas`;
    }
    st.textContent = `Importēti ${n} mērījumi par ${days.length} dienām (${shortDate(days[0])}–${shortDate(days[days.length-1])}).`;
    toast("Dexcom dati importēti"); loadPeriod(); loadDay(true);
  } catch (e) { st.textContent = "Neizdevās importēt: " + ((e && e.message) || "kļūda"); }
  finally { btn.disabled = false; }
};

/* ---------- recognition ---------- */
function clean(e){
  if (!e || typeof e !== "object") return null;
  const k = KIND[e.kind] ? e.kind : "note";
  const o = { kind: k, time: /^\d{1,2}:\d{2}$/.test(e.time||"") ? e.time.padStart(5,"0") : "" };
  if (k === "basal" || k === "bolus") { o.insulin = String(e.insulin || (k === "basal" ? "Lantus" : "Apidra")); o.units = num(e.units); }
  if (k === "meal") { o.meal = String(e.meal || "Ēdienreize"); o.items = (Array.isArray(e.items) ? e.items : []).map(i => ({ n: String(i.n||i.name||""), g: num(i.g), oh: num(i.oh) })).filter(i => i.n); o.mv = num(e.mv); o.mv_est = false; }
  if (k === "glucose") o.glucose = num(e.glucose);
  if (k === "tablets") o.count = num(e.count) || 1;
  o.bg = k === "glucose" ? null : num(e.bg);
  o.note = e.note ? String(e.note) : "";
  return withMv(o);
}
async function callParse(body){
  const { data, error } = await sb.functions.invoke("parse", { body: Object.assign({ today: todayStr(), now: nowTime(), cur }, body) });
  if (error) throw new Error(await fnError(error));
  return data || {};
}
let pending = null;
$("#send").onclick = async () => {
  const t = $("#input").value.trim(); if (!t) return;
  stopMic();
  const btn = $("#send"); btn.disabled = true; btn.textContent = "Atpazīst…";
  let list;
  if (!child.ai) {
    btn.disabled = false; btn.textContent = "Pievienot";
    pending = { list: [{ kind: "note", time: cur === todayStr() ? nowTime() : "", note: t, bg: null }], clearInput: true }; openPreview();
    return;
  }
  try {
    const r = await callParse({ mode: "text", text: t });
    list = (r.entries || []).map(clean).filter(Boolean);
  } catch (e) {
    toast(e.message + " — saglabāju kā piezīmi");
    list = [{ kind: "note", time: cur === todayStr() ? nowTime() : "", note: t, bg: null }];
  } finally { btn.disabled = false; btn.textContent = "Pievienot"; }
  pending = { list, clearInput: true }; openPreview();
};

let camMode = "menu";
$("#cam").onclick = () => {
  $("#sheetHost").innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="Ko fotografēsi?"><h2>Ko fotografēsi?</h2>
    <div class="choice"><button class="btn" type="button" id="chMeter">Glikometra rādījumu</button><button class="btn" type="button" id="chMenu">Ēdienkarti vai ēdienu</button></div>
    <div class="rowbtns"><button class="btn" id="chCancel" type="button">Atcelt</button></div></div></div>`;
  $("#chMeter").onclick = () => { camMode = "meter"; closeSheet(); $("#camFile").click(); };
  $("#chMenu").onclick = () => { camMode = "menu"; closeSheet(); $("#camFile").click(); };
  $("#chCancel").onclick = closeSheet;
};
function shrink(file){
  return new Promise(res => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { const max = 1600; let w = img.width, h = img.height; const s = Math.min(1, max/Math.max(w,h)); w = Math.round(w*s); h = Math.round(h*s);
      const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img,0,0,w,h); URL.revokeObjectURL(url);
      res(c.toDataURL("image/jpeg", 0.85).split(",")[1]); };
    img.onerror = () => { URL.revokeObjectURL(url); res(null); }; img.src = url;
  });
}
$("#camFile").onchange = async ev => {
  const f = ev.target.files && ev.target.files[0]; ev.target.value = ""; if (!f) return;
  const btn = $("#send"); btn.disabled = true; btn.textContent = camMode === "meter" ? "Lasa rādījumu…" : "Lasa ēdienkarti…";
  try {
    const image = await shrink(f); if (!image) throw new Error("Attēlu neizdevās atvērt");
    if (camMode === "meter") {
      const r = await callParse({ mode: "meter", image, mediaType: "image/jpeg" });
      let v = num(r.glucose); if (v == null) throw new Error(r.error || "Rādījumu neizdevās nolasīt");
      if ((r.unit && /mg/i.test(r.unit)) || v > 35) v = Math.round(v/18.016*10)/10;
      const time = (r.time && /^\d{1,2}:\d{2}$/.test(r.time) && (!r.date || r.date === cur)) ? r.time.padStart(5,"0") : (cur === todayStr() ? nowTime() : "");
      pending = { list: [{ kind: "glucose", time, glucose: v, bg: null, note: "glikometrs (foto)", src: "meter" }], clearInput: false };
    } else {
      const r = await callParse({ mode: "menu", image, mediaType: "image/jpeg", text: $("#input").value.trim() });
      const list = (r.entries || []).map(clean).filter(Boolean);
      if (!list.length) throw new Error(r.error || "Ēdienkarti neizdevās nolasīt");
      list.forEach(e => { e.src = "menu"; if (e.kind === "meal" && e.mv_est) e.note = (e.note ? e.note + "; " : "") + "MV aprēķinātas no ēdienkartes"; });
      pending = { list, clearInput: true };
    }
    openPreview();
  } catch (e) { toast(e.message || "Neizdevās"); }
  finally { btn.disabled = false; btn.textContent = "Pievienot"; }
};

/* ---------- preview & edit ---------- */
function closeSheet(){ $("#sheetHost").innerHTML = ""; }
function openPreview(){
  const tot = pending.list.reduce((s,e) => s + (e.kind === "meal" ? num(e.mv)||0 : 0), 0);
  $("#sheetHost").innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="Pārbaudi ierakstus">
    <h2>Pārbaudi pirms saglabāšanas</h2>
    <div class="prev" id="prevList"></div>
    ${pending.list.some(e => e.mv_est) ? `<p class="disc">MV ar “≈” ir aprēķinātas (1 MV = ${fmt(gPerMv)} g OH). Kopā ≈ ${fmt(tot,1)} MV. Pārbaudi gramus un ogļhidrātus, pieskaroties ierakstam.</p>` : ""}
    <p class="hint">Tiks saglabāts dienā ${esc(prettyDate(cur))}.</p>
    <div class="rowbtns"><button class="btn" id="pvCancel" type="button">Atcelt</button><button class="btn primary" id="pvSave" type="button">Saglabāt (${pending.list.length})</button></div>
  </div></div>`;
  const pl = $("#prevList");
  pending.list.forEach((e,i) => { const b = document.createElement("button"); b.type = "button"; b.className = "row k-"+e.kind; b.innerHTML = lineFor(e, { preview: true }); b.onclick = () => openEdit(e, i); pl.appendChild(b); });
  if (!pending.list.length) pl.innerHTML = `<div class="empty">Neko neatpazinu. Pamēģini pateikt citādi.</div>`;
  $("#pvCancel").onclick = () => { pending = null; closeSheet(); };
  $("#pvSave").onclick = savePending;
}
function toRow(e){
  return { child_id: child.id, date: e.date || cur, time: e.time || "", kind: e.kind, insulin: e.insulin ?? null, units: e.units ?? null, meal: e.meal ?? null,
    items: e.items || [], mv: e.mv ?? null, mv_est: !!e.mv_est, glucose: e.glucose ?? null, bg: e.bg ?? null, count: e.count ?? null, note: e.note || null, src: e.src || null };
}
async function savePending(){
  const btn = $("#pvSave"); btn.disabled = true; btn.textContent = "Saglabā…";
  const { error } = await sb.from("entries").insert(pending.list.map(toRow));
  if (error) { btn.disabled = false; btn.textContent = "Mēģināt vēlreiz"; toast("Neizdevās saglabāt: " + error.message); return; }
  if (pending.clearInput) $("#input").value = "";
  pending = null; closeSheet(); toast("Saglabāts"); loadDay(true);
}
function openEdit(e, pendingIdx){
  const isPending = pendingIdx !== undefined;
  const editable = isPending || canEdit(e);
  const k = e.kind || "note";
  const itemsTxt = (e.items||[]).map(i => i.n + " — " + (i.g!=null ? fmt(i.g,0) : "") + " — " + (i.oh!=null ? fmt(i.oh,0) : "")).join("\n");
  const dis = editable ? "" : "disabled";
  const wrap = document.createElement("div"); wrap.className = "sheet-bg";
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-label="Ieraksts">
    <h2>${editable ? "Labot ierakstu" : "Ieraksts"}</h2>
    ${editable ? "" : `<p class="hint">Šo ierakstu pievienoja cits cilvēks; aprūpētājs var labot tikai savus ierakstus.</p>`}
    <div class="grid">
      <label>Laiks<input id="fTime" type="time" value="${esc(e.time||"")}" ${dis}></label>
      <label>Veids<select id="fKind" ${dis}>${Object.keys(KIND).map(x => `<option value="${x}" ${x===k?"selected":""}>${KIND[x]}</option>`).join("")}</select></label>
      <label data-for="basal bolus">Insulīns<input id="fIns" value="${esc(e.insulin||"")}" placeholder="Lantus / Apidra" ${dis}></label>
      <label data-for="basal bolus">Vienības<input id="fUnits" inputmode="decimal" value="${esc(fmt(e.units))}" ${dis}></label>
      <label data-for="meal">Ēdienreize<input id="fMeal" value="${esc(e.meal||"")}" placeholder="Brokastis" ${dis}></label>
      <label data-for="meal">MV <span id="mvHint"></span><input id="fMv" inputmode="decimal" value="${esc(fmt(e.mv,1))}" placeholder="tukšs = aprēķināt" ${dis}></label>
      <label data-for="meal" class="full">Ēdieni: nosaukums — grami — ogļhidrāti g<textarea id="fItems" rows="5" ${dis}>${esc(itemsTxt)}</textarea></label>
      <label data-for="glucose">Cukurs, mmol/l<input id="fGlu" inputmode="decimal" value="${esc(fmt(e.glucose,1))}" ${dis}></label>
      <label data-for="tablets">Tabletes<input id="fCount" inputmode="decimal" value="${esc(fmt(e.count))}" ${dis}></label>
      <label data-for="basal bolus meal tablets note" class="full">Glikoze tobrīd, mmol/l<input id="fBg" inputmode="decimal" value="${esc(fmt(e.bg,1))}" placeholder="nav mērīts" ${dis}></label>
      <label class="full">Piezīme<input id="fNote" value="${esc(e.note||"")}" ${dis}></label>
    </div>
    <div class="rowbtns">
      ${editable ? `<button class="btn danger" id="fDel" type="button">Dzēst</button>` : ""}
      <button class="btn" id="fCancel" type="button">${editable ? "Atcelt" : "Aizvērt"}</button>
      ${editable ? `<button class="btn primary" id="fSave" type="button">Saglabāt</button>` : ""}
    </div>
  </div>`;
  $("#sheetHost").innerHTML = ""; $("#sheetHost").appendChild(wrap);
  const q = s => wrap.querySelector(s);
  const vis = () => { const kk = q("#fKind").value; wrap.querySelectorAll("[data-for]").forEach(l => l.hidden = !l.dataset.for.split(" ").includes(kk)); };
  q("#fKind").onchange = vis; vis();
  const parseItems = () => q("#fItems").value.split("\n").map(s => s.trim()).filter(Boolean).map(s => { const p = s.split(/\s*[—–]\s*|\s+-\s+/); return { n: (p[0]||"").trim(), g: num((p[1]||"").replace(/g/i,"")), oh: num((p[2]||"").replace(/g/i,"")) }; }).filter(i => i.n);
  const upd = () => { const oh = parseItems().reduce((s,i) => s + (i.oh||0), 0); q("#mvHint").textContent = oh ? "(no OH ≈ " + fmt(oh/gPerMv,1) + ")" : ""; };
  q("#fItems").oninput = upd; upd();
  q("#fCancel").onclick = () => { if (isPending) openPreview(); else closeSheet(); };
  if (!editable) return;
  q("#fSave").onclick = async () => {
    const kk = q("#fKind").value;
    const o = { kind: kk, time: q("#fTime").value || "", note: q("#fNote").value.trim(), bg: kk === "glucose" ? null : num(q("#fBg").value),
      insulin: null, units: null, meal: null, items: [], mv: null, mv_est: false, glucose: null, count: null, src: e.src || null };
    if (kk === "basal" || kk === "bolus") { o.insulin = q("#fIns").value.trim(); o.units = num(q("#fUnits").value); }
    if (kk === "meal") {
      o.meal = q("#fMeal").value.trim(); o.items = parseItems();
      const typed = num(q("#fMv").value);
      const keptEstimate = e.mv_est && typed != null && fmt(typed,1) === fmt(e.mv,1);
      if (typed != null && !keptEstimate) { o.mv = typed; o.mv_est = false; }
      else { o.mv = null; withMv(o); if (o.mv == null && typed != null) { o.mv = typed; o.mv_est = !!e.mv_est; } }
    }
    if (kk === "glucose") o.glucose = num(q("#fGlu").value);
    if (kk === "tablets") o.count = num(q("#fCount").value) || 1;
    if (isPending) { pending.list[pendingIdx] = o; openPreview(); return; }
    const row = toRow(Object.assign({ date: e.date }, o)); delete row.child_id;
    const { error } = await sb.from("entries").update(row).eq("id", e.id);
    if (error) { toast("Neizdevās saglabāt: " + error.message); return; }
    closeSheet(); toast("Saglabāts"); loadDay(true);
  };
  let armed = false;
  q("#fDel").onclick = async () => {
    if (!armed) { armed = true; q("#fDel").textContent = "Tiešām dzēst?"; return; }
    if (isPending) { pending.list.splice(pendingIdx,1); openPreview(); return; }
    const { error } = await sb.from("entries").delete().eq("id", e.id);
    if (error) { toast("Neizdevās izdzēst"); return; }
    closeSheet(); toast("Izdzēsts"); loadDay(true);
  };
}

/* ---------- copy ---------- */
function entryText(e){
  let s = "";
  if (e.kind === "basal" || e.kind === "bolus") s = `${e.insulin} ${fmt(e.units)} v`;
  else if (e.kind === "meal") s = `${e.meal}${e.mv!=null ? " ("+(e.mv_est?"≈":"")+fmt(e.mv,1)+" MV)" : ""}: ` + (e.items||[]).map(i => i.n + (i.g!=null ? " "+fmt(i.g,0)+"g" : "")).join(", ");
  else if (e.kind === "glucose") s = `Cukurs ${fmt(e.glucose,1)} mmol/l`;
  else if (e.kind === "tablets") s = `${fmt(e.count)} glikozes tab.`;
  else s = e.note || "";
  if (e.kind !== "glucose" && e.bg != null) s += ` [cukurs ${fmt(e.bg,1)}]`;
  if (e.note && e.kind !== "note") s += ` — ${e.note}`;
  return s;
}
$("#copyDay").onclick = () => {
  const list = sortE(entries); const t = dayTotals(list);
  const lines = [`${child.name} — ${prettyDate(cur)}`].concat(list.map(e => (e.time||"--:--") + "  " + entryText(e)));
  lines.push(`Kopā: ilgais ${fmt(t.bas)} v, īsais ${fmt(t.bol)} v, ${fmt(t.mv,1)} MV, ${fmt(t.tab)} glik. tab.`);
  const txt = lines.join("\n");
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => toast("Nokopēts"), () => toast("Neizdevās nokopēt"));
};

/* ---------- overview ---------- */
document.querySelectorAll("#presets .pchip").forEach(b => b.onclick = () => {
  const p = b.dataset.p, t = todayStr();
  period = p === "month" ? { from: t.slice(0,8)+"01", to: t } : { from: shift(t, -(Number(p)-1)), to: t };
  loadPeriod();
});
$("#rFrom").onchange = () => { if ($("#rFrom").value) { period.from = $("#rFrom").value; loadPeriod(); } };
$("#rTo").onchange = () => { if ($("#rTo").value) { period.to = $("#rTo").value; loadPeriod(); } };
async function loadPeriod(){
  if (period.from > period.to) { const x = period.from; period.from = period.to; period.to = x; }
  $("#rFrom").value = period.from; $("#rTo").value = period.to;
  const t = todayStr();
  document.querySelectorAll("#presets .pchip").forEach(b => { const p = b.dataset.p; const f = p === "month" ? t.slice(0,8)+"01" : shift(t, -(Number(p)-1)); b.setAttribute("aria-pressed", period.to === t && period.from === f); });
  $("#statGrid").innerHTML = `<p class="hint">Ielādē…</p>`;
  const [e, c] = await Promise.all([
    sb.from("entries").select("*").eq("child_id", child.id).gte("date", period.from).lte("date", period.to).limit(5000),
    sb.from("cgm_days").select("date,t,v").eq("child_id", child.id).gte("date", period.from).lte("date", period.to)
  ]);
  if (e.error) { $("#statGrid").innerHTML = `<p class="hint">Neizdevās ielādēt periodu.</p>`; return; }
  pEntries = e.data || []; pByDay = {}; pEntries.forEach(x => (pByDay[x.date] = pByDay[x.date] || []).push(x));
  pCgm = {}; (c.data || []).forEach(x => pCgm[x.date] = { t: x.t.map(Number), v: x.v.map(Number) });
  renderStats();
}
function periodStats(){
  const days = Array.from(new Set(Object.keys(pByDay).concat(Object.keys(pCgm)))).sort();
  const per = days.map(d => Object.assign({ date: d, cgm: cgmStats([pCgm[d]]) }, dayTotals(pByDay[d] || [])));
  const ins = per.filter(p => p.tdd > 0), n = ins.length;
  const avg = f => n ? ins.reduce((s,p) => s + p[f], 0)/n : null;
  const mvDays = per.filter(p => p.mv > 0);
  const sumBol = ins.reduce((s,p) => s + p.bol, 0), sumMvI = ins.reduce((s,p) => s + p.mv, 0);
  const gAll = []; pEntries.forEach(e => { const g = e.kind === "glucose" ? num(e.glucose) : num(e.bg); if (g != null) gAll.push(g); });
  const tdd = avg("tdd");
  return { days, per, n, bas: avg("bas"), bol: avg("bol"), tdd,
    mv: mvDays.length ? mvDays.reduce((s,p) => s + p.mv, 0)/mvDays.length : null,
    perMv: sumMvI > 0 ? sumBol/sumMvI : null, isf: tdd ? 100/tdd : null, cr: tdd ? 500/tdd : null,
    basPct: tdd ? avg("bas")/tdd*100 : null, tab: per.reduce((s,p) => s + p.tab, 0),
    cgm: cgmStats(Object.values(pCgm)),
    gAvg: gAll.length ? gAll.reduce((a,b) => a+b, 0)/gAll.length : null, gN: gAll.length };
}
function renderStats(){
  const S = periodStats();
  const st = (v,lab,sub,hl) => `<div class="stat${hl?" hl":""}"><b>${v===null||v===""?"—":v}</b><span>${lab}</span>${sub?`<small>${sub}</small>`:""}</div>`;
  $("#statGrid").innerHTML =
    st(fmt(S.tdd,1)+(S.tdd!=null?" v":""), "Vid. kopējā deva dienā", S.n ? `${S.n} dienas ar insulīnu` : "Nav insulīna ierakstu", true) +
    st(fmt(S.bas,1)+(S.bas!=null?" v":""), "Vid. ilgais (bazālais)", S.basPct!=null ? fmt(S.basPct,0)+"% no kopējās" : "") +
    st(fmt(S.bol,1)+(S.bol!=null?" v":""), "Vid. īsais dienā", "") +
    st(fmt(S.mv,1), "Vid. MV dienā", "") +
    st(S.perMv!=null ? fmt(S.perMv,2)+" v" : "", "Īsais uz 1 MV", "faktiski, ieskaitot korekcijas", true) +
    st(S.isf!=null ? fmt(S.isf,1) : "", "Jutība, mmol/l uz 1 v", "100 likums: 100 ÷ kopējā deva", true) +
    st(S.cr!=null ? fmt(S.cr,0)+" g" : "", "OH uz 1 v", "500 likums ≈ " + (S.cr!=null ? fmt(S.cr/gPerMv,1)+" MV" : "—")) +
    st(S.gAvg!=null ? fmt(S.gAvg,1) : "", "Vid. cukurs no pirksta", S.gN ? S.gN+" mērījumi" : "Nav mērījumu") +
    (S.cgm ? st(fmt(S.cgm.tir,0)+"%", "Dexcom: laiks diapazonā", "3,9–10 mmol/l", true) + st(fmt(S.cgm.avg,1), "Dexcom vid., mmol/l", `zem 3,9: ${fmt(S.cgm.lo,0)}% · virs 10: ${fmt(S.cgm.hi,0)}%`)
           : st("", "Dexcom dati", "nav importēti šim periodam") + st(fmt(S.tab), "Glikozes tabletes kopā", ""));
  const rows = S.per.map(p => `<tr><td><button type="button" data-d="${p.date}">${shortDate(p.date)}</button></td><td>${fmt(p.bas)}</td><td>${fmt(p.bol)}</td><td>${fmt(p.tdd)}</td><td>${fmt(p.mv,1)}</td><td>${p.mv>0&&p.bol>0?fmt(p.bol/p.mv,2):""}</td><td>${fmt(p.tab)}</td><td>${p.cgm?fmt(p.cgm.tir,0)+"%":""}</td></tr>`).join("");
  $("#dayTable").innerHTML = `<thead><tr><th>Diena</th><th>Ilgais</th><th>Īsais</th><th>Kopā</th><th>MV</th><th>v/MV</th><th>Tab.</th><th>Diap.</th></tr></thead><tbody>${rows || `<tr><td colspan="8">Šajā periodā nav ierakstu</td></tr>`}</tbody>`;
  $("#dayTable").querySelectorAll("button[data-d]").forEach(b => b.onclick = () => { cur = b.dataset.d; setView("day"); loadDay(); });
}

/* ---------- print & export ---------- */
function printHTML(from, to, byDay, cgm){
  pEntries = [].concat.apply([], Object.values(byDay)); pByDay = byDay; pCgm = cgm;
  const S = periodStats();
  const dayHTML = S.days.map(d => {
    const list = sortE(byDay[d] || []); const t = dayTotals(list); const cs = cgmStats([cgm[d]]);
    const chart = cs ? `<div class="chart">${cgmSvg(cgm[d], fingerMarks(list), PAL_PRINT)}<div class="cs">Dexcom: vid. ${fmt(cs.avg,1)} mmol/l · diapazonā ${fmt(cs.tir,0)}% · zem 3,9 ${fmt(cs.lo,0)}% · virs 10 ${fmt(cs.hi,0)}% · min ${fmt(cs.min,1)} / max ${fmt(cs.max,1)}</div></div>` : "";
    const rows = list.map(e => {
      const what = e.kind === "meal" ? `<b>${esc(e.meal)}</b><br>` + (e.items||[]).map(i => `${esc(i.n)}${i.g!=null ? ` <span class="g">${fmt(i.g,0)} g</span>` : ""}`).join("<br>")
        : esc(entryText(e).replace(/ — .*$/,"").replace(/ \[cukurs [^\]]*\]/,""));
      const gl = e.kind === "glucose" ? fmt(e.glucose,1) : (e.bg != null ? "<b>"+fmt(e.bg,1)+"</b>" : "");
      return `<tr><td class="t">${esc(e.time||"")}</td><td>${what}${e.note ? `<div class="n">${esc(e.note)}</div>` : ""}</td><td class="r">${e.kind==="meal"&&e.mv!=null ? (e.mv_est?"≈":"")+fmt(e.mv,1) : ""}</td><td class="r">${e.kind==="bolus" ? fmt(e.units) : ""}</td><td class="r">${e.kind==="basal" ? fmt(e.units) : ""}</td><td class="r">${gl}${e.kind==="tablets" ? (gl?"<br>":"")+fmt(e.count)+" tab." : ""}</td></tr>`;
    }).join("");
    return `<section class="pday"><h2><span class="num">${Number(d.slice(8))}</span>${esc(prettyDate(d))}</h2>${chart}
      ${list.length ? `<table><thead><tr><th>Laiks</th><th>Ieraksts</th><th>MV</th><th>Īsais v</th><th>Ilgais v</th><th>Cukurs / tab.</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><td></td><td>Kopā</td><td class="r">${fmt(t.mv,1)}</td><td class="r">${fmt(t.bol)}</td><td class="r">${fmt(t.bas)}</td><td class="r">${t.tab ? fmt(t.tab)+" tab." : ""}</td></tr></tfoot></table>
      <div class="sum">Kopējā deva: <b>${fmt(t.tdd)} v</b>${t.mv>0&&t.bol>0 ? ` · īsais uz 1 MV: <b>${fmt(t.bol/t.mv,2)} v</b>` : ""}</div>` : ""}</section>`;
  }).join("");
  const box = (v,l) => `<div><b>${v || "—"}</b><span>${l}</span></div>`;
  return `<div class="pr"><h1>${esc(child.name)} · Cukuriņa pieraksti</h1><div class="sub">${from === to ? esc(prettyDate(from)) : esc(prettyDate(from)) + " – " + esc(prettyDate(to))}</div>
    ${from === to ? "" : `<div class="pstats">${box(S.tdd!=null?fmt(S.tdd,1)+" v":"", "Vid. kopējā deva dienā")}${box(S.bas!=null?fmt(S.bas,1)+" v":"", "Vid. ilgais")}${box(S.bol!=null?fmt(S.bol,1)+" v":"", "Vid. īsais")}${box(fmt(S.mv,1), "Vid. MV dienā")}${box(S.perMv!=null?fmt(S.perMv,2)+" v":"", "Īsais uz 1 MV")}${box(S.isf!=null?fmt(S.isf,1):"", "Jutība mmol/l uz 1 v")}${box(S.cgm?fmt(S.cgm.tir,0)+"%":"", "Dexcom diapazonā 3,9–10")}${box(S.cgm?fmt(S.cgm.avg,1):(S.gAvg!=null?fmt(S.gAvg,1):""), S.cgm ? "Dexcom vid. mmol/l" : "Vid. cukurs no pirksta")}</div>`}
    <div class="pdisc">Aprēķini ir aptuveni un domāti sarunai ar endokrinologu. 1 MV = ${fmt(gPerMv)} g ogļhidrātu. “≈” — MV aprēķinātas no ēdienu sastāva.</div>
    ${dayHTML || "<p>Šajā periodā nav ierakstu.</p>"}</div>`;
}
function doPrint(html){
  $("#printArea").innerHTML = html;
  setTimeout(() => { window.print(); }, 50);
}
window.addEventListener("afterprint", () => { $("#printArea").innerHTML = ""; });
$("#printDay").onclick = () => { const by = {}; by[cur] = entries; const c = {}; if (cgmDay) c[cur] = cgmDay; doPrint(printHTML(cur, cur, by, c)); if (view === "stats") loadPeriod(); };
$("#printPeriod").onclick = () => doPrint(printHTML(period.from, period.to, pByDay, pCgm));
$("#dlCsv").onclick = () => {
  const q = v => { const s = String(v ?? ""); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; };
  const L = [["Datums","Laiks","Veids","Insulīns","Vienības","Ēdienreize","Ēdieni","MV","MV aprēķinātas","Cukurs mmol/l","Glik. tabletes","Piezīme","Pievienoja"].join(";")];
  Object.keys(pByDay).sort().forEach(d => sortE(pByDay[d]).forEach(e => {
    L.push([d, e.time, KIND[e.kind]||e.kind, e.insulin||"", fmt(e.units), e.meal||"", (e.items||[]).map(i => i.n + (i.g!=null?" "+fmt(i.g,0)+"g":"") + (i.oh!=null?" ("+fmt(i.oh,0)+"g OH)":"")).join(", "),
      fmt(e.mv,1), e.mv_est?"jā":"", fmt(e.kind==="glucose"?e.glucose:e.bg,1), e.kind==="tablets"?fmt(e.count):"", e.note||"", (members[e.created_by]||{}).display_name||""].map(q).join(";"));
  }));
  const blob = new Blob(["﻿" + L.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${child.name}_${period.from}_${period.to}.csv`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

/* ---------- family ---------- */
function inviteUrl(token){ return location.origin + location.pathname + "?invite=" + token; }
async function renderFamily(){
  await loadMembers();
  const me = members[user.id] || {};
  $("#myName").value = me.display_name || "";
  $("#gPerMv").value = fmt(gPerMv); $("#gPerMv").disabled = role !== "owner";
  const ml = $("#memberList"); ml.innerHTML = "";
  Object.values(members).sort((a,b) => ["owner","family","caregiver"].indexOf(a.role) - ["owner","family","caregiver"].indexOf(b.role)).forEach(m => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="pn"><b>${esc(m.display_name || "Bez vārda")}${m.user_id === user.id ? " (tu)" : ""}</b><span>${esc(m.email || "")}</span></div><span class="role">${ROLE[m.role]}</span>`;
    if (role === "owner" && m.user_id !== user.id) {
      const b = document.createElement("button"); b.className = "btn small danger"; b.type = "button"; b.textContent = "Noņemt"; let armed = false;
      b.onclick = async () => { if (!armed) { armed = true; b.textContent = "Tiešām?"; return; }
        const { error } = await sb.from("members").delete().eq("child_id", child.id).eq("user_id", m.user_id);
        if (error) toast("Neizdevās"); else { toast("Piekļuve noņemta"); renderFamily(); } };
      li.appendChild(b);
    }
    ml.appendChild(li);
  });
  $("#inviteCard").hidden = role !== "owner";
  if (role === "owner") {
    const { data } = await sb.from("invites").select("id, display_name, role, token, expires_at").eq("child_id", child.id).order("created_at", { ascending: false });
    const il = $("#inviteList"); il.innerHTML = "";
    (data || []).filter(i => new Date(i.expires_at) > new Date()).forEach(i => {
      const li = document.createElement("li");
      li.innerHTML = `<div class="pn"><b>${esc(i.display_name || "Ielūgums")}</b><span>gaida · derīgs līdz ${shortDate(i.expires_at.slice(0,10))}</span></div><span class="role">${ROLE[i.role]}</span>`;
      const s = document.createElement("button"); s.className = "btn small"; s.type = "button"; s.textContent = "Saite"; s.onclick = () => showInvite(i);
      const d = document.createElement("button"); d.className = "btn small danger"; d.type = "button"; d.textContent = "Atsaukt";
      d.onclick = async () => { await sb.from("invites").delete().eq("id", i.id); $("#invResult").innerHTML = ""; renderFamily(); };
      li.appendChild(s); li.appendChild(d); il.appendChild(li);
    });
  }
}
function showInvite(i){
  const url = inviteUrl(i.token);
  const box = $("#invResult");
  box.innerHTML = `<div class="invlink"><b>Ielūguma saite ${esc(i.display_name || "")}</b><code>${esc(url)}</code><div class="rowbtns"><button class="btn primary" id="invShare" type="button">Sūtīt</button><button class="btn" id="invCopy" type="button">Kopēt</button></div><p class="hint">Saite derīga 14 dienas un der tikai vienam cilvēkam. Sūti to personīgi, piemēram, WhatsApp.</p></div>`;
  const text = `Ielūgums uz ${child.name} dienasgrāmatu: ${url}`;
  $("#invShare").hidden = !navigator.share;
  $("#invShare").onclick = () => navigator.share({ title: child.name + " dienasgrāmata", text, url }).catch(() => {});
  $("#invCopy").onclick = () => navigator.clipboard.writeText(url).then(() => toast("Saite nokopēta"), () => toast("Atzīmē saiti un kopē"));
}
$("#invForm").onsubmit = async ev => {
  ev.preventDefault();
  const name = $("#invName").value.trim(); if (!name) return;
  const { data, error } = await sb.from("invites").insert({ child_id: child.id, display_name: name, role: $("#invRole").value }).select("id, display_name, role, token, expires_at").single();
  if (error) { toast("Neizdevās izveidot: " + error.message); return; }
  $("#invName").value = ""; await renderFamily(); showInvite(data);
};
$("#saveSettings").onclick = async () => {
  const nm = $("#myName").value.trim();
  if (nm) { await sb.from("members").update({ display_name: nm }).eq("child_id", child.id).eq("user_id", user.id); try { localStorage.setItem("myName", nm); } catch (_) {} }
  if (role === "owner") {
    const v = num($("#gPerMv").value);
    if (!v || v < 5 || v > 20) { toast("1 MV jābūt no 5 līdz 20 g"); return; }
    const { error } = await sb.from("children").update({ g_per_mv: v }).eq("id", child.id);
    if (!error) gPerMv = v;
  }
  await loadMemberships(); const m = memberships.find(x => x.child_id === child.id);
  $("#roleLabel").textContent = (m && m.display_name ? m.display_name + " · " : "") + ROLE[role];
  toast("Saglabāts"); renderFamily();
};
$("#signOut").onclick = async () => { if (channel) sb.removeChannel(channel); await sb.auth.signOut(); };

/* ---------- navigation ---------- */
function setView(v){
  view = v;
  $("#viewDay").hidden = v !== "day"; $("#viewStats").hidden = v !== "stats"; $("#viewFamily").hidden = v !== "family";
  $("#dock").hidden = v !== "day"; document.body.classList.toggle("nodock", v !== "day");
  document.querySelectorAll(".tabbar button").forEach(b => { if (b.dataset.v === v) b.setAttribute("aria-current","page"); else b.removeAttribute("aria-current"); });
  window.scrollTo(0,0);
  if (v === "stats") loadPeriod();
  if (v === "family") renderFamily();
}
document.querySelectorAll(".tabbar button").forEach(b => b.onclick = () => setView(b.dataset.v));

/* ---------- dictation in page (where the browser supports it) ---------- */
let rec = null, recOn = false;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) $("#mic").hidden = false;
function stopMic(){ if (rec && recOn) { try { rec.stop(); } catch (_) {} } }
$("#mic").onclick = () => {
  if (recOn) { stopMic(); return; }
  try {
    rec = new SR(); rec.lang = "lv-LV"; rec.continuous = true; rec.interimResults = true;
    const base = $("#input").value ? $("#input").value.trim() + " " : "";
    rec.onresult = ev => { let t = ""; for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript; $("#input").value = base + t; };
    rec.onerror = () => { recOn = false; $("#mic").classList.remove("on"); $("#mic").hidden = true; $("#hint").textContent = "Šeit diktēšana nav pieejama — izmanto mikrofonu uz telefona tastatūras."; };
    rec.onend = () => { recOn = false; $("#mic").classList.remove("on"); };
    rec.start(); recOn = true; $("#mic").classList.add("on");
  } catch (_) { $("#mic").hidden = true; }
};

/* ---------- service worker ---------- */
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));

/* start: onAuthStateChange fires INITIAL_SESSION and calls boot() */
setMode("in");
})();
