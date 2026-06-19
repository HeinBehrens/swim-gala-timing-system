# Running the timing server on Windows

For race day you'll typically run the Node server on the **same Windows PC as Sport
Systems**, so each finalised heat is written straight into SS's Colorado Dolphin
folder and SS captures it with no copying or networking.

> **No Bluetooth setup needed on the PC.** The ESP32-C5 gateway does all the BLE
> button scanning and streams presses to the server over Wi-Fi (or USB). The only
> Bluetooth on the PC is the *browser* step for first-time Wi-Fi provisioning
> (Chrome/Edge), and that needs no install.

## 1. Install Node.js
Download the **LTS** Windows installer from <https://nodejs.org>, run it (accept the
defaults). This gives you `node` and `npm`. Verify in a Command Prompt:
```
node -v
```
It should print a version (e.g. `v22.x`).

## 2. Get the code
- **With Git** (install [Git for Windows](https://git-scm.com/download/win) first):
  ```
  git clone https://github.com/HeinBehrens/swim-gala-timing-system.git
  ```
- **Without Git:** on the GitHub page, **Code → Download ZIP**, then extract it
  (e.g. to `C:\swim-gala-timing-system`).

## 3. Install dependencies (once)
Open a Command Prompt in the project folder and run:
```
npm install
```
(No native build / no BLE module to compile — the gateway handles Bluetooth.)

## 4. Tell it where Sport Systems' Dolphin folder is
1. In Sport Systems: **Tools → Support File Locations** → read **"Colorado Dolphin
   Database Directory"** (e.g. `C:\MeetOrg53\MeetSupport`).
2. Open **`start.bat`** in Notepad and set that path:
   ```
   set "DOLPHIN_DIR=C:\MeetOrg53\MeetSupport"
   ```
3. Still in SS, make sure Dolphin capture is **enabled**: set the number of Dolphin
   timers to **at least 1**, and set the Dolphin **meet / data-set number to `001`**
   (or match it to the meet number in the dashboard's *Settings → Sport Systems export*).

## 5. Run it
**Double-click `start.bat`.** A console window shows the server log and the dashboard
opens at <http://localhost:8000>. First time only:
- **Provision the gateway's Wi-Fi:** dashboard **Settings → Wi-Fi** (use **Chrome or
  Edge** — Web Bluetooth).
- **Designate the starter button:** **Settings → re-enroll**.

To stop the server, close the console window (or `Ctrl+C` in it).

## How a result reaches Sport Systems
When a heat is finalised the server writes `{meet}-000-00F{race}.do3` (e.g.
`001-000-00F0001.do3`) into the Dolphin folder. In SS: **Get On-Line Times → enter the
race number** (just the number, e.g. `1`) and it pulls in the lane times. SS matches
on **meet number + race number**; the `-000-00F` middle is fixed.

## Troubleshooting
- **"npm is not recognized"** — Node didn't add itself to PATH; close and reopen the
  Command Prompt, or reinstall Node with the default options.
- **Port 8000 already in use** — another copy is running; close it (or that console).
- **SS says "Can't Locate Dolphin Race File"** — check the **meet/data-set number**
  matches (`001`), Dolphin timers ≥ 1, and that `DOLPHIN_DIR` points at the *exact*
  folder from step 4.
- **Gateway shows disconnected after restarting the ESP** — the server auto-reconnects
  within ~10 s; no need to restart it.
- The dashboard runs in any browser, but **Wi-Fi provisioning needs Chrome or Edge**.
