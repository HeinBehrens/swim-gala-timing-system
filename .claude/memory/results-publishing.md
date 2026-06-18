---
name: results-publishing
description: "Results DB (SQLite) + single-file public results site generator, fed by CSV imports for event & swimmer details"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4ce72c54-e8ee-48fd-a00c-3169b68c8f5e
---

Built 2026-06-02. Completed heats persist to SQLite and publish to a static public results page.

**Database** ([src/db.ts]): `better-sqlite3`, file `results.db` (WAL). Tables `races` + `lane_results`. `saveRace()` is a transaction; `listResults()`/`getResult()` read. Server persists each completed race exactly once via `persistIfCompleted()` (guarded by `race.savedToDb`, reset on prepare/reset). REST: `GET /api/results`.

**Public site** ([src/site.ts], CLI [src/publish.ts] = `npm run publish`): emits ONE self-contained `public/results.html` (inline CSS/JS, data embedded as JSON, no external assets) — hostable on GitHub Pages/Netlify/S3. The server regenerates it after every completed heat and serves it at `/results` (static dir `/public`). Client is vanilla JS, hash-routed: Home = events grid → Event page (results grouped by sex, ranked by time, age/club shown) → per-swimmer pages → all-swimmers index. User wants it kept simple — NO React/RTK (explicitly rejected).

**Imports (the "event details + swimmer details" the user will supply later):** timing data only has lane numbers, so swimmer/event info is joined from two CSVs at the project root:
- `events.csv`: `event,name,stroke,distance,sex,agegroup` → event titles.
- `roster.csv`: `event,heat,lane,name,age,sex,club` → joins lane→swimmer on (event,heat,lane).
Templates committed as `events.sample.csv` / `roster.sample.csv`. No CSV → page still shows events + lane times with a banner. As of build time, the samples were copied to live `events.csv`/`roster.csv` as a DEMO — replace with real entries or delete for lane-only. If the user later has a Hytek/Team Manager export, match that format instead of the CSVs.

Override paths via env: `RESULTS_DB`, `ROSTER`, `EVENTS`, `SITE_OUT`. See [[server-ts-not-built]].
