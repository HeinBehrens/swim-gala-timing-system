/**
 * BLE Concurrent-Reception Test — Simultaneous Multi-Button Press
 * ===============================================================
 * Press ALL buttons at (roughly) the same time, repeatedly.
 *
 * What this is really testing: when several buttons burst their advertisements
 * at the same instant, can ONE BLE radio receive them all without dropping any?
 * That's the failure mode that matters at a real gala — a whole heat finishing
 * together. So the headline metric here is COMPLETENESS (every round detects
 * all N buttons) and drops under load, NOT the press-time spread (that spread
 * is dominated by your hand and isn't operationally meaningful — in the real
 * system each button is timed against the start, never against each other).
 *
 * Buttons are auto-registered: any device broadcasting a BTHome single-press is
 * tracked, so you don't need to pre-configure MACs. Known ones get nice labels.
 *
 * Usage:
 *   npx tsx src/simultaneous-test.ts            # expects 4 buttons
 *   npx tsx src/simultaneous-test.ts 6          # expects 6
 *
 * Press all buttons together. Repeat 15–20 rounds. Ctrl+C for the summary.
 */

// @ts-ignore — noble typings are imprecise for the abandonware fork
import noble from "@abandonware/noble";

// ── Config ───────────────────────────────────────────────────────────────────

const EXPECTED = Number(process.argv[2]) || 4;
const BTHOME_UUID = "fcd2";
const ROUND_QUIET_MS = 1200; // finalize a round this long after the last NEW button

// Known buttons (nice labels). Unknown ones are auto-labelled by id.
const KNOWN: Record<string, string> = {
  "EE7AF4FD6001D2FCED84FC59EB06D0C4": "Button A (SBBT-002C)",
  "925E84314E5F46DF5EEED475F78B997B": "Button B (SBBT-002C)",
  "FAFD423DEE3995F9094BA2E55C3B54DB": "Button C (Shelly BLU)",
};

function labelFor(id: string): string {
  return KNOWN[id] ?? `Button ${id.slice(0, 8)}…`;
}

// ── BTHome parser (button + packet_id) ───────────────────────────────────────

function parseBtHome(payload: Buffer): { button?: number; packetId?: number } {
  if (payload.length === 0) return {};
  let idx = 1; // skip device-info byte
  let button: number | undefined;
  let packetId: number | undefined;
  while (idx < payload.length) {
    const objId = payload[idx]!;
    idx++;
    if (objId === 0x00 && idx < payload.length) { packetId = payload[idx]!; idx++; }
    else if (objId === 0x01 && idx < payload.length) { idx++; }       // battery
    else if (objId === 0x3a && idx < payload.length) { button = payload[idx]!; idx++; }
    else { idx++; }
  }
  return { button, packetId };
}

// ── State ────────────────────────────────────────────────────────────────────

interface DevicePress {
  firstTs: number;   // press time = first packet of this button's burst
  packetId: number;
  packets: number;
  minRssi: number;
}

let round = 0;
let roundActive = false;
let roundTimer: ReturnType<typeof setTimeout> | null = null;
const roundPresses = new Map<string, DevicePress>();

const allDevices = new Set<string>();
interface RoundResult { detected: number; spread: number; missing: string[] }
const results: RoundResult[] = [];

// ── Round handling ───────────────────────────────────────────────────────────

function finalizeRound(): void {
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null; }
  roundActive = false;
  if (roundPresses.size === 0) return;

  const entries = [...roundPresses.entries()].sort(
    (a, b) => a[1].firstTs - b[1].firstTs
  );
  const firstTs = entries[0]![1].firstTs;
  const spread = entries[entries.length - 1]![1].firstTs - firstTs;
  const detected = roundPresses.size;
  const missing = [...allDevices].filter(id => !roundPresses.has(id)).map(labelFor);

  console.log();
  console.log(`  ── Round ${round} ──  ${detected}/${EXPECTED} detected   spread ${spread.toFixed(1)}ms`);
  for (const [id, p] of entries) {
    const delta = p.firstTs - firstTs;
    const tag = delta === 0 ? "baseline" : `+${delta.toFixed(1)}ms`;
    console.log(
      `     ${labelFor(id).padEnd(26)} ${tag.padStart(10)}  packets=${String(p.packets).padStart(2)}  rssi=${p.minRssi}dBm`
    );
  }
  if (detected < EXPECTED) {
    console.log(`     ⚠️  MISSED: ${missing.length ? missing.join(", ") : `${EXPECTED - detected} button(s)`} — a dropped finish in a real race`);
  } else {
    console.log(`     ✅ all ${EXPECTED} received`);
  }

  results.push({ detected, spread, missing });
  roundPresses.clear();
  console.log(`\n  ⏳ Ready for round ${round + 1} — press all ${EXPECTED} together…`);
}

