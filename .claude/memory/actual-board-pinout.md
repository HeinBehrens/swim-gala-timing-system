---
name: actual-board-pinout
description: "User's physical ESP32 board confirmed from photos — exact model, silkscreen pin rows, and which header row each wiring pin sits on"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 1fff1c04-ad91-485c-b8ed-43bc64438328
---

User's actual gateway board (confirmed by photos 2026-06-16): silkscreen **ESP32-C5-KITC-A V1.2** = the **ESP32-C5-DevKitC-1 v1.2** assumed in [[server-ts-not-built]] / HARDWARE.md. WiFi module marked ESP32-C5-32. Two USB-C ports (USB + UART), RESET + BOOT buttons. Currently prototyped on a breadboard with the **PCM5102 DAC** ("LINE OUT" purple GY-PCM5102A, Option A) — so the user went with the [[export-do4-sportsystems]]-unrelated DAC/AUX route, not the MAX98357.

Physical header layout, component-side up, USB-C ports on the RIGHT:
- FRONT row (toward you): `3V3 RET 2 3 0 1 6 7 8 9 10 25 26 5V G NC`
- BACK row (far side):    `G TXO RXO 24 23 15 27 4 5 NC 28 G 14 13 G NC`

Key gotcha for drawing wiring: the pins are split across both rows — **LCK(GPIO6) + DIN(GPIO10) + 3V3 + 5V are on the FRONT row; BCK(GPIO4) + light SIG(GPIO5) are on the BACK row**. PCM5102 jumpers must reach across to both. Pin roles confirmed in firmware esp32_shelly_scanner.ino:67-77 (SIGNAL_PIN 5, I2S_BCLK 4, I2S_LRC 6, I2S_DOUT 10, RGB_LED_PIN 27 = onboard WS2812 start cue, no wiring).

**Why:** my first ASCII "wiring" was a made-up schematic layout and didn't match the real board, which annoyed the user. **How to apply:** when showing wiring, draw it against THIS physical row layout, not an invented one. SCK→GND is the silent-audio gotcha to flag every time. See [[sportsystems-do3-format]] only for export, unrelated to wiring.
