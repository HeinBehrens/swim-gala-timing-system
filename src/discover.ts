/**
 * Shelly BLU Button Discovery & Test
 * ====================================
 * Scans for nearby BLE devices broadcasting BTHome v2 data.
 * Press each Shelly BLU Button and watch the output to find MAC addresses
 * and verify button presses are being detected.
 *
 * Usage:
 *   npm run discover
 *
 * Press Ctrl+C to stop scanning.
 */

// @ts-ignore — noble typings are imprecise for the abandonware fork
import noble from "@abandonware/noble";

// ── BTHome v2 constants ──────────────────────────────────────────────────────

const BTHOME_UUID = "fcd2"; // 16-bit service UUID (noble uses short form)

const PRESS_LABELS: Record<number, string> = {
  1: "SINGLE",
  2: "DOUBLE",
  3: "TRIPLE",
  4: "LONG",
};

// ── State ────────────────────────────────────────────────────────────────────

interface DeviceInfo {
  name: string;
  lastSeen: string;
  rssi: number | null;
  battery: number | null;
  pressCount: number;
}

const devices = new Map<string, DeviceInfo>();

// Dedup: track last seen packet_id per device to avoid logging duplicate advertisements
const lastPacketId = new Map<string, number>();

// ── BTHome v2 parser ─────────────────────────────────────────────────────────

interface BtHomeEntry {
  name: string;
  value: number;
  label?: string;
}

function parseBtHomeV2(payload: Buffer): BtHomeEntry[] {
  if (payload.length === 0) return [];

  // First byte: device info (bit 0 = encryption, bit 2 = trigger-based)
  let idx = 1; // skip device-info byte
  const results: BtHomeEntry[] = [];

  while (idx < payload.length) {
    const objId = payload[idx]!;
    idx++;

    switch (objId) {
      case 0x00: // packet_id — 1 byte
        if (idx < payload.length) {
          results.push({ name: "packet_id", value: payload[idx]! });
          idx += 1;
        }
        break;

      case 0x01: // battery — 1 byte (0-100%)
        if (idx < payload.length) {
          results.push({ name: "battery", value: payload[idx]! });
          idx += 1;
        }
        break;

      case 0x3a: // button event — 1 byte
        if (idx < payload.length) {
          const val = payload[idx]!;
          results.push({
            name: "button",
            value: val,
            label: PRESS_LABELS[val] ?? `UNKNOWN(${val})`,
          });
          idx += 1;
        }
        break;

      default:
        // Unknown object — skip 1 byte and hope for the best
        idx += 1;
        break;
    }
  }

  return results;
}

// ── Timestamp helper ─────────────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

// ── Discovery handler ────────────────────────────────────────────────────────

