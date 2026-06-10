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
 * connection_status{ble}, battery_status{lane,level}, config, toast,
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
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Esp32Gateway, PressEvent, DEFAULT_PORT, DEFAULT_TCP_HOST, DEFAULT_TCP_PORT } from "./esp32.js";
import { importStartListBuffer } from "./import.js";
import { saveRace, updateRace, listResults, completedHeatKeys, LaneRow } from "./store.js";
import { writeSite } from "./site.js";

// ── Paths ────────────────────────────────────────────────────────────────────
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(SRC_DIR, "..");
const STATIC_DIR = join(BASE_DIR, "static");
const EXPORTS_DIR = join(BASE_DIR, "exports");
const PUBLIC_DIR = join(BASE_DIR, "public");
const LANES_PATH = process.env.LANES_JSON || join(SRC_DIR, "lanes.json");

// ── Config ───────────────────────────────────────────────────────────────────
const NUM_LANES = 6;
const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT) || 8000;
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
  mac_starter?: string;
  pool_length_m?: string;       // pool length in metres (default "25") — sets splits-per-race
  collect_splits?: string;      // "1" = record per-length splits, else finish only
  review_before_export?: string; // "1" = hold finished heat for an editable review before the .do3 is written
  // Swimmer-name display (safeguarding) — any combination of these three "1"/"0" toggles:
  name_show_first?: string;        // first name
  name_show_last_initial?: string; // last-name initial only
  name_show_age?: string;          // age
  // Per-lane button MACs: mac_lane_{1..6} (primary) + optional mac_lane_{1..6}_b/_c.
  [key: string]: string | undefined;
}

// ── Lane map (from lanes.json, overridable via set_config) ───────────────────
interface LaneButton { role: string; label: string; mac: string }
interface LanesFile {
  port: string; baud: number; enrolledAt: string; buttons: LaneButton[];
  poolLengthM?: number; collectSplits?: boolean; reviewBeforeExport?: boolean;
  nameShowFirst?: boolean; nameShowLastInitial?: boolean; nameShowAge?: boolean;
}

let config: DashConfig = {
  pool_length_m: "25", collect_splits: "0", review_before_export: "1",
  name_show_first: "1", name_show_last_initial: "1", name_show_age: "0",
};

// Build the display name from a full roster name + age, per the name-display config.
// e.g. "Caitlin WELLARD", 11 → "Caitlin W (11)" / "Caitlin W" / "Caitlin (11)" / "W" …
function formatSwimmerName(fullName: string, age: number | null): string {
  if (!fullName) return "";
  const words = fullName.trim().split(/\s+/);
  const first = words[0] || "";
  const last = words.length > 1 ? words[words.length - 1]! : "";
  const parts: string[] = [];
  if ((config.name_show_first ?? "1") === "1") parts.push(first);
  if ((config.name_show_last_initial ?? "1") === "1" && last) parts.push(last[0]!.toUpperCase());
  let s = parts.join(" ");
  if ((config.name_show_age ?? "0") === "1" && age != null) s = s ? `${s} (${age})` : String(age);
  return s || first || fullName; // never blank
}
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
        const m = /^lane(\d)([bc])?$/.exec(b.role); // lane3 (primary), lane3b, lane3c (optional)
        if (m) config[`mac_lane_${m[1]}${m[2] ? `_${m[2]}` : ""}`] = mac;
      }
    }
    if (data.poolLengthM) config.pool_length_m = String(data.poolLengthM);
    if (data.collectSplits != null) config.collect_splits = data.collectSplits ? "1" : "0";
    if (data.reviewBeforeExport != null) config.review_before_export = data.reviewBeforeExport ? "1" : "0";
    if (data.nameShowFirst != null) config.name_show_first = data.nameShowFirst ? "1" : "0";
    if (data.nameShowLastInitial != null) config.name_show_last_initial = data.nameShowLastInitial ? "1" : "0";
    if (data.nameShowAge != null) config.name_show_age = data.nameShowAge ? "1" : "0";
  } catch {
    console.warn(`  ⚠️  No ${LANES_PATH} — run "npm run enroll" to register buttons.`);
  }
  rebuildMaps();
}

// Suffixes for a lane's optional buttons: primary, then optional B and C.
const BTN_SUFFIXES: ReadonlyArray<readonly [string, string]> = [["", ""], ["_b", "b"], ["_c", "c"]];

function rebuildMaps(): void {
  laneByMac = new Map();
  for (let i = 1; i <= NUM_LANES; i++) {
    for (const [suffix] of BTN_SUFFIXES) {
      const mac = config[`mac_lane_${i}${suffix}`];
      if (mac) laneByMac.set(mac.toLowerCase(), i); // every button on a lane maps to that lane
    }
  }
  starterMac = (config.mac_starter || "").toLowerCase();
  pushStarterMac(); // keep the gateway's local siren trigger in sync
}

