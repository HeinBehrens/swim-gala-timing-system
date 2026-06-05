/**
 * Results store (single JSON file)
 * ================================
 * Lightweight, file-based persistence — one local JSON file, no database, no
 * native modules. Each completed heat is appended as a race record (with its
 * per-lane results). The whole store is held in memory and written atomically on
 * every save, so a fresh checkout just works (no schema, no build step).
 *
 * File: results.json at the project root (override with env RESULTS_JSON).
 *
 * Public API (saveRace / listResults / getResult) is intentionally small and
 * stable, so callers (server.ts, site.ts) don't depend on the storage details.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const JSON_PATH = process.env.RESULTS_JSON || join(SRC_DIR, "..", "results.json");

export interface LaneRow {
  lane: number;
  time: number | null;     // seconds, or null = no time (NT)
  place: number | null;    // finishing place among lanes with a time
  finished: boolean;
}

export interface RaceMeta {
  eventNum: number;
  heatNum: number;
  raceId: number;
  datasetNum: number;
  startedAt: string | null; // ISO
  completedAt: string;      // ISO
}

export interface StoredRace extends RaceMeta {
  id: number;
  lanes: LaneRow[];
}

interface Store { nextId: number; races: StoredRace[] }

// Load the store once at startup. Corrupt/unreadable file → start empty (and the
// bad file is left in place for inspection rather than silently overwritten until
// the next save).
function load(): Store {
  if (!existsSync(JSON_PATH)) return { nextId: 1, races: [] };
  try {
    const data = JSON.parse(readFileSync(JSON_PATH, "utf8"));
    if (data && Array.isArray(data.races) && typeof data.nextId === "number") return data as Store;
  } catch { /* fall through to empty */ }
  console.warn(`  ⚠️  ${JSON_PATH} unreadable — starting with an empty results store`);
  return { nextId: 1, races: [] };
}

const store: Store = load();

// Atomic write: serialize to a temp file then rename over the target, so a crash
// mid-write can never corrupt the results.
function persist(): void {
  const tmp = JSON_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, JSON_PATH);
}

/** Persist one completed race + its lane results. Returns the new race id. */
export function saveRace(meta: RaceMeta, lanes: LaneRow[]): number {
  const id = store.nextId++;
  store.races.push({
    id,
    eventNum: meta.eventNum,
    heatNum: meta.heatNum,
    raceId: meta.raceId,
    datasetNum: meta.datasetNum,
    startedAt: meta.startedAt,
    completedAt: meta.completedAt,
    lanes: lanes.map((l) => ({ lane: l.lane, time: l.time, place: l.place, finished: !!l.finished })),
  });
  persist();
  return id;
}

/** Most-recent races first, capped at `limit`. */
export function listResults(limit = 200): StoredRace[] {
  return [...store.races].sort((a, b) => b.id - a.id).slice(0, limit);
}

export function getResult(id: number): StoredRace | null {
  return store.races.find((r) => r.id === id) ?? null;
}

/** Distinct `${event}-${heat}` keys that have at least one saved (completed) race. */
export function completedHeatKeys(): Set<string> {
  return new Set(store.races.map((r) => `${r.eventNum}-${r.heatNum}`));
}
