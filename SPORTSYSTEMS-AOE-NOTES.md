# SPORTSYSTEMS AOE — reverse-engineering notes

Technical reference on how **SPORTSYSTEMS Meet Organisation 5.3** ingests timing
results, and which interface is easiest for this project to feed. Companion to
[`SPORTSYSTEMS.md`](SPORTSYSTEMS.md) (the operator-facing how-to).

> **Provenance:** derived from *static analysis* of our own licensed installer
> `SS53MeetInstall.exe` (downloaded from sportsys.co.uk) for **interoperability**
> — extracting the result format so a compatible timing feed can be built. No
> binary was executed; nothing was patched or circumvented.

---

## How the install was inspected

- `SS53MeetInstall.exe` = **Inno Setup 6.1.0** installer → unpacked with
  `innoextract` (no execution).
- Payload binaries (all **VB6** — `msvbvm60.dll`, `MSCOMCTL.OCX`, `MSHFLXGD.OCX`):
  - **`app/SSMeet53.exe`** (5.5 MB) — the main Meet Organisation app.
  - **`app/AOEComm.exe`** (120 KB) — the **serial timing comms** module ("SPORTSYSTEMS AOE Communications"); uses **`MSCOMM32.OCX`** (VB6 serial control).
  - `app/MeetSpec.exe` — meet specification tool.
- Strings extracted as ASCII **and UTF‑16LE** (VB6 stores BSTRs as UTF‑16).
- Other notables: bundled **SQLite via ODBC** (`sqliteodbc.exe`) = data store;
  **Chilkat** (`ChilkatAx-9.5.0`) for HTTP/SOAP (online entries upload); a
  `MeetSupport/` web pack (`liveboard.htm`, `liveres.js`, `livescb.js`) for live
  web results/scoreboard.

---

## Two families of timing integration

### A. AOE **serial** (live, over a COM port — `AOEComm.exe`)

The "listen on a COM port" path. Supported timer systems found in the binaries:

| System | String evidence | Framing |
|---|---|---|
| **Colorado Time Systems** | "Colorado Time Systems Timer Comms" | ASCII, simplest of the serial set |
| **ARES / OSM6** (Omega Swiss Timing) | "SPORTSYSTEMS ARES/OSM6 Timer Comms", "Invalid \<Type of Message\> from OSM6 - Binary" | **binary** |
| **Omega** | "Omega Rcvd:", "Invalid Omega record - Initial block is missing" | **block-framed binary** |
| **Quantum** | "SPORTSYSTEMS Quantum Timer Comms" | serial |
| **Daktronics Omnisport** | "Daktronics Omnisport Timer Comms" | serial |
| **ALGE** | "Alge Bi-Directional Timer Comms" | serial, bi-directional |

- **Serial defaults:** `9600,n,8,1` (alt `9600,e,7,1`). Baud choices exposed:
  2400/4800/9600/19200/38400/57600/115200.
- **Handshake aware:** menus for CTS/DSR/CD/DTR ("CTS Timeout", "DSR Timeout",
  "Carrier Detect Timeout", "mnuDTREnable") — it's a full RS‑232 terminal.
- **Internal record model** (the AOE log columns):
  `Type · Event · Heat · Lap · Lane · Place · Time · Mode`.
- **Why it's hard to emulate:** OSM6 is binary; Omega is block/binary with
  validity checks; each system has its own frame + (likely) checksums. Plus it
  needs a **virtual COM pair** (com0com) because SPORTSYSTEMS *reads* the port.

### B. **CTS Dolphin** (file-based — the easy one) ⭐

SPORTSYSTEMS reads **Colorado Dolphin race files** straight off disk — no serial
port at all:

- Reads **`.do3`** files (only `*.do3` appears — **not** `.do4`; see correction
  below) from a configured directory.
- Config keys: **`CTSDolphinPath`** (default **`C:\CTSDolphin`**),
  `CTSDolphinMeetNumb`, **`CTSDolphinRaceNumb`** — files are matched by
  **Dolphin race number** (+ meet number).