function persistLanes(): void {
  const buttons: LaneButton[] = [];
  for (let i = 1; i <= NUM_LANES; i++) {
    for (const [suffix, roleSuffix] of BTN_SUFFIXES) {
      const mac = config[`mac_lane_${i}${suffix}`];
      if (mac) buttons.push({ role: `lane${i}${roleSuffix}`, label: `Lane ${i}${roleSuffix ? " " + roleSuffix.toUpperCase() : ""}`, mac: mac.toLowerCase() });
    }
  }
  if (config.mac_starter) buttons.push({ role: "start", label: "Starter", mac: config.mac_starter.toLowerCase() });
  const out: LanesFile = {
    port: SERIAL_PORT, baud: 115200, enrolledAt: new Date().toISOString(), buttons,
    poolLengthM: Number(config.pool_length_m) || 25,
    collectSplits: config.collect_splits === "1",
    reviewBeforeExport: (config.review_before_export || "1") === "1",
    nameShowFirst: (config.name_show_first ?? "1") === "1",
    nameShowLastInitial: (config.name_show_last_initial ?? "1") === "1",
    nameShowAge: (config.name_show_age ?? "0") === "1",
  };
  try { writeFileSync(LANES_PATH, JSON.stringify(out, null, 2) + "\n"); } catch { /* best effort */ }
}

// ── Race state machine (mirrors server.py RaceManager) ───────────────────────
// Splits + up to 3 buttons ("watches") per lane:
//  • Each wall touch may be timed by 1–3 buttons. Presses landing within
//    SPLIT_WINDOW_MS of each other (and up to MAX_WATCHES) count as the SAME
//    touch by different timers, consolidated per USA-Swimming rules (3 → median,
//    2 → average, 1 → that one). A press after the window opens the NEXT split
//    (the next lap). One button/lane is the default — extra buttons are optional
//    and simply add watches to the same touches.
//  • A lane finishes once it has `expectedTouches` touches. With ONE finish-end
//    button/pad the swimmer only touches the timed wall every SECOND length (the
//    far-end turns aren't timed), so touches = distance ÷ (2 × pool length). With
//    splits collection off, expectedTouches is 1 → the first touch is the finish.
const SPLIT_WINDOW_MS = 1500; // presses this close = the same wall touch (different timers)
const MAX_WATCHES = 3;        // buttons per lane the consolidation will accept

