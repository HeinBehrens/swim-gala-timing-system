/**
 * ESP32-C5 BLE Gateway — Host-side reader (USB serial OR Wi-Fi TCP)
 * ================================================================
 * Reads the line protocol from firmware/esp32_shelly_scanner and emits typed
 * events. Works over either transport — the firmware streams the SAME lines on
 * both, so everything downstream (enroll, monitor, server) is identical:
 *   - Serial:  new Esp32Gateway("/dev/cu.usbserial-10")
 *   - Wi-Fi:   new Esp32Gateway({ host: "swim-timer.local", tcpPort: 3333 })
 *
 * The ESP timestamps each press on-chip in microseconds before sending, so the
 * transport (and its latency/jitter) never affects timing accuracy.
 *
 * Firmware line protocol (tab-separated):
 *   READY<TAB>esp32-shelly-scanner<TAB>v5
 *   WIFI<TAB>...                      (status, treated as a "line" event)
 *   PRESS<TAB>mac<TAB>button<TAB>packetId<TAB>rssi<TAB>microsSinceBoot
 *
 * Events: "open", "ready"(string), "press"(PressEvent), "line"(string),
 *         "error"(Error), "close". TCP auto-reconnects with backoff.
 */

import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { existsSync } from "node:fs";

// "auto" = pick the first attached USB-serial device (handles macOS bumping the
// port name on replug, e.g. cu.usbserial-10 -> cu.usbserial-110).
export const DEFAULT_PORT = "auto";
export const DEFAULT_BAUD = 115200;
export const DEFAULT_TCP_HOST = "swim-timer.local";
export const DEFAULT_TCP_PORT = 3333;

export const PRESS_LABELS: Record<number, string> = {
  1: "SINGLE",
  2: "DOUBLE",
  3: "TRIPLE",
  4: "LONG",
};

export interface PressEvent {
  mac: string;       // canonical lower-case, e.g. "7c:c6:b6:58:6f:c6"
  button: number;    // 1=single 2=double 3=triple 4=long
  press: string;     // human label for button
  packetId: number;
  rssi: number;
  espMicros: number; // microseconds since ESP boot — AUTHORITATIVE press time
  hostTs: number;    // Date.now() when the host received the line (reference only)
}

export interface GatewayOptions {
  path?: string;      // serial device path, or "auto" to detect
  baud?: number;
  host?: string;      // TCP host (Wi-Fi)
  tcpPort?: number;
  auto?: boolean;     // prefer USB serial; fall back to the gateway on Wi-Fi (host) when no device
}

export class Esp32Gateway extends EventEmitter {
  private port?: SerialPort;
  private socket?: Socket;
  private buf = "";
  private closed = false;
  private reconnectMs = 1000;
  private serialPreferred = DEFAULT_PORT;
  private serialBaud = DEFAULT_BAUD;
  private autoHost = DEFAULT_TCP_HOST;
  private autoTcpPort = DEFAULT_TCP_PORT;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(target: string | GatewayOptions = DEFAULT_PORT) {
    super();
    const opts: GatewayOptions = typeof target === "string" ? { path: target } : target;
    this.serialBaud = opts.baud ?? DEFAULT_BAUD;
    if (opts.auto) {
      this.serialPreferred = opts.path ?? DEFAULT_PORT;
      this.autoHost = opts.host ?? DEFAULT_TCP_HOST;
      this.autoTcpPort = opts.tcpPort ?? DEFAULT_TCP_PORT;
      void this.connectAuto();
    } else if (opts.host) {
      this.openTcp(opts.host, opts.tcpPort ?? DEFAULT_TCP_PORT);
    } else {
      this.openSerial(opts.path ?? DEFAULT_PORT, opts.baud ?? DEFAULT_BAUD);
    }
  }

  // Find an attached USB-serial device. PREFERS the USB-UART bridge
  // (CH340/CP210x/FTDI): on this gateway the firmware's Serial — the PRESS lines —
  // comes out the bridge (e.g. /dev/cu.usbserial-10). The native-USB /dev/cu.usbmodem*
  // (USB-JTAG) is flashing-only and carries NO press data, so picking it makes the
  // link look "connected" while zero presses arrive — it's only a last resort (boards
  // that have ONLY native USB still work). Maps tty.* -> cu.* (callout, no carrier wait).
  static async detectPort(): Promise<string | undefined> {
    let ports: Awaited<ReturnType<typeof SerialPort.list>>;
    try { ports = await SerialPort.list(); } catch { return undefined; }
    const isBridge = (p: { path: string; manufacturer?: string }) =>
      /usbserial|wchusbserial|SLAB_USBtoUART/i.test(p.path) ||
      /CH340|CP210|FTDI|Silicon Labs|wch/i.test(p.manufacturer ?? "");
    const isNativeUsb = (p: { path: string; manufacturer?: string }) =>
      /usbmodem/i.test(p.path) || /Espressif/i.test(p.manufacturer ?? "");
    const hit = ports.find(isBridge) ?? ports.find(isNativeUsb);
    if (!hit) return undefined;
    return hit.path.replace("/dev/tty.", "/dev/cu.");
  }

