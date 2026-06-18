---
name: user-uk-based
description: "The user is in the UK — affects part sourcing, voltages/plugs, governing body, and pricing."
metadata: 
  node_type: memory
  type: user
  originSessionId: 5e18f228-cea2-432d-80a2-ce5a847bdb76
---

The user is based in the **United Kingdom**. Apply this to all recommendations:

- **Parts/suppliers**: prefer UK sources — Amazon.co.uk, RS Components, CPC/Farnell, The Pi Hut, Pimoroni, Toolstation/Screwfix (for relays, horns, sirens). Avoid US-only suppliers.
- **Mains/voltage**: 230 V / 50 Hz, BS 1363 (3-pin UK) plugs. Mains hum is **50 Hz** (and 150 Hz harmonics). 12 V DC sirens/horns are the off-the-shelf norm here.
- **Swimming context**: governing body is **Swim England** (not USA Swimming); meet software is **Sport Systems**; results go to Swim England rankings via Lenex. See [[export-do4-sportsystems]].
- **Pricing**: quote in **£ (GBP)**.