function truncHundredths(seconds: number): number {
  return Math.floor(seconds * 100) / 100;
}
/** Parse an edited time field: "92.95" / "1:32.95" / "1:32" → seconds, or null. */
// Parse "32.10" / "m:ss.hh" / "h:mm:ss.hh" (1–3 colon-separated parts) → seconds.
function parseTimeInput(s: string): number | null {
  s = s.trim();
  if (!s) return null;
  if (s.includes(":")) {
    const parts = s.split(":");
    if (parts.length > 3) return null;
    let total = 0;
    for (const p of parts) { const n = Number(p); if (!Number.isFinite(n)) return null; total = total * 60 + n; }
    return total;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
/** Consolidate up to 3 watch times for one touch into a single official time. */
function consolidateTimes(times: number[]): number | null {
  const valid = times.filter((t) => t != null && t > 0).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0]!;
  if (valid.length === 2) return truncHundredths((valid[0]! + valid[1]!) / 2); // average of two
  return valid[Math.floor(valid.length / 2)]!;                                 // median (middle) of three+
}

interface LanePress { elapsed: number; isFinish: boolean; splitIndex: number }

class RaceManager {
  state: RaceState = "idle";
  eventNum = 1;
  heatNum = 1;
  datasetNum = 1;
  raceIdCounter = 0;
  startWall = 0;            // seconds (Date.now()/1000) — for the dashboard clock
  startEspMicros: number | null = null; // ESP on-chip µs — for accurate splits
  expectedTouches = 1;     // timed wall touches that make a finish (distance ÷ 2 pool lengths); 1 = finish only
  // lane -> ordered splits; each split = up to 3 raw watch elapsed-times (seconds).
  laneSplits: Record<number, number[][]> = {};
  laneFinished: Record<number, boolean> = {};
  battery: Record<number, number> = {};
  savedToStore = false;       // guard so each completed race is persisted exactly once
  savedRaceId: number | null = null; // store id once saved (so edits update in place)
  reviewPending = false;      // finished but held for an editable review before export
  private splitOpenWall: Record<number, number> = {}; // wall ms the current split's first watch landed

  constructor() { this.clearLanes(); }

  private clearLanes(): void {
    for (let i = 1; i <= NUM_LANES; i++) { this.laneSplits[i] = []; this.laneFinished[i] = false; this.splitOpenWall[i] = 0; }
  }

  prepare(eventNum: number, heatNum: number, expectedTouches = 1): void {
    this.eventNum = eventNum; this.heatNum = heatNum;
    this.expectedTouches = Math.max(1, expectedTouches);
    this.raceIdCounter += 1;
    this.state = "ready";
    this.startWall = 0; this.startEspMicros = null;
    this.savedToStore = false; this.savedRaceId = null; this.reviewPending = false;
    this.clearLanes();
  }

  start(espMicros: number | null = null): void {
    this.startWall = Date.now() / 1000;
    this.startEspMicros = espMicros;
    this.state = "running";
  }

  /**
   * Record a button press for a lane. Groups it into the current open split (a
   * 2nd/3rd timer's watch of the same touch) or opens the next split (a new lap).
   * Returns the press's elapsed time + which split it landed in, or null if the
   * press isn't recordable (not running / stray press after the finish).
   */
  recordLane(lane: number, espMicros: number | null = null): LanePress | null {
    if (this.state !== "running") return null;
    if (lane < 1 || lane > NUM_LANES) return null;
    let elapsed: number;
    if (espMicros != null && this.startEspMicros != null) {
      elapsed = (espMicros - this.startEspMicros) / 1e6;       // precise, on-chip
    } else {
      elapsed = Date.now() / 1000 - this.startWall;            // wall-clock fallback
    }
    if (elapsed < 0) elapsed = 0;

    const splits = this.laneSplits[lane]!;
    const nowWall = Date.now();
    const last = splits[splits.length - 1];
    const withinWindow = splits.length > 0 && nowWall - (this.splitOpenWall[lane] || 0) <= SPLIT_WINDOW_MS;
    let splitIndex: number;
    if (withinWindow && last && last.length < MAX_WATCHES) {
      last.push(elapsed);                 // another timer's watch of the same touch
      splitIndex = splits.length - 1;
    } else {
      if (this.laneFinished[lane]) return null; // finished + window closed → ignore stray press
      splits.push([elapsed]);             // a new wall touch (the next lap)
      this.splitOpenWall[lane] = nowWall;
      splitIndex = splits.length - 1;
    }

    const isFinish = splits.length >= this.expectedTouches;
    if (isFinish) this.laneFinished[lane] = true;
    if (Object.values(this.laneFinished).every(Boolean)) this.state = "completed";
    return { elapsed, isFinish, splitIndex };
  }

  manualTime(lane: number, t: number): boolean {
    if (lane < 1 || lane > NUM_LANES || t <= 0) return false;
    this.laneSplits[lane] = [[t]];        // a manual entry is a finish time (no splits)
    this.splitOpenWall[lane] = 0;
    this.laneFinished[lane] = true;
    if (Object.values(this.laneFinished).every(Boolean)) this.state = "completed";
    return true;
  }

  stop(): void { this.state = "completed"; }
  reset(): void { this.state = "idle"; this.startWall = 0; this.startEspMicros = null; this.savedToStore = false; this.savedRaceId = null; this.reviewPending = false; this.clearLanes(); }

  /** Operator edit of a lane's result: a time string ("32.10", "1:05.30") or ""/"NT" to clear. */
  setLaneResult(lane: number, raw: string): boolean {
    if (lane < 1 || lane > NUM_LANES) return false;
    const s = raw.trim();
    if (s === "" || /^nt$/i.test(s)) {
      this.laneSplits[lane] = [];          // no time (NT), but resolved
      this.laneFinished[lane] = true;
      return true;
    }
    const t = parseTimeInput(s);
    if (t == null || t <= 0) return false;
    this.laneSplits[lane] = [[t]];         // manual finish time (collapses any splits)
    this.laneFinished[lane] = true;
    return true;
  }

  elapsedSeconds(): number {
    if (this.state !== "running" || !this.startWall) return 0;
    return Date.now() / 1000 - this.startWall;
  }

  /** The official finish time for a lane = consolidated last split, or null (NT). */
  laneResult(lane: number): number | null {
    const splits = this.laneSplits[lane] || [];
    return splits.length ? consolidateTimes(splits[splits.length - 1]!) : null;
  }

  /** Consolidated cumulative time at each recorded split (for display + export). */
  laneSplitTimes(lane: number): number[] {
    return (this.laneSplits[lane] || [])
      .map((w) => consolidateTimes(w))
      .filter((t): t is number => t != null);
  }

  /** Largest number of splits any lane recorded (≥1). */
  maxSplits(): number {
    let m = 1;
    for (let i = 1; i <= NUM_LANES; i++) m = Math.max(m, (this.laneSplits[i] || []).length);
    return m;
  }
}

const race = new RaceManager();

// ── Enrollment (server-driven, triggered from the dashboard) ─────────────────
// Press order: all of lane 1's buttons, then lane 2's, … then the starter. With
// buttonsPerLane=1 (default) it's the classic 6 lanes + starter. 2 or 3 adds the
// optional B/C buttons per lane.
function buildEnrollSlots(buttonsPerLane: number): Array<{ role: string; label: string }> {
  const n = Math.min(MAX_WATCHES, Math.max(1, buttonsPerLane));
  const slots: Array<{ role: string; label: string }> = [];
  for (let i = 1; i <= NUM_LANES; i++) {
    slots.push({ role: `lane${i}`, label: `Lane ${i}` });
    if (n >= 2) slots.push({ role: `lane${i}b`, label: `Lane ${i} · btn B` });
    if (n >= 3) slots.push({ role: `lane${i}c`, label: `Lane ${i} · btn C` });
  }
  slots.push({ role: "start", label: "Starter" });
  return slots;
}
let enrollSlots = buildEnrollSlots(1);
let enrolling = false;
let enrollIndex = 0;
const enrollAssigned = new Map<string, string>(); // mac -> role (ignore repeats)
let enrollPrevConfig: DashConfig | null = null;

// ── WebSocket clients + broadcast helpers (app.js message shapes) ────────────
const clients = new Set<WebSocket>();
let bleConnected = false;
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
  const msg: Record<string, unknown> = { type: "config" };
  for (let i = 1; i <= NUM_LANES; i++) {
    msg[`mac_lane_${i}`] = config[`mac_lane_${i}`] || "";
    msg[`mac_lane_${i}_b`] = config[`mac_lane_${i}_b`] || ""; // optional 2nd button
    msg[`mac_lane_${i}_c`] = config[`mac_lane_${i}_c`] || ""; // optional 3rd button
  }
  msg.mac_starter = config.mac_starter || "";
  msg.pool_length_m = config.pool_length_m || "25";
  msg.collect_splits = config.collect_splits || "0";
  msg.review_before_export = config.review_before_export || "1";
  msg.name_show_first = config.name_show_first ?? "1";
  msg.name_show_last_initial = config.name_show_last_initial ?? "1";
  msg.name_show_age = config.name_show_age ?? "0";
  return msg;
}

