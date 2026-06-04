/**
 * Button Enrollment Wizard
 * ========================
 * Registers the 7 gala buttons by the ORDER you press them:
 *   1st new button -> Lane 1, 2nd -> Lane 2, ... 6th -> Lane 6, 7th -> Starter.
 *
 * Fully press-driven — no keyboard needed. Just press each button once when
 * prompted. Already-registered buttons are ignored, so a stray double-press of
 * the previous button won't jump the queue. The result is saved to lanes.json,
 * which monitor.ts / the timing server read to label presses.
 *
 * Usage:
 *   npm run enroll
 *   npm run enroll -- /dev/cu.usbserial-XX     # override port
 *
 * Re-run anytime to re-register (e.g. swapped buttons, replaced batteries).
 */

import { Esp32Gateway, PressEvent, DEFAULT_PORT } from "./esp32.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Slot { role: string; label: string }
const SLOTS: Slot[] = [
  { role: "lane1", label: "Lane 1" },
  { role: "lane2", label: "Lane 2" },
  { role: "lane3", label: "Lane 3" },
  { role: "lane4", label: "Lane 4" },
  { role: "lane5", label: "Lane 5" },
  { role: "lane6", label: "Lane 6" },
  { role: "start", label: "Starter" },
];

interface Button { role: string; label: string; mac: string }
interface LaneConfig {
  port: string;
  baud: number;
  enrolledAt: string;
  buttons: Button[];
}

const CONFIG_PATH = fileURLToPath(new URL("./lanes.json", import.meta.url));
const port = process.argv[2] || DEFAULT_PORT;

async function main(): Promise<void> {
  console.log();
  console.log(`╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║  🏊 Button Enrollment — press each button once, in order        ║`);
  console.log(`╠════════════════════════════════════════════════════════════════╣`);
  console.log(`║  Press: Lane 1 → Lane 2 → … → Lane 6 → Starter.                 ║`);
  console.log(`║  Each press is locked in as you go. Ctrl+C to abort.           ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝`);
  console.log();

  const gateway = new Esp32Gateway(port);
  const assigned = new Map<string, string>(); // mac -> label (to ignore repeats)
  const buttons: Button[] = [];

  gateway.on("error", (e) => {
    console.error(`  ❌ Serial error on ${port}: ${e.message}`);
    console.error(`     Is the logger still running, or wrong port? Free the port and retry.`);
    process.exit(1);
  });

  await new Promise<void>((resolve) => {
    let opened = false;
    gateway.on("open", () => { opened = true; });
    gateway.on("ready", (v) => {
      console.log(`  ✅ Gateway ready (${v}) on ${port}\n`);
      resolve();
    });
    // If the board was already running (no fresh boot banner), proceed shortly.
    setTimeout(() => { if (opened) resolve(); }, 2500);
  });

  for (let i = 0; i < SLOTS.length; i++) {
    const slot = SLOTS[i]!;
    process.stdout.write(`  👉 Press the ${slot.label} button …`);
    const mac = await waitForNewButton(gateway, assigned);
    assigned.set(mac, slot.label);
    buttons.push({ role: slot.role, label: slot.label, mac });
    console.log(`  ✓  ${slot.label.padEnd(8)} = ${mac}`);
  }

  const config: LaneConfig = {
    port,
    baud: 115200,
    enrolledAt: new Date().toISOString(),
    buttons,
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  console.log();
  console.log(`  💾 Saved ${buttons.length} buttons → ${CONFIG_PATH}`);
  console.log(`  ▶  Run "npm run monitor" to see labeled presses live.`);
  console.log();
  await gateway.close();
  process.exit(0);
}

/** Resolve with the MAC of the first press from a button not already assigned. */
function waitForNewButton(
  gateway: Esp32Gateway,
  assigned: Map<string, string>
): Promise<string> {
  return new Promise((resolve) => {
    const onPress = (ev: PressEvent) => {
      if (assigned.has(ev.mac)) return; // repeat of an already-registered button
      gateway.off("press", onPress);
      resolve(ev.mac);
    };
    gateway.on("press", onPress);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
