# Swim Gala Timing System — Hardware (start signal kit)

Companion hardware for the ESP32-C5 gateway (`firmware/esp32_shelly_scanner`, **v11**).
Adds an **external start** (button → ESP), a **bright 12 V beacon**, and a **start beep**
played through a megaphone — all powered from a power bank, in a waterproof box.

The Shelly starter button is **not needed**: pressing the start button makes the ESP
timestamp the start (on-chip µs), tell the host to start the clock, flash the beacon,
and beep the megaphone — one trigger, everything in sync.

> **All timing is done on the ESP32, not the host.** The start is captured in a
> hardware ISR at the falling edge and finishes are stamped with the on-chip
> microsecond clock in the BLE callback — both from the *same* monotonic clock,
> so a race time is `finish_µs − start_µs` and any USB/host latency cancels. The
> host only subtracts. This is why a button on GPIO4 (and the DIY touchpads
> below) is accurate despite running through a laptop — see the README for the
> full rationale and `src/latency-test.ts` for why host-side stamps are not.

## Pin map (ESP32-C5-DevKitC-1 v1.2)
| GPIO | Role | Connects to |
|---|---|---|
| **GPIO4** | START input (active-LOW, ISR-timed) | start button → GND |
| **GPIO5** | Beacon switch (on for 1.5 s at start) | MOSFET module SIG → 12 V beacon |
| **GPIO6** | Start tone (2 kHz PWM) | 1 µF cap → megaphone 3.5 mm AUX tip |
| GND | common ground | ground everything together (critical) |
| 5V | ESP power | power bank USB-A |

Safe GPIOs only; avoid C5 strapping pins 7/25/26/27/28 + MTMS/MTDI, USB 13/14, UART 11/12.

## Wiring

### Beacon (12 V via PD power bank)
```
 USB-C PD bank ── PD trigger cable ──▶ 12V+ ─▶ MOSFET VIN+
                                       12V GND ▶ MOSFET VIN−
 GPIO5 ─────────────────────────────────────▶ MOSFET SIG
 ESP GND ────────────────────────────────────▶ MOSFET GND   (shared ground!)
 MOSFET OUT+ ─▶ beacon (+)
 MOSFET OUT− ─▶ beacon (−)
 ESP powered from the SAME bank's USB-A port → ground is common.
```

### Start button (on a cable)
```
 Switchcraft EP913S23 (momentary, IP67):  COM → GND,  NO → GPIO4
 (no resistor — firmware uses internal pull-up)
```

### Start tone → megaphone AUX
```
 GPIO6 ──[ 1 µF ]──▶ 3.5 mm TIP (+ RING for mono)
 GND ──────────────▶ 3.5 mm SLEEVE
 Set loudness with the megaphone's volume knob.
```

