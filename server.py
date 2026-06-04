#!/usr/bin/env python3
"""
Swim Gala Timing System — Server
=================================
A 6-lane wireless swim timing backend powered by Shelly BLU Button 1 Tough
devices. Receives button presses via direct BLE advertisement scanning
(bleak) and/or Home Assistant WebSocket, manages race state, broadcasts
real-time updates over WebSocket, and exports results in CTS Dolphin .do3
and FinishLynx .lif formats.

Run:
    python server.py
"""

from __future__ import annotations

import asyncio
import csv
import json
import logging
import os
import pathlib
import time
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.requests import Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

# Map Shelly BLU Button MAC addresses → lane numbers.
# Replace placeholders with your real MACs.
LANE_MAC_MAP: dict[str, int] = {
    "AA:BB:CC:DD:EE:01": 1,
    "AA:BB:CC:DD:EE:02": 2,
    "AA:BB:CC:DD:EE:03": 3,
    "AA:BB:CC:DD:EE:04": 4,
    "AA:BB:CC:DD:EE:05": 5,
    "AA:BB:CC:DD:EE:06": 6,
}

STARTER_MAC: str = "AA:BB:CC:DD:EE:00"

# Home Assistant WebSocket integration (set token to enable)
HA_WS_URL: str = "ws://homeassistant.local:8123/api/websocket"
HA_TOKEN: str = ""  # long-lived access token; empty = disabled

# BLE debounce window (seconds) per lane per event
DEBOUNCE_SECONDS: float = 3.0

# Server bind address
HOST: str = "0.0.0.0"
PORT: int = 8000

# BTHome v2 service UUID (16-bit 0xFCD2 as 128-bit)
BTHOME_UUID: str = "0000fcd2-0000-1000-8000-00805f9b34fb"

# Directories
BASE_DIR = pathlib.Path(__file__).resolve().parent
EXPORTS_DIR = BASE_DIR / "exports"
LOGS_DIR = BASE_DIR / "logs"
STATIC_DIR = BASE_DIR / "static"
AUDIT_LOG_PATH = LOGS_DIR / "ble_audit.csv"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("swim_timer")

# ---------------------------------------------------------------------------
# Race state machine
# ---------------------------------------------------------------------------


class RaceState(Enum):
    IDLE = "idle"
    READY = "ready"
    RUNNING = "running"
    COMPLETED = "completed"


class RaceManager:
    """Manages the lifecycle of a single race."""

    def __init__(self, num_lanes: int = 6) -> None:
        self.num_lanes: int = num_lanes
        self.event_num: int = 1
        self.heat_num: int = 1
        self.dataset_num: int = 1
        self.race_id_counter: int = 0
        self.state: RaceState = RaceState.IDLE
        self.start_time_ns: int = 0
        self.lane_times: dict[int, list[float]] = {i: [] for i in range(1, num_lanes + 1)}
        self.lane_finished: dict[int, bool] = {i: False for i in range(1, num_lanes + 1)}

    # -- state transitions ---------------------------------------------------

    def prepare_race(self, event_num: int, heat_num: int) -> None:
        self.event_num = event_num
        self.heat_num = heat_num
        self.race_id_counter += 1
        self.state = RaceState.READY
        self.start_time_ns = 0
        self.lane_times = {i: [] for i in range(1, self.num_lanes + 1)}
        self.lane_finished = {i: False for i in range(1, self.num_lanes + 1)}
        logger.info(
            "Race prepared: Event %d, Heat %d (race_id=%d)",
            self.event_num,
            self.heat_num,
            self.race_id_counter,
        )

    def start_race(self) -> None:
        if self.state != RaceState.READY:
            logger.warning("Cannot start race – state is %s", self.state.value)
            return
        self.start_time_ns = time.monotonic_ns()
        self.state = RaceState.RUNNING
        logger.info("Race STARTED (monotonic_ns=%d)", self.start_time_ns)

    def record_lane_time(self, lane: int) -> float | None:
        """Record a split/finish time. Returns elapsed seconds or None."""
        if self.state != RaceState.RUNNING:
            return None
        if lane < 1 or lane > self.num_lanes:
            return None
        elapsed = self.get_elapsed_seconds()
        self.lane_times[lane].append(elapsed)
        logger.info("Lane %d time recorded: %.3f s", lane, elapsed)
        # Mark finished (every press is treated as a valid split; last one is the finish)
        self.lane_finished[lane] = True
        # Check whether all lanes have at least one time
        if all(self.lane_finished.values()):
            self.state = RaceState.COMPLETED
            logger.info("All lanes finished – race COMPLETED")
        return elapsed

    def stop_race(self) -> None:
        self.state = RaceState.COMPLETED
        logger.info("Race manually STOPPED")

    def reset(self) -> None:
        self.state = RaceState.IDLE
        self.start_time_ns = 0
        self.lane_times = {i: [] for i in range(1, self.num_lanes + 1)}
        self.lane_finished = {i: False for i in range(1, self.num_lanes + 1)}
        logger.info("Race RESET to IDLE")

    # -- queries --------------------------------------------------------------

    def get_elapsed_seconds(self) -> float:
        if self.start_time_ns == 0:
            return 0.0
        return (time.monotonic_ns() - self.start_time_ns) / 1_000_000_000

    def get_lane_result(self, lane: int) -> float | None:
        times = self.lane_times.get(lane, [])
        return times[-1] if times else None

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state.value,
            "event_num": self.event_num,
            "heat_num": self.heat_num,
            "dataset_num": self.dataset_num,
            "race_id": self.race_id_counter,
            "elapsed": self.get_elapsed_seconds() if self.state == RaceState.RUNNING else 0.0,
            "lane_times": {str(k): v for k, v in self.lane_times.items()},
            "lane_finished": {str(k): v for k, v in self.lane_finished.items()},
            "num_lanes": self.num_lanes,
        }


# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------

race_manager = RaceManager(num_lanes=6)

# Connected WebSocket clients
ws_clients: set[WebSocket] = set()

# Battery status per lane
battery_status: dict[int, int] = {}

# Debounce tracker: (mac, event_type) → last timestamp
_debounce_tracker: dict[tuple[str, str], float] = {}

# Connection status flags
ble_connected: bool = False
ha_connected: bool = False

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _format_time_mss_hh(seconds: float) -> str:
    """Format seconds as M:SS.hh (minutes:seconds.hundredths)."""
    minutes = int(seconds) // 60
    secs = seconds - minutes * 60
    return f"{minutes}:{secs:05.2f}"


def _format_time_mmss_hh(seconds: float) -> str:
    """Format seconds as MM:SS.hh."""
    minutes = int(seconds) // 60
    secs = seconds - minutes * 60
    return f"{minutes:02d}:{secs:05.2f}"


def _debounce_ok(mac: str, event_type: str) -> bool:
    """Return True if enough time has passed since the last event."""
    key = (mac.upper(), event_type)
    now = time.monotonic()
    last = _debounce_tracker.get(key, 0.0)
    if now - last < DEBOUNCE_SECONDS:
        return False
    _debounce_tracker[key] = now
    return True


async def _broadcast(msg: dict[str, Any]) -> None:
    """Send a JSON message to every connected WebSocket client."""
    payload = json.dumps(msg)
    to_remove: list[WebSocket] = []
    for ws in ws_clients:
        try:
            await ws.send_text(payload)
        except Exception:
            to_remove.append(ws)
    for ws in to_remove:
        ws_clients.discard(ws)


async def _broadcast_race_state() -> None:
    await _broadcast(
        {
            "type": "race_state",
            "state": race_manager.state.value,
            "event_num": race_manager.event_num,
            "heat_num": race_manager.heat_num,
            "start_time": race_manager.start_time_ns / 1_000_000_000 if race_manager.start_time_ns else 0,
            "elapsed": race_manager.get_elapsed_seconds() if race_manager.state == RaceState.RUNNING else 0.0,
        }
    )


async def _broadcast_lane_time(lane: int, elapsed: float, split_index: int, is_finish: bool) -> None:
    await _broadcast(
        {
            "type": "lane_time",
            "lane": lane,
            "time": round(elapsed, 3),
            "split_index": split_index,
            "is_finish": is_finish,
        }
    )


