/**
 * BLE Metronome Sync Test — Cue-to-Reception Latency
 * ===================================================
 * A ◆ marker sweeps left→right toward a ┃ target on a STEADY, repeating beat.
 * You press a button right as the marker lands on the target — on whichever
 * beat you're ready for. The program records every beat time and reports how
 * far your press landed from the nearest beat.
 *
 * Why a repeating metronome (not a one-shot "3..2..1.. PRESS"):
 *   • A steady rhythm is anticipatable — you sync your press to the landing
 *     instead of reacting to a sudden cue, which strips most human reaction
 *     time out of the number.
 *   • You can't "miss your one chance" — just press on any beat when ready.
 *
 * What the offset means:
 *   offset = (your sync error)  +  (BLE air/stack latency)
 * A consistent small offset across presses = a clean, low-latency path. An
 * offset hundreds of ms larger than your usual on some press = the radio/stack
 * lagging that press — the thing that would corrupt a recorded race time.
 *
 * Usage:
 *   npx tsx src/countdown-test.ts          # 1 press (default)
 *   npx tsx src/countdown-test.ts 8        # 8 presses, one per beat you choose
 *
 * Ctrl+C any time for the summary so far.
 */

// @ts-ignore — noble typings are imprecise for the abandonware fork
import noble from "@abandonware/noble";

// ── Config ───────────────────────────────────────────────────────────────────

const PRESSES = Number(process.argv[2]) || 1; // how many presses to time
const BTHOME_UUID = "fcd2";

const WIDTH = 20;       // marker travel cells
const STEP_MS = 150;    // time per cell → sweep ≈ (WIDTH+1)*STEP_MS
const CYCLE_MS = (WIDTH + 1) * STEP_MS; // one full sweep / beat period

// Known buttons get nice labels; unknown ones are auto-labelled by id.
const KNOWN: Record<string, string> = {
  "EE7AF4FD6001D2FCED84FC59EB06D0C4": "Button A (SBBT-002C)",
  "925E84314E5F46DF5EEED475F78B997B": "Button B (SBBT-002C)",
  "FAFD423DEE3995F9094BA2E55C3B54DB": "Button C (Shelly BLU)",
};
const labelFor = (id: string) => KNOWN[id] ?? `Button ${id.slice(0, 8)}…`;

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

// ── Press plumbing ───────────────────────────────────────────────────────────

interface Press { id: string; ts: number; rssi: number; }

let pending: Press | null = null;                 // a press waiting to be consumed
const lastPacketId = new Map<string, number>();   // dedup repeated burst packets

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
  if (lastPacketId.get(id) === packetId) return; // repeat packet of same press
  lastPacketId.set(id, packetId);

  pending = { id, ts: performance.now(), rssi: peripheral.rssi }; // ts = reception
}

// ── Timing helpers ───────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Results ──────────────────────────────────────────────────────────────────

interface Result { n: number; label: string; offset: number; rssi: number; }
const results: Result[] = [];

// Signed offset (ms) of a press relative to the nearest beat: negative = pressed
// before the beat (anticipated early), positive = after.
function nearestOffset(pressTs: number, beats: number[]): number {
  let best = Infinity;
  const candidates = beats.length ? [...beats, beats[beats.length - 1]! + CYCLE_MS] : [];
  for (const b of candidates) {
    if (Math.abs(pressTs - b) < Math.abs(best)) best = pressTs - b;
  }
  return best;
}

// ── Summary ──────────────────────────────────────────────────────────────────

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function stdev(a: number[]): number {
  if (a.length < 2) return NaN;
  const m = avg(a);
  return Math.sqrt(avg(a.map((x) => (x - m) ** 2)));
}

function printSummary(): void {
  console.log();
  console.log(`  ═══════════════════════════════════════════════════════════════`);
  console.log(`  SUMMARY — ${results.length} timed press(es)`);
  console.log(`  ═══════════════════════════════════════════════════════════════`);
  if (!results.length) {
    console.log(`  No presses recorded.`);
    console.log();
    return;
  }
  const f = (n: number) => (Number.isNaN(n) ? "—" : (n >= 0 ? "+" : "") + n.toFixed(1));
  console.log(`  offset from beat (ms):  (− = pressed early, + = late)`);
  for (const r of results) {
    console.log(`     press #${String(r.n).padStart(2)}  ${r.label.padEnd(26)} ${f(r.offset).padStart(8)}ms   rssi=${r.rssi}dBm`);
  }
  if (results.length > 1) {
    const offs = results.map((r) => r.offset);
    console.log();
    console.log(`     mean ${f(avg(offs))}ms   jitter (±1σ) ${stdev(offs).toFixed(1)}ms`);
  }
  console.log();
  console.log(`  How to read this:`);
  console.log(`    • A consistent offset (small jitter) = a clean, low-latency path —`);
  console.log(`      the steady bias is your sync habit + fixed BLE latency.`);
  console.log(`    • One press far off your usual offset = the radio/stack lagging that`);
  console.log(`      press. That spike is what corrupts a recorded time.`);
  console.log(`    • (macOS adds its own scheduling jitter — a Pi/BlueZ host does better.)`);
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log();
  console.log(`╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║  🏊 BLE Metronome Sync Test — Cue-to-Reception Latency         ║`);
  console.log(`╠════════════════════════════════════════════════════════════════╣`);
  console.log(`║                                                                ║`);
  console.log(`║  A ◆ sweeps to the ┃ target on a steady beat, over and over.    ║`);
  console.log(`║  Press a button right as it lands — on any beat you're ready.   ║`);
  console.log(`║  ${String(PRESSES).padStart(2)} press(es) to time. Ctrl+C for the summary.               ║`);
  console.log(`║                                                                ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝`);

  await new Promise<void>((resolve) => {
    noble.on("stateChange", (state: string) => {
      if (state === "poweredOn") {
        console.log(`\n  ✅ Bluetooth ready — the beat starts now.\n`);
        noble.startScanning([], true); // allowDuplicates required
        resolve();
      } else {
        console.log(`  ⚠️  Bluetooth state: ${state}`);
        noble.stopScanning();
      }
    });
  });

  noble.on("discover", onDiscover);

  const shutdown = () => { noble.stopScanning(); printSummary(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Repeating metronome sweep. Each landing on the target is a beat.
  const beats: number[] = [];
  pending = null; // ignore anything stamped before the beat begins

  while (results.length < PRESSES) {
    for (let i = 0; i <= WIDTH; i++) {
      const onTarget = i === WIDTH;
      const track = "·".repeat(i) + "◆" + "·".repeat(WIDTH - i);
      console.log(`  ${track}┃${onTarget ? "  ⬅ NOW" : ""}`);
      if (onTarget) beats.push(performance.now());

      // Consume a press if one arrived during this frame.
      if (pending) {
        const p = pending;
        pending = null;
        const offset = nearestOffset(p.ts, beats);
        results.push({ n: results.length + 1, label: labelFor(p.id), offset, rssi: p.rssi });
        const sign = offset >= 0 ? "+" : "";
        console.log(
          `\n  ✅ ${labelFor(p.id)} — ${sign}${offset.toFixed(1)}ms from the beat ` +
          `(${offset >= 0 ? "just after" : "just before"})   rssi=${p.rssi}dBm\n`
        );
        if (results.length >= PRESSES) break;
      }

      await sleep(STEP_MS);
    }
  }

  noble.stopScanning();
  printSummary();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
