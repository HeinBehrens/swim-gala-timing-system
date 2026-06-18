---
name: ble-capture-bottleneck
description: "BLE capture path — the 85-89% test result is likely human press artifacts, NOT radio drops; an ESP32-C5 gateway is now built and stable as the capture path regardless"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4ce72c54-e8ee-48fd-a00c-3169b68c8f5e
---

`src/simultaneous-test.ts` with 4 Shelly BLU buttons pressed together gave **84% and 89% completeness**. **Do NOT read this as a radio bottleneck.** The incomplete rounds look like human pressing artifacts: a "missed" button reappears as the baseline of the next round with a fresh packet burst (pressed a beat late, split by the 1200ms quiet window); ragged rounds recover perfectly next round; big 1.2-1.8s spreads are pairs pressed ~1.2s apart by hand. The test conflates didn't-press / received-but-late / true-drop, so it's the wrong instrument. An earlier "the Mac radio is the bottleneck" claim was over-stated and walked back. `NOBLE_REPORT_ALL_HCI_EVENTS` is a no-op on macOS (Linux-only HCI path); we already pass `allowDuplicates=true`.

**ESP32-C5 gateway built (2026-06-02).** Independent of the bottleneck question, an **ESP32-C5** dev board (port `/dev/cu.usbserial-10`) now acts as a dedicated BLE observer — firmware at [firmware/esp32_shelly_scanner/esp32_shelly_scanner.ino]. Continuous passive scan parses Shelly BLU Button1 Tough BTHome v2 adverts (service `fcd2`, obj `0x3a`=button, `0x00`=packet_id), timestamps each press on-chip in µs (before any USB round-trip → no host jitter), dedups the advert burst by packet_id, and streams `PRESS\t<mac>\t<button>\t<packetId>\t<rssi>\t<microsSinceBoot>` over USB serial @115200. Survived sustained 6-button simultaneous bursts with zero drops/crashes.

**Hard-won firmware gotchas (ESP32-C5, arduino-esp32 core 3.3.8, bundled BLE lib — NOT external NimBLE-Arduino):**
- Continuous `scan->start(0)` LEAKS: bundled lib has no public `setMaxResults()`, default `m_maxResults=0xFF` never frees, so every advertiser accumulates until `operator new` throws `std::bad_alloc` → terminate → abort. Fix: finite-duration scan loop (`start(SCAN_SECONDS,false)` clears results race-safely each window) called from `loop()`.
- Keep the scan callback minimal (no STL/Serial) — push a fixed-size POD to a FreeRTOS queue; dedup+Serial in `loop()`.
- `getAddress().getNative()` returns little-endian on-air bytes — reverse for the canonical `7c:c6:b6:..` MAC the Shelly app shows.

**Wi-Fi/BLE coexistence — modem-sleep approach FAILED, reverted (2026-06-05).** Tried (firmware v14) dropping Wi-Fi to `WIFI_PS_MAX_MODEM` on the starter press to give BLE more radio during a heat. It re-associated the station at the worst moment ("esp joined wifi") and the host never got the start → **no countdown**. Calling `WiFi.setSleep()` synchronously in the high-prio ioTask on the starter press is the trap. Reverted to v13 (PRs #2 then #3). Lesson: don't toggle Wi-Fi power-save in firmware around the start. For BLE reliability during a heat, run the **host over USB** (already auto-preferred when cabled) — see [[server-ts-not-built]]. Note the ESP32-C5 has ONE RF transceiver shared Wi-Fi/BLE via time-division (dual-band 2.4/5 GHz but no separate 5 GHz radio; BLE is 2.4 GHz only), so you can't dodge coexistence by band.

Setup: 7 buttons = 6 lanes + 1 starter. Starter is a non-Shelly OUI (canonical `<starter-mac-redacted>`). Lane→MAC enrollment to be done host-side by press order. See [[server-ts-not-built]].

Toolchain: `arduino-cli` + esptool via Homebrew; pyserial at `/opt/homebrew/opt/esptool/libexec/bin/python3`.
