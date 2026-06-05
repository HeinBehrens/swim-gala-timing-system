/**
 * Swim Gala Timing System — Server (TypeScript)
 * =============================================
 * Port of the reference server.py onto the ESP32-C5 capture path.
 *
 * Button presses no longer come from on-Mac BLE (bleak/noble) — they arrive from
 * the ESP32-C5 gateway over USB serial (src/esp32.ts), already timestamped on-chip
 * in microseconds. The server keeps the race state machine, serves the existing
 * static/ dashboard + phone remote, and broadcasts updates over WebSocket.
 *
 * Protocol note: this matches what static/app.js ACTUALLY parses (which had drifted
 * from server.py). Server→client messages: full_state, race_state, lane_time,
 * connection_status{ble,ha}, battery_status{lane,level}, config, toast,
 * export_ready{filename,url}. Client→server actions accept BOTH the dashboard's
 * vocabulary (prepare/start/stop/reset/export/export_do3/export_lif/simulate_lane/
 * set_event_heat/set_config/get_state) and the phone remote's (prepare_race/
 * start_race/stop_race/reset_race/simulate_press).
 *
 * Timing: the dashboard's live master clock is wall-clock (start_time in seconds),
 * but each recorded lane split is computed from the ESP32 µs timestamps when
 * available, so finishes are accurate regardless of host/USB jitter.
 *
 * Run:  npm start        (tsx src/server.ts)
 */

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Esp32Gateway, PressEvent, DEFAULT_PORT, DEFAULT_TCP_HOST, DEFAULT_TCP_PORT } from "./esp32.js";
import { saveRace, listResults, LaneRow } from "./db.js";
import { writeSite } from "./site.js";

// ── Paths ────────────────────────────────────────────────────────────────────
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(SRC_DIR, "..");
const STATIC_DIR = join(BASE_DIR, "static");
const EXPORTS_DIR = join(BASE_DIR, "exports");
const PUBLIC_DIR = join(BASE_DIR, "public");
const LANES_PATH = join(SRC_DIR, "lanes.json");

// ── Config ───────────────────────────────────────────────────────────────────
const NUM_LANES = 6;
const HOST = "0.0.0.0";
const PORT = 8000;
const DEBOUNCE_SECONDS = 3.0;

// Transport: "serial" (default, USB) or "wifi"/"tcp" (over the LAN).
//   ESP32_TRANSPORT=wifi ESP32_HOST=swim-timer.local npm start
const TRANSPORT = (process.env.ESP32_TRANSPORT || "serial").toLowerCase();
const SERIAL_PORT = process.env.ESP32_PORT || DEFAULT_PORT;
const TCP_HOST = process.env.ESP32_HOST || DEFAULT_TCP_HOST;
const TCP_PORT = Number(process.env.ESP32_TCP_PORT) || DEFAULT_TCP_PORT;
const USE_WIFI = TRANSPORT === "wifi" || TRANSPORT === "tcp";

type RaceState = "idle" | "ready" | "running" | "completed";

interface DashConfig {
  mac_lane_1?: string; mac_lane_2?: string; mac_lane_3?: string;
  mac_lane_4?: string; mac_lane_5?: string; mac_lane_6?: string;
  mac_starter?: string;
  ha_url?: string; ha_token?: string;
}

// ── Lane map (from lanes.json, overridable via set_config) ───────────────────
interface LaneButton { role: string; label: string; mac: string }
interface LanesFile { port: string; baud: number; enrolledAt: string; buttons: LaneButton[] }

let config: DashConfig = { ha_url: "", ha_token: "" };
let laneByMac = new Map<string, number>(); // mac(lower) -> lane
let starterMac = "";

// The gateway fires the start siren locally the instant it sees the starter
// button — so it needs to know that MAC. Push it down the link on connect and
// whenever enrollment changes it.
let gatewayRef: Esp32Gateway | null = null;
function pushStarterMac(): void {
  if (gatewayRef && starterMac) gatewayRef.send(`STARTER\t${starterMac}\n`);
}

