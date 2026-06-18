---
name: start-signal-hardware
description: "ESP32-C5 start-signal (horn/siren + light) wiring, GPIO, and firmware design"
metadata: 
  node_type: memory
  type: project
  originSessionId: d0958291-c495-419d-b1c5-e4bfc0f59302
---

Start-signal feature on the ESP32-C5-DevKitC-1 v1.2 gateway (firmware/esp32_shelly_scanner), added 2026-06-03. Fires a physical start signal LOCALLY the instant the starter button is seen — lowest latency, synced to the on-chip press timestamp.

**Firmware design (stable regardless of which transducer):**
- `SIGNAL_PIN = GPIO5` → logic-level MOSFET gate → switches a separately-powered 12 V load (horn/siren and/or strobe light). Active HIGH, auto-off after `SIGNAL_MS` (1500 ms), non-blocking (handled in ioTask).
- Trigger is LOCAL: ioTask compares each new press MAC to `starterMac`; on match calls `fireStartSignal()`.
- Starter MAC is pushed from the host over the existing link: server sends `STARTER\t<mac>\n` on gateway connect and whenever enrollment changes (`pushStarterMac()` in rebuildMaps; `Esp32Gateway.send()` writes to serial/TCP). Firmware reads it in `pollCommands()` (ioTask) and persists to NVS namespace "cfg" key "starter". Survives re-enrollment from the dashboard.
- Firmware version bumped to **v9**. Flash with PartitionScheme=huge_app (see [[gateway-wifi-flashing]]).

**Safe GPIO on C5:** avoid strapping pins 7,25,26,27,28 + MTMS/MTDI, USB 13/14, UART 11/12. GPIO5 (and 6,4,3) are safe outputs.

**Wiring (12 V load via logic-level N-MOSFET, e.g. AO3400/IRLZ44N):**
`GPIO5 →220Ω→ gate`, `gate →100kΩ→ GND` (pulldown, keeps load OFF at boot), `source → GND` (common with 12 V GND), `drain → load(−)`, `load(+) → +12 V` (separate supply). Flyback diode across inductive loads. Easiest: a prebuilt "MOSFET trigger driver module".

**FINAL DESIGN (2026-06-03, firmware v11):** Start comes INTO the ESP, Shelly starter button dropped. Pin map:
- **GPIO4** = START input (INPUT_PULLUP, active-LOW, ISR-timed for precise µs). A start button or contact to GND. ISR captures esp_timer_get_time(), sets startFlag; ioTask emits `START\t<micros>\n` to host + calls fireStartSignal().
- **GPIO5** = strobe/beacon light via logic-level MOSFET (12 V LED beacon). On for SIGNAL_MS (1500 ms).
- **GPIO6** = start TONE (LEDC PWM 2 kHz) → RC low-pass (1kΩ+100nF) + 1µF coupling cap → megaphone 3.5 mm AUX (tip+ring mono, sleeve=GND). Plays start beep through the megaphone; loudness via megaphone volume.

Server: `gateway.on("start")` → `handleExternalStart(micros)` → race.start (mirrors starter-button path). esp32.ts parses `START` line → "start" event. Starter-MAC local trigger (GPIO5/STARTER push) kept as dormant fallback.

Megaphone (voice + AUX start tone): MyMealivos 50W with 3.5mm AUX input (amazon.co.uk B07MXCXCTT). Announcer talks via mic; start beep plays via AUX. Start flow: press GPIO4 button → ESP timestamps start + tells host + flashes light + beeps megaphone, all one synced trigger.

**Full BOM + wiring saved to `HARDWARE.md` in the repo root** (version-tracked). Bright beacon = 12V dome/strobe via USB-C PD power bank + 12V PD trigger cable + logic-level MOSFET module on GPIO5. Power bank pick: UGREEN Nexode 100W 20000mAh (PD-C port → 12V trigger → beacon; USB-A port → ESP 5V; simultaneous, common ground). Start button = Switchcraft EP913S23 IP67 momentary (COM→GND, NO→GPIO4), on a cable. Beacon also on a cable. Both enter the IP67 box via glands or SP13 2-pin connectors. Tone: GPIO6 → 1µF cap → megaphone AUX tip.
