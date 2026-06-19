---
name: sportsystems-dolphin-capture
description: "CONFIRMED-WORKING end-to-end Sport Systems Colorado Dolphin file capture — where SS lives, and the serial-port trick that makes AOE Connect work with no Colorado hardware."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1fff1c04-ad91-485c-b8ed-43bc64438328
---

**WORKS end-to-end as of 2026-06-19.** Our `.do3` results capture into Sport Systems Meet Organisation via the Colorado Dolphin (file) AOE — no Colorado hardware.

**Where SS lives:** the **Parallels "Windows 11" VM** (a full, independent Windows). `C:\MeetOrg53\SSMeet53.exe` (+ `AOEComm.exe`, `MeetSpec.exe`); Dolphin folder `C:\MeetOrg53\MeetSupport`; config `C:\MeetOrg53\sportsys.ini`; meets `C:\SPORTSYS\SSMeet\Meets`. Drive via `prlctl exec "Windows 11" cmd /c ...`. The old **CrossOver bottle `sports732` was DELETED** (was only ever used for offline RE of the same binary; Parallels never used it).

**The fix that made it work (the whole saga's answer):** SS treats the Dolphin as an "AOE". **AOE Connect** launches `AOEComm.exe`, a serial bridge that **opens a COM port and CRASHES if none exists** — so on a PC with no serial port the link never establishes ("Use AOE Connect Feature To Establish Link To AOE System" / crash). Fix = **give the machine a COM port so AOEComm survives**; SS then shows "connected" and reads the `.do3` FILES from disk (AOEComm isn't involved in the file read).
- **Parallels:** `prlctl set "Windows 11" --device-add serial --output /tmp/aoe-com.out`, then **RESTART the VM** (serial ports are NOT hot-pluggable — the reboot is mandatory; "after reboot it all works"). Set `aoecomm.ini` `CommPort` to the new COM if needed.
- **Real Windows PC:** install **com0com** (virtual COM) or use any USB-serial adapter; point `aoecomm.ini` `CommPort` at it.

**Meet must be Dolphin-configured:** `AOEType=D`, `NumDolphinTimers≥1`, `CTSDolphinPath=C:\MeetOrg53\MeetSupport` (per-meet `…meet.ini`; set via SS AOE setup). Seed the meet first (entries → process → seed) or there's no heat to capture into. ⚠️ Never put `.do3` files inside the meet folder (`…\SSMeet\Meets\<meet>\`) — a stray `CCIH1` folder there blocked entry-processing once ("file for this event does not exist"); `.do3` go ONLY in CTSDolphinPath.

**Filename + body:** `{meet:03}-000-00F{race:04}.do3` (literal `-000-00F`; keys = meet+race). Body byte-confirmed correct — see [[sportsystems-do3-format]]. Operator: AOE Connect → Get On-Line Times → enter the integer race number.

**Repo:** [[server-ts-not-built]] writes `.do3` into `DOLPHIN_DIR` (point it at the Dolphin folder); see SPORTSYSTEMS-DOLPHIN-SETUP.md + WINDOWS.md.

**Binary patch (file-only AOE w/o any COM port):** scoped (installer in ~/Downloads, `objdump` works, gate = a FindWindowA check) but **NOT needed** — the serial-port route works and doesn't modify the commercial binary. Don't patch unless the COM-port route ever becomes impossible.
