# Getting results into Sport Systems — without retyping

This document explains how race results from this DIY timing system reach
**SPORTSYSTEMS Meet Organisation** ([sportsys.co.uk](https://www.sportsys.co.uk/)),
the UK gala/meet-management package used with Swim England, the available levels
of automation, and the trade-offs between them. The goal is simple: **the
operator never re-types a time.**

The relevant feature in SPORTSYSTEMS is its **AOE (electronic timing) interface**
— *AOE = Automatic Officiating Equipment*, the swimming term for electronic
timing. (SPORTSYSTEMS also sells a basic Meet Organisation edition *without* the
AOE interface, so confirm your licence includes it.) Everything below is about
feeding that AOE interface — by file or live over a serial port — with no
manual entry. SPORTSYSTEMS' other products are **Entry Manager** and
**Club Ranking**.

> **Decision (chosen route): write one Colorado Dolphin `.do3` file per heat into
> the folder SPORTSYSTEMS watches.** It's the easiest *and* most foolproof — no
> serial port, no `com0com`, no protocol emulation, and we already generate
> Dolphin files. Reverse-engineering the SPORTSYSTEMS binary confirmed it reads
> **`.do3`** files from a configured directory by race number (the **CTS Dolphin**
> capture). See [`SPORTSYSTEMS-AOE-NOTES.md`](SPORTSYSTEMS-AOE-NOTES.md) for the
> evidence and the full list of timing systems considered.
>
> The live serial paths (Colorado/ARES/Omega/Quantum over a COM port) remain
> documented below as a *future* option, but they're more setup and more to break,
> so we are **not** building them now.

---

## The pipeline

```
Shelly BLU buttons ──BLE──▶ ESP32-C5 gateway ──USB/Wi-Fi──▶ timing server (Node)
                                                                   │
                                                                   ▼
                                                       results for the heat
                                                                   │
        ┌──────────────────────────────┬───────────────────────────┘
        ▼                              ▼                            ▼
  .do4 file import            folder-watch import           live serial feed
   (manual, today)            (auto, file-based)         (auto, console-style)
        └──────────────────────────────┴───────────────────────────┘
                                   │
                                   ▼
                            Sport Systems
                                   │ exports Lenex (.lef/.lxf)
                                   ▼
                    Swim England rankings (resultsuploader)
```

The timing server already produces **Colorado Dolphin `.do4`** files (one per
heat), which Sport Systems imports. Everything below is about *how* those
results cross into Sport Systems with the least manual effort.

---

## Option 1 — File import per heat (works today)

After a heat is finalised, the server writes a `.do4` into the exports folder.
In Sport Systems you import that file and it matches on event/heat/lane.

- **Setup:** none — this already works.
- **Per heat:** one "import" action.
- **Good when:** you want zero new moving parts and don't mind a click per heat.

---

## Option 2 — CTS Dolphin file capture ⭐ (the chosen route)

SPORTSYSTEMS has a built-in **CTS Dolphin** capture: it reads Colorado Dolphin
**`.do3`** race files from a configured directory and matches them by **race
number** — exactly the kind of file we already produce. We write one `.do3` per
heat into that directory and SPORTSYSTEMS picks it up. **No serial, no com0com,
no per-heat click, no new protocol.**

- **In SPORTSYSTEMS:** point its Dolphin data directory (`CTSDolphinPath`,
  default `C:\CTSDolphin`) at the folder our server writes to. It supports
  **1 / 2 / 3 timers** ("Colorado Time System Dolphin - 2/3 Timers"), matching
  our 1–3 buttons per lane.
- **In our server:** write the heat's result as `.do3` into that folder using the
  Dolphin **race-number filename** SPORTSYSTEMS expects.
- **Per heat:** nothing — fully automatic.
- **Caveat:** the folder must be reachable by the Windows machine running
  SPORTSYSTEMS (a local path if the server runs on Windows, or a network share /
  synced folder otherwise).

> Confirmed by reverse-engineering the SPORTSYSTEMS binary — see
> [`SPORTSYSTEMS-AOE-NOTES.md`](SPORTSYSTEMS-AOE-NOTES.md). Note it reads **`.do3`**
> (not `.do4`); commit #9 already added `.do3` auto-export. Remaining to confirm:
> the exact Dolphin race-number **filename convention** and `.do3` column layout
> so our files are found and parsed cleanly.

---

## Option 3 — Live serial feed (Colorado / Dolphin console emulation)

The SPORTSYSTEMS **AOE interface** can **listen on a serial COM port** for a
**Colorado/Dolphin** timing feed. Instead of files, our software pretends to be
the timing console and streams each result to that port — times appear in
SPORTSYSTEMS *live, as the heat finishes*. This is the most seamless,
"broadcast-style" path.

### Why a virtual COM pair is required

A serial COM port can only be opened by one program at a time. Sport Systems is
**reading** one port; whatever feeds it must **write** to a *different, linked*
port. You bridge the two with a **null-modem** link:

- **Virtual (recommended):** [com0com](https://com0com.sourceforge.net/) — free,
  open-source. Creates a linked pair, e.g. `COM5 ↔ COM6`, with no hardware.
  Sport Systems listens on `COM6`; we write `COM5`.
- **Physical:** two USB-serial adapters joined by a null-modem cable. Works, but
  it's hardware to carry and fail.

```
   our software ──writes──▶ COM5 ╎ com0com ╎ COM6 ──read──▶ Sport Systems
                                  (virtual null-modem)
```

This requirement is independent of *who* does the writing (browser or Node) — it
is just how serial "listening" works.

### The protocol

Sport Systems' serial interface expects the **Colorado / Dolphin** result
format. We already generate the Colorado Dolphin **file** format (`.do4`); the
**serial** form is the same data streamed as a live console would send it. The
exact byte framing + baud rate (so our emitter matches what Sport Systems parses)
are being captured from the Colorado/Dolphin timing-console spec and will be
documented here before the emitter is built — see *Current status* below.

---

## Who writes the COM port? Browser vs. Node

Two ways to actually push the serial stream, with different setup costs.

### A. Browser only — Web Serial API

Modern **Chrome / Edge** can open and write a COM port directly from the web page
(`navigator.serial`). The dashboard you already use to run the race can be the
bridge — **no Node install on the Windows machine.** We add a *"Connect to Sport
Systems"* button that opens the port and emits each result as a heat finalises.

Two constraints:

1. **Secure context.** `navigator.serial` only works over **https** or
   **localhost**. Opening the dashboard from another machine over plain
   `http://<server-ip>:8000` is blocked. Fixes:
   - open the dashboard on the **same machine** that serves it (`localhost`), or
   - flip one Chrome flag: `chrome://flags` → *"Insecure origins treated as
     secure"* → add the server's address, or
   - serve the dashboard over https.
2. **com0com** still required (see above).

### B. Node server on the Windows laptop

Run the small Node timing server on the **same Windows machine** as Sport
Systems. The server writes the COM port **directly** using the serial library it
already uses for the ESP — no browser permissions, no secure-context flags. The
ESP connects to this laptop over Wi-Fi (or USB into its UART port with the CH340
driver).

| | **A. Browser + Web Serial** | **B. Node on Windows** |
|---|---|---|
| Install on Windows | com0com + Chrome flag | Node + com0com |
| Writes the port via | the dashboard tab | the server (existing serial code) |
| Robustness | good — relies on the tab staying open/granted | most bulletproof |
| Server can stay on the Mac? | yes | no (moves to Windows) |
| Machines at the gala | 2 (Mac + Windows) or 1 | **1** |

### Recommendation

- **Fewest surprises on race day → Option 3B:** one Windows laptop runs the
  timing server *and* Sport Systems; the server writes the COM port directly; the
  ESP joins over Wi-Fi. One machine, no browser quirks, no extra cables.
- **Least to install / keep the Mac as the brain → Option 3A:** browser +
  Web Serial + com0com, with the Chrome flag for the Mac's address.
- **Don't want to set up serial at all → Option 2** (folder-watch) **or Option 1**
  (file import) — both already avoid retyping.

---

## Pitfalls that cause manual re-entry (and how to avoid them)

Whichever path you choose, results only flow cleanly if the meet structure lines
up. Watch for:

- **Event / heat numbering mismatch.** The numbers in the timing system must
  match the Sport Systems programme exactly. We import the Sport Systems start
  list (`.txt`) so event/heat/lane numbering is shared from the start.
- **Empty lanes / No-Time (NT).** A lane with no swimmer or an unfinished swim is
  sent as NT (manual Stop → NT). Make sure these are explicit, not blank, so the
  import doesn't stall waiting for a time.
- **Disqualifications (DQ).** DQs are entered in Sport Systems against the
  swimmer; the timing feed supplies the *time*, not the DQ decision.
- **Relays & splits.** Splits are collected every second length (touch at the
  finish end). Relay take-over and per-leg handling are managed in Sport Systems.
- **Lane → swimmer mapping.** The timing feed carries event/heat/lane + time;
  Sport Systems maps lane → seeded swimmer. Keep the start-list import current so
  that mapping is correct.

---

## Onward to Swim England

Once results are in Sport Systems, it exports **Lenex** (`.lef`/`.lxf`), which is
uploaded to Swim England's results system (`resultsuploader.swimming.org`). This
system deliberately stops at Sport Systems and lets it own the Lenex/Swim England
step — we do **not** build a direct Lenex exporter.

---

## Current status & next steps

**Chosen route: Option 2 — one `.do3` per heat into the CTS Dolphin folder.**

- ✅ Per-heat Dolphin file export exists (`.do4` and, since commit #9, `.do3`).
- ✅ Confirmed (via binary analysis) SPORTSYSTEMS reads `.do3` from
  `CTSDolphinPath` by race number — Option 2 is viable with no serial work.
- ⬜ Match the exact Dolphin **race-number filename** SPORTSYSTEMS looks for, and
  write into `CTSDolphinPath`.
- ⬜ Verify the `.do3` **column layout** (lane/time/Lap/2–3 timers) parses cleanly.
- ⬜ *(Deferred, not building now)* the live serial console feed (Option 3).