  // Schedule the next connection attempt with exponential backoff (deduped, so
  // a simultaneous error+close fire only arms one retry).
  private scheduleRetry(fn: () => void): void {
    if (this.closed || this.retryTimer) return;
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 8000);
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; fn(); }, wait);
  }

  // Resolve the serial device to open, or undefined if none is attached.
  private async resolveSerialPath(): Promise<string | undefined> {
    const p = this.serialPreferred;
    // Honour an explicit port. On Windows a COM name (COM5, \\.\COM12) isn't a
    // filesystem path, so existsSync() would always fail — accept it directly;
    // elsewhere (macOS/Linux /dev/*) keep the existence check.
    if (p !== "auto" && (/^(\\\\\.\\)?COM\d+$/i.test(p) || existsSync(p))) return p;
    return Esp32Gateway.detectPort();
  }

  // ── Serial transport (auto-detect + auto-reconnect) ──
  private openSerial(path: string, baud: number): void {
    this.serialPreferred = path;
    this.serialBaud = baud;
    void this.connectSerial();
  }

  private async connectSerial(): Promise<void> {
    if (this.closed) return;
    const target = await this.resolveSerialPath();
    if (!target) {
      const want = this.serialPreferred === "auto" ? "any USB-serial device" : this.serialPreferred;
      this.emit("error", new Error(`waiting for ${want}…`));
      return this.scheduleRetry(() => this.connectSerial());
    }
    this.openSerialPath(target, () => this.connectSerial());
  }

  // Open a known serial device; on disconnect, run `next` after backoff.
  private openSerialPath(target: string, next: () => void): void {
    const port = new SerialPort({ path: target, baudRate: this.serialBaud, autoOpen: false });
    this.port = port;
    const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
    parser.on("data", (line: string) => this.handleLine(line));
    port.on("error", (e: Error) => this.emit("error", e));
    port.on("close", () => { this.port = undefined; this.emit("close"); this.scheduleRetry(next); });
    port.open((err) => {
      if (err) { this.scheduleRetry(next); return; }
      this.reconnectMs = 1000;
      this.emit("open", `serial ${target}`);
    });
  }

  // ── Auto transport: prefer USB serial, fall back to the gateway on Wi-Fi ──
  private async connectAuto(): Promise<void> {
    if (this.closed) return;
    const target = await this.resolveSerialPath();
    if (target) { this.openSerialPath(target, () => this.connectAuto()); return; }
    // No USB device attached — find the gateway over Wi-Fi instead.
    this.openTcpOnce(this.autoHost, this.autoTcpPort, () => this.connectAuto());
  }

  // ── TCP transport (Wi-Fi) ──
  private openTcp(host: string, tcpPort: number): void {
    this.autoHost = host; this.autoTcpPort = tcpPort;
    this.openTcpOnce(host, tcpPort, () => this.openTcp(host, tcpPort));
  }

  // One TCP connection attempt. On failure/close, run `next` after backoff.
  private openTcpOnce(host: string, tcpPort: number, next: () => void): void {
    if (this.closed) return;
    const sock = new Socket();
    this.socket = sock;
    sock.setNoDelay(true);
    let opened = false;
    sock.connect(tcpPort, host, () => {
      opened = true;
      this.reconnectMs = 1000;
      this.emit("open", `wifi ${host}:${tcpPort}`);
    });
    sock.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        this.handleLine(line);
      }
    });
    sock.on("error", () => {}); // handled by the close that follows
    sock.on("close", () => {
      this.socket = undefined;
      if (opened) this.emit("close");
      else this.emit("error", new Error(`waiting for gateway on Wi-Fi (${host}:${tcpPort})…`));
      this.scheduleRetry(next);
    });
  }

  private handleLine(line: string): void {
    line = line.replace(/\r$/, "").trim();
    if (!line) return;
    const parts = line.split("\t");

    if (parts[0] === "PRESS" && parts.length >= 6) {
      const button = Number(parts[2]);
      const ev: PressEvent = {
        mac: parts[1]!.toLowerCase(),
        button,
        press: PRESS_LABELS[button] ?? `UNKNOWN(${button})`,
        packetId: Number(parts[3]),
        rssi: Number(parts[4]),
        espMicros: Number(parts[5]),
        hostTs: Date.now(),
      };
      this.emit("press", ev);
    } else if (parts[0] === "START") {
      // External start signal from the gateway (start button / PA tone contact).
      // parts[1] = on-chip microseconds, the authoritative start time.
      this.emit("start", Number(parts[1]));
    } else if (parts[0] === "READY") {
      this.emit("ready", parts.slice(1).join(" "));
    } else {
      this.emit("line", line); // WIFI banners, ESP boot logs, etc.
    }
  }

  /** Send a line to the gateway over whichever transport is currently connected. */
  send(line: string): void {
    if (this.port && this.port.isOpen) this.port.write(line);
    else if (this.socket && !this.socket.destroyed) this.socket.write(line);
  }

  /**
   * Reboot the ESP32 over the serial line with an esptool-style DTR/RTS pulse:
   * RTS drives EN (reset), DTR drives IO0. Pulsing EN low→high while IO0 stays
   * high reboots into firmware (not the bootloader). There is no reset line over
   * Wi-Fi/TCP, so that transport reports unsupported.
   */
  restart(): Promise<{ ok: boolean; detail: string }> {
    const port = this.port;
    if (!port || !port.isOpen) {
      return Promise.resolve({
        ok: false,
        detail: this.socket ? "gateway is on Wi-Fi — no serial reset line" : "no serial connection",
      });
    }
    return new Promise((resolve) => {
      // EN low (RTS asserted) + IO0 high (DTR cleared) → hold the chip in reset
      port.set({ dtr: false, rts: true }, (e1) => {
        if (e1) { resolve({ ok: false, detail: e1.message }); return; }
        setTimeout(() => {
          // EN high → boot into firmware
          port.set({ dtr: false, rts: false }, (e2) =>
            resolve(e2 ? { ok: false, detail: e2.message } : { ok: true, detail: "reset pulse sent" }));
        }, 150);
      });
    });
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    return new Promise((resolve) => {
      if (this.socket) { this.socket.destroy(); resolve(); }
      else if (this.port && this.port.isOpen) this.port.close(() => resolve());
      else resolve();
    });
  }
}