function loadLanes(): void {
  try {
    const data = JSON.parse(readFileSync(LANES_PATH, "utf8")) as LanesFile;
    for (const b of data.buttons) {
      const mac = b.mac.toLowerCase();
      if (b.role === "start") config.mac_starter = mac;
      else {
        const m = /^lane(\d)$/.exec(b.role);
        if (m) (config as any)[`mac_lane_${m[1]}`] = mac;
      }
    }
  } catch {
    console.warn(`  ⚠️  No ${LANES_PATH} — run "npm run enroll" to register buttons.`);
  }
  rebuildMaps();
}

function rebuildMaps(): void {
  laneByMac = new Map();
  for (let i = 1; i <= NUM_LANES; i++) {
    const mac = (config as any)[`mac_lane_${i}`] as string | undefined;
    if (mac) laneByMac.set(mac.toLowerCase(), i);
  }
  starterMac = (config.mac_starter || "").toLowerCase();
  pushStarterMac(); // keep the gateway's local siren trigger in sync
}

function persistLanes(): void {
  const buttons: LaneButton[] = [];
  for (let i = 1; i <= NUM_LANES; i++) {
    const mac = (config as any)[`mac_lane_${i}`] as string | undefined;
    if (mac) buttons.push({ role: `lane${i}`, label: `Lane ${i}`, mac: mac.toLowerCase() });
  }
  if (config.mac_starter) buttons.push({ role: "start", label: "Starter", mac: config.mac_starter.toLowerCase() });
  const out: LanesFile = { port: SERIAL_PORT, baud: 115200, enrolledAt: new Date().toISOString(), buttons };
  try { writeFileSync(LANES_PATH, JSON.stringify(out, null, 2) + "\n"); } catch { /* best effort */ }
}

// ── Race state machine (mirrors server.py RaceManager) ───────────────────────
class RaceManager {
  state: RaceState = "idle";
  eventNum = 1;
  heatNum = 1;
  datasetNum = 1;
  raceIdCounter = 0;
  startWall = 0;            // seconds (Date.now()/1000) — for the dashboard clock
  startEspMicros: number | null = null; // ESP on-chip µs — for accurate splits
  laneTimes: Record<number, number[]> = {};
  laneFinished: Record<number, boolean> = {};
  battery: Record<number, number> = {};
  savedToDb = false;       // guard so each completed race is persisted exactly once

  constructor() { this.clearLanes(); }

  private clearLanes(): void {
    for (let i = 1; i <= NUM_LANES; i++) { this.laneTimes[i] = []; this.laneFinished[i] = false; }
  }

  prepare(eventNum: number, heatNum: number): void {
    this.eventNum = eventNum; this.heatNum = heatNum;
    this.raceIdCounter += 1;
    this.state = "ready";
    this.startWall = 0; this.startEspMicros = null;
    this.savedToDb = false;
    this.clearLanes();
  }

  start(espMicros: number | null = null): void {
    this.startWall = Date.now() / 1000;
    this.startEspMicros = espMicros;
    this.state = "running";
  }

  /** Record a finish for a lane. Returns elapsed seconds, or null if not recordable. */
  recordLane(lane: number, espMicros: number | null = null): number | null {
    if (this.state !== "running") return null;
    if (lane < 1 || lane > NUM_LANES) return null;
    let elapsed: number;
    if (espMicros != null && this.startEspMicros != null) {
      elapsed = (espMicros - this.startEspMicros) / 1e6;       // precise, on-chip
    } else {
      elapsed = Date.now() / 1000 - this.startWall;            // wall-clock fallback
    }
    if (elapsed < 0) elapsed = 0;
    this.laneTimes[lane]!.push(elapsed);
    this.laneFinished[lane] = true;
    if (Object.values(this.laneFinished).every(Boolean)) this.state = "completed";
    return elapsed;
  }

