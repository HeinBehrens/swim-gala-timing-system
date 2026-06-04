/**
 * Live Labeled Monitor
 * ====================
 * Reads lanes.json (from `npm run enroll`) and prints each button press with its
 * lane label and a race clock. The clock zeroes on the Starter press, then every
 * lane finish is shown as an elapsed time from the start — using the ESP32's
 * on-chip microsecond timestamps, so it reflects the real press instants, not
 * when the host happened to read the serial line.
 *
 * Usage:
 *   npm run monitor
 *   npm run monitor -- /dev/cu.usbserial-XX
 *
 * This is a thin demonstration of the capture pipeline; the full timing server
 * (src/server.ts) will build on the same esp32.ts + lanes.json foundation.
 */

import { Esp32Gateway, PressEvent } from "./esp32.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Button { role: string; label: string; mac: string }
interface LaneConfig { port: string; baud: number; enrolledAt: string; buttons: Button[] }

const CONFIG_PATH = fileURLToPath(new URL("./lanes.json", import.meta.url));

function loadConfig(): LaneConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as LaneConfig;
  } catch {
    console.error(`  ❌ No lanes.json found. Run "npm run enroll" first.`);
    process.exit(1);
  }
}

function main(): void {
  const cfg = loadConfig();
  const port = process.argv[2] || cfg.port;
  const byMac = new Map(cfg.buttons.map((b) => [b.mac, b]));
  const startMac = cfg.buttons.find((b) => b.role === "start")?.mac;

  console.log();
  console.log(`  🏊 Live monitor — ${cfg.buttons.length} buttons on ${port}`);
  console.log(`  Press the Starter to zero the clock; lane presses show as elapsed.\n`);

  let startMicros: number | null = null;
  const gateway = new Esp32Gateway(port);

  gateway.on("error", (e) => { console.error(`  ❌ Serial error: ${e.message}`); process.exit(1); });
  gateway.on("ready", (v) => console.log(`  ✅ Gateway ready (${v})\n`));

  gateway.on("press", (ev: PressEvent) => {
    const btn = byMac.get(ev.mac);
    const label = btn ? btn.label : `UNKNOWN ${ev.mac}`;

    if (btn && btn.role === "start") {
      startMicros = ev.espMicros;
      console.log(`\n  🔫 ${label} — clock ZEROED  (rssi ${ev.rssi}dBm)\n`);
      return;
    }

    let clock = "";
    if (startMicros !== null) {
      const secs = (ev.espMicros - startMicros) / 1e6;
      clock = secs >= 0 ? `  ⏱  ${secs.toFixed(3)}s` : `  ⏱  (before start)`;
    }
    const tag = btn ? "🏁" : "❓";
    console.log(`  ${tag} ${label.padEnd(8)} ${ev.press.padEnd(7)}${clock}   rssi ${ev.rssi}dBm`);
  });
}

main();