async def _broadcast_connection(source: str, connected: bool) -> None:
    await _broadcast({"type": "connection_status", "source": source, "connected": connected})


async def _broadcast_battery(lane: int, pct: int) -> None:
    await _broadcast({"type": "battery_status", "lane": lane, "battery_pct": pct})


def _build_full_state() -> dict[str, Any]:
    return {
        "type": "full_state",
        "race": race_manager.to_dict(),
        "battery": {str(k): v for k, v in battery_status.items()},
        "ble_connected": ble_connected,
        "ha_connected": ha_connected,
        "lane_mac_map": {mac: lane for mac, lane in LANE_MAC_MAP.items()},
        "starter_mac": STARTER_MAC,
    }


# ---------------------------------------------------------------------------
# BLE audit logger
# ---------------------------------------------------------------------------

_audit_writer: csv.writer | None = None
_audit_file: Any = None


def _init_audit_log() -> None:
    global _audit_writer, _audit_file
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    file_exists = AUDIT_LOG_PATH.exists() and AUDIT_LOG_PATH.stat().st_size > 0
    _audit_file = open(AUDIT_LOG_PATH, "a", newline="")
    _audit_writer = csv.writer(_audit_file)
    if not file_exists:
        _audit_writer.writerow(["timestamp_iso", "mac", "packet_id", "event_type", "raw_hex"])


def _audit_log(mac: str, packet_id: int | None, event_type: str, raw_hex: str) -> None:
    if _audit_writer is None:
        return
    _audit_writer.writerow(
        [
            datetime.now(timezone.utc).isoformat(),
            mac,
            packet_id if packet_id is not None else "",
            event_type,
            raw_hex,
        ]
    )
    _audit_file.flush()


# ---------------------------------------------------------------------------
# BTHome v2 parser
# ---------------------------------------------------------------------------


def parse_bthome_v2(payload: bytes) -> list[dict[str, Any]]:
    """
    Parse BTHome v2 service data payload.

    Returns a list of parsed object entries, e.g.:
        [{"object_id": 0x3A, "name": "button", "value": 1},
         {"object_id": 0x01, "name": "battery", "value": 85}]
    """
    if not payload:
        return []

    # First byte: device info
    #   bit 0 – encryption flag
    #   bit 2 – trigger-based flag
    idx = 1  # skip device-info byte
    results: list[dict[str, Any]] = []

    while idx < len(payload):
        obj_id = payload[idx]
        idx += 1

        if obj_id == 0x00:
            # packet_id — 1 byte
            if idx < len(payload):
                results.append({"object_id": 0x00, "name": "packet_id", "value": payload[idx]})
                idx += 1
        elif obj_id == 0x01:
            # battery — 1 byte (0-100 %)
            if idx < len(payload):
                results.append({"object_id": 0x01, "name": "battery", "value": payload[idx]})
                idx += 1
        elif obj_id == 0x3A:
            # button event — 1 byte (1=press, 2=double, 3=triple, 4=long)
            if idx < len(payload):
                results.append({"object_id": 0x3A, "name": "button", "value": payload[idx]})
                idx += 1
        else:
            # Unknown object: we cannot know the length, so we stop parsing
            # to avoid misinterpreting subsequent bytes.
            break

    return results


# ---------------------------------------------------------------------------
# Incoming button-press handler (shared by BLE + HA paths)
# ---------------------------------------------------------------------------


async def handle_button_press(mac: str, press_type: int) -> None:
    """
    Process a button press from any source.

    Args:
        mac: uppercase MAC address of the button.
        press_type: 1=single, 2=double, 3=triple, 4=long.
    """
    mac = mac.upper()

    # Only act on single-press events
    if press_type != 1:
        logger.debug("Ignoring non-single press (type=%d) from %s", press_type, mac)
        return

    # Starter button
    if mac == STARTER_MAC.upper():
        if race_manager.state == RaceState.READY:
            if _debounce_ok(mac, "start"):
                race_manager.start_race()
                await _broadcast_race_state()
        return

    # Lane button
    lane = LANE_MAC_MAP.get(mac)
    if lane is None:
        logger.debug("Unknown MAC %s — ignoring", mac)
        return

    if race_manager.state == RaceState.RUNNING:
        if _debounce_ok(mac, f"lane_{lane}"):
            elapsed = race_manager.record_lane_time(lane)
            if elapsed is not None:
                split_index = len(race_manager.lane_times[lane]) - 1
                is_finish = race_manager.lane_finished[lane]
                await _broadcast_lane_time(lane, elapsed, split_index, is_finish)
                # If race auto-completed, broadcast state change
                if race_manager.state == RaceState.COMPLETED:
                    await _broadcast_race_state()


