/**
 * BLE Timing-Quality Test — Single-Button Characterization
 * =========================================================
 * What this measures (the things that actually predict timing accuracy):
 *
 *   1. Burst redundancy  — packets received per press. The Shelly BLU fires a
 *      short burst of identical advertisements per press (all sharing one
 *      packet_id). More packets = more chance we catch the first one.
 *   2. Burst width       — time from the first to the last packet of a press.
 *      This is the timestamp uncertainty: if we only ever caught the *first*
 *      packet, error is ~0; if we sometimes catch a later one, this is the
 *      jitter that becomes a timing error.
 *   3. Drop proxy        — gaps in the per-device packet_id counter. packet_id
 *      increments per event; a missing value means an event we never received.
 *      (Caveat: battery/other broadcasts can also bump the counter, so treat
 *      this as an upper bound on dropped presses, not an exact figure.)
 *   4. RSSI              — to correlate drops/jitter with signal strength.
 *
 * Why not "press all buttons at once and measure the spread"? That spread is
 * dominated by your hand (you can't press 3 buttons within a few ms), and in
 * the real system lanes are never compared to each other — each button is
 * timed against the start. What matters is each button's *own* latency
 * variance, which is what burst width + redundancy capture.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT — this test does NOT reflect production timing accuracy.
 *
 * In the real system ALL timing happens ON THE ESP32, never on this host. The
 * firmware stamps every press with the on-chip microsecond clock
 * (`esp_timer_get_time()`) inside the BLE receive callback, and the external
 * START is captured in a hardware ISR at the falling edge — both readings come
 * from the SAME monotonic ESP clock. A race time is therefore just
 * `finish_µs − start_µs`, a difference of two ESP timestamps. The host (this
 * Node process) only does bookkeeping: matching presses to the start and
 * subtracting. See firmware esp32_shelly_scanner.ino (v11), onResult()/onStartIsr().
 *
 * Why that beats timing on macOS (what this script does):
 *   • CoreBluetooth coalesces scan callbacks and exposes no hardware RX
 *     timestamp, so a host stamp is taken whenever Node happens to be scheduled
 *     — tens of ms of variable OS/event-loop/USB-serial jitter per event.
 *   • That jitter is INDEPENDENT per event, so it does NOT cancel between start
 *     and finish — it lands directly in the result.
 *   • On the ESP32 the stamp is taken microseconds after the radio/edge event on
 *     a bare-metal MCU with no OS scheduler, and because start and finish use one
 *     clock, ANY downstream USB/host latency cancels exactly (a 200 ms-late
 *     serial line still yields the correct elapsed time).
 *
 * So the burst-width / jitter numbers below are a PESSIMISTIC, host-side proxy
 * for radio reliability (drops, redundancy) — useful for choosing buttons and
 * placement — but they are not the timing error the swimmers actually get.
 *
 * Usage:
 *   npx tsx src/latency-test.ts
 *
 * Press ONE button at a time, ~1s apart. Do 20–30 presses per button.
 * Ctrl+C for the summary.
 */

// @ts-ignore — noble typings are imprecise for the abandonware fork
import noble from "@abandonware/noble";

// ── Known buttons from discovery ─────────────────────────────────────────────

const BUTTONS: Record<string, string> = {
  "EE7AF4FD6001D2FCED84FC59EB06D0C4": "Button A (SBBT-002C)",
  "925E84314E5F46DF5EEED475F78B997B": "Button B (SBBT-002C)",
  "FAFD423DEE3995F9094BA2E55C3B54DB": "Button C (Shelly BLU)",
};

const BTHOME_UUID = "fcd2";

// Quiet gap (ms) after the last packet of a press before we consider the
// burst finished and print/record it.
const BURST_FINALIZE_MS = 600;

// ── BTHome parser (button + packet_id) ───────────────────────────────────────

