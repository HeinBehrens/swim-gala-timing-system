# Swim Gala Timing System

A low-cost automatic swim-meet timing system: **Shelly BLU Button1 Tough** lane
buttons + an **ESP32-C5 gateway**, a Node server with a live dashboard, results
publishing, and DIY start/finish hardware. Six lane buttons + one start button
(optionally up to three backup buttons per lane). Feeds **Sport Systems** as a
Colorado `.do4`; Sport Systems handles the Swim England rankings upload.

## Timing runs on the ESP32 — not on the host

**All timing is done on-chip on the ESP32**, and this is the core reason the
system is accurate. The host (the Node server on macOS/Linux) never timestamps a
race event — it only does bookkeeping.

- Every button press is stamped with the ESP's **on-chip microsecond clock**
  (`esp_timer_get_time()`) inside the BLE receive callback, *before* any
  processing — see `firmware/esp32_shelly_scanner/esp32_shelly_scanner.ino`,
  `onResult()`.
- The **start** is a designated **Shelly BLU button** — its press is stamped with
  the same on-chip µs clock in the BLE callback, and the host starts the clock
  from that PRESS line (there is no wired start button as of v12).
- Start and finish are read from the **same monotonic clock**, so a race time is
  simply `finish_µs − start_µs`. The ESP streams these stamps to the host as one
  identical line (`PRESS\t…\tmicrosSinceBoot`) over **both transports** — USB
  serial always, and **Wi-Fi TCP (port 3333, `swim-timer.local`)** when Wi-Fi is
  provisioned. The host just subtracts. Because the stamp is taken on-chip before
  either transport, it doesn't matter whether the line arrives over USB or Wi-Fi
  — neither path can affect the timing.

### Why this beats timing on the host (macOS)

| | ESP32 on-chip | Host (macOS / Node) |
|---|---|---|
| When the stamp is taken | µs after the radio/edge event, in the callback/ISR | whenever the OS schedules Node to run |
| Clock | one bare-metal monotonic µs counter | OS clock, behind CoreBluetooth + event loop + USB serial |
| Jitter source | none meaningful | OS scheduling, callback coalescing, USB latency — **tens of ms, varying per event** |
| Does the jitter cancel? | **Yes** — start & finish share one clock, so downstream USB/host latency cancels exactly | **No** — each event's host-side delay is independent and lands directly in the result |

Concretely: even if the serial line to the host is **200 ms late**, the elapsed
time is still correct, because it's the difference of two stamps taken on the ESP
itself. Host-side timestamping has no such guarantee — its per-event jitter does
not cancel and shows up as timing error.

> Note: `src/latency-test.ts` deliberately timestamps on the *host* to
> characterize BLE radio reliability (drops, burst redundancy). Its jitter
> numbers are a **pessimistic host-side proxy**, not the timing error swimmers
> get — see the header comment in that file.

## Components

- **`firmware/esp32_shelly_scanner/`** — ESP32-C5 gateway (v13). Captures BTHome
  button broadcasts, on-chip µs timestamps, dedups the advert burst by
  `packet_id`, fires the start signal (5 V USB light + I2S beep via a MAX98357)
  off a designated Shelly starter button, and streams each line over **both USB
  serial and Wi-Fi TCP (port 3333)**. Wi-Fi provisioned over BLE.
- **`src/server.ts`** — Node server: serial → race state machine → live dashboard
  (`static/`), phone `/remote`, and a read-only `/view` spectator screen. Includes a
  meet-schedule selector and Colorado Dolphin `.do3`/`.do4` + FinishLynx `.lif`
  export (see below).
- **`src/publish.ts`** — completed heats → `results.json` → single-file public results page.
- **`HARDWARE.md`** — start-signal kit (USB light + MAX98357 I2S beep, PCM5102 AUX
  option) and DIY finish touchpads.
- **`BUYING.md`** — where to buy the Shelly BLU buttons and the ESP32-C5 board
  (UK / EU / AliExpress, with prices).

## Results export (AOE → Sport Systems → Swim England)

Each finished heat produces a **Colorado Dolphin `.do4`** in `exports/` that
**Sport Systems** imports as "Colorado Time Systems" AOE. The full pipeline:

```
ESP32 buttons → this system → .do4 → Sport Systems → Lenex .lef → Swim England rankings
            (Colorado AOE times)   (meet management)   (results)   (resultsuploader.swimming.org)
```

**This project's job ends at the `.do4`.** Sport Systems seeds the meet (the Lenex
start list you import — see below) and produces the Lenex results file uploaded to
Swim England. There is no direct-to-Swim-England export here by design.

The `.do4` layout is verified against real CTS Dolphin sample files and the
open-source Wahoo! Results parser: an `event;heat;num_splits;round` header, then
`num_splits` lines per lane — `Lane<n>;t1;t2;t3`, up to three watch/button times
(blank for an un-pressed watch, `0;0;0` for a no-touch lane) — and a trailing
16-hex checksum line (importers skip it; ours is a deterministic placeholder).
Times are total seconds, 2 dp, CRLF. Filenames follow the Dolphin convention
(`AAA-BBB-CCCX-NNNN.do4`).

