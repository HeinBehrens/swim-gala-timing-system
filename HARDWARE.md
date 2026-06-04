# Swim Gala Timing System — Hardware (start signal kit)

Companion hardware for the ESP32-C5 gateway (`firmware/esp32_shelly_scanner`, **v12**).
Adds a **5 V USB strobe light** and a **start beep** played through a **MAX98357 I2S
amp + speaker** — both USB-powered, in a waterproof box. No 12 V, no power bank, no
megaphone needed for the start signal.

**No wired start button.** The race start is one of the **Shelly BLU buttons**,
designated host-side (dashboard re-enroll → sends `STARTER\t<mac>` to the ESP). When
that button is pressed the ESP timestamps it on-chip, the host starts the clock from
its PRESS line, and the ESP fires the light + beep locally — one wireless trigger,
everything in sync.

> **All timing is done on the ESP32, not the host.** The start button (a designated
> Shelly BLU button) and every finish are stamped with the on-chip microsecond clock
> in the BLE receive callback — all from the *same* monotonic clock, so a race time
> is `finish_µs − start_µs` and any transport latency cancels. The host only
> subtracts. The same stamped line is streamed over **both USB serial and Wi-Fi TCP
> (port 3333, `swim-timer.local`)**; since the stamp is taken on-chip before either
> path, it makes no difference which transport delivers it. This is why the system
> (and the DIY touchpads below) is accurate despite running through a laptop over USB
> or Wi-Fi — see the README for the full rationale and `src/latency-test.ts` for why
> host-side stamps are not.

## Pin map (ESP32-C5-DevKitC-1 v1.2)
| GPIO | Role | Connects to |
|---|---|---|
| **GPIO5** | Light switch (on for 1.5 s at start) | MOSFET module SIG → 5 V USB strobe/LED |
| **GPIO4** | I2S BCLK (bit clock) | MAX98357 **BCLK** |
| **GPIO6** | I2S LRC (word clock) | MAX98357 **LRC** |
| **GPIO10** | I2S DOUT (serial data) | MAX98357 **DIN** |
| GND | common ground | ground everything together (critical) |
| 5V | ESP + amp + light power | USB (power bank USB-A or USB charger) |

Safe GPIOs only; avoid C5 strapping pins 7/25/26/27/28 + MTMS/MTDI, USB 13/14, UART 11/12.
(GPIO4/6 were freed from the old wired-start/megaphone-tone roles; verify GPIO10 is free
on your board before wiring.)

## Wiring

### Start beep — MAX98357 I2S amp → speaker
```
 ESP 5V  ─────────▶ MAX98357 VCC   (2.5–5.5 V)
 ESP GND ─────────▶ MAX98357 GND   (shared ground)
 GPIO4   ─────────▶ MAX98357 BCLK
 GPIO6   ─────────▶ MAX98357 LRC
 GPIO10  ─────────▶ MAX98357 DIN
 MAX98357 SD  ── leave enabled (board default / tie to VCC); silence = no I2S data
 MAX98357 GAIN ── sets volume (floating ≈ 9 dB; see board silkscreen)
 MAX98357 +/− ─▶ 4–8 Ω speaker
```

### Strobe light (5 V USB via MOSFET)
```
 USB 5V  ───────────────────────────▶ MOSFET VIN+  ─▶ light (+)
 GPIO5   ───────────────────────────▶ MOSFET SIG
 ESP GND ───────────────────────────▶ MOSFET VIN− / GND  (shared ground)
 MOSFET OUT− ─▶ light (−)
 A logic-level MOSFET module low-side-switches the light's 5 V; powered from the
 same USB source as the ESP so ground is common.
```

### Start trigger (wireless — no wiring)
```
 Designate one Shelly BLU button as the starter in the dashboard
 (Settings → re-enroll). The host sends "STARTER\t<mac>" to the ESP, which
 saves it to flash (NVS) and fires the light + beep on that button's press.
```

> Where to buy the **Shelly BLU buttons** and the **ESP32-C5 board** (UK / EU /
> AliExpress, with prices): see [BUYING.md](BUYING.md).