  manualTime(lane: number, t: number): boolean {
    if (lane < 1 || lane > NUM_LANES || t <= 0) return false;
    this.laneTimes[lane]!.push(t);
    this.laneFinished[lane] = true;
    if (Object.values(this.laneFinished).every(Boolean)) this.state = "completed";
    return true;
  }

  stop(): void { this.state = "completed"; }
  reset(): void { this.state = "idle"; this.startWall = 0; this.startEspMicros = null; this.savedToDb = false; this.clearLanes(); }

  elapsedSeconds(): number {
    if (this.state !== "running" || !this.startWall) return 0;
    return Date.now() / 1000 - this.startWall;
  }

  laneResult(lane: number): number | null {
    const times = this.laneTimes[lane] || [];
    return times.length ? times[0]! : null; // first touch = the finish
  }
}

const race = new RaceManager();

// ── Enrollment (server-driven, triggered from the dashboard) ─────────────────
const ENROLL_SLOTS: Array<{ role: string; label: string }> = [
  { role: "lane1", label: "Lane 1" }, { role: "lane2", label: "Lane 2" },
  { role: "lane3", label: "Lane 3" }, { role: "lane4", label: "Lane 4" },
  { role: "lane5", label: "Lane 5" }, { role: "lane6", label: "Lane 6" },
  { role: "start", label: "Starter" },
];
let enrolling = false;
let enrollIndex = 0;
const enrollAssigned = new Map<string, string>(); // mac -> role (ignore repeats)
let enrollPrevConfig: DashConfig | null = null;

// ── WebSocket clients + broadcast helpers (app.js message shapes) ────────────
const clients = new Set<WebSocket>();
let bleConnected = false;
const haConnected = false;
// Gateway Wi-Fi link, parsed from the firmware's `WIFI<TAB>...` status lines.
type WifiState = "connected" | "connecting" | "failed" | "idle" | "unknown";
let wifiState: WifiState = "unknown";
let wifiDetail = ""; // SSID / IP / failure reason — shown in the dashboard tooltip

// Map a firmware WIFI status string to a state + human detail for the UI.
function parseWifiStatus(s: string): void {
  if (/^connected\b/i.test(s)) { wifiState = "connected"; wifiDetail = s.replace(/^connected\s*/i, "").trim(); }
  else if (/^connecting\b/i.test(s)) { wifiState = "connecting"; wifiDetail = s.replace(/^connecting to\s*/i, "").trim(); }
  else if (/^idle\b/i.test(s)) { wifiState = "idle"; wifiDetail = "no credentials"; }
  else if (/^failed\b|NOT visible|^network seen/i.test(s)) { wifiState = "failed"; wifiDetail = s; }
  // other lines (boot logs) leave state unchanged
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg: unknown): void {
  const payload = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
}

function configMessage(): Record<string, unknown> {
  return {
    type: "config",
    mac_lane_1: config.mac_lane_1 || "", mac_lane_2: config.mac_lane_2 || "",
    mac_lane_3: config.mac_lane_3 || "", mac_lane_4: config.mac_lane_4 || "",
    mac_lane_5: config.mac_lane_5 || "", mac_lane_6: config.mac_lane_6 || "",
    mac_starter: config.mac_starter || "",
    ha_url: config.ha_url || "", ha_token: config.ha_token || "",
  };
}

function fullState(): Record<string, unknown> {
  const lanes: Record<number, { time: number | null; finished: boolean; battery: number | null }> = {};
  for (let i = 1; i <= NUM_LANES; i++) {
    lanes[i] = { time: race.laneResult(i), finished: race.laneFinished[i]!, battery: race.battery[i] ?? null };
  }
  const cfg = configMessage();
  delete (cfg as any).type;
  return {
    type: "full_state",
    event: race.eventNum, heat: race.heatNum,
    state: race.state,
    start_time: race.startWall, elapsed: race.elapsedSeconds(),
    lanes, ble: bleConnected, ha: haConnected,
    wifi: wifiState, wifi_detail: wifiDetail, config: cfg,
  };
}