`.do3` (finals only) and FinishLynx `.lif` remain available via the WebSocket
actions `export_do3` / `export_lif`, but are not part of the Sport Systems workflow.

### Review before export

By default a finished heat is **held for review**: the dashboard shows an editable
table — fix any time, or mark a lane **NT** — and the `.do4` is written only when
you click **Confirm & Export** (edits after export overwrite the file). Turn this
off in Settings → *Review & edit results before exporting* for hands-free
auto-export the instant a heat finalises.

### Splits & up to 3 buttons per lane (optional)

- **Splits** — enable Settings → *Collect per-length splits* and set the pool
  length. With one finish-end button the swimmer touches the timed wall every
  **second** length, so touches = distance ÷ (2 × pool length): a 100m in a 25m
  pool records a 50m split + the finish; a 50m records the finish only. Splits ride
  in the `.do4` automatically (one line per timed touch).
- **Up to 3 buttons per lane** — optional backup timers. Re-enroll with *Buttons
  per lane* = 2 or 3; presses within ~1.5s of each other are consolidated per
  USA-Swimming rules (median of 3, average of 2). Default stays **1 button/lane**.

## Running

```bash
npm install
npm start          # serial → dashboard + /remote over WebSocket
npm run publish    # build the public results page
```

Provisioning the gateway's Wi-Fi needs Chrome/Edge (Web Bluetooth): Settings →
**Wi-Fi (Bluetooth setup)** → **Scan networks** lists nearby 2.4 GHz SSIDs (the
gateway scans on request), then enter the password and **Configure**. Sample data
lives in `roster.sample.csv` / `events.sample.csv`; copy them to
`roster.csv` / `events.csv` (the live files are git-ignored).

### Running a heat (control panel)

Pick the event/heat from the **Schedule** dropdown (built from the imported roster;
`✓` marks heats already run). Then **Prepare** → press the **starter button** (or
**Start**) → lane buttons record finishes → **Stop** to finalise. Any lane without
a recorded time is scored **NT**, so empty lanes need no special handling. When the
heat finishes it's held for an **editable review** — adjust a time or mark a lane
NT, then **Confirm & Export** writes the `.do4` (see *Review before export* above).
Once a heat is done, clicking **Prepare** again (or **Reset**) auto-advances to the
next not-yet-completed heat — so you step through the schedule hands-free. The whole background goes
black → **green** (ready) → **yellow** (running) as a deck-visible cue, mirrored on
`/remote` and `/view`. Settings → **Gateway** has a **Restart ESP32** button (over
USB serial) for when the board needs a reboot.

## Importing heats / start lists (Lenex)

Instead of hand-editing `roster.csv`/`events.csv`, import them straight from your
meet software's **Lenex** export (the standard Sport Systems and most meet
programs produce):

```bash
npm run import -- path/to/meet.lef     # plain-XML Lenex
npm run import -- path/to/meet.lxf     # zipped Lenex (handled automatically)
```

It writes `events.csv` (event, name, stroke, distance, sex, agegroup) and
`roster.csv` (event, heat, lane, name, age, sex, club) — exactly what the results
page consumes — and prints a summary of events/heats/entries found. Lane
assignments are required in the export (entries without a lane are skipped).

> Lenex is a published standard and Sport Systems is compliant, but programs vary
> slightly in attribute usage. If a field maps oddly, the whole mapping lives in
> `lenexToRows()` in `src/import.ts` and is easy to adjust — send a real export
> and I'll tune it. Hy-Tek (`.hy3`) or a plain CSV start list can be added the
> same way.

## Testing without hardware (no ESP32)

You can exercise the **entire pipeline** — race clock, lane finishes, results,
and AOE export — with no buttons and no gateway, using the built-in simulator:

1. `npm install && npm start`, then open **http://localhost:8000**. (The gateway
   shows disconnected — that's fine; the simulator doesn't use it.)
2. Open **Settings → Simulation Controls** and click **Simulate Start** (or press
   the **`S`** key) to start the clock.
3. **Finish each lane** by pressing number keys **`1`–`6`** (or the lane buttons /
   the phone remote at `/remote`). Each press records that lane's time at the
   moment you press it — so spacing them out gives realistic finishes.
4. When all lanes finish the heat completes — or click **Stop** to finalise early,
   and any lane without a time is scored **NT**. Results save to `results.json`,
   and you can **export** the Colorado `.do3`/`.do4` and FinishLynx `.lif` files.
5. **Reset** advances to the next heat (or pick one from the Schedule dropdown) and repeat.

This needs no enrollment (it records by lane number directly) and works on a fresh
checkout — ideal for sharing with testers who don't have the timing hardware.
