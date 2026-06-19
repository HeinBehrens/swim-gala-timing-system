# Sport Systems ⇄ Colorado Dolphin (file) — Windows setup

How to make **Sport Systems Meet Organisation** read our timing results as a
**Colorado Dolphin** AOE, on a Windows PC, **without any Colorado hardware**.

## How it works (why this is needed)
SS doesn't read Dolphin `.do3` files until an "AOE" (timing) link is *connected*.
For a Colorado Dolphin (`AOEType=D`) the **AOE Connect** button launches a small
serial helper, **`AOEComm.exe`**, which opens a COM port. SS then watches for that
helper's window (titled `SPORTSYSTEMS AOE Communications`) to decide it's "connected"
— and once connected, **SS reads the `.do3` files from disk** (the helper isn't
involved in the file read at all).

The problem: on a PC with **no COM port**, `AOEComm.exe` crashes when it tries to
open the port, so the link never establishes and you get *"Use AOE Connect Feature
To Establish Link"* (or a crash). The fix is simply to **give it a COM port to
open** — then the helper stays alive, SS shows "connected," and reads our files.

> No Colorado box is involved. The `.do3` files **are** the "Dolphin." The COM port
> exists only so SS's serial helper doesn't crash on startup.

## One-time setup
1. **Give Windows a COM port.** Modern laptops have none, and `AOEComm.exe` must open
   one or it crashes. Either:
   - **Easiest — a USB-to-serial adapter (~£3).** Plug it in; in **Device Manager →
     Ports (COM & LPT)** note the COM number it's assigned (e.g. `COM3`). Plug-and-play,
     no driver-signing hassle, and nothing needs to be wired to the adapter — SS only
     needs to *open* the port.
   - **No hardware — com0com** (free virtual null-modem) creates a virtual COM pair
     (e.g. `COM3 ↔ COM4`). On Windows 10/11 use a **signed** build / allow the driver,
     or it won't install. (Verified working: a serial port that simply *opens*.)
2. **Point the AOE helper at it.** Edit `C:\MeetOrg53\aoecomm.ini`:
   ```
   [Properties]
   CommPort=1            ; the virtual COM number from step 1
   Settings=9600,e,7,1
   ```
3. **Set the Dolphin folder.** In SS: **Tools → Support File Locations → Colorado
   Dolphin Database Directory** → a folder you control (e.g. `C:\MeetOrg53\MeetSupport`).
4. **Enable Dolphin capture for the meet.** In the meet's AOE setup choose **Colorado
   Dolphin** and set **number of Dolphin timers ≥ 1**. (In the meet's `…meet.ini` this
   is `AOEType=D`, `NumDolphinTimers=2`, `CTSDolphinPath=<the folder>`.)

## Per heat (what the timing system does automatically)
5. Drop the heat's result file in the Dolphin folder, named exactly:
   ```
   {meet:3}-000-00F{race:4}.do3      e.g.  001-000-00F0001.do3
   ```
   - `{meet}` = SS's Dolphin **meet/data-set number**, 3 digits (default `001`).
   - `{race}` = the **race number** for that heat, 4 digits (`0001`).
   - The middle **`-000-00F` is a fixed literal** SS hard-codes — do **not** put the
     real event/heat/round there, or SS won't find the file.
   - Body: line 1 `event;heat;num_splits;round` (e.g. `1;1;1;Final`), then one line per
     lane `lane;time;;` (blank time = no swim), then any 16-hex checksum line (ignored).
   - Our server writes this automatically — run it with `DOLPHIN_DIR` pointed at the
     Dolphin folder (see WINDOWS.md).

## Capture a heat
6. In **Meet Results Capture**: click **AOE Connect** (now succeeds — the helper opens
   the virtual COM and stays up), then **Get On-Line Times → enter the race number**
   (just the integer, e.g. `1`). SS reads the matching `.do3` and fills the lane times.

## Troubleshooting
- **AOE Connect still crashes / "no COM port"** → the `CommPort` in `aoecomm.ini`
  doesn't match an openable port. Re-check the com0com number.
- **"Can't Locate Dolphin Race File"** → the `.do3` name/number is wrong. It must be
  `{meet}-000-00F{race}.do3` with the meet number matching SS's Dolphin meet number.
- **"file for this event does not exist"** → an SS meet-data problem (an event file is
  missing), not a Dolphin issue — re-import the start list / re-process entries. Do not
  put `.do3` files inside the meet folder (`…\SSMeet\Meets\<meet>\`); they go only in
  the Colorado Dolphin Database Directory.

## Fallback (no com0com available)
SS only checks for a **window titled `SPORTSYSTEMS AOE Communications`** plus the
`.do3` on disk. If you can't add a COM port, keep any process alive that owns a window
with that exact title (e.g. a tiny stub app), set `[AOEComm] AOECommPid=<that PID>` and
`AOECommMeet=<meet id>` in `sportsys.ini`, and SS will treat the Dolphin as connected.
The com0com route above is cleaner and uses SS's own AOE Connect, so prefer it.
