---
name: server-ts-not-built
description: "src/server.ts is now BUILT — TypeScript timing server fed by the ESP32-C5 over USB serial, serving the existing static/ dashboard"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4ce72c54-e8ee-48fd-a00c-3169b68c8f5e
---

The TypeScript timing server is **built and working** (2026-06-02): [src/server.ts]. Run with `npm start`. Verified end-to-end: armed → physical starter press → 6 lane finishes timed off ESP µs → auto-complete → `.do3`/`.lif` export downloadable.

Architecture: presses arrive from the ESP32-C5 over USB serial via [src/esp32.ts] (NOT noble/bleak), using the [src/lanes.json] MAC→lane map from `npm run enroll` ([src/enroll.ts]). `src/server.ts` runs the race state machine (idle→ready→running→completed), serves `static/` (dashboard at `/`, phone remote at `/remote`), and broadcasts over WebSocket `/ws`. Express v5 + ws.

**Critical contract finding:** `server.py`, `static/app.js`, and `static/remote.html` had DRIFTED — they did not speak the same protocol. `server.ts` matches what **app.js actually parses**, not the stale Python:
- Server→client: `full_state{event,heat,state,start_time,elapsed,lanes:{n:{time,finished,battery}},ble,ha,config}`, `race_state{state,start_time,elapsed}`, `lane_time{lane,time,is_finish}`, `connection_status{ble,ha}`, `battery_status{lane,level}`, `config`, `toast{message,level}`, `export_ready{filename,url}`.
- Client→server actions are a SUPERSET of dashboard + phone-remote vocab: `prepare`/`prepare_race`, `start`/`start_race`, `stop`/`stop_race`, `reset`/`reset_race`, `export`/`export_results`/`export_do3`/`export_lif`, `simulate_start`, `simulate_lane`/`simulate_press`, `set_event_heat`, `set_config`, `get_state`. Handlers read both `event`/`event_num` key spellings.

**Timing model (user-specified):** the authoritative t=0 is the ESP32 µs timestamp of the physical STARTER button press; each lane split = `(lane_µs − start_µs)/1e6`. `start_time` sent to the client is host wall-clock seconds ONLY to drive app.js's cosmetic live counter (`Date.now()/1000 - start_time`) — never used for recorded splits.

Not yet wired: battery (firmware only emits PRESS lines, not BTHome battery obj 0x01 yet → `battery` stays null); Home Assistant path dropped (`ha` always false). Override serial port with env `ESP32_PORT`. See [[ble-capture-bottleneck]].

**Running / viewing (confirmed 2026-06-05):** server listens on **port 8000**, host `0.0.0.0` ([src/server.ts] `PORT = 8000`). Dashboard → http://localhost:8000, phone remote → http://localhost:8000/remote. To view inside VS Code, open the **Simple Browser** (Cmd+Shift+P → "Simple Browser: Show" → `http://localhost:8000`); there's no terminal command to launch it. Gotcha: `npm start` throws `EADDRINUSE 0.0.0.0:8000` when an instance is already up — check first with `lsof -nP -iTCP:8000 -sTCP:LISTEN` instead of launching a second. `npm run dev` = same server under `tsx watch` (auto-reload).