## Bill of materials (UK)
| Part | Purpose | Qty | Link |
|---|---|---|---|
| ESP32-C5-DevKitC-1 v1.2 | gateway (have) | 1 | — |
| MAX98357 I2S 3 W Class-D amp module | start beep (I2S → speaker) | 1 | **ordered** — Amazon B0FKSLXFK6 https://www.amazon.co.uk/dp/B0FKSLXFK6 (3-pack) |
| 4–8 Ω speaker (3 W+) | start beep output | 1 | https://www.amazon.co.uk/s?k=4+ohm+3w+speaker |
| 5 V USB LED strobe / warning light | start flash | 1 | https://www.amazon.co.uk/s?k=5v+usb+strobe+warning+light |
| Logic-level MOSFET trigger module | GPIO5 switches the 5 V light | 1 | https://www.amazon.co.uk/s?k=mosfet+trigger+driver+module |
| USB power source (power bank or charger) | powers ESP + amp + light (all 5 V) | 1 | any 5 V/≥2 A USB-A power bank or charger |
| USB-A → bare-wire / breakout | tap 5 V for the light + amp | 1 | https://www.amazon.co.uk/s?k=usb+a+to+screw+terminal+adapter |
| IP67 enclosure (158×90×60, clear lid) | houses ESP + amp + MOSFET | 1 | https://www.amazon.co.uk/Electronics-Electrical-Electronic-6-1x3-5x2-3Inch-157X88-5X60mm/dp/B0CYZT7T72 |
| Cable glands (PG7/PG9) **or** SP13 2-pin connectors | cable entry (permanent vs unpluggable) | 2–4 | glands https://www.amazon.co.uk/s?k=pg7+pg9+cable+gland+pack · SP13 https://www.amazon.co.uk/s?k=sp13+2+pin+waterproof+connector |
| 2-core cable | light run (≤10 m) | ~10 m | https://www.amazon.co.uk/s?k=2+core+cable |
| Electronics starter kit (breadboard, resistors, jumpers) | prototyping | 1 | https://www.amazon.co.uk/ELEGOO-Electronics-Potentiometer-tie-points-Breadboard/dp/B01LZRV539 |
| Dupont jumper wires | GPIO ↔ MAX98357 / MOSFET | 1 | https://www.amazon.co.uk/Elegoo-120pcs-Multicolored-Breadboard-arduino-colorful/dp/B01EV70C78 |

## Power
Everything is **5 V from one USB source** — a USB-A power bank or a wall charger (≥2 A). The
ESP, the MAX98357 amp, and the (switched) 5 V light all share that supply, so ground is
common automatically. No PD trigger / 12 V / dual-rail bank required anymore.

## Assembly notes / cautions
- **Shared ground is mandatory** — ESP GND, MAX98357 GND, MOSFET GND/VIN−, and the light's
  5 V return must all connect. One USB source for everything makes this automatic.
- **MAX98357 SD pin** must be enabled (board default high / tie to VCC) or you get no sound;
  silence is just the absence of I2S data, so no extra mute logic is needed.
- **Power-bank auto-shutoff:** pick one that won't cut off at low current; the ESP (Wi-Fi+BLE)
  usually draws enough (>100 mA) to keep it awake.
- **Light = single flash** (1.5 s), like real meet start systems — not a continuous strobe.
- **No wired start button** — the start is a Shelly BLU button designated in the dashboard.
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
Each pad is a simple **contact closure to GND** (INPUT_PULLUP, active-LOW): press → input
reads LOW — the same electrical idea as a momentary button.
- **Pin budget:** the safe-GPIO list above can't spare 6 lanes. Add **one MCP23017** (16
  inputs over I²C, internal pull-ups, ~£3): lanes 1–6 → GPA0–GPA5; scales to 16 lanes free.
- **Long wet runs (≤10 m each):** use the expander's pull-ups (or external 4.7 k–10 k), not
  the weak internal ones — long cable = noisy antenna. Add a series 100 Ω + TVS diode at the
  ESP end for ESD/surge protection on cables living on a wet pool deck.

### Firmware: debounce + first-touch latch
Two must-haves: debounce (water/multi-touch chatter) and a **per-lane latch so the *first*
touch wins** and later touches in the same heat are ignored until `resetHeat()`. Emits a
finish as an on-chip-timestamped event, the same path as a button press.
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
v12, flash with `arduino-cli ... --fqbn esp32:esp32:esp32c5:PartitionScheme=huge_app`.
Requires arduino-esp32 core 3.x (uses `ESP_I2S.h`). Designate a starter button in the
dashboard, then test: pressing it should fire the light (GPIO5) + a 2 kHz beep over the
MAX98357 for 1.5 s. You can verify the beep with just the amp + speaker wired, before the
strobe light arrives.