// ── Roster / events (from roster.csv + events.csv, e.g. `npm run import`) ─────
// Feeds swimmer names into the LIVE dashboard. Reloaded on event/heat change so
// a mid-meet re-import shows up without a server restart.
const ROSTER_PATH = process.env.ROSTER || join(BASE_DIR, "roster.csv");
const EVENTS_PATH = process.env.EVENTS || join(BASE_DIR, "events.csv");
interface RosterSwimmer { name: string; age: number | null; sex: string; club: string; seed: string }
let roster = new Map<string, RosterSwimmer>();         // key: `${event}-${heat}-${lane}`
let eventNames = new Map<number, string>();            // event number -> display name
let eventDistances = new Map<number, number>();        // event number -> race distance (metres)

// Parse a distance string ("50m", "100m", relay "4x50m") into total metres.
function parseDistanceMeters(s: string): number {
  const relay = /(\d+)\s*x\s*(\d+)/i.exec(s); // "4x50m" → 4 legs × 50 m
  if (relay) return Number(relay[1]) * Number(relay[2]);
  const m = /(\d+)/.exec(s);
  return m ? Number(m[1]) : 0;
}

// How many timed wall touches this event makes. With a single finish-end pad/button
// the swimmer touches the timed wall only every SECOND length (the far-end turns
// aren't timed), so touches = distance ÷ (2 × pool length). e.g. 100m in a 25m pool
// → 2 touches (a 50m split + the finish); 50m in a 25m pool → 1 (finish only, no
// split). Returns 1 when splits collection is off or the distance/pool is unknown.
function expectedTouchesFor(eventNum: number): number {
  if ((config.collect_splits || "0") !== "1") return 1;
  const dist = eventDistances.get(eventNum) || 0;
  const pool = Number(config.pool_length_m) || 25;
  if (!dist || !pool) return 1;
  return Math.max(1, Math.round(dist / (2 * pool)));
}

function parseCsvRows(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = (cells[i] ?? "").trim()));
    return o;
  });
}
function reloadRoster(): void {
  const r = new Map<string, RosterSwimmer>();
  if (existsSync(ROSTER_PATH)) {
    for (const row of parseCsvRows(readFileSync(ROSTER_PATH, "utf8"))) {
      const event = Number(row.event), heat = Number(row.heat), lane = Number(row.lane);
      if (!event || !heat || !lane) continue;
      r.set(`${event}-${heat}-${lane}`, {
        name: row.name || "", age: row.age ? Number(row.age) : null,
        sex: (row.sex || "").toUpperCase(), club: row.club || "", seed: row.seed || "",
      });
    }
  }
  const e = new Map<number, string>();
  const ed = new Map<number, number>();
  if (existsSync(EVENTS_PATH)) {
    for (const row of parseCsvRows(readFileSync(EVENTS_PATH, "utf8"))) {
      const event = Number(row.event);
      if (!event) continue;
      if (row.name) e.set(event, row.name);
      const dist = parseDistanceMeters(row.distance || "");
      if (dist) ed.set(event, dist);
    }
  }
  roster = r; eventNames = e; eventDistances = ed;
}
reloadRoster(); // initial load at startup

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function rowsToCsv(header: string[], rows: Record<string, string>[]): string {
  return header.join(",") + "\n" + rows.map((r) => header.map((h) => csvCell(r[h] ?? "")).join(",")).join("\n") + "\n";
}