function broadcastRaceState(): void {
  broadcast({ type: "race_state", state: race.state, start_time: race.startWall, elapsed: race.elapsedSeconds() });
}
function broadcastLaneTime(lane: number, time: number, isFinish: boolean): void {
  broadcast({ type: "lane_time", lane, time: Math.round(time * 1000) / 1000, is_finish: isFinish });
}
function broadcastConnection(): void {
  broadcast({ type: "connection_status", ble: bleConnected, ha: haConnected, wifi: wifiState, wifi_detail: wifiDetail });
}
function toast(message: string, level = "info"): void {
  broadcast({ type: "toast", message, level });
}

// ── Completion + DB persistence ──────────────────────────────────────────────
// Place map: lanes with a time, ranked fastest-first.
function placesByLane(): Map<number, number> {
  const finished: Array<[number, number]> = [];
  for (let lane = 1; lane <= NUM_LANES; lane++) {
    const r = race.laneResult(lane);
    if (r !== null) finished.push([lane, r]);
  }
  finished.sort((a, b) => a[1] - b[1]);
  const place = new Map<number, number>();
  finished.forEach(([lane], i) => place.set(lane, i + 1));
  return place;
}

// Persist a completed race exactly once.
function persistIfCompleted(): void {
  if (race.state !== "completed" || race.savedToDb) return;
  const place = placesByLane();
  const lanes: LaneRow[] = [];
  for (let lane = 1; lane <= NUM_LANES; lane++) {
    lanes.push({
      lane,
      time: race.laneResult(lane),
      place: place.get(lane) ?? null,
      finished: race.laneFinished[lane]!,
    });
  }
  try {
    const id = saveRace(
      {
        eventNum: race.eventNum, heatNum: race.heatNum,
        raceId: race.raceIdCounter, datasetNum: race.datasetNum,
        startedAt: race.startWall ? new Date(race.startWall * 1000).toISOString() : null,
        completedAt: new Date().toISOString(),
      },
      lanes
    );
    race.savedToDb = true;
    console.log(`  💾 Saved results: event ${race.eventNum} heat ${race.heatNum} -> results.db #${id}`);
    try { writeSite(); } catch (e) { console.warn(`  ⚠️  Site publish failed: ${(e as Error).message}`); }
    toast(`Results saved (event ${race.eventNum}, heat ${race.heatNum})`, "success");
  } catch (e) {
    console.warn(`  ⚠️  Failed to save results: ${(e as Error).message}`);
  }
}

// Broadcast race_state on completion AND persist to the DB.
function settleCompletion(): void {
  if (race.state === "completed") {
    broadcastRaceState();
    persistIfCompleted();
  }
}

// ── Enrollment (press-order registration, driven from the dashboard) ─────────
function broadcastEnroll(extra: Record<string, unknown>): void {
  broadcast({ type: "enroll", total: ENROLL_SLOTS.length, ...extra });
}

function startEnroll(): void {
  enrolling = true;
  enrollIndex = 0;
  enrollAssigned.clear();
  enrollPrevConfig = { ...config }; // snapshot for cancel
  broadcastEnroll({ status: "started", slot: ENROLL_SLOTS[0]!.label, index: 0 });
}

function cancelEnroll(): void {
  if (!enrolling) return;
  enrolling = false;
  if (enrollPrevConfig) { config = { ...enrollPrevConfig }; rebuildMaps(); }
  enrollPrevConfig = null;
  broadcastEnroll({ status: "cancelled" });
}

