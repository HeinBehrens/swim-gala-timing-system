---
name: sportsystems-do3-format
description: "The Colorado Dolphin .do3 file format SPORTSYSTEMS reads, how it locates files, and how the SPORTSYSTEMS app was reverse-engineered (so don't re-derive it)."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5e18f228-cea2-432d-80a2-ce5a847bdb76
---

How SPORTSYSTEMS Meet Organisation 5.3 ingests our **.do3** results (reverse-engineered 2026-06-10/11 — don't re-derive). See also [[export-do4-sportsystems]], repo docs `SPORTSYSTEMS.md` + `SPORTSYSTEMS-AOE-NOTES.md`.

**The app is VB6, NOT Delphi.** `SSMeet53.exe` = native-compiled **Visual Basic 6** (`VB5!` header, `msvbvm60.dll`, `MSCOMM32.OCX`, ~190 `__vba*` runtime calls, parses files via `__vbaInputFile` = VB `Input #`). The **installer** `SS53MeetInstall.exe` is **Inno Setup** (Delphi/Pascal) — that's the only Delphi thing; don't confuse them.

**.do3 file format** (standard Colorado Dolphin; our `buildDolphin()` writes it, CRLF line endings):
- Line 1 (header): `event;heat;num_splits;round`  e.g. `3;2;1;Final` (semicolon-delimited). `num_splits`=1 for .do3 (finish only); it tells the reader how many lane lines per lane.
- Lane lines: `.do3` → bare `<n>;t1;t2;t3` (e.g. `1;6.74;6.74;6.74`); `.do4` → `Lane<n>;t1;t2;t3`. Up to 3 watch times (blank for an un-pressed timer: `1;0.20;;`). Times = total seconds, 2 dp.
- Trailer: a 16-hex checksum line (ours is a deterministic placeholder).

**BODY BYTE-CONFIRMED CORRECT (2026-06-18, RE of `SSMeet53.exe` parse routine `0x47a000–0x47c800`):** lines read via `__vbaLineInputStr`, split on literal `;`. Times parsed via **`__vbaCyStr` as TOTAL SECONDS** (`83.45`) — there is NO `:`-handling and NO `*60` in the parser, so `M:SS.hh` would BREAK it (do NOT switch). Lane line `<n>;t;t;t` (lane via `__vbaI4Str`, up to 3 times via `__vbaCyStr`); empty/no-swim `<n>;;;` (length-guarded, treated as no time). Checksum trailer is **NOT validated** (no CRC/hash in the read routine; `CheckSumClrdo` belongs to the *serial* Colorado path) — any/absent value works. Decimal separator MUST be `.` (locale-sensitive `__vbaCyStr`). **No generator changes needed.** Parser proc names: `DecodeColorado`, `GetDolphinTime`, `OpenDolphinLog`, `LoadDolphinMeets`.

**How SPORTSYSTEMS locates the file:** reads from the **Colorado Dolphin Database Directory**, default **`C:\CTSDolphin`** (flat folder; configurable via Tools → Support File Locations). It **keys a file to a heat by MEET NUMBER + RACE NUMBER only** — operator enters the race number at Results Capture (Get On-Line Times). Genuine name uses **REAL event/heat/round** — `AAA-BBB-CCXNNNN.do3` (AAA=dataset, BBB=event, CCC=heat, X=round T/P/S/F, NNNN=race), confirmed by official CTS docs + SwimRankings wiki. ⚠️ **RESOLVED 2026-06-18:** the SPORTSYSTEMS-AOE-NOTES "`-000-00F` is a byte-confirmed fixed literal" claim was almost certainly a capture taken while event/heat/round sat at DEFAULTS (0/0/F), NOT a literal. A `000-00F` filename was briefly shipped then **REVERTED** to real values (the genuine format). Match key is meet + race number; whether SS matches positionally (meet@chars1-3, race@chars12-15) or rebuilds the name from real values is still unconfirmed — **settle with ONE live capture**. For Dolphin SS sends NOTHING to the timer — one-way read-back only.

**Filename scheme** (`exportBaseName()`, current/reverted): `{meet:3}-{event:3}-{heat:2}{round}{race:4}.do3` with REAL values, e.g. `001-415-13F0005.do3` — matches the genuine CTS Dolphin format. Meet number + round configurable (Settings → "Sport Systems export"); event/heat from the start-list import. **Still needs ONE live capture** to confirm SS finds it AND that our 4-digit race number equals the race number the operator enters at Results Capture (the other half of the meet+race match key). See [[sportsystems-crossover-setup]] — SS isn't currently configured for Dolphin capture, which is likely the real blocker.

**Round letter X (RESOLVED via CTS spec, 2026-06-11):** `T`=Timed final, `P`=Prelim, `S`=Semi-final, `F`=Final. Swim England club galas are technically TIMED FINALS = `T`, but **round is irrelevant to SS matching (keyed by meet+race) so the user chose `F` for now** (matches the `-000-00F` template). Configurable in Settings → "Sport Systems export"; current default `F`. Filename: first 3 chars = Data Set number (001–999), last 4 = Race Number (0001–9999, unique per data set; Dolphin resets to 0001 on launch and scans C:\CTSDolphin for the highest data set). Newer Dolphins also use a companion `DolphinEventList.csv` defining events. Still confirm the live file loads with ONE test capture; the .do3 BODY column layout (delimiter/order) is from the wahoo-results parser, not an official CTS spec, so verify against a real sample if one ever appears.

**RE tooling:** `brew install innoextract chmlib`; `innoextract SS53MeetInstall.exe` → `app/SSMeet53.exe` + `AOEComm.exe`; `extract_chmLib app/Meet50ug.chm` → user guide (ConnectAOE.htm = the Dolphin setup page); strings via python UTF-16LE+ASCII regex. Extraction is transient in `/tmp/ss53` (re-extract from `~/Downloads/SS53MeetInstall.exe`).
