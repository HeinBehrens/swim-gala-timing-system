---
name: wifi-unknown-is-serial-transport-artifact
description: "Dashboard wifi=\"unknown\" usually means the server is on USB-serial transport, NOT that the gateway's WiFi is down — verify with ping"
metadata: 
  node_type: memory
  type: project
  originSessionId: 18331838-33be-4f4d-aa21-ac65f52c45c4
---

The dashboard / `/api/state` `wifi` field reads `"unknown"` whenever `src/server.ts` is connected to the gateway over **USB serial** (its primary transport), because the server only learns WiFi state from the firmware's `WIFI\t...` serial lines and often isn't picking those up. It only shows `wifi: "connected"` when the server is on the **WiFi/TCP** transport (it infers it from the transport itself — see server.ts ~line 1161). After a flash/USB re-enumeration the server auto-switches from WiFi back to serial, so the dot flips to `unknown` even though WiFi is perfectly fine.

**Why:** caused a false "WiFi dropped" scare during the 70/30 ratio test on 2026-06-12 — 5 samples `connected` then `unknown`, but the gateway was up the whole time.

**How to apply:** to check if the gateway's WiFi is actually up, don't trust the dashboard dot when on serial — run `ping swim-timer.local` (it was <lan-ip-redacted>) and `nc -z swim-timer.local 3333`. Both succeeding = WiFi up. See [[gateway-wifi-flashing]] and [[ble-capture-bottleneck]] for the BLE/WiFi scan-window coexistence ratio (70/30 verified solid, 80/20 also held but tight).