async def handle_battery_update(mac: str, pct: int) -> None:
    mac = mac.upper()
    lane = LANE_MAC_MAP.get(mac)
    if lane is not None:
        battery_status[lane] = pct
        await _broadcast_battery(lane, pct)


# ---------------------------------------------------------------------------
# BLE scanner (bleak)
# ---------------------------------------------------------------------------


async def _ble_scanner_task() -> None:
    """Background task: scan for BLE advertisements and process BTHome v2 data."""
    global ble_connected

    try:
        from bleak import BleakScanner  # type: ignore[import-untyped]
    except ImportError:
        logger.warning("bleak is not installed — BLE scanning disabled")
        return

    def _detection_callback(device: Any, advertisement_data: Any) -> None:
        """Called by BleakScanner for each detected advertisement."""
        mac = device.address.upper() if device.address else ""

        # Filter: only known MACs
        if mac not in LANE_MAC_MAP and mac != STARTER_MAC.upper():
            return

        # Look for BTHome v2 service data
        sd = advertisement_data.service_data or {}
        payload = sd.get(BTHOME_UUID)
        if payload is None:
            return

        raw_hex = payload.hex()
        objects = parse_bthome_v2(payload)

        packet_id: int | None = None
        for obj in objects:
            if obj["name"] == "packet_id":
                packet_id = obj["value"]

        for obj in objects:
            if obj["name"] == "button":
                _audit_log(mac, packet_id, f"button_{obj['value']}", raw_hex)
                asyncio.get_event_loop().create_task(handle_button_press(mac, obj["value"]))
            elif obj["name"] == "battery":
                _audit_log(mac, packet_id, f"battery_{obj['value']}", raw_hex)
                asyncio.get_event_loop().create_task(handle_battery_update(mac, obj["value"]))

    logger.info("Starting BLE scanner…")
    scanner = BleakScanner(detection_callback=_detection_callback)

    try:
        await scanner.start()
        ble_connected = True
        await _broadcast_connection("bleak", True)
        logger.info("BLE scanner running")

        # Keep scanner alive until cancellation
        while True:
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        logger.info("BLE scanner stopping…")
    except Exception as exc:
        logger.error("BLE scanner error: %s", exc)
    finally:
        try:
            await scanner.stop()
        except Exception:
            pass
        ble_connected = False
        await _broadcast_connection("bleak", False)
        logger.info("BLE scanner stopped")


# ---------------------------------------------------------------------------
# Home Assistant WebSocket client
# ---------------------------------------------------------------------------