function parseBtHome(payload: Buffer): { button?: number; packetId?: number } {
  if (payload.length === 0) return {};
  let idx = 1; // skip device-info byte
  let button: number | undefined;
  let packetId: number | undefined;

  while (idx < payload.length) {
    const objId = payload[idx]!;
    idx++;
    if (objId === 0x00 && idx < payload.length) {
      packetId = payload[idx]!;
      idx++;
    } else if (objId === 0x01 && idx < payload.length) {
      idx++; // skip battery value
    } else if (objId === 0x3a && idx < payload.length) {
      button = payload[idx]!;
      idx++;
    } else {
      idx++; // unknown object id — best-effort skip 1 byte
    }
  }
  return { button, packetId };
}

// ── State ────────────────────────────────────────────────────────────────────

interface Burst {
  deviceId: string;
  packetId: number;
  firstTs: number;       // performance.now() of first packet (the "press time")
  lastTs: number;        // performance.now() of last packet
  count: number;         // packets received in this burst
  minRssi: number;
  maxRssi: number;
  timer: ReturnType<typeof setTimeout>;
}

interface DeviceStats {
  presses: number;
  packetCounts: number[];   // packets per press
  burstWidths: number[];    // first→last ms per press
  rssis: number[];          // min RSSI per press
  seqGaps: number;          // sum of packet_id gaps (drop proxy)
  lastNewPacketId: number | null;
}

// active bursts keyed by deviceId (only one in-flight burst per device at a time)
const activeBurst = new Map<string, Burst>();
const stats = new Map<string, DeviceStats>();

for (const id of Object.keys(BUTTONS)) {
  stats.set(id, {
    presses: 0,
    packetCounts: [],
    burstWidths: [],
    rssis: [],
    seqGaps: 0,
    lastNewPacketId: null,
  });
}

// ── Finalize a press ─────────────────────────────────────────────────────────

function finalizeBurst(deviceId: string): void {
  const b = activeBurst.get(deviceId);
  if (!b) return;
  activeBurst.delete(deviceId);

  const s = stats.get(deviceId)!;
  const width = b.lastTs - b.firstTs;
  s.presses++;
  s.packetCounts.push(b.count);
  s.burstWidths.push(width);
  s.rssis.push(b.minRssi);

  const label = BUTTONS[deviceId]!;
  console.log(
    `  ✓ ${label.padEnd(26)} press #${String(s.presses).padStart(2)}  ` +
    `packets=${String(b.count).padStart(2)}  width=${width.toFixed(1).padStart(6)}ms  ` +
    `rssi=${b.minRssi}…${b.maxRssi}dBm  pid=${b.packetId}`
  );
}

// ── Discovery handler ────────────────────────────────────────────────────────

function onDiscover(peripheral: noble.Peripheral): void {
  const ad = peripheral.advertisement;
  const btHomeEntry = ad.serviceData?.find(
    (sd: { uuid: string; data: Buffer }) => sd.uuid === BTHOME_UUID
  );
  if (!btHomeEntry) return;

  const deviceId = (peripheral.id ?? peripheral.address ?? "").toUpperCase();
  if (!BUTTONS[deviceId]) return; // not one of our buttons

  const { button, packetId } = parseBtHome(btHomeEntry.data);
  if (packetId === undefined) return;
  if (button !== 1) return; // single-press events only

  const now = performance.now();
  const rssi = peripheral.rssi;
  const existing = activeBurst.get(deviceId);

  if (existing && existing.packetId === packetId) {
    // Same press — another packet of the burst. Extend it.
    existing.lastTs = now;
    existing.count++;
    existing.minRssi = Math.min(existing.minRssi, rssi);
    existing.maxRssi = Math.max(existing.maxRssi, rssi);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => finalizeBurst(deviceId), BURST_FINALIZE_MS);
    return;
  }

  // A new press (new packet_id). Finalize any in-flight burst first.
  if (existing) {
    clearTimeout(existing.timer);
    finalizeBurst(deviceId);
  }

  // Drop proxy: count gaps in the packet_id sequence (wraps at 256).
  const s = stats.get(deviceId)!;
  if (s.lastNewPacketId !== null) {
    const gap = (packetId - s.lastNewPacketId - 1 + 256) % 256;
    // Ignore implausibly large gaps (likely a long idle period / wrap noise).
    if (gap > 0 && gap < 20) s.seqGaps += gap;
  }
  s.lastNewPacketId = packetId;

  const b: Burst = {
    deviceId,
    packetId,
    firstTs: now,
    lastTs: now,
    count: 1,
    minRssi: rssi,
    maxRssi: rssi,
    timer: setTimeout(() => finalizeBurst(deviceId), BURST_FINALIZE_MS),
  };
  activeBurst.set(deviceId, b);
}