function handleEnrollPress(mac: string): void {
  if (enrollAssigned.has(mac)) return;       // repeat of an already-registered button
  const slot = ENROLL_SLOTS[enrollIndex];
  if (!slot) return;
  enrollAssigned.set(mac, slot.role);
  const key = slot.role === "start" ? "mac_starter" : `mac_lane_${slot.role.replace("lane", "")}`;
  (config as any)[key] = mac;
  enrollIndex++;
  const next = ENROLL_SLOTS[enrollIndex];
  broadcastEnroll({ status: "assigned", slot: slot.label, role: slot.role, mac, index: enrollIndex - 1, next: next?.label });

  if (!next) {
    // All seven assigned — commit.
    enrolling = false;
    enrollPrevConfig = null;
    rebuildMaps();
    persistLanes();
    broadcastEnroll({ status: "done" });
    broadcast(configMessage());
    broadcast(fullState());
  }
}

// ── Debounce (per mac+kind), even though firmware already dedups bursts ──────
const debounce = new Map<string, number>();
function debounceOk(mac: string, kind: string): boolean {
  const key = `${mac}|${kind}`;
  const now = Date.now() / 1000;
  const last = debounce.get(key) ?? 0;
  if (now - last < DEBOUNCE_SECONDS) return false;
  debounce.set(key, now);
  return true;
}

// ── Button-press handling (shared by ESP32 + simulated paths) ────────────────
function handleButtonPress(mac: string, pressType: number, espMicros: number | null): void {
  mac = mac.toLowerCase();
  console.log(`  🔘 press ${mac} type=${pressType} @${new Date().toISOString().slice(11, 23)}`);
  if (enrolling) { handleEnrollPress(mac); return; } // registration mode captures presses
  if (pressType !== 1) return; // single-press only

  if (mac === starterMac) {
    if (race.state === "ready" && debounceOk(mac, "start")) {
      race.start(espMicros);
      broadcastRaceState();
    }
    return;
  }

  const lane = laneByMac.get(mac);
  if (lane === undefined) return; // unknown button

  if (race.state === "running" && debounceOk(mac, `lane_${lane}`)) {
    const elapsed = race.recordLane(lane, espMicros);
    if (elapsed !== null) {
      broadcastLaneTime(lane, elapsed, race.laneFinished[lane]!);
      settleCompletion();
    }
  }
}

// External start from the gateway (a start button / PA tone contact wired to the
// ESP). Starts the race exactly like the starter button, using the on-chip start
// timestamp — sound and timing share one trigger, so they're inherently synced.
function handleExternalStart(espMicros: number | null): void {
  console.log(`  🚦 external start @${new Date().toISOString().slice(11, 23)}`);
  if (race.state === "ready" && debounceOk("__ext_start__", "start")) {
    race.start(espMicros);
    broadcastRaceState();
  }
}

// ── Exports (mirror server.py .do3 / .lif) ───────────────────────────────────
function fmtMMSShh(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}
// Dolphin filename convention: AAA-BBB-CC[C]X[-]NNNN (AAA dataset 001-999, BBB
// event, CC/CCC heat, X round letter, NNNN race id). Verified against real
// samples: .do3 uses a 2-digit heat with NO dash before the race id
// (008-000-00F0001.do3); .do4 uses a 3-digit heat WITH a dash (008-000-001A-0010.do4).
function exportBaseName(ext: "do3" | "do4" | "lif"): string {
  const ds = String(race.datasetNum).padStart(3, "0");
  const ev = String(race.eventNum).padStart(3, "0");
  const id = String(race.raceIdCounter).padStart(4, "0");
  const round = "F"; // we only run timed finals
  if (ext === "do4") {
    const ht = String(race.heatNum).padStart(3, "0");
    return `${ds}-${ev}-${ht}${round}-${id}.do4`;
  }
  const ht = String(race.heatNum).padStart(2, "0");
  return `${ds}-${ev}-${ht}${round}${id}.${ext}`;
}