## Bill of materials (UK)
| Part | Purpose | Qty | Link |
|---|---|---|---|
| ESP32-C5-DevKitC-1 v1.2 | gateway (have) | 1 | — |
| 12 V LED strobe/rotating beacon | start flash | 1 | https://www.amazon.co.uk/Cyrank-Strobe-Flashing-Security-Warning-Default/dp/B0CRF1J3M8 |
| Logic-level MOSFET trigger module | GPIO5 switches beacon | 1 | https://www.amazon.co.uk/s?k=mosfet+trigger+driver+module |
| USB-C PD power bank (simultaneous PD + 5 V) | powers ESP (5 V) + beacon (12 V) | 1 | UGREEN Nexode 100W https://www.amazon.co.uk/UGREEN-20000mAh-Charging-Recharge-Compatible/dp/B0C3GTMX5M · INIU 65W https://www.amazon.co.uk/INIU-20000mAh-Charging-Portable-Charger/dp/B0CB1DF4JQ |
| USB-C → 12 V PD trigger cable | 12 V from the bank | 1 | https://www.amazon.co.uk/s?k=usb+c+pd+to+12v+trigger+cable |
| Start button (momentary, IP67) | START → GPIO4/GND | 1 | Switchcraft EP913S23 https://www.digikey.co.uk/en/products/detail/switchcraft-inc/EP913S23/5361153 |
| — cheaper alt | budget / hands-free | — | RUNCCI-YUN https://www.amazon.co.uk/RUNCCI-YUN-Momentary-Waterproof-Stainless-Normally/dp/B0B3QJGNG7 · foot switch https://www.amazon.co.uk/mxuteuk-Momentary-Nonslip-Handsfree-Industrial/dp/B08JLMXQS6 |
| Megaphone w/ 3.5 mm AUX in | voice + start beep | 1 | Pyle PMP43IN (AA) https://www.amazon.co.uk/Megaphone-Function-800-Metres-Microphone-Batteries/dp/B00R9P1BT8 · MyMealivos (USB-rechargeable) https://www.amazon.co.uk/MyMealivos-Megaphone-Detachable-Microphone-Lightweight/dp/B07YRJJ1TJ |
| 3.5 mm plug / screw-terminal | GPIO6 tone → AUX | 1 | https://www.amazon.co.uk/s?k=3.5mm+screw+terminal+connector |
| IP67 enclosure (158×90×60, clear lid) | houses ESP + MOSFET | 1 | https://www.amazon.co.uk/Electronics-Electrical-Electronic-6-1x3-5x2-3Inch-157X88-5X60mm/dp/B0CYZT7T72 |
| Cable glands (PG7/PG9) **or** SP13 2-pin connectors | cable entry (permanent vs unpluggable) | 2–4 | glands https://www.amazon.co.uk/s?k=pg7+pg9+cable+gland+pack · SP13 https://www.amazon.co.uk/s?k=sp13+2+pin+waterproof+connector |
| 2-core cable | button + beacon runs (≤10 m each) | ~10 m | https://www.amazon.co.uk/s?k=2+core+cable |
| Electronics starter kit (breadboard, caps, resistors, jumpers) | 1 µF AUX cap + prototyping | 1 | https://www.amazon.co.uk/ELEGOO-Electronics-Potentiometer-tie-points-Breadboard/dp/B01LZRV539 |
| Dupont jumper wires | GPIO connections | 1 | https://www.amazon.co.uk/Elegoo-120pcs-Multicolored-Breadboard-arduino-colorful/dp/B01EV70C78 |

## Recommended power bank
**UGREEN Nexode 100W 20000mAh** (2× USB-C + 1× USB-A) — plug the **PD trigger cable into a
USB-C port** (→ 12 V for the beacon) and run the **ESP off the USB-A port** (→ 5 V). Both
output simultaneously and share one internal ground. Alt: **INIU 65W 20000mAh** (3-port).

## Assembly notes / cautions
- **Shared ground is mandatory** — ESP GND, MOSFET GND/VIN−, and the 12 V (PD) ground must
  all connect. Using one power bank for both ESP and beacon makes this automatic.
- **Start button must be MOMENTARY** (push-to-make), not latching. Switchcraft: COM + NO only.
- **Power-bank auto-shutoff:** pick one that won't cut off at low current; the ESP (Wi-Fi+BLE)
  usually draws enough (>100 mA) to keep it awake.
- **Beacon = single flash** (1.5 s), like real meet start systems — not a continuous strobe.
- The cheap Pyle megaphone uses **AA batteries** (not USB); MyMealivos is USB-rechargeable.
  Only one wire goes to it: GPIO6 → its 3.5 mm AUX.
- Browser note: the dashboard runs in any browser, but **Wi-Fi provisioning needs Chrome/Edge**
  (Web Bluetooth). Server runs on macOS/Windows/Linux (Node) — see [[gateway-wifi-flashing]].

## Finish touchpads (DIY)

Official touchpads (Colorado Time Systems / Daktronics) run **~$1,000–1,500 *per lane***
new — a full 6-lane set is $6k–9k+. A DIY membrane pad is electrically just a big version
of the start button (a contact closure to GND) and costs **£15–30 per lane** in materials,
**~£90–180 for six lanes**. Accurate to a few ms; lives or dies on the seal and mounting.

### The critical gotcha: pool water is conductive
The pad closes a circuit when two conductive layers touch — **and pool water closes that
same circuit.** The conductive sandwich must be **hermetically sealed and bone dry inside**.
One drop between the layers = the pad reads "pressed" forever. Waterproofing here is not
about protecting electronics; it's the difference between a working pad and a dead short.
**Pressure-test every pad in a bucket before a gala.**

### Layer stack (front face → wall side)
```
1. Front skin    — tough flexible vinyl/PVC (banner or pool-inflatable material)
2. Top conductor — conductive fabric  ←─ swimmer's touch pushes this...
3. Spacer        — open plastic mesh (5–12 mm holes)   ...through the holes...
4. Bot conductor — conductive fabric  ←─ ...onto this → circuit closes
5. Back skin     — same vinyl/PVC
   → whole stack heat-sealed/welded around all 4 edges into one dry pouch
```
Touch anywhere → top layer bows through a mesh hole → contacts bottom layer → GPIO LOW.