async def _ha_websocket_task() -> None:
    """Background task: connect to Home Assistant WebSocket API."""
    global ha_connected

    if not HA_TOKEN:
        logger.info("HA token not configured — Home Assistant integration disabled")
        return

    import websockets  # type: ignore[import-untyped]

    backoff = 1.0
    max_backoff = 60.0
    msg_id = 1

    while True:
        try:
            logger.info("Connecting to Home Assistant at %s …", HA_WS_URL)
            async with websockets.connect(HA_WS_URL) as ws:
                # Phase 1: receive auth_required
                auth_required = json.loads(await ws.recv())
                if auth_required.get("type") != "auth_required":
                    logger.error("Unexpected HA message: %s", auth_required)
                    continue

                # Phase 2: send auth
                await ws.send(json.dumps({"type": "auth", "access_token": HA_TOKEN}))
                auth_result = json.loads(await ws.recv())
                if auth_result.get("type") != "auth_ok":
                    logger.error("HA auth failed: %s", auth_result)
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, max_backoff)
                    continue

                logger.info("Authenticated with Home Assistant")
                ha_connected = True
                await _broadcast_connection("ha", True)
                backoff = 1.0  # reset on success

                # Phase 3: subscribe to state_changed events
                subscribe_msg = {
                    "id": msg_id,
                    "type": "subscribe_events",
                    "event_type": "state_changed",
                }
                msg_id += 1
                await ws.send(json.dumps(subscribe_msg))

                # Phase 4: process events
                async for raw in ws:
                    data = json.loads(raw)
                    if data.get("type") != "event":
                        continue
                    event = data.get("event", {})
                    event_data = event.get("data", {})
                    entity_id = event_data.get("entity_id", "")

                    # Filter for Shelly BLU Button entities
                    if not entity_id.startswith("event.shelly_blu_button_"):
                        continue

                    new_state = event_data.get("new_state", {})
                    attributes = new_state.get("attributes", {})
                    event_type = attributes.get("event_type", "")

                    # Map HA event_type strings to press types
                    press_map = {
                        "single_push": 1,
                        "double_push": 2,
                        "triple_push": 3,
                        "long_push": 4,
                    }
                    press_type = press_map.get(event_type)
                    if press_type is None:
                        continue

                    # Identify the MAC from the entity attributes
                    device_mac = attributes.get("mac", "").upper().replace(":", "")
                    # Normalise to colon-separated
                    if len(device_mac) == 12:
                        device_mac = ":".join(
                            device_mac[i : i + 2] for i in range(0, 12, 2)
                        )

                    if device_mac:
                        logger.info("HA event: %s press_type=%d mac=%s", entity_id, press_type, device_mac)
                        await handle_button_press(device_mac, press_type)

        except asyncio.CancelledError:
            logger.info("HA WebSocket task cancelled")
            break
        except Exception as exc:
            logger.warning("HA WebSocket error: %s — retrying in %.0fs", exc, backoff)
        finally:
            if ha_connected:
                ha_connected = False
                await _broadcast_connection("ha", False)

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, max_backoff)


# ---------------------------------------------------------------------------
# Export functions
# ---------------------------------------------------------------------------


def export_do3() -> pathlib.Path:
    """Export race results in CTS Dolphin .do3 format."""
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    filename = (
        f"{race_manager.dataset_num}-{race_manager.event_num:03d}-"
        f"{race_manager.heat_num:02d}F-{race_manager.race_id_counter:04d}.do3"
    )
    filepath = EXPORTS_DIR / filename

    lines: list[str] = []
    for lane in range(1, race_manager.num_lanes + 1):
        result = race_manager.get_lane_result(lane)
        if result is not None:
            time_str = _format_time_mss_hh(result)
        else:
            time_str = "      NT"
        lines.append(f"Lane {lane}   {time_str}")

    filepath.write_text("\n".join(lines) + "\n", encoding="utf-8")
    logger.info("Exported DO3: %s", filepath)
    return filepath


def export_lif() -> pathlib.Path:
    """Export race results in FinishLynx .lif format."""
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    filename = (
        f"{race_manager.dataset_num}-{race_manager.event_num:03d}-"
        f"{race_manager.heat_num:02d}F-{race_manager.race_id_counter:04d}.lif"
    )
    filepath = EXPORTS_DIR / filename

    # Gather finished lanes and sort by time to determine place
    finished: list[tuple[int, float]] = []
    for lane in range(1, race_manager.num_lanes + 1):
        result = race_manager.get_lane_result(lane)
        if result is not None:
            finished.append((lane, result))
    finished.sort(key=lambda x: x[1])

    # Assign places
    place_map: dict[int, int] = {}
    for place_idx, (lane, _time) in enumerate(finished, start=1):
        place_map[lane] = place_idx

    lines: list[str] = []
    lines.append(f"; Event {race_manager.event_num}, Heat {race_manager.heat_num}")
    lines.append(
        f"{race_manager.event_num},1,{race_manager.heat_num},"
        f"Event {race_manager.event_num},,,,,,,,,"
    )

    for lane in range(1, race_manager.num_lanes + 1):
        result = race_manager.get_lane_result(lane)
        place = place_map.get(lane, 0)
        last_name = f"Lane {lane}"
        first_name = ""
        affiliation = ""
        swimmer_id = lane
        if result is not None:
            time_str = _format_time_mmss_hh(result)
        else:
            time_str = "NT"
        lines.append(
            f"{place},{swimmer_id},{lane},{last_name},{first_name},"
            f"{affiliation},{time_str},,,,,,,,,,,,"
        )

    filepath.write_text("\n".join(lines) + "\n", encoding="utf-8")
    logger.info("Exported LIF: %s", filepath)
    return filepath


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(title="Swim Gala Timing System", version="1.0.0")