// Merge a freshly-imported start list with the current one, PRESERVING heats that
// have already been run (their roster rows stay, so stored results' name lookups
// remain valid). The import overwrites only not-yet-run heats. results.json is never
// touched, so completed results are always kept.
function mergeStartList(newRosterCsv: string, newEventsCsv: string): { rosterCsv: string; eventsCsv: string } {
  const done = completedHeatKeys();
  const isDone = (r: Record<string, string>) => done.has(`${Number(r.event)}-${Number(r.heat)}`);
  const oldRoster = existsSync(ROSTER_PATH) ? parseCsvRows(readFileSync(ROSTER_PATH, "utf8")) : [];
  const newRoster = parseCsvRows(newRosterCsv);
  const rosterRows = [...oldRoster.filter(isDone), ...newRoster.filter((r) => !isDone(r))]
    .sort((a, b) => Number(a.event) - Number(b.event) || Number(a.heat) - Number(b.heat) || Number(a.lane) - Number(b.lane));

  // Events: new file's version wins per event number; keep old events not in the new file.
  const byNum = new Map<number, Record<string, string>>();
  if (existsSync(EVENTS_PATH)) for (const e of parseCsvRows(readFileSync(EVENTS_PATH, "utf8"))) byNum.set(Number(e.event), e);
  for (const e of parseCsvRows(newEventsCsv)) byNum.set(Number(e.event), e);
  const eventRows = [...byNum.values()].sort((a, b) => Number(a.event) - Number(b.event));

  return {
    rosterCsv: rowsToCsv(["event", "heat", "lane", "name", "age", "sex", "club", "seed"], rosterRows),
    eventsCsv: rowsToCsv(["event", "name", "stroke", "distance", "sex", "agegroup"], eventRows),
  };
}

// ── Schedule (distinct event/heat from the imported roster) ──────────────────
// Drives the control-panel selector and the auto-advance. `completed` is derived
// from the persisted results store, so it survives a server restart.
interface ScheduleEntry { event: number; heat: number; event_name: string; swimmers: number; completed: boolean }
function buildSchedule(): ScheduleEntry[] {
  const seen = new Map<string, { event: number; heat: number; swimmers: number }>();
  for (const key of roster.keys()) {
    const parts = key.split("-");
    const event = Number(parts[0]), heat = Number(parts[1]);
    if (!event || !heat) continue;
    const k = `${event}-${heat}`;
    const cur = seen.get(k) ?? { event, heat, swimmers: 0 };
    cur.swimmers += 1;
    seen.set(k, cur);
  }
  const done = completedHeatKeys();
  return [...seen.values()]
    .sort((a, b) => a.event - b.event || a.heat - b.heat)
    .map((e) => ({
      event: e.event, heat: e.heat,
      event_name: eventNames.get(e.event) ?? "",
      swimmers: e.swimmers,
      completed: done.has(`${e.event}-${e.heat}`),
    }));
}

/** First heat in the schedule that has not been completed, or null if all done. */
function firstUncompletedHeat(): { event: number; heat: number } | null {
  const next = buildSchedule().find((s) => !s.completed);
  return next ? { event: next.event, heat: next.heat } : null;
}

function fullState(): Record<string, unknown> {
  const lanes: Record<number, { time: number | null; finished: boolean; battery: number | null; name: string; club: string; seed: string; splits: number[] }> = {};
  for (let i = 1; i <= NUM_LANES; i++) {
    const sw = roster.get(`${race.eventNum}-${race.heatNum}-${i}`);
    lanes[i] = {
      time: race.laneResult(i), finished: race.laneFinished[i]!, battery: race.battery[i] ?? null,
      name: formatSwimmerName(sw?.name ?? "", sw?.age ?? null), club: sw?.club ?? "", seed: sw?.seed ?? "", splits: race.laneSplitTimes(i),
    };
  }
  const cfg = configMessage();
  delete (cfg as any).type;
  return {
    type: "full_state",
    event: race.eventNum, heat: race.heatNum,
    event_name: eventNames.get(race.eventNum) ?? "",
    state: race.state,
    start_time: race.startWall, elapsed: race.elapsedSeconds(),
    expected_touches: race.expectedTouches,
    review_pending: race.reviewPending,
    review_mode: (config.review_before_export || "1") === "1",
    exported: race.savedToStore,
    lanes, ble: bleConnected,
    wifi: wifiState, wifi_detail: wifiDetail, config: cfg,
    schedule: buildSchedule(),
  };
}

