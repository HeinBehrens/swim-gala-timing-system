# Swim Gala Timing System

A low-cost automatic swim-meet timing system: **Shelly BLU Button1 Tough** lane
buttons + an **ESP32-C5 gateway**, a Node server with a live dashboard, results
publishing, and DIY start/finish hardware. Six lane buttons + one start button.

## Timing runs on the ESP32 — not on the host

**All timing is done on-chip on the ESP32**, and this is the core reason the
system is accurate. The host (the Node server on macOS/Linux) never timestamps a
race event — it only does bookkeeping.

- Every button press is stamped with the ESP's **on-chip microsecond clock**
  (`esp_timer_get_time()`) inside the BLE receive callback, *before* any
  processing — see `firmware/esp32_shelly_scanner/esp32_shelly_scanner.ino`,
  `onResult()`.
- The external **START** is captured in a **hardware ISR at the falling edge**
  (`onStartIsr()`), so the start instant is precise to the edge, not to when
  software got around to looking.
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

- **`firmware/esp32_shelly_scanner/`** — ESP32-C5 gateway (v12). Captures BTHome
  button broadcasts, on-chip µs timestamps, dedups the advert burst by
  `packet_id`, fires the start signal (5 V USB light + I2S beep via a MAX98357)
  off a designated Shelly starter button, and streams each line over **both USB
  serial and Wi-Fi TCP (port 3333)**. Wi-Fi provisioned over BLE.
- **`src/server.ts`** — Node server: serial → race state machine → live dashboard
  (`static/`) + `/remote`, with Colorado Dolphin `.do3`/`.do4` and FinishLynx
  `.lif` result export (see below).
- **`src/publish.ts`** — completed heats → SQLite → single-file public results page.
- **`HARDWARE.md`** — start-signal kit (USB light + MAX98357 I2S beep, PCM5102 AUX
  option) and DIY finish touchpads.
- **`BUYING.md`** — where to buy the Shelly BLU buttons and the ESP32-C5 board
  (UK / EU / AliExpress, with prices).

## Results export (AOE → meet software)

The server writes result files into `exports/` that meet-management software
imports as **Automatic Officiating Equipment (AOE)**:

- **Colorado Dolphin `.do3`** (final times) and **`.do4`** (with split columns) —
  imported as "Colorado Time Systems" AOE by **Sport Systems** and Hy-Tek Meet
  Manager. Format verified against real Dolphin sample files: `event;heat;splits;round`
  header, 10 lane lines, 16-hex checksum, CRLF. **For this system, target `.do3`**
  (single finish touch per lane = no splits).
- **FinishLynx `.lif`** — for photo-finish/Lynx workflows.

Filenames follow the Dolphin convention (`AAA-BBB-CCXNNNN.do3` /
`AAA-BBB-CCCX-NNNN.do4`). WebSocket actions: `export_do3`, `export_do4`,
`export_lif`, or `export` (all three). One caveat: the trailing 16-hex checksum
is a deterministic placeholder (the real algorithm is undocumented; importers we
tested skip it) — if an import is rejected, that's the one byte-field to match
against a vendor sample.

## Running

```bash
npm install
npm start          # serial → dashboard + /remote over WebSocket
npm run publish    # build the public results page
```

Provisioning the gateway's Wi-Fi needs Chrome/Edge (Web Bluetooth). Sample data
lives in `roster.sample.csv` / `events.sample.csv`; copy them to
`roster.csv` / `events.csv` (the live files are git-ignored).

## Testing without hardware (no ESP32)

You can exercise the **entire pipeline** — race clock, lane finishes, results,
SQLite, and AOE export — with no buttons and no gateway, using the built-in
simulator:

1. `npm install && npm start`, then open **http://localhost:8000**. (The gateway
   shows disconnected — that's fine; the simulator doesn't use it.)
2. Open **Settings → Simulation Controls** and click **Simulate Start** (or press
   the **`S`** key) to start the clock.
3. **Finish each lane** by pressing number keys **`1`–`6`** (or the lane buttons /
   the phone remote at `/remote`). Each press records that lane's time at the
   moment you press it — so spacing them out gives realistic finishes.
4. When all lanes finish, the heat completes, results save to `results.db`, and
   you can **export** the Colorado `.do3`/`.do4` and FinishLynx `.lif` files.
5. Change event/heat and repeat.

This needs no enrollment (it records by lane number directly) and works on a fresh
checkout — ideal for sharing with testers who don't have the timing hardware.