- **Conductor: nickel/silver-plated ripstop fabric, NOT bare aluminium foil.** Foil is £2
  but creases, tears, and grows an *insulating oxide skin* → flaky contact within weeks.
  Conductive fabric (~£8–12/sheet) flexes forever and doesn't oxidize.
- **Spacer: plastic canvas (cross-stitch grid) or garden netting.** Hole size + stiffness
  sets the trigger force — want "deliberate hand slap" to fire, not "wave slosh."
- **Bus bars:** a strip of copper tape along one edge of each conductive layer; solder one
  wire per layer to it.

### Bill of materials (per pad, UK)
| Item | Cost |
|---|---|
| Conductive fabric ×2 layers | £8–12 |
| Plastic mesh / canvas spacer | £2–4 |
| Vinyl/PVC skin (front+back) | £3–6 |
| Copper tape + 2-core wire + SP13 connector | £3–5 |
| Sealing (heat-weld or vinyl-repair tape) | £1–3 |
| **Per pad** | **£15–30** |
| **6-lane set** | **£90–180** |
| 1× MCP23017 I²C I/O expander (whole set) | £2–4 |

### Size & mounting
- **Don't copy the FINA 2.4 m × 0.9 m pad.** For a club gala, **1.2 m wide × 0.6 m tall**
  per lane covers where swimmers touch and is far easier to seal and keep flat.
- Grommets along the top edge → bungee/clip to the lane rail or starting block; slip a
  length of PVC pipe into a bottom sleeve as a weight so it hangs flat and stays submerged.

### Wiring to the ESP32-C5
Each pad is electrically identical to the **START input on GPIO4** — a contact closure to
GND, INPUT_PULLUP, active-LOW. Press → input reads LOW.
- **Pin budget:** the safe-GPIO list above can't spare 6 lanes. Add **one MCP23017** (16
  inputs over I²C, internal pull-ups, ~£3): lanes 1–6 → GPA0–GPA5; scales to 16 lanes free.
- **Long wet runs (≤10 m each):** use the expander's pull-ups (or external 4.7 k–10 k), not
  the weak internal ones — long cable = noisy antenna. Add a series 100 Ω + TVS diode at the
  ESP end for ESD/surge protection on cables living on a wet pool deck.

### Firmware: debounce + first-touch latch
Two must-haves: debounce (water/multi-touch chatter) and a **per-lane latch so the *first*
touch wins** and later touches in the same heat are ignored until `resetHeat()`. Emits a
finish as a timestamped event on the same path as the GPIO4 start.
```cpp
const uint8_t LANES = 6;
uint32_t touchMs[LANES];        // 0 = not yet finished this heat
uint32_t lowSince[LANES];       // debounce timer
const uint16_t DEBOUNCE = 25;   // ms of stable LOW required

void pollLanes() {
  uint32_t now = millis();
  for (uint8_t i = 0; i < LANES; i++) {
    bool pressed = (mcpRead(i) == LOW);
    if (pressed) {
      if (lowSince[i] == 0) lowSince[i] = now;
      if (!touchMs[i] && now - lowSince[i] >= DEBOUNCE) {
        touchMs[i] = now;                 // FIRST clean touch wins
        sendFinish(i, now);               // → host, same path as start
      }
    } else {
      lowSince[i] = 0;                     // reset debounce, keep latch
    }
  }
}
void resetHeat() { for (auto &t : touchMs) t = 0; }  // call on new start
```

### Build & test sequence
1. Build **one** pad first. Before sealing, meter across the two wires: **open at rest,
   near-0 Ω when pressed anywhere** — check all four corners + center.
2. Seal the pouch, then **submerge in a bucket 30 min** — meter still open → good seal;
   reads closed → water got in, find the leak.
3. Tune trigger force by swapping spacer thickness until a light touch fires but squeezing
   the bag edges / shaking does not.
4. Only then replicate ×6.

**Start strategy:** for the first gala, run **one pad + finish buttons on the other lanes**
so you can validate a real pad in water before committing to a full set.

## Firmware
v11, flash with `arduino-cli ... --fqbn esp32:esp32:esp32c5:PartitionScheme=huge_app`.
Test the start flow with just the button on GPIO4/GND before the beacon/megaphone arrive.