# -- Lifecycle events --------------------------------------------------------


@app.on_event("startup")
async def startup() -> None:
    """Initialise directories, audit log, and background tasks."""
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_DIR.mkdir(parents=True, exist_ok=True)

    _init_audit_log()

    # Launch BLE scanner
    asyncio.create_task(_ble_scanner_task())

    # Launch HA WebSocket client (no-op if token is empty)
    asyncio.create_task(_ha_websocket_task())

    logger.info("Startup complete — background tasks launched")


@app.on_event("shutdown")
async def shutdown() -> None:
    if _audit_file is not None:
        _audit_file.close()
    logger.info("Server shutdown")


# -- Static files & index page -----------------------------------------------

# Mount static files (must be after other routes to avoid shadowing)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR), check_dir=False), name="static")


@app.get("/")
async def index() -> FileResponse | JSONResponse:
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return JSONResponse({"detail": "static/index.html not found — place your dashboard files in static/"}, status_code=404)


@app.get("/remote")
async def remote() -> FileResponse | JSONResponse:
    """Serve the mobile remote control page for phone-based timing."""
    remote_path = STATIC_DIR / "remote.html"
    if remote_path.exists():
        return FileResponse(str(remote_path))
    return JSONResponse({"detail": "static/remote.html not found"}, status_code=404)


# -- REST API -----------------------------------------------------------------


@app.get("/api/state")
async def api_state() -> JSONResponse:
    return JSONResponse(_build_full_state())


@app.get("/api/exports")
async def api_exports() -> JSONResponse:
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(f.name for f in EXPORTS_DIR.iterdir() if f.is_file())
    return JSONResponse({"files": files})


@app.post("/api/config")
async def api_config(request: Request) -> JSONResponse:
    """Update lane MAC mappings at runtime."""
    body = await request.json()
    new_map: dict[str, int] | None = body.get("lane_mac_map")
    new_starter: str | None = body.get("starter_mac")

    global STARTER_MAC

    if new_map is not None:
        LANE_MAC_MAP.clear()
        for mac, lane in new_map.items():
            LANE_MAC_MAP[mac.upper()] = int(lane)
        logger.info("Lane MAC map updated: %s", LANE_MAC_MAP)

    if new_starter is not None:
        STARTER_MAC = new_starter.upper()
        logger.info("Starter MAC updated: %s", STARTER_MAC)

    return JSONResponse({"status": "ok", "lane_mac_map": LANE_MAC_MAP, "starter_mac": STARTER_MAC})