function onDiscover(peripheral: noble.Peripheral): void {
  const ad = peripheral.advertisement;
  const serviceData = ad.serviceData;

  // Find BTHome v2 service data
  const btHomeEntry = serviceData?.find(
    (sd: { uuid: string; data: Buffer }) => sd.uuid === BTHOME_UUID
  );
  if (!btHomeEntry) return;

  // macOS CoreBluetooth hides real MAC addresses — use peripheral.id (stable per device on this Mac)
  const deviceId = peripheral.id?.toUpperCase() ?? peripheral.address?.toUpperCase();
  const displayAddr = peripheral.address && peripheral.address !== "" 
    ? peripheral.address.toUpperCase() 
    : deviceId;
  const name = ad.localName ?? "Shelly BLU";
  const rssi = peripheral.rssi;
  const rawHex = btHomeEntry.data.toString("hex");
  const objects = parseBtHomeV2(btHomeEntry.data);

  const isNew = !devices.has(deviceId);

  // Upsert device info
  const existing = devices.get(deviceId) ?? {
    name,
    lastSeen: timestamp(),
    rssi,
    battery: null,
    pressCount: 0,
  };
  existing.lastSeen = timestamp();
  existing.rssi = rssi;

  // Extract parsed data
  let buttonEvent: BtHomeEntry | undefined;
  let packetId: number | undefined;

  for (const obj of objects) {
    if (obj.name === "button") buttonEvent = obj;
    if (obj.name === "battery") existing.battery = obj.value;
    if (obj.name === "packet_id") packetId = obj.value;
  }

  devices.set(deviceId, existing);

  // ── Deduplicate by packet_id ──
  // Each button press gets a unique packet_id. The button broadcasts the same
  // advertisement multiple times (typically 5-10x) for reliability. We only
  // want to log once per actual press.
  if (buttonEvent && packetId !== undefined) {
    const prevId = lastPacketId.get(deviceId);
    if (prevId === packetId) {
      return; // duplicate advertisement — skip
    }
    lastPacketId.set(deviceId, packetId);
  }

  // ── Print output ──

  if (buttonEvent) {
    existing.pressCount++;
    console.log();
    console.log(
      `  🔵 ══════════════════════════════════════════════════`
    );
    console.log(`  🔵  BUTTON PRESS DETECTED!`);
    console.log(
      `  🔵 ──────────────────────────────────────────────────`
    );
    console.log(`  🔵  Time:       ${timestamp()}`);
    console.log(`  🔵  Device ID:  ${deviceId}`);
    console.log(`  🔵  Name:       ${name}`);
    console.log(
      `  🔵  Press:      ${buttonEvent.label} (#${existing.pressCount})`
    );
    if (existing.battery !== null) {
      console.log(`  🔵  Battery:    ${existing.battery}%`);
    }
    if (packetId !== undefined) {
      console.log(`  🔵  Packet ID:  ${packetId}`);
    }
    console.log(`  🔵  RSSI:       ${rssi} dBm`);
    console.log(`  🔵  Raw:        ${rawHex}`);
    console.log(
      `  🔵 ══════════════════════════════════════════════════`
    );
    console.log();
  } else if (isNew) {
    console.log(
      `  📡 [${timestamp()}] New BTHome device: ${deviceId} (${name}) RSSI=${rssi}dBm raw=${rawHex}`
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log();
  console.log(`╔═══════════════════════════════════════════════════════╗`);
  console.log(`║  🏊 Shelly BLU Button Discovery & Test               ║`);
  console.log(`╠═══════════════════════════════════════════════════════╣`);
  console.log(`║                                                       ║`);
  console.log(`║  Scanning for BTHome v2 BLE advertisements...         ║`);
  console.log(`║  Press each Shelly BLU Button to see it appear here.  ║`);
  console.log(`║                                                       ║`);
  console.log(`║  Press Ctrl+C to stop.                                ║`);
  console.log(`║                                                       ║`);
  console.log(`╚═══════════════════════════════════════════════════════╝`);
  console.log();

  // Wait for Bluetooth adapter to be ready
  noble.on("stateChange", (state: string) => {
    if (state === "poweredOn") {
      console.log(`  ✅ Bluetooth adapter is powered on`);
      console.log(`  👆 Press your Shelly BLU buttons now...\n`);
      // Scan for all devices, allow duplicates so we see every press
      noble.startScanning([], true);
    } else {
      console.log(`  ⚠️  Bluetooth state: ${state}`);
      if (state === "poweredOff") {
        console.log(`  ❌ Please enable Bluetooth in System Settings`);
      }
      noble.stopScanning();
    }
  });

  noble.on("discover", onDiscover);

  // Periodic status
  const statusInterval = setInterval(() => {
    const totalPresses = [...devices.values()].reduce(
      (sum, d) => sum + d.pressCount,
      0
    );
    if (devices.size > 0) {
      console.log(
        `  ── Status: ${devices.size} BTHome device(s), ${totalPresses} total press(es) ──`
      );
    } else {
      console.log(`  ⏳ Still scanning... no BTHome devices detected yet.`);
      console.log(`     Make sure Bluetooth is on and buttons are nearby.`);
    }
  }, 15_000);

  // Graceful shutdown on Ctrl+C
  const shutdown = () => {
    clearInterval(statusInterval);
    noble.stopScanning();

    console.log(`\n`);
    console.log(`╔═══════════════════════════════════════════════════════╗`);
    console.log(`║  DISCOVERY SUMMARY                                   ║`);
    console.log(`╠═══════════════════════════════════════════════════════╣`);

    if (devices.size === 0) {
      console.log(`║  No BTHome devices were detected.                    ║`);
      console.log(`║  Check Bluetooth is on and buttons are nearby.       ║`);
    } else {
      console.log(`║                                                       ║`);
      for (const [id, info] of [...devices.entries()].sort()) {
        const nameStr = info.name.slice(0, 14).padEnd(14);
        console.log(
          `║  ID: ${id.slice(0, 18).padEnd(18)}  Presses: ${String(info.pressCount).padStart(3)}  ${nameStr} ║`
        );
      }
      console.log(`║                                                       ║`);
      console.log(`║  Copy these Device IDs into src/config.ts             ║`);
    }

    console.log(`╚═══════════════════════════════════════════════════════╝`);
    console.log();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
