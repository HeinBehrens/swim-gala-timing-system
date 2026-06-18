---
name: audio-chain-debug
description: "The start-beep audio chain (PCM5102 DAC → amp/PA) is working; the root causes found while debugging it, and the final working setup."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1fff1c04-ad91-485c-b8ed-43bc64438328
---

The start-signal **audio is working** as of 2026-06-17. Debugging the "no sound / quiet / humming" chain (PCM5102 DAC route, [[actual-board-pinout]]) surfaced several stacked causes — in the order they were fixed:

1. **No sound** → wiring on the PCM5102 (BCK→GPIO4 not GPIO27, and **SCK must be tied to GND** — floating SCK = no PLL = silence). Isolated with the bench **Test tone** (see below) + multimeter (AC on LINE OUT, DC ~1.6 V on the toggling clocks).
2. **Still quiet** → LINE OUT is line-level only; it **cannot drive a passive speaker**. User is driving it through a **powered amp / sound system / PA** (the proper loud route). Firmware digital level was also bumped to ~full scale (`AMP`/`TEST_TONE_AMP = 32000`).
3. **Loud humming** → was the firmware's faint ~90 Hz idle keep-alive tone, amplified. **Fixed: `KEEPALIVE_AMP = 0`** (idle now streams digital silence; I2S stays active so the DAC doesn't hiss). Raise to ~20–80 only if a powered speaker with auto-standby ever sleeps and clips the first beep — not an issue on an always-on amp/PA.
4. **Hum remained at idle** → a **ground loop** (USB-powered ESP + separately-powered amp sharing audio ground via the 3.5 mm cable). **Fixed with an inline 3.5 mm ground-loop isolator.** Not a firmware issue.

**Firmware test aids added** (`esp32_shelly_scanner.ino`): serial/TCP commands `TEST` (continuous 300→3000 Hz sweep siren), `TONE <hz>` (steady), `TESTOFF`; `TEST_TONE_ON_BOOT` compile flag (currently 0); and a dashboard **Test tone** toggle button (Settings → Gateway). Flash over USB with `arduino-cli ... --fqbn esp32:esp32:esp32c5:PartitionScheme=huge_app -u -p <port>`; the C5 re-enumerates its port on reset (e.g. `usbmodem101` ↔ `usbmodem1101`) — re-detect before flashing. Server holds the serial port → stop it (free :8000) before a USB flash if it fell back to serial.
