/**
 * Results database (SQLite via better-sqlite3)
 * ============================================
 * Lightweight, file-based persistence — one local file, no server. Each completed
 * heat is written as a race row plus per-lane result rows. Queryable later for an
 * event history / results export.
 *
 * File: results.db at the project root (override with env RESULTS_DB).
 */

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.RESULTS_DB || join(SRC_DIR, "..", "results.db");

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

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS races (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_num    INTEGER NOT NULL,
    heat_num     INTEGER NOT NULL,
    race_id      INTEGER,
    dataset_num  INTEGER,
    started_at   TEXT,
    completed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lane_results (
    race_db_id   INTEGER NOT NULL,
    lane         INTEGER NOT NULL,
    time_seconds REAL,
    place        INTEGER,
    finished     INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (race_db_id) REFERENCES races(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_lane_results_race ON lane_results(race_db_id);
`);

const insertRace = db.prepare(`
  INSERT INTO races (event_num, heat_num, race_id, dataset_num, started_at, completed_at)
  VALUES (@eventNum, @heatNum, @raceId, @datasetNum, @startedAt, @completedAt)
`);
const insertLane = db.prepare(`
  INSERT INTO lane_results (race_db_id, lane, time_seconds, place, finished)
  VALUES (?, ?, ?, ?, ?)
`);
const selectRaces = db.prepare(`SELECT * FROM races ORDER BY id DESC LIMIT ?`);
const selectLanes = db.prepare(
  `SELECT lane, time_seconds AS time, place, finished FROM lane_results WHERE race_db_id = ? ORDER BY lane`
);
const selectRace = db.prepare(`SELECT * FROM races WHERE id = ?`);

/** Persist one completed race + its lane results in a single transaction. Returns the row id. */
export const saveRace = db.transaction((meta: RaceMeta, lanes: LaneRow[]): number => {
  const info = insertRace.run(meta as unknown as Record<string, unknown>);
  const raceDbId = Number(info.lastInsertRowid);
  for (const l of lanes) insertLane.run(raceDbId, l.lane, l.time, l.place, l.finished ? 1 : 0);
  return raceDbId;
});

function hydrate(r: any): StoredRace {
  return {
    id: r.id,
    eventNum: r.event_num,
    heatNum: r.heat_num,
    raceId: r.race_id,
    datasetNum: r.dataset_num,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    lanes: (selectLanes.all(r.id) as any[]).map((l) => ({
      lane: l.lane,
      time: l.time,
      place: l.place,
      finished: !!l.finished,
    })),
  };
}

export function listResults(limit = 200): StoredRace[] {
  return (selectRaces.all(limit) as any[]).map(hydrate);
}

export function getResult(id: number): StoredRace | null {
  const r = selectRace.get(id) as any;
  return r ? hydrate(r) : null;
}
