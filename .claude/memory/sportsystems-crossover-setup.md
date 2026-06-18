---
name: sportsystems-crossover-setup
description: "Where Sport Systems actually runs (CrossOver bottle, NOT the Parallels VM) and how to set it up to capture our Colorado Dolphin .do3 files."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1fff1c04-ad91-485c-b8ed-43bc64438328
---

**Sport Systems "Meet Organisation 5.3" runs via CrossOver on the Mac**, bottle **`sports732`** — `~/Library/Application Support/CrossOver/Bottles/sports732/drive_c/MeetOrg53/SSMeet53.exe`. It is **NOT in the Parallels "Windows 11" VM** (that VM has no SS install and no `C:\CTSDolphin`). Discovered 2026-06-18. See [[sportsystems-do3-format]].

**Key consequence:** the bottle's `C:\` = `~/Library/Application Support/CrossOver/Bottles/sports732/drive_c/`. SS runs on the SAME Mac as the timing server, so the server can write `.do3` files **straight into the bottle's `drive_c/CTSDolphin`** — no VM, no network share, no file copy. This is the cleanest integration path.

**Current config (`drive_c/MeetOrg53/sportsys.ini`):** `MeetsPath=C:\SPORTSYS\SSMeet\Meets`; `ClrdoSettings=9600,o,8,1` (that's the SERIAL Colorado path, irrelevant to files). ⚠️ **`NumDolphinTimers=0`** and there is **no `CTSDolphin` folder and zero `.do3`/`.do4` files anywhere in the bottle** → **SS is NOT configured to capture Dolphin files, and never has.** This is the most likely reason "the integration doesn't work" — SS isn't even looking, regardless of our filename/format (which the body RE confirmed is correct).

**Setup to make it work (do these, then ONE live capture settles the filename/match):**
1. Launch SS via CrossOver (bottle `sports732`).
2. **Enable Dolphin capture for the meet:** set the number of Dolphin timers ≥ 1 (currently 0) and set the **Colorado Dolphin Database Directory** (Tools → Support File Locations; exact GUI labels to confirm in-app / help page `ConnectAOE.htm`). Default dir is `C:\CTSDolphin`.
3. **Create that folder:** `mkdir "~/Library/Application Support/CrossOver/Bottles/sports732/drive_c/CTSDolphin"` (= `C:\CTSDolphin` in the bottle).
4. **Point the server's export at it.** Server currently writes to a hardcoded `exports/` ([server.ts:41] `EXPORTS_DIR = join(BASE_DIR, "exports")`) — make it configurable (env var, e.g. `DOLPHIN_DIR`) or symlink, so `.do3` lands in the bottle's `CTSDolphin`.
5. **Import the start list** (HSL `.txt`) into SS so event/heat/lane numbering AND race numbers match the timing side.
6. **Match keys:** meet number (`config.dolphin_meet` must == SS's Dolphin meet number) + 4-digit race number (must == the race number the operator enters at Results Capture / "Get On-Line Times").
7. Run a heat → `.do3` appears in `CTSDolphin` → SS Results Capture → enter race number → confirm it reads it. That single capture also confirms the [[sportsystems-do3-format]] filename matching (positional vs real-values).
