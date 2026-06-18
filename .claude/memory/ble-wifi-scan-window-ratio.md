---
name: ble-wifi-scan-window-ratio
description: ESP32-C5 BLE/Wi-Fi coexistence is tuned by the BLE scan window/interval duty cycle — 75/25 is the chosen ratio (max BLE that keeps Wi-Fi stable); 80/20 flaps
metadata: 
  node_type: memory
  type: project
  originSessionId: 18331838-33be-4f4d-aa21-ac65f52c45c4
---

The single-radio BLE/Wi-Fi coexistence on the gateway is tuned in firmware via the BLE scan duty cycle in `setup()` of [firmware/esp32_shelly_scanner/esp32_shelly_scanner.ino]: `scan->setInterval(100); scan->setWindow(N)`. The window must be SHORTER than the interval to leave radio gaps for Wi-Fi — `window==interval` (100/100) = 100% BLE duty starves Wi-Fi and it reconnects constantly.

Empirically tested 2026-06-12 (ground truth = independent `ping swim-timer.local`, plus `/api/state` transport/wifi):
- **80/20 (window 80) — FLAPS.** Wi-Fi dropped within ~1 min of boot, ping failed, server link fell to null/serial. Too tight.
- **75/25 (window 75) — SOLID.** ping never failed across multi-minute observation. **This is what's flashed and chosen** — most BLE capture that still holds Wi-Fi.
- **70/30 (window 70) — SOLID** (the safe fallback if 75/25 ever flaps under real load).

Don't redo the modem-sleep approach (that FAILED — see [[ble-capture-bottleneck]]); the duty-cycle window is the working lever. The READY banner still says `v13` regardless of ratio (never bumped), so the flashed ratio is NOT self-identifying — track it here. To flash: gateway must be on USB; if the server holds the serial port, free it first by forcing the link to Wi-Fi (`set_transport` / Link chip) — see [[node-mdns-local-needs-family4]] for the Wi-Fi-first link and [[gateway-wifi-flashing]] for the arduino-cli command.
