# Where to Buy — Core Parts

Purchasing guide for the two parts the timing system can't run without: the
**Shelly BLU Button1 Tough** lane buttons and the **ESP32-C5 gateway board**. For
the rest of the start-signal kit (beacon, megaphone, power bank, enclosure) and
the DIY finish touchpads, see [HARDWARE.md](HARDWARE.md). Prices are indicative
(incl. VAT where shown) and move around — check the seller for the live figure.

## 1. Lane buttons — Shelly BLU Button1 Tough (SBBT-002C)

The waterproof/shockproof BLE button each swimmer/timekeeper presses. The firmware
reads its BTHome v2 broadcasts and timestamps them on-chip.

- **Model:** `SBBT-002C` (the **Tough** variant — IP-rated, not the indoor BLU Button1).
- **Battery:** CR2032, ~2-year life. Buy a few spares.
- **Quantity:** **7** — 6 for the lanes + **1 for the start**. There is no wired
  start button: one button is designated the starter in the dashboard, and its
  press both starts the clock and fires the light + beep. See [HARDWARE.md](HARDWARE.md).
- **Colours:** Black, Ivory, Mocha (model suffix `-B` / `-I` / `-M`). Cosmetic only.

| Seller | Region | ~Price each | Link |
|---|---|---|---|
| **Shelly Store UK** (official UK reseller) | UK | ~£15–18 | https://shellystore.co.uk/product/shelly-blu-button1-tough-black/ |
| Shelly Europe (manufacturer) | EU | ~€16.90 | https://www.shelly.com/products/shelly-blu-button-tough-1-black |
| **AliExpress — Shelly official store** | intl | ~£10–13 | https://www.aliexpress.com/w/wholesale-shelly-blu-button-tough.html |
| JDK Benelux | EU | ~€16 | https://shop.jdkbenelux.com/en/Shelly-BLU-Button-Tough-1/SBBT-002C-I |
| Shelly USA | US | ~$20 | https://us.shelly.com/products/shelly-blu-button-tough-1-black |
| Amazon UK (search "Shelly BLU Button Tough") | UK | varies | https://www.amazon.co.uk/s?k=shelly+blu+button+tough |

> Buy the **Tough** (`SBBT-002C`), not the standard indoor BLU Button1 — only the
> Tough is rated for the wet poolside environment.
>
> **Cheapest:** the **Shelly official store on AliExpress** typically undercuts the
> EU/UK shops (~£10–13 each) — just confirm the listing is the *Tough* `SBBT-002C`
> and ships from the official Shelly store. Order early; AliExpress shipping to the
> UK can take 1–3 weeks.
>
> **Knowledge base / pairing:** https://kb.shelly.cloud/knowledge-base/shelly-blu-button-tough-1

**Rough button spend:** 7 × ~£16 ≈ **£112** (6 lanes + 1 start), plus a pack of CR2032s.

## 2. Gateway board — ESP32-C5-DevKitC-1

The board running the gateway firmware (`firmware/esp32_shelly_scanner/`, v13): BLE
observer + Wi-Fi/USB streaming + the GPIO start/beacon/beep. Get the **C5 DevKitC-1**;
the firmware FQBN and pin map target this board specifically.

- **Recommended variant:** `ESP32-C5-DevKitC-1-N8R4` (8 MB flash, 4 MB PSRAM).
  `N8R8` (8 MB PSRAM) also works.
- **Why C5:** dual-band Wi-Fi (2.4 + 5 GHz) plus BLE; the firmware/pin map and the
  `huge_app` partition scheme are set up for it. *(The system itself only uses a
  2.4 GHz SSID — see [[gateway-wifi-flashing]] — but the build targets the C5.)*

| Seller | Region | ~Price | Link |
|---|---|---|---|
| **DigiKey UK** | UK | ~£12–18 | https://www.digikey.co.uk/en/products/detail/espressif-systems/ESP32-C5-DEVKITC-1-N8R4/26658349 |
| Mouser | UK/intl | ~£12–18 | https://www.mouser.com/ProductDetail/Espressif-Systems/ESP32-C5-DevKitC-1-N8R4?qs=sqEgtWRSLJ2%2Fdhsv380LjQ%3D%3D |
| DigiKey (N8R8 PSRAM variant) | intl | ~£15–20 | https://www.digikey.com/en/products/detail/espressif-systems/ESP32-C5-DEVKITC-1-N8R8/28718162 |
| AliExpress — **Espressif official store** | intl | ~£10–14 | https://www.aliexpress.com/w/wholesale-ESP32%2DC5%2DDevKitC%2D1.html |
| Espressif DevKits hub (find a distributor) | intl | — | https://www.espressif.com/en/products/devkits |

> Availability of the C5 fluctuates and some distributor SKUs show as obsolete —
> if DigiKey/Mouser are out, the **Espressif official store on AliExpress** is the
> most reliable stock. Buy a **spare board** — it's the single point of failure on
> meet day, and a cold spare you can swap in seconds is cheap insurance.

**Rough gateway spend:** ~**£15** per board (buy 2 → ~£30).

## Quick shopping list (minimum to run)

| Item | Qty | ~Total |
|---|---|---|
| Shelly BLU Button1 Tough (SBBT-002C) | 7 (6 lanes + start) | £112 |
| CR2032 batteries (spares) | pack | £4 |
| ESP32-C5-DevKitC-1 (+ 1 spare) | 2 | £30 |
| MAX98357 I2S amp + 4–8 Ω speaker | 1 | £8 |
| 5 V USB strobe light + MOSFET module | 1 | £10 |
| USB-C cable for the ESP | 1 | £4 |
| **Core electronics subtotal** | | **~£168** |

Add the start-signal kit and (optional) DIY finish touchpads from
[HARDWARE.md](HARDWARE.md) to complete the build.