# -- WebSocket ----------------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    ws_clients.add(ws)
    logger.info("WebSocket client connected (%d total)", len(ws_clients))

    # Send full state on connect
    try:
        await ws.send_text(json.dumps(_build_full_state()))
    except Exception:
        ws_clients.discard(ws)
        return

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({"type": "error", "message": "Invalid JSON"}))
                continue

            action = msg.get("action", "")

            if action == "prepare_race":
                event_num = int(msg.get("event_num", race_manager.event_num))
                heat_num = int(msg.get("heat_num", race_manager.heat_num))
                race_manager.prepare_race(event_num, heat_num)
                await _broadcast_race_state()

            elif action == "start_race":
                if race_manager.state == RaceState.READY:
                    race_manager.start_race()
                    await _broadcast_race_state()
                else:
                    await ws.send_text(
                        json.dumps({"type": "error", "message": f"Cannot start – state is {race_manager.state.value}"})
                    )

            elif action == "stop_race":
                race_manager.stop_race()
                await _broadcast_race_state()

            elif action == "reset_race":
                race_manager.reset()
                await _broadcast_race_state()

            elif action == "manual_time":
                lane = int(msg.get("lane", 0))
                t = float(msg.get("time", 0.0))
                if 1 <= lane <= race_manager.num_lanes and t > 0:
                    race_manager.lane_times[lane].append(t)
                    race_manager.lane_finished[lane] = True
                    split_index = len(race_manager.lane_times[lane]) - 1
                    await _broadcast_lane_time(lane, t, split_index, True)
                    logger.info("Manual time for lane %d: %.3f s", lane, t)
                    if all(race_manager.lane_finished.values()):
                        race_manager.state = RaceState.COMPLETED
                        await _broadcast_race_state()

            elif action == "simulate_start":
                # Simulate a starter-button press
                if race_manager.state == RaceState.READY:
                    race_manager.start_race()
                    await _broadcast_race_state()
                    logger.info("Simulated START")
                elif race_manager.state == RaceState.IDLE:
                    # Auto-prepare then start for convenience
                    race_manager.prepare_race(race_manager.event_num, race_manager.heat_num)
                    race_manager.start_race()
                    await _broadcast_race_state()
                    logger.info("Simulated auto-prepare + START")

            elif action == "simulate_press":
                lane = int(msg.get("lane", 0))
                if race_manager.state == RaceState.RUNNING and 1 <= lane <= race_manager.num_lanes:
                    elapsed = race_manager.record_lane_time(lane)
                    if elapsed is not None:
                        split_index = len(race_manager.lane_times[lane]) - 1
                        is_finish = race_manager.lane_finished[lane]
                        await _broadcast_lane_time(lane, elapsed, split_index, is_finish)
                        logger.info("Simulated press lane %d → %.3f s", lane, elapsed)
                        if race_manager.state == RaceState.COMPLETED:
                            await _broadcast_race_state()

            elif action == "export_results":
                try:
                    do3_path = export_do3()
                    lif_path = export_lif()
                    await ws.send_text(
                        json.dumps(
                            {
                                "type": "export_complete",
                                "files": [do3_path.name, lif_path.name],
                            }
                        )
                    )
                except Exception as exc:
                    await ws.send_text(json.dumps({"type": "error", "message": f"Export failed: {exc}"}))

            else:
                await ws.send_text(json.dumps({"type": "error", "message": f"Unknown action: {action}"}))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("WebSocket error: %s", exc)
    finally:
        ws_clients.discard(ws)
        logger.info("WebSocket client disconnected (%d remaining)", len(ws_clients))


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

BANNER = r"""
╔═══════════════════════════════════════════════════╗
║                                                   ║
║   ███████╗██╗    ██╗██╗███╗   ███╗                ║
║   ██╔════╝██║    ██║██║████╗ ████║                ║
║   ███████╗██║ █╗ ██║██║██╔████╔██║                ║
║   ╚════██║██║███╗██║██║██║╚██╔╝██║                ║
║   ███████║╚███╔███╔╝██║██║ ╚═╝ ██║                ║
║   ╚══════╝ ╚══╝╚══╝ ╚═╝╚═╝     ╚═╝                ║
║                                                   ║
║   ████████╗██╗███╗   ███╗███████╗██████╗          ║
║   ╚══██╔══╝██║████╗ ████║██╔════╝██╔══██╗         ║
║      ██║   ██║██╔████╔██║█████╗  ██████╔╝         ║
║      ██║   ██║██║╚██╔╝██║██╔══╝  ██╔══██╗         ║
║      ██║   ██║██║ ╚═╝ ██║███████╗██║  ██║         ║
║      ╚═╝   ╚═╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝         ║
║                                                   ║
║   6-Lane Wireless Swim Gala Timing System         ║
║   Dashboard:  http://localhost:8000               ║
║   Phone Remote: http://localhost:8000/remote      ║
║                                                   ║
╚═══════════════════════════════════════════════════╝
"""

if __name__ == "__main__":
    import uvicorn  # type: ignore[import-untyped]

    print(BANNER)
    uvicorn.run(
        "server:app",
        host=HOST,
        port=PORT,
        log_level="info",
    )