// Genuine Dolphin files end with a 16-hex-char checksum line. The algorithm is
// undocumented; importers we can inspect (e.g. Wahoo! Results) SKIP this line
// entirely, so a well-formed 16-hex value satisfies the file shape. We derive it
// deterministically from the body (FNV-1a, widened to 64 bits). If Sport Systems
// turns out to validate it, this is the single thing to replace with the real
// algorithm (needs a vendor sample to reverse-engineer).
function dolphinChecksum(body: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  for (let i = 0; i < body.length; i++) {
    h1 = Math.imul(h1 ^ body.charCodeAt(i), 0x01000193) >>> 0;
  }
  let h2 = Math.imul((h1 ^ 0xdeadbeef) >>> 0, 0x01000193) >>> 0;
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).toUpperCase();
}

// Build a Colorado Dolphin do3/do4 result file — Sport Systems / Hy-Tek Meet
// Manager import these as "Colorado Time Systems" AOE. Layout verified against
// real sample files (Wahoo! Results test corpus):
//   header:    <event>;<heat>;<num_splits>;<round>
//   10 lanes:  do3 → "<n>;t;t;t" (bare number, blanks for no time)
//              do4 → "Lane<n>;t;t;t" (0;0;0 for no time)
//   trailer:   16-hex checksum line
// Times are TOTAL SECONDS, 2 decimals (e.g. 143.31 = 2:23.31). We have one
// electronic time per lane, replicated across all three watch columns so the
// importer consolidates onto it cleanly. CRLF endings (Windows AOE convention).
function buildDolphin(ext: "do3" | "do4"): string {
  const isDo4 = ext === "do4";
  const prefix = isDo4 ? "Lane" : "";
  const empty = isDo4 ? "0;0;0" : ";;";
  const rows: string[] = [];
  rows.push(`${race.eventNum};${race.heatNum};1;Final`); // event;heat;num_splits;round
  for (let lane = 1; lane <= 10; lane++) {
    const r = lane <= NUM_LANES ? race.laneResult(lane) : null;
    if (r !== null) {
      const t = r.toFixed(2);
      rows.push(`${prefix}${lane};${t};${t};${t}`);
    } else {
      rows.push(`${prefix}${lane};${empty}`);
    }
  }
  const body = rows.join("\r\n") + "\r\n";
  return body + dolphinChecksum(body) + "\r\n";
}

function exportDo3(): string {
  mkdirSync(EXPORTS_DIR, { recursive: true });
  const name = exportBaseName("do3");
  writeFileSync(join(EXPORTS_DIR, name), buildDolphin("do3"));
  return name;
}
function exportDo4(): string {
  mkdirSync(EXPORTS_DIR, { recursive: true });
  const name = exportBaseName("do4");
  writeFileSync(join(EXPORTS_DIR, name), buildDolphin("do4"));
  return name;
}
function exportLif(): string {
  mkdirSync(EXPORTS_DIR, { recursive: true });
  const name = exportBaseName("lif");
  const finished: Array<[number, number]> = [];
  for (let lane = 1; lane <= NUM_LANES; lane++) {
    const r = race.laneResult(lane);
    if (r !== null) finished.push([lane, r]);
  }
  finished.sort((a, b) => a[1] - b[1]);
  const place = new Map<number, number>();
  finished.forEach(([lane], i) => place.set(lane, i + 1));

  const lines: string[] = [];
  lines.push(`; Event ${race.eventNum}, Heat ${race.heatNum}`);
  lines.push(`${race.eventNum},1,${race.heatNum},Event ${race.eventNum},,,,,,,,,`);
  for (let lane = 1; lane <= NUM_LANES; lane++) {
    const r = race.laneResult(lane);
    const p = place.get(lane) ?? 0;
    const t = r !== null ? fmtMMSShh(r) : "NT";
    lines.push(`${p},${lane},${lane},Lane ${lane},,,${t},,,,,,,,,,,,`);
  }
  writeFileSync(join(EXPORTS_DIR, name), lines.join("\n") + "\n");
  return name;
}
function doExport(ws: WebSocket, which: "do3" | "do4" | "lif" | "both"): void {
  try {
    const names: string[] = [];
    if (which === "do3" || which === "both") names.push(exportDo3());
    if (which === "do4" || which === "both") names.push(exportDo4());
    if (which === "lif" || which === "both") names.push(exportLif());
    for (const filename of names) {
      send(ws, { type: "export_ready", filename, url: `/exports/${filename}` });
    }
  } catch (e) {
    send(ws, { type: "toast", message: `Export failed: ${(e as Error).message}`, level: "error" });
  }
}

