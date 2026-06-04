/**
 * Public results site generator
 * =============================
 * Joins the recorded times (results.db) with an optional swimmer roster
 * (roster.csv) and emits ONE self-contained static HTML file — inline CSS/JS,
 * data embedded as JSON, no external assets — so it can be hosted anywhere
 * (GitHub Pages, Netlify, S3, a club website, …).
 *
 * Roster CSV (project root, override with env ROSTER):
 *   event,heat,lane,name,age,sex,club
 * No roster → the page still lists events + lane times, just without names.
 *
 * Output: public/results.html (override with env SITE_OUT).
 * Run standalone with:  npm run publish
 * The server also regenerates it after every completed heat.
 */

import { listResults } from "./db.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(SRC_DIR, "..");
const ROSTER_PATH = process.env.ROSTER || join(BASE_DIR, "roster.csv");
const EVENTS_PATH = process.env.EVENTS || join(BASE_DIR, "events.csv");
const SITE_PATH = process.env.SITE_OUT || join(BASE_DIR, "public", "results.html");

interface RosterEntry { name: string; age: number | null; sex: string; club: string }
interface EventMeta { name: string; stroke: string; distance: string; sex: string; ageGroup: string }

// Minimal CSV parser (handles quoted fields + embedded commas).
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f.trim() !== "")) rows.push(row); }
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
}

function loadRoster(): Map<string, RosterEntry> {
  const map = new Map<string, RosterEntry>();
  if (!existsSync(ROSTER_PATH)) return map;
  for (const r of parseCsv(readFileSync(ROSTER_PATH, "utf8"))) {
    const event = Number(r.event), heat = Number(r.heat), lane = Number(r.lane);
    if (!event || !heat || !lane) continue;
    map.set(`${event}-${heat}-${lane}`, {
      name: r.name || `Lane ${lane}`,
      age: r.age ? Number(r.age) : null,
      sex: (r.sex || "").toUpperCase(),
      club: r.club || "",
    });
  }
  return map;
}

function loadEvents(): Map<number, EventMeta> {
  const map = new Map<number, EventMeta>();
  if (!existsSync(EVENTS_PATH)) return map;
  for (const r of parseCsv(readFileSync(EVENTS_PATH, "utf8"))) {
    const event = Number(r.event);
    if (!event) continue;
    map.set(event, {
      name: r.name || "",
      stroke: r.stroke || "",
      distance: r.distance || "",
      sex: (r.sex || "").toUpperCase(),
      ageGroup: r.agegroup || r.age_group || "",
    });
  }
  return map;
}

export interface ResultRow {
  event: number; heat: number; lane: number;
  time: number | null; finished: boolean; completedAt: string;
  name: string | null; age: number | null; sex: string | null; club: string | null;
}

export function buildData(): {
  generatedAt: string; hasRoster: boolean; results: ResultRow[];
  eventsMeta: Record<number, EventMeta>;
} {
  const races = listResults(1000);
  const roster = loadRoster();
  const eventsMap = loadEvents();
  const results: ResultRow[] = [];
  for (const race of races) {
    for (const ln of race.lanes) {
      const r = roster.get(`${race.eventNum}-${race.heatNum}-${ln.lane}`);
      results.push({
        event: race.eventNum, heat: race.heatNum, lane: ln.lane,
        time: ln.time, finished: ln.finished, completedAt: race.completedAt,
        name: r?.name ?? null, age: r?.age ?? null, sex: r?.sex ?? null, club: r?.club ?? null,
      });
    }
  }
  const eventsMeta: Record<number, EventMeta> = {};
  for (const [k, v] of eventsMap) eventsMeta[k] = v;
  return { generatedAt: new Date().toISOString(), hasRoster: roster.size > 0, results, eventsMeta };
}

