#!/usr/bin/env python3
"""
Shelly BLU Button Discovery & Test Script
==========================================
Scans for nearby BLE devices broadcasting BTHome v2 data.
Press each Shelly BLU Button and watch the output to find MAC addresses
and verify button presses are being detected.

Usage:
    python3 discover_buttons.py

Press Ctrl+C to stop scanning.
"""

import asyncio
import sys
import time
from datetime import datetime

# BTHome v2 service UUID (16-bit 0xFCD2 as 128-bit)
BTHOME_UUID = "0000fcd2-0000-1000-8000-00805f9b34fb"

# Track seen devices to highlight NEW presses
seen_devices: dict[str, dict] = {}
press_count: dict[str, int] = {}


def parse_bthome_v2(payload: bytes) -> list[dict]:
    """Parse BTHome v2 service data payload."""
    if not payload:
        return []

    device_info = payload[0]
    encrypted = bool(device_info & 0x01)
    trigger_based = bool(device_info & 0x04)

    idx = 1
    results = []

    while idx < len(payload):
        obj_id = payload[idx]
        idx += 1

        if obj_id == 0x00:  # packet_id
            if idx < len(payload):
                results.append({"name": "packet_id", "value": payload[idx]})
                idx += 1
        elif obj_id == 0x01:  # battery
            if idx < len(payload):
                results.append({"name": "battery", "value": payload[idx]})
                idx += 1
        elif obj_id == 0x3A:  # button event
            if idx < len(payload):
                press_types = {1: "SINGLE", 2: "DOUBLE", 3: "TRIPLE", 4: "LONG"}
                val = payload[idx]
                results.append({
                    "name": "button",
                    "value": val,
                    "label": press_types.get(val, f"UNKNOWN({val})")
                })
                idx += 1
        elif obj_id == 0x02:  # temperature (2 bytes, sint16, factor 0.01)
            if idx + 1 < len(payload):
                val = int.from_bytes(payload[idx:idx+2], 'little', signed=True) * 0.01
                results.append({"name": "temperature", "value": round(val, 2)})
                idx += 2
        elif obj_id == 0x45:  # signal strength (1 byte)
            if idx < len(payload):
                results.append({"name": "signal_strength", "value": payload[idx]})
                idx += 1
        else:
            # Unknown object — try to skip 1 byte
            idx += 1

    return results


def detection_callback(device, advertisement_data):
    """Called for every BLE advertisement detected."""
    sd = advertisement_data.service_data or {}
    payload = sd.get(BTHOME_UUID)

    if payload is None:
        return

    mac = device.address.upper()
    name = device.name or advertisement_data.local_name or "Unknown"
    rssi = advertisement_data.rssi if hasattr(advertisement_data, 'rssi') else None
    raw_hex = payload.hex()
    objects = parse_bthome_v2(payload)

    now = datetime.now().strftime("%H:%M:%S.%f")[:-3]

    # Track device
    is_new = mac not in seen_devices
    seen_devices[mac] = {"name": name, "last_seen": now, "rssi": rssi}

    # Check for button events
    button_event = None
    battery = None
    packet_id = None

    for obj in objects:
        if obj["name"] == "button":
            button_event = obj
        elif obj["name"] == "battery":
            battery = obj["value"]
        elif obj["name"] == "packet_id":
            packet_id = obj["value"]

    if button_event:
        press_count[mac] = press_count.get(mac, 0) + 1
        count = press_count[mac]

        print()
        print(f"  🔵 ══════════════════════════════════════════════════")
        print(f"  🔵  BUTTON PRESS DETECTED!")
        print(f"  🔵 ──────────────────────────────────────────────────")
        print(f"  🔵  Time:       {now}")
        print(f"  🔵  MAC:        {mac}")
        print(f"  🔵  Name:       {name}")
        print(f"  🔵  Press:      {button_event['label']} (#{count})")
        if battery is not None:
            print(f"  🔵  Battery:    {battery}%")
        if packet_id is not None:
            print(f"  🔵  Packet ID:  {packet_id}")
        if rssi is not None:
            print(f"  🔵  RSSI:       {rssi} dBm")
        print(f"  🔵  Raw:        {raw_hex}")
        print(f"  🔵 ══════════════════════════════════════════════════")
        print()
    elif is_new:
        # First time seeing this BTHome device (might be a beacon/advertisement)
        print(f"  📡 [{now}] New BTHome device: {mac} ({name}) RSSI={rssi}dBm raw={raw_hex}")


async def main():
    try:
        from bleak import BleakScanner
    except ImportError:
        print("ERROR: bleak not installed. Run: pip3 install bleak")
        sys.exit(1)

    print()
    print("╔═══════════════════════════════════════════════════════╗")
    print("║  🏊 Shelly BLU Button Discovery & Test               ║")
    print("╠═══════════════════════════════════════════════════════╣")
    print("║                                                       ║")
    print("║  Scanning for BTHome v2 BLE advertisements...         ║")
    print("║  Press each Shelly BLU Button to see it appear here.  ║")
    print("║                                                       ║")
    print("║  Press Ctrl+C to stop.                                ║")
    print("║                                                       ║")
    print("╚═══════════════════════════════════════════════════════╝")
    print()

    scanner = BleakScanner(detection_callback=detection_callback)

    try:
        await scanner.start()
        print("  ✅ BLE scanner started successfully!")
        print("  👆 Press your Shelly BLU buttons now...\n")

        # Keep running, print periodic status
        while True:
            await asyncio.sleep(10)
            if seen_devices:
                print(f"  ── Status: {len(seen_devices)} BTHome device(s) detected, "
                      f"{sum(press_count.values())} total press(es) ──")
            else:
                print("  ⏳ Still scanning... no BTHome devices detected yet.")
                print("     Make sure Bluetooth is enabled and buttons are nearby.")

    except KeyboardInterrupt:
        pass
    finally:
        await scanner.stop()

    # Print summary
    print("\n")
    print("╔═══════════════════════════════════════════════════════╗")
    print("║  DISCOVERY SUMMARY                                   ║")
    print("╠═══════════════════════════════════════════════════════╣")

    if not seen_devices:
        print("║  No BTHome devices were detected.                    ║")
        print("║  Check that Bluetooth is on and buttons are nearby.  ║")
    else:
        print("║                                                       ║")
        for mac, info in sorted(seen_devices.items()):
            presses = press_count.get(mac, 0)
            print(f"║  MAC: {mac}  Presses: {presses:3d}  Name: {info['name'][:12]:<12} ║")
        print("║                                                       ║")
        print("║  Copy the MAC addresses above into server.py          ║")
        print("║  LANE_MAC_MAP at the top of the file.                 ║")

    print("╚═══════════════════════════════════════════════════════╝")
    print()


if __name__ == "__main__":
    asyncio.run(main())