- Multi-timer: "Colorado Time System Dolphin - **2 Timers** / **3 Timers**",
  computes "Dolphin Time Difference:" between them → matches our 1/2/3
  buttons-per-lane.
- Errors to test against: "Can't Locate Dolphin Race File.",
  `ERROR_DO_NOT_HAVE_RACE`, `ERROR_INVALID_RACE_LENGTH`.
- UI: "Colorado Dolphin Capture", "Colorado Dolphin Database Directory".
- **No splits.** `.do3` carries final times only. Split times do not cross into
  SPORTSYSTEMS via this route — that would need `.do4` (and it's unconfirmed
  whether 5.3 reads `.do4`).

### Onward → Swim England

`&Lenex` → "Lenex 3.0 Export" / "British Rankings - Lenex 3.0 Export"
(`*.LEF`, `GBRankLenex`, `LENEXGB`). SPORTSYSTEMS owns the Lenex/Swim England
step — we deliberately do not build a Lenex exporter.

---

## ⚠️ Correction: it reads `.do3`, not `.do4`

Earlier we assumed `.do4`. The SPORTSYSTEMS 5.3 binary references **only `.do3`**
for Dolphin capture. **Our exporter should output `.do3`** (commit #9 already
added `.do3` auto-export) and write it into the `CTSDolphinPath` directory with
the Dolphin **race-number** filename SPORTSYSTEMS expects. (Whether 5.3 also
accepts `.do4` is unconfirmed — assume `.do3`.)

---

## Which AOE system is easiest to interface? (the answer)

**Ranked easiest → hardest for *us* to feed:**

1. **CTS Dolphin file (`.do3`) ⭐ — by far the easiest.** No serial, no com0com,
   no framing, no checksums, no handshaking. We **already generate Dolphin
   files**; we just write `.do3` into `C:\CTSDolphin` (or wherever `CTSDolphinPath`
   points) with the right race-number name, and SPORTSYSTEMS captures it. Works
   for 1/2/3 timers. This is the recommended target.
2. **Colorado Time Systems (serial)** — if a *live* serial feed is ever required,
   this is the simplest of the serial protocols (plain ASCII console format), but
   still needs com0com + exact-frame emulation. More work than files.
3. **Quantum / Daktronics / ALGE (serial)** — vendor-specific serial formats.
4. **Omega (serial)** — block-framed binary with validity checks.
5. **ARES / OSM6 (serial)** — binary protocol. Hardest.

**Recommendation:** target **CTS Dolphin `.do3` files** dropped into
`CTSDolphinPath`. It needs zero new protocol work and reuses our existing Dolphin
exporter. The live serial path (Colorado) is a later "nice to have," not worth
the com0com + binary-frame effort given the file path exists.

---

## Open items to confirm

- **`.do3` filename convention — CONFIRMED.** SPORTSYSTEMS matches
  `<meet>-000-00F<race>.do3`, e.g. `008-000-00F0004.do3`. The middle segment
  `-000-00F` is a **fixed literal** (byte-confirmed in the binary; the `F` is
  ASCII 0x46) — event (`000`), heat (`00`) and round (`F`) are constants and are
  **not** used for matching. SPORTSYSTEMS keys the file purely on the **3-digit
  meet number** (`<meet>`) and **4-digit race number** (`<race>`). ⚠️ Our exporter
  must NOT encode real event/heat/round into the name, or the file won't be found.
- **`.do3` body layout — STRUCTURE CONFIRMED, semantics pending a sample.**
  Plain text, read line-by-line (`Line Input #`), **semicolon-delimited**, each
  data line splits into **exactly 4 fields**, **one row per lane**, **final times
  only**. (The "Lap"/splits column belongs to the *serial* AOE log model, not the
  `.do3` file — see family A.) Still to confirm against a real capture: the exact
  meaning/order of the 4 fields, the time string format, and how a no-swim lane
  is represented.
- Whether 5.3 also reads `.do4`.
- The Colorado **serial** frame (only if we later want the live feed).
