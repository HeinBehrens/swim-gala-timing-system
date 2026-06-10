/**
 * Lenex start-list importer
 * =========================
 * Reads a Lenex meet file (the British/European interchange standard that Sport
 * Systems and most meet software export) and writes the two CSVs this system
 * already consumes:
 *   - roster.csv : event,heat,lane,name,age,sex,club   (per-swimmer heat sheet)
 *   - events.csv : event,name,stroke,distance,sex,agegroup
 *
 * Accepts:
 *   - .lef  — Lenex as plain XML
 *   - .lxf  — Lenex zipped (single .lef inside); unzipped via Node's built-in zlib
 *
 * Usage:
 *   npm run import -- path/to/meet.lef        # writes roster.csv + events.csv
 *   npm run import -- path/to/meet.lxf
 *   ROSTER=out/roster.csv EVENTS=out/events.csv npm run import -- meet.lef
 *
 * NOTE: Lenex is a published standard and Sport Systems is Lenex-compliant, but
 * exact attribute usage varies a little between programs. This parser is
 * defensive (tries common variants), logs what it found, and is easy to tweak.
 * If a real export maps a field oddly, the mapping is all in lenexToRows().
 */

import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

// ── Tiny XML parser (dependency-free) ────────────────────────────────────────
// Lenex is well-formed XML that is almost entirely attributes on nested
// elements, so we only need element tags + attributes (text nodes are ignored).

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  // Strip declarations, comments and DOCTYPE.
  xml = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  const tagRe = /<\/?([A-Za-z_][\w.-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const [whole, tag, attrText, selfClose] = m;
    const isClose = whole.startsWith("</");
    if (isClose) {
      // pop to matching tag
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const node: XmlNode = { tag, attrs: parseAttrs(attrText ?? ""), children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
}

function findAll(node: XmlNode, tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => { for (const c of n.children) { if (c.tag === tag) out.push(c); walk(c); } };
  walk(node);
  return out;
}
function child(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

// ── .lxf (zip) → .lef (xml) ──────────────────────────────────────────────────
// A .lxf is a ZIP holding a single .lef. Read the End-Of-Central-Directory to
// find the central-directory entry (reliable sizes), then inflate the entry.
function unzipSingle(buf: Buffer): string {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); // PK\x05\x06
  if (eocd < 0) throw new Error("not a zip (no EOCD) — try exporting as .lef");
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error("bad central directory");
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const extraLen = buf.readUInt16LE(cdOffset + 30);
  const cdCommentLen = buf.readUInt16LE(cdOffset + 32);
  const localOff = buf.readUInt32LE(cdOffset + 42);
  void nameLen; void extraLen; void cdCommentLen;
  // local header at localOff: sig(4) ... namelen@26 extralen@28
  if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("bad local header");
  const lNameLen = buf.readUInt16LE(localOff + 26);
  const lExtraLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + lNameLen + lExtraLen;
  const comp = buf.subarray(dataStart, dataStart + compSize);
  return (method === 0 ? comp : inflateRawSync(comp)).toString("utf8");
}

// ── Lenex → CSV rows ─────────────────────────────────────────────────────────

const STROKE: Record<string, string> = {
  FREE: "Freestyle", BACK: "Backstroke", BREAST: "Breaststroke", FLY: "Butterfly",
  MEDLEY: "Medley", IM: "Medley", UNKNOWN: "",
};
function genderWord(g: string): string {
  const u = g.toUpperCase();
  if (u === "M" || u === "MALE") return "Boys";
  if (u === "F" || u === "FEMALE") return "Girls";
  return "Mixed"; // X / A / mixed / all
}
function sexLetter(g: string): string {
  const u = g.toUpperCase();
  if (u.startsWith("M")) return "M";
  if (u.startsWith("F")) return "F";
  return "X";
}

interface RosterRow { event: number; heat: number; lane: number; name: string; age: number | ""; sex: string; club: string; seed: string; }
interface EventRow { event: number; name: string; stroke: string; distance: string; sex: string; agegroup: string; }

// Normalise a seed/entry time to a tidy display string ("1:07.79", "50.71"), or ""
// for blank/NT. Handles Lenex "HH:MM:SS.ss" and Sport Systems "m:ss.hh" / "ss.hh".
function normalizeSeed(s: string): string {
  s = (s || "").trim();
  if (!s || /^(nt|0|00:00(\.0+)?|00:00:00(\.0+)?)$/i.test(s)) return "";
  const m = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(s); // HH:MM:SS.ss (Lenex)
  if (m) {
    const h = +m[1]!, mm = +m[2]!, ss = m[3]!;
    if (h > 0) return `${h}:${String(mm).padStart(2, "0")}:${ss}`;
    if (mm > 0) return `${mm}:${ss}`;
    return ss;
  }
  return s; // already "m:ss.hh" or "ss.hh"
}

function ageFrom(birth: string, meetDate: string): number | "" {
  // birth may be "YYYY-MM-DD" or "YYYY". Swimming age is commonly year-based.
  const by = parseInt(birth.slice(0, 4), 10);
  if (!by) return "";
  const my = parseInt((meetDate || "").slice(0, 4), 10) || new Date().getFullYear();
  return my - by;
}

function lenexToRows(root: XmlNode): { roster: RosterRow[]; events: EventRow[] } {
  const meet = findAll(root, "MEET")[0];
  const meetDate = (meet && findAll(meet, "SESSION")[0]?.attrs.date) || "";

  // event meta + heatid → heat number, keyed by eventid
  const eventMeta = new Map<string, EventRow>();
  const eventNumByHeatId = new Map<string, { event: number; heat: number }>();
  const eventNumById = new Map<string, number>();

  for (const ev of findAll(root, "EVENT")) {
    const eid = ev.attrs.eventid || ev.attrs.number || "";
    const num = parseInt(ev.attrs.number || ev.attrs.eventid || "0", 10);
    eventNumById.set(eid, num);
    const ss = child(ev, "SWIMSTYLE");
    const gender = ev.attrs.gender || ss?.attrs.gender || "";
    const dist = ss?.attrs.distance || "";
    const relay = parseInt(ss?.attrs.relaycount || "1", 10) || 1;
    const stroke = STROKE[(ss?.attrs.stroke || "").toUpperCase()] ?? (ss?.attrs.stroke || "");
    const distance = dist ? `${relay > 1 ? `${relay}x` : ""}${dist}m` : "";
    const ag = findAll(ev, "AGEGROUP")[0]?.attrs;
    const agegroup = ag
      ? (ag.agemin && ag.agemin !== "-1" ? `${ag.agemin}-${ag.agemax}` : (ag.name || "Open"))
      : "Open";
    eventMeta.set(eid, {
      event: num,
      name: `${genderWord(gender)} ${distance} ${stroke}`.replace(/\s+/g, " ").trim(),
      stroke, distance, sex: sexLetter(gender), agegroup,
    });
    for (const ht of findAll(ev, "HEAT")) {
      const hid = ht.attrs.heatid || ht.attrs.heatID || "";
      if (hid) eventNumByHeatId.set(hid, { event: num, heat: parseInt(ht.attrs.number || "0", 10) });
    }
  }

  const roster: RosterRow[] = [];
  for (const clubNode of findAll(root, "CLUB")) {
    const club = clubNode.attrs.name || clubNode.attrs.shortname || "";
    for (const ath of findAll(clubNode, "ATHLETE")) {
      const first = ath.attrs.firstname || "";
      const last = ath.attrs.lastname || "";
      const name = `${first} ${last}`.trim() || ath.attrs.name || "";
      const sex = sexLetter(ath.attrs.gender || "");
      const age = ageFrom(ath.attrs.birthdate || ath.attrs.birthyear || "", meetDate);
      for (const entry of findAll(ath, "ENTRY")) {
        const lane = parseInt(entry.attrs.lane || "0", 10);
        if (!lane) continue; // no lane assigned yet → skip
        const hid = entry.attrs.heatid || entry.attrs.heatID || "";
        const byHeat = hid ? eventNumByHeatId.get(hid) : undefined;
        const event = byHeat?.event ?? eventNumById.get(entry.attrs.eventid || "") ?? 0;
        const heat = byHeat?.heat ?? parseInt(entry.attrs.heat || "0", 10);
        if (!event || !heat) continue;
        roster.push({ event, heat, lane, name, age, sex, club, seed: normalizeSeed(entry.attrs.entrytime || "") });
      }
    }
  }

  roster.sort((a, b) => a.event - b.event || a.heat - b.heat || a.lane - b.lane);
  const events = [...eventMeta.values()].sort((a, b) => a.event - b.event);
  return { roster, events };
}

// ── CSV writing ──────────────────────────────────────────────────────────────
function csvField(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(header: string[], rows: Record<string, string | number>[]): string {
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map((h) => csvField(r[h] ?? "")).join(","));
  return lines.join("\n") + "\n";
}

// ── Reusable API (used by the CLI below and by the server's admin upload) ─────
export interface ImportResult {
  rosterCsv: string;
  eventsCsv: string;
  summary: { events: number; entries: number; eventCount: number; heatCount: number };
}

/** Parse a Lenex buffer (.lef XML or .lxf zip) into roster + events CSV text. */
export function importLenexBuffer(buf: Buffer): ImportResult {
  const xml = buf[0] === 0x50 /* 'P' → zip */ ? unzipSingle(buf) : buf.toString("utf8");
  const root = parseXml(xml);
  if (findAll(root, "MEET").length === 0) {
    throw new Error("Not a Lenex file (no <MEET> element).");
  }
  const { roster, events } = lenexToRows(root);
  return {
    eventsCsv: toCsv(["event", "name", "stroke", "distance", "sex", "agegroup"], events as unknown as Record<string, string | number>[]),
    rosterCsv: toCsv(["event", "heat", "lane", "name", "age", "sex", "club", "seed"], roster as unknown as Record<string, string | number>[]),
    summary: {
      events: events.length,
      entries: roster.length,
      eventCount: new Set(roster.map((r) => r.event)).size,
      heatCount: new Set(roster.map((r) => `${r.event}-${r.heat}`)).size,
    },
  };
}

// ── Sport Systems heat-sheet (.txt) → CSV rows ───────────────────────────────
// Sport Systems exports a tab-delimited event/heat program, e.g.:
//   Event 415 Mixed 50m Freestyle
//   Heat Number - 1
//   Lane<TAB>Comp.No.<TAB>Name<TAB>AaD<TAB><TAB>Club<TAB> Time
//   2<TAB>(1)<TAB>Caitlin WELLARD<TAB>11<TAB><TAB>Ashford Town<TAB>        <TAB>
// One "Event N …" section per event, "Heat Number - N" per heat, then lane rows.

// Derive stroke/distance/sex from an event name like "Mixed 50m Freestyle".
function parseEventName(name: string): { stroke: string; distance: string; sex: string; agegroup: string } {
  const relay = /(\d+)\s*x\s*(\d+)/i.exec(name);
  const dist = /(\d+)\s*m\b/i.exec(name) || /\b(\d{2,4})\b/.exec(name);
  const distance = relay ? `${relay[1]}x${relay[2]}m` : (dist ? `${dist[1]}m` : "");
  let stroke = "";
  if (/butterfly|\bfly\b/i.test(name)) stroke = "Butterfly";
  else if (/backstroke|\bback\b/i.test(name)) stroke = "Backstroke";
  else if (/breaststroke|\bbreast\b/i.test(name)) stroke = "Breaststroke";
  else if (/medley|\bim\b/i.test(name)) stroke = "Medley";
  else if (/freestyle|\bfree\b/i.test(name)) stroke = "Freestyle";
  let sex = "X";
  if (/\bgirls?\b|\bwomen\b|\bfemale\b|\bladies\b/i.test(name)) sex = "F";
  else if (/\bboys?\b|\bmen\b|\bmale\b/i.test(name)) sex = "M";
  return { stroke, distance, sex, agegroup: "" };
}

function parseSportSystems(text: string): { roster: RosterRow[]; events: EventRow[] } {
  const eventMeta = new Map<number, EventRow>();
  const roster: RosterRow[] = [];
  let curEvent = 0, curHeat = 0;
  for (const raw of text.replace(/﻿/g, "").split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const evM = /^Event\s+(\d+)\s+(.+)$/i.exec(trimmed);
    if (evM) {
      curEvent = parseInt(evM[1]!, 10); curHeat = 0;
      const name = evM[2]!.trim();
      eventMeta.set(curEvent, { event: curEvent, name, ...parseEventName(name) });
      continue;
    }
    const htM = /^Heat\s*Number\s*-?\s*(\d+)/i.exec(trimmed);
    if (htM) { curHeat = parseInt(htM[1]!, 10); continue; }
    if (/^Lane\b/i.test(trimmed)) continue; // column-header row
    if (curEvent && curHeat) {
      const cols = raw.split("\t");
      const lane = parseInt((cols[0] || "").trim(), 10);
      if (!lane) continue;                  // not a swimmer row
      const name = (cols[2] || "").trim();
      if (!name) continue;
      const ageN = parseInt((cols[3] || "").trim(), 10);
      roster.push({ event: curEvent, heat: curHeat, lane, name, age: Number.isFinite(ageN) ? ageN : "", sex: "", club: (cols[5] || "").trim(), seed: normalizeSeed(cols[6] || "") });
    }
  }
  roster.sort((a, b) => a.event - b.event || a.heat - b.heat || a.lane - b.lane);
  return { roster, events: [...eventMeta.values()].sort((a, b) => a.event - b.event) };
}

/** Parse a Sport Systems heat-sheet (.txt) into roster + events CSV text. */
export function importSportSystemsText(text: string): ImportResult {
  const { roster, events } = parseSportSystems(text);
  if (events.length === 0) throw new Error("No 'Event N …' lines found — is this a Sport Systems heat sheet?");
  return {
    eventsCsv: toCsv(["event", "name", "stroke", "distance", "sex", "agegroup"], events as unknown as Record<string, string | number>[]),
    rosterCsv: toCsv(["event", "heat", "lane", "name", "age", "sex", "club", "seed"], roster as unknown as Record<string, string | number>[]),
    summary: {
      events: events.length,
      entries: roster.length,
      eventCount: new Set(roster.map((r) => r.event)).size,
      heatCount: new Set(roster.map((r) => `${r.event}-${r.heat}`)).size,
    },
  };
}

/** Import a start list — auto-detects Lenex (.lef/.lxf) vs Sport Systems text (.txt). */
export function importStartListBuffer(buf: Buffer): ImportResult {
  const head = buf.subarray(0, 64).toString("utf8").trimStart();
  if (buf[0] === 0x50 /* 'PK' zip → .lxf */ || head.startsWith("<")) return importLenexBuffer(buf);
  return importSportSystemsText(buf.toString("utf8"));
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main(): void {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: npm run import -- <meet.lef|meet.lxf|sportsystems.txt>");
    process.exit(1);
  }
  const rosterOut = process.env.ROSTER || "roster.csv";
  const eventsOut = process.env.EVENTS || "events.csv";

  let result: ImportResult;
  try {
    result = importStartListBuffer(readFileSync(input));
  } catch (e) {
    console.error(`✗ ${basename(input)}: ${(e as Error).message}`);
    process.exit(2);
  }
  writeFileSync(eventsOut, result.eventsCsv);
  writeFileSync(rosterOut, result.rosterCsv);

  console.log(`✓ Imported ${basename(input)}`);
  console.log(`  ${result.summary.events} events  → ${eventsOut}`);
  console.log(`  ${result.summary.entries} swimmer-lane entries → ${rosterOut}`);
  if (result.summary.entries === 0) {
    console.warn("  ⚠ No lane entries found. The export may not have lane/heat assignments yet,");
    console.warn("    or it uses different attribute names — check src/import.ts lenexToRows().");
  } else {
    console.log(`  across ${result.summary.eventCount} events / ${result.summary.heatCount} heats`);
  }
}

// Only run the CLI when invoked directly (not when imported by the server).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
