---
name: node-mdns-local-needs-family4
description: "Node can't reach the gateway at swim-timer.local unless TCP connect forces family:4 — default lookup hangs on the mDNS AAAA query"
metadata: 
  node_type: memory
  type: project
  originSessionId: 18331838-33be-4f4d-aa21-ac65f52c45c4
---

When the server connects to the gateway over Wi-Fi/TCP (`swim-timer.local:3333`), the Node `Socket.connect` MUST pass `{ port, host, family: 4 }`. The default dual-stack lookup issues both A and AAAA queries, and the **IPv6/AAAA query for the `.local` mDNS name hangs (~5s+) and times out the whole connect** — even though the OS `ping swim-timer.local` resolves instantly. Symptom: dashboard shows `transport:null, ble:false` forever while `ping`/`nc -z swim-timer.local 3333` both succeed.

**Why:** cost a long debug on 2026-06-12. Presses (LED flashing on the gateway) never reached the dashboard because the server simply never connected over Wi-Fi; the failure looked like a hardware/gateway problem but was Node DNS. Confirmed: connect by IP = 11ms, connect by hostname default = timeout, hostname + family:4 = 11ms.

**How to apply:** both TCP connect paths in [src/esp32.ts](src/esp32.ts) (`tryTcpAuto` and `openTcpOnce`) now force `family: 4` — keep it. If you ever see the server stuck not connecting while ping works, this is the first thing to check. Related: the link is Wi-Fi-first / serial-fallback, and the dashboard's Link chip shows the active transport — see [[wifi-unknown-is-serial-transport-artifact]] and [[gateway-wifi-flashing]].