function broadcastRaceState(): void {
  broadcast({ type: "race_state", state: race.state, start_time: race.startWall, elapsed: race.elapsedSeconds() });
}
function broadcastLaneTime(lane: number, time: number, isFinish: boolean, splitIndex = 0): void {
  broadcast({ type: "lane_time", lane, time: Math.round(time * 1000) / 1000, is_finish: isFinish, split_index: splitIndex });
}
function broadcastConnection(): void {
  broadcast({ type: "connection_status", ble: bleConnected, wifi: wifiState, wifi_detail: wifiDetail });
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

// LaneRow[] for the current race (consolidated time + place + splits).
function currentLaneRows(): LaneRow[] {
  const place = placesByLane();
  const lanes: LaneRow[] = [];
  for (let lane = 1; lane <= NUM_LANES; lane++) {
    lanes.push({
      lane,
      time: race.laneResult(lane),
      place: place.get(lane) ?? null,
      finished: race.laneFinished[lane]!,
      splits: race.laneSplitTimes(lane),
    });
  }
  return lanes;
}

// Persist the completed race — INSERT on first save, UPDATE in place if it was
// already saved (i.e. an edit after export). Tracks the store id on the race.
function saveResults(): void {
  const lanes = currentLaneRows();
  if (race.savedToStore && race.savedRaceId != null) {
    updateRace(race.savedRaceId, lanes);
    return;
  }
  const id = saveRace(
    {
      eventNum: race.eventNum, heatNum: race.heatNum,
      raceId: race.raceIdCounter, datasetNum: race.datasetNum,
      startedAt: race.startWall ? new Date(race.startWall * 1000).toISOString() : null,
      completedAt: new Date().toISOString(),
    },
    lanes
  );
  race.savedRaceId = id; race.savedToStore = true;
  console.log(`  💾 Saved results: event ${race.eventNum} heat ${race.heatNum} -> results.json #${id}`);
}

// Persist + publish + write the Colorado Dolphin .do3 (the file Sport Systems'
// CTS Dolphin capture reads — confirmed by binary analysis; SS reads .do3, not
// .do4). Clears the review hold. Used for hands-free finalise, the "Confirm &
// Export" click, and re-export after an edit.
function finalizeAndExport(): void {
  try {
    saveResults();
    race.reviewPending = false;
    try { writeSite(); } catch (e) { console.warn(`  ⚠️  Site publish failed: ${(e as Error).message}`); }
    try {
      const filename = exportDo3();
      broadcast({ type: "export_ready", filename, url: `/exports/${filename}` });
      console.log(`  📤 Exported ${filename}`);
      toast(`Results saved + exported (event ${race.eventNum}, heat ${race.heatNum})`, "success");
    } catch (e) {
      console.warn(`  ⚠️  Export failed: ${(e as Error).message}`);
    }
  } catch (e) {
    console.warn(`  ⚠️  Failed to save results: ${(e as Error).message}`);
  }
}

// On completion: if "review before export" is on, HOLD the heat for an editable
// review (no .do3 yet) until the operator confirms. Otherwise persist + export now.
function settleCompletion(): void {
  if (race.state !== "completed") return;
  broadcastRaceState();
  const review = (config.review_before_export || "1") === "1";
  if (review && !race.savedToStore) {
    race.reviewPending = true;       // editable table shown; .do3 held until confirm
  } else if (!race.savedToStore) {
    finalizeAndExport();             // hands-free auto-export
  }
  broadcast(fullState()); // refresh schedule + review state for all clients
}

// ── Enrollment (press-order registration, driven from the dashboard) ─────────
function broadcastEnroll(extra: Record<string, unknown>): void {
  broadcast({ type: "enroll", total: enrollSlots.length, ...extra });
}

// Map an enroll slot role ("lane3", "lane3b", "lane3c", "start") to its config key.
function enrollKeyForRole(role: string): string {
  if (role === "start") return "mac_starter";
  const m = /^lane(\d)([bc])?$/.exec(role)!;
  return `mac_lane_${m[1]}${m[2] ? `_${m[2]}` : ""}`;
}

function startEnroll(buttonsPerLane = 1): void {
  enrollSlots = buildEnrollSlots(buttonsPerLane);
  enrolling = true;
  enrollIndex = 0;
  enrollAssigned.clear();
  enrollPrevConfig = { ...config }; // snapshot for cancel
  // Fresh start: drop any previously-enrolled lane/starter buttons so re-enrolling
  // with fewer buttons-per-lane doesn't leave stale B/C entries behind.
  for (let i = 1; i <= NUM_LANES; i++) for (const [s] of BTN_SUFFIXES) delete config[`mac_lane_${i}${s}`];
  delete config.mac_starter;
  broadcastEnroll({ status: "started", slot: enrollSlots[0]!.label, index: 0 });
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
  const slot = enrollSlots[enrollIndex];
  if (!slot) return;
  enrollAssigned.set(mac, slot.role);
  config[enrollKeyForRole(slot.role)] = mac;
  enrollIndex++;
  const next = enrollSlots[enrollIndex];
  broadcastEnroll({ status: "assigned", slot: slot.label, role: slot.role, mac, index: enrollIndex - 1, next: next?.label });

  if (!next) {
    // Every slot assigned — commit.
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
    const res = race.recordLane(lane, espMicros);
    if (res !== null) {
      broadcastLaneTime(lane, res.elapsed, res.isFinish, res.splitIndex);
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

// Render one split's three watch columns exactly as real Dolphin files do:
// each of the up-to-3 button times, BLANK for an un-pressed watch (e.g. "88.31;;"
// or ";43.42;43.41"), and the whole-split no-touch placeholder otherwise — "0;0;0"
// in .do4, bare ";;" in .do3. Times are TOTAL SECONDS, 2 decimals (143.31 = 2:23.31).
function watchCols(watches: number[] | undefined, do3: boolean): string {
  if (!watches || watches.length === 0) return do3 ? ";;" : "0;0;0";
  return [0, 1, 2].map((i) => (watches[i] != null ? watches[i]!.toFixed(2) : "")).join(";");
}

// Build a Colorado Dolphin do3/do4 result file — Sport Systems / Hy-Tek Meet
// Manager import these as "Colorado Time Systems" AOE. Layout verified against
// real sample files (Wahoo! Results test corpus):
//   header:    <event>;<heat>;<num_splits>;<round>
//   lanes:     do3 → "<n>;t;t;t" (bare number), finals only (1 line/lane)
//              do4 → "Lane<n>;t;t;t", num_splits lines per lane (split 1..N, last = finish)
//   trailer:   16-hex checksum line (importers skip it; ours is a placeholder)
// Each value is one button's cumulative time at that wall; up to 3 per split.
function buildDolphin(ext: "do3" | "do4"): string {
  const isDo4 = ext === "do4";
  const numSplits = isDo4 ? race.maxSplits() : 1; // .do3 carries the finish only
  const rows: string[] = [];
  rows.push(`${race.eventNum};${race.heatNum};${numSplits};Final`); // event;heat;num_splits;round
  for (let lane = 1; lane <= 10; lane++) {
    const splits = lane <= NUM_LANES ? (race.laneSplits[lane] || []) : [];
    if (isDo4) {
      // One line per split. The file must hold num_splits*10 lane lines, so lanes
      // with fewer splits (DNF / empty) pad with "0;0;0".
      for (let s = 0; s < numSplits; s++) rows.push(`Lane${lane};${watchCols(splits[s], false)}`);
    } else {
      rows.push(`${lane};${watchCols(splits[splits.length - 1], true)}`); // do3: final split's watches
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
function doExport(ws: WebSocket, which: "do3" | "lif" | "both"): void {
  try {
    const names: string[] = [];
    if (which === "do3" || which === "both") names.push(exportDo3());
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
      reloadRoster();
      broadcast(fullState());
      break;

    case "reload_roster":
      reloadRoster();
      broadcast(fullState());
      toast("Roster reloaded", "success");
      break;

    case "prepare":
    case "prepare_race": {
      reloadRoster();
      let ev = num(msg.event ?? msg.event_num, race.eventNum);
      let ht = num(msg.heat ?? msg.heat_num, race.heatNum);
      // If the selected heat is already completed (e.g. you just finished it and
      // clicked Prepare again), auto-advance to the next heat still to run — so you
      // move through the schedule without a manual Reset or dropdown change.
      if (completedHeatKeys().has(`${ev}-${ht}`)) {
        const next = firstUncompletedHeat();
        if (next) { ev = next.event; ht = next.heat; }
      }
      race.prepare(ev, ht, expectedTouchesFor(ev));
      broadcast(fullState());
      break;
    }

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
    case "reset_race": {
      race.reset();
      // Auto-advance: after finishing a heat, Reset moves on to the next heat that
      // hasn't been completed yet (the just-finished one is now excluded). If an
      // aborted heat wasn't completed, it stays the first-uncompleted, so we hold.
      const next = firstUncompletedHeat();
      if (next && (next.event !== race.eventNum || next.heat !== race.heatNum)) {
        race.eventNum = next.event; race.heatNum = next.heat; reloadRoster();
      }
      broadcast(fullState());
      break;
    }

    case "restart_gateway":
    case "restart_esp":
      if (gatewayRef) {
        gatewayRef.restart().then((r) => {
          toast(r.ok ? "ESP32 restarting…" : `ESP32 restart failed: ${r.detail}`, r.ok ? "info" : "error");
        });
      } else {
        toast("ESP32 restart failed: no gateway", "error");
      }
      break;

    case "test_beep":
      if (gatewayRef) { gatewayRef.send("BEEP\n"); toast("Test beep sent", "info"); }
      else toast("Test beep failed: no gateway", "error");
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

    // Edit a finished lane's result in the review table (a time string, or ""/"NT").
    // If the heat was already exported, re-save + re-export the .do3 so the file matches.
    case "set_lane_result": {
      if (race.state !== "completed") { send(ws, { type: "toast", message: "Edit only after the heat finishes", level: "error" }); break; }
      const lane = num(msg.lane, 0);
      if (race.setLaneResult(lane, String(msg.time ?? ""))) {
        if (race.savedToStore) finalizeAndExport(); // already exported → keep the file in sync
        broadcast(fullState());
      }
      break;
    }

    // Confirm the reviewed results and write the .do3 (ends the review hold).
    case "confirm_export":
      if (race.state === "completed") { finalizeAndExport(); broadcast(fullState()); }
      else send(ws, { type: "toast", message: "No finished heat to export", level: "error" });
      break;

    case "simulate_start":
      if (race.state === "ready") { race.start(); broadcastRaceState(); }
      else if (race.state === "idle") { race.prepare(race.eventNum, race.heatNum, expectedTouchesFor(race.eventNum)); race.start(); broadcastRaceState(); }
      break;

    case "simulate_lane":
    case "simulate_press": {
      const lane = num(msg.lane, 0);
      if (race.state === "running" && lane >= 1 && lane <= NUM_LANES) {
        const res = race.recordLane(lane, null);
        if (res !== null) {
          broadcastLaneTime(lane, res.elapsed, res.isFinish, res.splitIndex);
          settleCompletion();
        }
      }
      break;
    }

    case "set_config": {
      const key = String(msg.key || "");
      const value = String(msg.value || "");
      const isMac = /^mac_lane_[1-6](_[bc])?$/.test(key) || key === "mac_starter";
      const isSetting = ["pool_length_m", "collect_splits", "review_before_export",
        "name_show_first", "name_show_last_initial", "name_show_age"].includes(key);
      if (isMac || isSetting) {
        config[key] = isMac ? value.toLowerCase() : value;
        rebuildMaps();
        persistLanes();
        broadcast(configMessage());
        toast(`Saved ${key}`, "success");
      }
      break;
    }

    case "start_enroll":
      startEnroll(num(msg.buttons_per_lane, 1));
      break;
    case "cancel_enroll":
      cancelEnroll();
      break;

    case "export":
    case "export_results":
      doExport(ws, "both");
      break;
    case "export_do3":
    case "export_do4": // legacy alias — we now only emit .do3 (Sport Systems reads .do3)
      doExport(ws, "do3");
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
  app.get("/view", (_req, res) => res.sendFile(join(STATIC_DIR, "view.html")));
  app.get("/api/state", (_req, res) => res.json(fullState()));
  app.get("/api/exports", (_req, res) => {
    try { res.json({ files: readdirSync(EXPORTS_DIR).sort() }); }
    catch { res.json({ files: [] }); }
  });
  app.get("/api/results", (_req, res) => {
    try { res.json({ results: listResults(200) }); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
  // Upload a start list from the dashboard's Settings — a Sport Systems heat-sheet
  // (.txt) or Lenex (.lef/.lxf), auto-detected. Writes roster.csv/events.csv,
  // reloads the live roster, and pushes names to all clients.
  app.post("/api/import", express.raw({ type: "*/*", limit: "25mb" }), (req, res) => {
    try {
      const imported = importStartListBuffer(req.body as Buffer);
      const preserved = completedHeatKeys().size; // heats already run — kept on re-import
      const merged = mergeStartList(imported.rosterCsv, imported.eventsCsv);
      writeFileSync(EVENTS_PATH, merged.eventsCsv);
      writeFileSync(ROSTER_PATH, merged.rosterCsv);
      reloadRoster();
      broadcast(fullState());
      const note = preserved ? ` (${preserved} completed heat${preserved === 1 ? "" : "s"} kept)` : "";
      toast(`Imported ${imported.summary.entries} swimmers across ${imported.summary.eventCount} events${note}`, "success");
      res.json({ ok: true, summary: imported.summary, preserved });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
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
    } else if (process.env.RAW_SERIAL) {
      // Diagnostic: `RAW_SERIAL=1 npm start` echoes every non-WIFI line the ESP sends.
      // Invaluable for the usbserial-vs-usbmodem "no presses" trap — if this stays silent
      // after "gateway connected", you're on the wrong USB port (native usbmodem ≠ data).
      console.log(`  🪵 raw: ${JSON.stringify(line)}`);
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
    console.log(`  Live view:    http://localhost:${PORT}/view`);
    console.log(`  ESP32 input:  ${transportLabel}`);
    console.log();
  });
}

main();