// ── Summary ──────────────────────────────────────────────────────────────────

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function printSummary(): void {
  console.log();
  console.log(`  ═══════════════════════════════════════════════════════════════`);
  console.log(`  FINAL SUMMARY`);
  console.log(`  ═══════════════════════════════════════════════════════════════`);

  for (const [id, label] of Object.entries(BUTTONS)) {
    const s = stats.get(id)!;
    console.log();
    console.log(`  ${label}`);
    if (s.presses === 0) {
      console.log(`    (no presses detected)`);
      continue;
    }
    const f = (n: number) => (Number.isNaN(n) ? "—" : n.toFixed(1));
    console.log(`    presses detected   : ${s.presses}`);
    console.log(`    packets / press    : avg ${f(avg(s.packetCounts))}  min ${Math.min(...s.packetCounts)}  max ${Math.max(...s.packetCounts)}`);
    console.log(`    burst width (ms)   : avg ${f(avg(s.burstWidths))}  p50 ${f(pct(s.burstWidths, 50))}  p95 ${f(pct(s.burstWidths, 95))}  max ${f(Math.max(...s.burstWidths))}`);
    console.log(`    single-packet press: ${s.packetCounts.filter(c => c === 1).length} of ${s.presses}  (risky — no redundancy)`);
    console.log(`    seq gaps (drop≈)   : ${s.seqGaps}  (upper bound on missed events)`);
    console.log(`    RSSI (min/press)   : avg ${f(avg(s.rssis))}dBm  worst ${Math.min(...s.rssis)}dBm`);
  }

  console.log();
  console.log(`  How to read this:`);
  console.log(`    • burst width p95 ≈ your worst-case timestamp jitter per press.`);
  console.log(`      If we always catch the first packet it trends toward 0; large`);
  console.log(`      values mean the first packet is sometimes missed.`);
  console.log(`    • single-packet presses are the dangerous ones — one dropped`);
  console.log(`      radio packet there = a completely missed finish.`);
  console.log(`    • seq gaps > 0 means advertisements were lost in the air.`);
  console.log(`    • (macOS adds its own jitter — a Pi/BlueZ host will look better.)`);
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log();
  console.log(`╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║  🏊 BLE Timing-Quality Test — Single-Button Characterization   ║`);
  console.log(`╠════════════════════════════════════════════════════════════════╣`);
  console.log(`║                                                                ║`);
  console.log(`║  Press ONE button at a time, ~1 second apart.                  ║`);
  console.log(`║  Aim for 20–30 presses per button for stable percentiles.      ║`);
  console.log(`║  Ctrl+C for the summary.                                       ║`);
  console.log(`║                                                                ║`);
  console.log(`║  Known buttons:                                                ║`);
  for (const [id, label] of Object.entries(BUTTONS)) {
    console.log(`║    • ${label.padEnd(28)} ${id.slice(0, 16)}… ║`);
  }
  console.log(`║                                                                ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝`);
  console.log();

  noble.on("stateChange", (state: string) => {
    if (state === "poweredOn") {
      console.log(`  ✅ Bluetooth ready — start pressing.\n`);
      noble.startScanning([], true); // allowDuplicates = true (required)
    } else {
      console.log(`  ⚠️  Bluetooth state: ${state}`);
      noble.stopScanning();
    }
  });

  noble.on("discover", onDiscover);

  const shutdown = () => {
    noble.stopScanning();
    // Flush any in-flight bursts.
    for (const id of [...activeBurst.keys()]) {
      const b = activeBurst.get(id);
      if (b) clearTimeout(b.timer);
      finalizeBurst(id);
    }
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
