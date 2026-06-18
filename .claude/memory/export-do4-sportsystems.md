---
name: export-do4-sportsystems
description: Export pipeline — this system writes one Colorado Dolphin .do3 per heat into the folder Sport Systems' CTS Dolphin capture watches; Sport Systems handles the Swim England Lenex upload. Keep Sport Systems. (NB .do3 not .do4.)
metadata: 
  node_type: memory
  type: project
  originSessionId: 5e18f228-cea2-432d-80a2-ce5a847bdb76
---

The result pipeline is: **ESP32 buttons → this system → Colorado Dolphin file → Sport Systems → Lenex `.lef` → resultsuploader.swimming.org → Swim England rankings.**

- **⚠️ CORRECTION (2026-06-10, from reverse-engineering the SPORTSYSTEMS installer):** SPORTSYSTEMS Meet Organisation 5.3 reads **`.do3`**, NOT `.do4`. Its "CTS Dolphin" capture reads `.do3` race files from a folder (`CTSDolphinPath`, default `C:\CTSDolphin`) matched by race number, and supports 1/2/3 timers. So the right output is **`.do3` written one-per-heat into that folder** — the chosen, easiest, most foolproof route (no serial, no com0com). Commit #9 already added `.do3` auto-export. (Earlier this memory said `.do4`-only — that was wrong.)
- **Full integration map + the "easiest AOE to interface" analysis** live in the repo: `SPORTSYSTEMS.md` (operator how-to) and `SPORTSYSTEMS-AOE-NOTES.md` (binary-analysis reference). SPORTSYSTEMS also supports live **serial** AOE timers (Colorado, ARES/OSM6, Omega, Quantum, Daktronics, ALGE at `9600,n,8,1`, via `AOEComm.exe`/MSCOMM32.ocx) but those are binary/complex — the file route is preferred. Reverse-engineering done via `innoextract` on `SS53MeetInstall.exe` (Inno Setup; VB6 app). See PR #10.
- **Sport Systems owns both ends**: seeding (the Lenex start list we *import*) and producing the compliant **Lenex results file** uploaded to Swim England ([resultsuploader.swimming.org](https://resultsuploader.swimming.org/), auto-loads to rankings in 1–2h; Swim England accepts Lenex from Sport Systems or HDR+MDF/NDF from Hy-Tek).

**Decision (2026-06-09): KEEP Sport Systems in the process. Do NOT build a direct Lenex-to-Swim-England exporter.** It was considered and declined. (Doing so would also require carrying the Swim England membership number through import — the current importer drops it; `roster.csv` is only event,heat,lane,name,age,sex,club — and a seeding source would still be needed.) Related: [[results-publishing]], [[empty-lane-nt-workflow]].