// ── WebSocket action handling (superset: dashboard + phone remote) ───────────
function num(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function handleAction(ws: WebSocket, msg: Record<string, unknown>): void {
  const action = String(msg.action || "");

  switch (action) {
    case "get_state":
      send(ws, fullState());
      break;

    case "set_event_heat":
      race.eventNum = num(msg.event ?? msg.event_num, race.eventNum);
      race.heatNum = num(msg.heat ?? msg.heat_num, race.heatNum);
      broadcast(fullState());
      break;

    case "prepare":
    case "prepare_race":
      race.prepare(num(msg.event ?? msg.event_num, race.eventNum), num(msg.heat ?? msg.heat_num, race.heatNum));
      broadcastRaceState();
      break;

    case "start":
    case "start_race":
      if (race.state === "ready") { race.start(); broadcastRaceState(); }
      else send(ws, { type: "toast", message: `Cannot start — state is ${race.state}`, level: "error" });
      break;

    case "stop":
    case "stop_race":
      race.stop(); settleCompletion(); // stop finalizes the race -> persist partial/full results
      break;

    case "reset":
    case "reset_race":
      race.reset(); broadcastRaceState();
      break;

    case "manual_time": {
      const lane = num(msg.lane, 0);
      const t = num(msg.time, 0);
      if (race.manualTime(lane, t)) {
        broadcastLaneTime(lane, t, true);
        settleCompletion();
      }
      break;
    }

    case "simulate_start":
      if (race.state === "ready") { race.start(); broadcastRaceState(); }
      else if (race.state === "idle") { race.prepare(race.eventNum, race.heatNum); race.start(); broadcastRaceState(); }
      break;

    case "simulate_lane":
    case "simulate_press": {
      const lane = num(msg.lane, 0);
      if (race.state === "running" && lane >= 1 && lane <= NUM_LANES) {
        const elapsed = race.recordLane(lane, null);
        if (elapsed !== null) {
          broadcastLaneTime(lane, elapsed, race.laneFinished[lane]!);
          settleCompletion();
        }
      }
      break;
    }

    case "set_config": {
      const key = String(msg.key || "");
      const value = String(msg.value || "");
      if (key in config || /^mac_lane_[1-6]$/.test(key) || ["mac_starter", "ha_url", "ha_token"].includes(key)) {
        (config as any)[key] = key.startsWith("mac_") ? value.toLowerCase() : value;
        rebuildMaps();
        persistLanes();
        broadcast(configMessage());
        toast(`Saved ${key}`, "success");
      }
      break;
    }

    case "start_enroll":
      startEnroll();
      break;
    case "cancel_enroll":
      cancelEnroll();
      break;

    case "export":
    case "export_results":
      doExport(ws, "both");
      break;
    case "export_do3":
      doExport(ws, "do3");
      break;
    case "export_do4":
      doExport(ws, "do4");
      break;
    case "export_lif":
      doExport(ws, "lif");
      break;

    default:
      send(ws, { type: "toast", message: `Unknown action: ${action}`, level: "error" });
  }
}

// ── HTTP + WebSocket server ──────────────────────────────────────────────────
function main(): void {
  loadLanes();
  mkdirSync(EXPORTS_DIR, { recursive: true });

  const app = express();
  app.use(express.json());
  app.get("/", (_req, res) => res.sendFile(join(STATIC_DIR, "index.html")));
  app.get("/remote", (_req, res) => res.sendFile(join(STATIC_DIR, "remote.html")));
  app.get("/api/state", (_req, res) => res.json(fullState()));
  app.get("/api/exports", (_req, res) => {
    try { res.json({ files: readdirSync(EXPORTS_DIR).sort() }); }
    catch { res.json({ files: [] }); }
  });
  app.get("/api/results", (_req, res) => {
    try { res.json({ results: listResults(200) }); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
  app.use("/exports", express.static(EXPORTS_DIR));
  app.get("/results", (_req, res) => res.sendFile(join(PUBLIC_DIR, "results.html")));
  app.use("/public", express.static(PUBLIC_DIR));
  app.use(express.static(STATIC_DIR)); // app.js, style.css, remote.html, etc.

  try { writeSite(); } catch { /* generated on first completion otherwise */ }

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    clients.add(ws);
    send(ws, fullState()); // hydrate on connect
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); }
      catch { send(ws, { type: "toast", message: "Invalid JSON", level: "error" }); return; }
      handleAction(ws, msg);
    });
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  // ── ESP32-C5 gateway: presses flow in over USB serial OR Wi-Fi TCP ──
  const transportLabel = USE_WIFI ? `wifi ${TCP_HOST}:${TCP_PORT}`
    : `USB serial (auto), Wi-Fi fallback → ${TCP_HOST}:${TCP_PORT}`;
  const gateway = USE_WIFI
    ? new Esp32Gateway({ host: TCP_HOST, tcpPort: TCP_PORT })
    : new Esp32Gateway({ auto: true, path: SERIAL_PORT, host: TCP_HOST, tcpPort: TCP_PORT });
  gatewayRef = gateway;
  gateway.on("open", (where?: string) => {
    bleConnected = true;
    pushStarterMac(); // (re)tell the gateway which button starts the race → siren
    lastErr = ""; // so the next disconnect always logs, even if the message repeats
    // Connected over Wi-Fi/TCP ⇒ the gateway is necessarily on Wi-Fi. (Firmware
    // only sends WIFI status lines over serial, so reflect it here.)
    if (where?.startsWith("wifi")) { wifiState = "connected"; wifiDetail = where.replace(/^wifi\s*/, ""); }
    broadcastConnection();
    console.log(`  📡 ESP32 gateway connected (${where ?? transportLabel})`);
  });
  gateway.on("ready", (v) => console.log(`  ✅ Gateway firmware ${v}`));
  let lastWifiLog = "";
  gateway.on("line", (line: string) => {
    if (line.startsWith("WIFI")) {
      const status = line.replace(/^WIFI\t/, "");
      if (status !== lastWifiLog) { console.log(`  📶 Wi-Fi: ${status}`); lastWifiLog = status; }
      parseWifiStatus(status);
      broadcastConnection();
    }
  });
  gateway.on("close", () => { bleConnected = false; wifiState = "unknown"; wifiDetail = ""; broadcastConnection(); });
  let lastErr = "";
  gateway.on("error", (e: Error) => {
    if (bleConnected) { bleConnected = false; broadcastConnection(); }
    if (e.message !== lastErr) { console.warn(`  ⚠️  ${e.message}`); lastErr = e.message; }
  });
  gateway.on("press", (ev: PressEvent) => handleButtonPress(ev.mac, ev.button, ev.espMicros));
  gateway.on("start", (espMicros: number) => handleExternalStart(espMicros));

  server.listen(PORT, HOST, () => {
    console.log();
    console.log(`  🏊 Swim Gala Timing System (TypeScript)`);
    console.log(`  Dashboard:    http://localhost:${PORT}`);
    console.log(`  Phone remote: http://localhost:${PORT}/remote`);
    console.log(`  ESP32 input:  ${transportLabel}`);
    console.log();
  });
}

main();