// ── Discovery handler ────────────────────────────────────────────────────────

function onDiscover(peripheral: noble.Peripheral): void {
  const ad = peripheral.advertisement;
  const entry = ad.serviceData?.find(
    (sd: { uuid: string; data: Buffer }) => sd.uuid === BTHOME_UUID
  );
  if (!entry) return;

  const { button, packetId } = parseBtHome(entry.data);
  if (button !== 1 || packetId === undefined) return; // single-press only

  const id = (peripheral.id ?? peripheral.address ?? "").toUpperCase();
  if (!id) return;
  allDevices.add(id);

  const now = performance.now();
  const existing = roundPresses.get(id);

  if (existing) {
    // Same button again this round.
    if (existing.packetId === packetId) {
      existing.packets++;                                  // extra packet of same burst
      existing.minRssi = Math.min(existing.minRssi, peripheral.rssi);
    }
    // (different packetId = a second press this round; ignore, keep the first)
    return;
  }

  // New button in this round.
  if (!roundActive) {
    roundActive = true;
    round++;
    console.log(`\n  🏁 Round ${round} — detecting…`);
  }
  roundPresses.set(id, {
    firstTs: now,
    packetId,
    packets: 1,
    minRssi: peripheral.rssi,
  });
  console.log(`     ✓ ${labelFor(id)}`);

  // Reset quiet timer; finalize early if we already have everyone.
  if (roundTimer) clearTimeout(roundTimer);
  if (roundPresses.size >= EXPECTED) {
    finalizeRound();
  } else {
    roundTimer = setTimeout(finalizeRound, ROUND_QUIET_MS);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

function printSummary(): void {
  console.log();
  console.log(`  ═══════════════════════════════════════════════════════════════`);
  console.log(`  FINAL SUMMARY — ${results.length} round(s), expecting ${EXPECTED} buttons each`);
  console.log(`  ═══════════════════════════════════════════════════════════════`);

  if (results.length === 0) {
    console.log(`  No rounds recorded.`);
    console.log();
    return;
  }

  const complete = results.filter(r => r.detected === EXPECTED).length;
  const completeness = (complete / results.length) * 100;
  const spreads = results.filter(r => r.detected >= 2).map(r => r.spread);
  const avgS = spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : NaN;
  const maxS = spreads.length ? Math.max(...spreads) : NaN;
  const totalMissed = results.reduce((a, r) => a + (EXPECTED - r.detected), 0);

  const f = (n: number) => (Number.isNaN(n) ? "—" : n.toFixed(1));
  console.log(`  Buttons seen overall : ${allDevices.size}`);
  console.log(`  COMPLETE rounds      : ${complete}/${results.length}  (${completeness.toFixed(0)}%)  ← the number that matters`);
  console.log(`  Total missed presses : ${totalMissed}  (dropped under concurrent load)`);
  console.log(`  Press spread (ms)    : avg ${f(avgS)}  max ${f(maxS)}  (mostly your hand — informational)`);
  console.log();
  console.log(`  Read it like this:`);
  console.log(`    • Completeness must be ~100%. Anything less means the radio drops`);
  console.log(`      finishes when a heat touches together — the worst failure mode.`);
  console.log(`    • If completeness is low, we add a 2nd BLE adapter / move the hub`);
  console.log(`      closer / use a Pi before building further.`);
  console.log(`    • Spread is expected to be tens of ms (hand sync) and is harmless.`);
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log();
  console.log(`╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║  🏊 BLE Concurrent-Reception Test — Simultaneous Press        ║`);
  console.log(`╠════════════════════════════════════════════════════════════════╣`);
  console.log(`║                                                                ║`);
  console.log(`║  Press ALL ${String(EXPECTED).padEnd(2)} buttons together, each round.                  ║`);
  console.log(`║  Repeat 15–20 rounds. Ctrl+C for the summary.                  ║`);
  console.log(`║                                                                ║`);
  console.log(`║  Headline metric = COMPLETENESS (all buttons received every     ║`);
  console.log(`║  round). Buttons auto-register, so the 4th just works.          ║`);
  console.log(`║                                                                ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝`);
  console.log();

  noble.on("stateChange", (state: string) => {
    if (state === "poweredOn") {
      console.log(`  ✅ Bluetooth ready — press all ${EXPECTED} together.\n`);
      noble.startScanning([], true); // allowDuplicates required
    } else {
      console.log(`  ⚠️  Bluetooth state: ${state}`);
      noble.stopScanning();
    }
  });

  noble.on("discover", onDiscover);

  const shutdown = () => {
    noble.stopScanning();
    if (roundPresses.size > 0) finalizeRound();
    printSummary();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