// NOTE: the client script below uses ONLY normal strings + concatenation (no
// template literals, no ${}) so it survives this outer template literal intact.
// The only interpolation is the embedded DATA payload.
function renderHtml(data: ReturnType<typeof buildData>): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swim Gala — Results</title>
<style>
  :root { --bg:#0b1220; --card:#121a2b; --line:#22304a; --txt:#e8eef7; --dim:#9fb0c8; --accent:#36c5f0; --gold:#f6c651; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  header { padding:18px 20px; border-bottom:1px solid var(--line); position:sticky; top:0; background:rgba(11,18,32,.92); backdrop-filter:blur(6px); z-index:5; }
  header h1 { margin:0; font-size:18px; letter-spacing:.3px; }
  header .sub { color:var(--dim); font-size:12px; margin-top:3px; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  main { max-width:980px; margin:0 auto; padding:18px 16px 60px; }
  .crumbs { color:var(--dim); font-size:13px; margin-bottom:14px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card h3 { margin:0 0 4px; font-size:16px; }
  .card .meta { color:var(--dim); font-size:13px; }
  .banner { background:#2a2410; border:1px solid #5a4a18; color:#f6d873; padding:10px 14px; border-radius:10px; margin-bottom:16px; font-size:13px; }
  h2.section { font-size:15px; color:var(--accent); border-bottom:1px solid var(--line); padding-bottom:6px; margin:26px 0 10px; }
  table { width:100%; border-collapse:collapse; margin-bottom:10px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); font-size:14px; }
  th { color:var(--dim); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.4px; }
  td.t { font-variant-numeric:tabular-nums; font-weight:600; }
  td.place { width:38px; color:var(--dim); }
  tr.p1 td.place { color:var(--gold); font-weight:700; }
  .nt { color:var(--dim); }
  .pill { display:inline-block; font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); color:var(--dim); margin-left:6px; }
  footer { text-align:center; color:var(--dim); font-size:12px; padding:24px; }
</style>
</head>
<body>
<header>
  <h1><a href="#/" style="color:inherit">🏊 Swim Gala — Results</a></h1>
  <div class="sub" id="sub"></div>
</header>
<main id="app"></main>
<footer>Static results page · generated <span id="gen"></span></footer>
<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>
"use strict";
var DATA = JSON.parse(document.getElementById("data").textContent);
var R = DATA.results;
var EM = DATA.eventsMeta || {};
document.getElementById("gen").textContent = new Date(DATA.generatedAt).toLocaleString();

function eventName(e){
  var m = EM[e];
  if(m && m.name) return m.name;
  var bits = [];
  if(m){ if(m.sex) bits.push(sexLabel(m.sex)); if(m.ageGroup) bits.push(m.ageGroup); if(m.distance) bits.push(m.distance); if(m.stroke) bits.push(m.stroke); }
  return bits.length ? bits.join(" ") : ("Event "+e);
}
function eventTitle(e){ var n = eventName(e); return n===("Event "+e) ? n : ("Event "+e+" — "+n); }

function esc(s){ s = (s==null?"":String(s)); return s.replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""); }
function swimmerId(r){ return slug((r.name||("lane-"+r.lane)) + "-" + (r.club||"")); }
function fmt(t){ if(t==null) return "NT"; var m=Math.floor(t/60), s=t-m*60; var ss=s.toFixed(2); if(s<10) ss="0"+ss; return (m>0? m+":"+ss : Number(t).toFixed(2)); }
function uniq(a){ return a.filter(function(v,i){ return a.indexOf(v)===i; }); }
function sexLabel(x){ return x==="F"?"Female":x==="M"?"Male":(x||"Unspecified"); }

function events(){ return uniq(R.map(function(r){return r.event;})).sort(function(a,b){return a-b;}); }
function rowsForEvent(e){ return R.filter(function(r){ return r.event===e; }); }

// Rank a set of rows by time (entries with a time get places; NT last).
function ranked(rows){
  var timed = rows.filter(function(r){return r.time!=null;}).slice().sort(function(a,b){return a.time-b.time;});
  timed.forEach(function(r,i){ r._place=i+1; });
  var nt = rows.filter(function(r){return r.time==null;});
  return timed.concat(nt);
}

function link(href, text, cls){ return '<a href="'+href+'"'+(cls?' class="'+cls+'"':'')+'>'+text+'</a>'; }

function viewHome(){
  var evs = events();
  var sub = R.length+" results · "+evs.length+" event"+(evs.length===1?"":"s");
  var html = "";
  if(!DATA.hasRoster) html += '<div class="banner">No <b>roster.csv</b> found — showing lane times only. Add a roster (event,heat,lane,name,age,sex,club) and re-publish to break results down by swimmer, age and sex.</div>';
  html += '<div class="crumbs">Home</div>';
  html += '<div style="margin-bottom:14px">'+link("#/swimmers","View all swimmers →")+'</div>';
  html += '<div class="grid">';
  evs.forEach(function(e){
    var rows = rowsForEvent(e);
    var swimmers = uniq(rows.map(function(r){return r.name||("Lane "+r.lane);})).length;
    var heats = uniq(rows.map(function(r){return r.heat;})).length;
    var when = rows[0] ? new Date(rows[0].completedAt).toLocaleDateString() : "";
    html += '<a class="card" href="#/event/'+e+'" style="color:inherit"><h3>'+esc(eventName(e))+'</h3>'
      + '<div class="meta">Event '+e+' · '+heats+' heat'+(heats===1?"":"s")+' · '+swimmers+' swimmer'+(swimmers===1?"":"s")+'</div>'
      + '<div class="meta">'+when+'</div></a>';
  });
  html += '</div>';
  return { sub:sub, html:html };
}

function resultTable(rows){
  var withRoster = rows.some(function(r){return r.name;});
  var html = '<table><thead><tr><th class="place">#</th><th>'+(withRoster?"Swimmer":"Lane")+'</th>'
    + (withRoster?'<th>Age</th><th>Club</th>':'')
    + '<th>Heat</th><th>Lane</th><th style="text-align:right">Time</th></tr></thead><tbody>';
  ranked(rows).forEach(function(r){
    var name = r.name ? link("#/swimmer/"+swimmerId(r), esc(r.name)) : ("Lane "+r.lane);
    var place = r.time!=null ? r._place : "";
    html += '<tr class="'+(r._place===1?"p1":"")+'">'
      + '<td class="place">'+place+'</td>'
      + '<td>'+name+'</td>'
      + (withRoster?('<td>'+(r.age!=null?r.age:"")+'</td><td>'+esc(r.club||"")+'</td>'):'')
      + '<td>'+r.heat+'</td><td>'+r.lane+'</td>'
      + '<td class="t" style="text-align:right">'+(r.time!=null?fmt(r.time):'<span class="nt">NT</span>')+'</td></tr>';
  });
  html += '</tbody></table>';
  return html;
}

function viewEvent(e){
  e = Number(e);
  var rows = rowsForEvent(e);
  if(!rows.length) return { sub:"", html:'<div class="crumbs">'+link("#/","Home")+' / Event '+e+'</div><p>No results.</p>' };
  var html = '<div class="crumbs">'+link("#/","Home")+' / Event '+e+'</div>';
  html += '<h1 style="margin:.2em 0 0">'+esc(eventTitle(e))+'</h1>';
  // Break down by sex, then list ranked (age shown per row).
  var sexes = uniq(rows.map(function(r){return r.sex||"";}));
  var order = ["F","M",""];
  sexes.sort(function(a,b){ return order.indexOf(a)-order.indexOf(b); });
  var anyRoster = rows.some(function(r){return r.name;});
  if(anyRoster){
    sexes.forEach(function(sx){
      var sub = rows.filter(function(r){return (r.sex||"")===sx;});
      if(!sub.length) return;
      html += '<h2 class="section">'+sexLabel(sx)+' <span class="pill">'+sub.length+'</span></h2>';
      html += resultTable(sub);
    });
  } else {
    html += '<h2 class="section">Results</h2>' + resultTable(rows);
  }
  return { sub:"Event "+e, html:html };
}

function viewSwimmers(){
  var bySw = {};
  R.forEach(function(r){ if(!r.name) return; var id=swimmerId(r); (bySw[id]=bySw[id]||{name:r.name,club:r.club,sex:r.sex,age:r.age,n:0,id:id}); bySw[id].n++; });
  var list = Object.keys(bySw).map(function(k){return bySw[k];}).sort(function(a,b){return a.name.localeCompare(b.name);});
  var html = '<div class="crumbs">'+link("#/","Home")+' / Swimmers</div><h1 style="margin:.2em 0 .4em">Swimmers</h1>';
  if(!list.length){ html += '<p class="nt">No swimmer roster loaded.</p>'; return { sub:"Swimmers", html:html }; }
  html += '<table><thead><tr><th>Swimmer</th><th>Age</th><th>Sex</th><th>Club</th><th>Swims</th></tr></thead><tbody>';
  list.forEach(function(s){
    html += '<tr><td>'+link("#/swimmer/"+s.id, esc(s.name))+'</td><td>'+(s.age!=null?s.age:"")+'</td><td>'+sexLabel(s.sex)+'</td><td>'+esc(s.club||"")+'</td><td>'+s.n+'</td></tr>';
  });
  html += '</tbody></table>';
  return { sub:"Swimmers", html:html };
}

function viewSwimmer(id){
  var rows = R.filter(function(r){ return r.name && swimmerId(r)===id; });
  if(!rows.length) return { sub:"", html:'<div class="crumbs">'+link("#/","Home")+'</div><p>Unknown swimmer.</p>' };
  var s = rows[0];
  var html = '<div class="crumbs">'+link("#/","Home")+' / '+link("#/swimmers","Swimmers")+' / '+esc(s.name)+'</div>';
  html += '<h1 style="margin:.2em 0 0">'+esc(s.name)+'</h1>';
  html += '<div class="meta" style="color:var(--dim);margin-bottom:10px">'+sexLabel(s.sex)+(s.age!=null?(' · Age '+s.age):'')+(s.club?(' · '+esc(s.club)):'')+'</div>';
  html += '<table><thead><tr><th>Event</th><th>Heat</th><th>Lane</th><th>Place</th><th style="text-align:right">Time</th></tr></thead><tbody>';
  rows.sort(function(a,b){return a.event-b.event || a.heat-b.heat;}).forEach(function(r){
    // place within that event's sex group
    var grp = R.filter(function(x){ return x.event===r.event && (x.sex||"")===(r.sex||""); });
    var rk = ranked(grp);
    var me = rk.filter(function(x){return x.lane===r.lane && x.heat===r.heat;})[0];
    var place = (me && me.time!=null) ? me._place : "";
    html += '<tr><td>'+link("#/event/"+r.event, "Event "+r.event)+'</td><td>'+r.heat+'</td><td>'+r.lane+'</td><td>'+place+'</td><td class="t" style="text-align:right">'+(r.time!=null?fmt(r.time):'<span class="nt">NT</span>')+'</td></tr>';
  });
  html += '</tbody></table>';
  return { sub:esc(s.name), html:html };
}

function route(){
  var h = location.hash.replace(/^#/,"") || "/";
  var parts = h.split("/").filter(Boolean);
  var v;
  if(parts[0]==="event") v = viewEvent(parts[1]);
  else if(parts[0]==="swimmer") v = viewSwimmer(parts[1]);
  else if(parts[0]==="swimmers") v = viewSwimmers();
  else v = viewHome();
  document.getElementById("app").innerHTML = v.html;
  document.getElementById("sub").textContent = v.sub || "";
  window.scrollTo(0,0);
}
window.addEventListener("hashchange", route);
route();
</script>
</body>
</html>
`;
}

export function writeSite(): string {
  const data = buildData();
  mkdirSync(dirname(SITE_PATH), { recursive: true });
  writeFileSync(SITE_PATH, renderHtml(data));
  return SITE_PATH;
}
