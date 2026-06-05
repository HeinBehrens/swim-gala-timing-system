/*
 * ESP32 Shelly BLU Button1 Tough — BLE Capture Gateway (USB + Wi-Fi)
 * =================================================================
 * Dedicated BLE observer for the 6-lane swim-gala timing system.
 *
 * Captures Shelly BLU Button1 Tough BTHome v2 broadcasts, timestamps each press
 * ON-CHIP in microseconds, dedups the advert burst by packet_id, and streams one
 * clean line per press to the laptop over BOTH:
 *
 * Start signal (v12): no wired start button. The race start is one of the Shelly
 * BLU buttons, designated by the host via "STARTER\t<mac>". When that button is
 * seen the ESP fires the local start signal — a 5 V USB strobe LIGHT (GPIO5 via a
 * logic-level MOSFET) plus a start BEEP played over I2S through a MAX98357 3 W amp
 * + speaker. Light and sound are USB-powered; the host starts the clock from the
 * starter button's PRESS line.
 *   - USB serial (115200), always; and
 *   - Wi-Fi TCP (port 3333), when Wi-Fi credentials are set below.
 * The host can use either; USB is the bulletproof fallback.
 *
 * The on-chip microsecond timestamp is the authoritative press time, taken before
 * any USB/Wi-Fi round-trip, so finish timing never inherits transport jitter.
 *
 * ⚠️ Wi-Fi/BLE coexist on one radio: enabling Wi-Fi time-slices the radio, so BLE
 *    scan duty drops below 100%. To protect finish capture, the gateway drops Wi-Fi
 *    to max modem-sleep for the duration of a heat — from the starter press until
 *    ~20 s after the last press (5 min hard cap) — handing the radio back to the
 *    BLE scan. The station stays associated, so the TCP press stream keeps flowing
 *    and on-chip µs timestamps keep splits exact. USB serial is unaffected and
 *    remains the bulletproof fallback.
 *
 * Output line (tab-separated, newline-terminated), identical on both transports:
 *   PRESS<TAB>mac<TAB>button<TAB>packetId<TAB>rssi<TAB>microsSinceBoot
 *   e.g.  PRESS\t7c:c6:b6:58:6f:c6\t1\t110\t-48\t1843221905
 * Startup banners (USB only): READY..., and WIFI<TAB><ip> once connected.
 *
 * Board: ESP32-C5 Dev Module (esp32:esp32:esp32c5), arduino-esp32 core 3.3.8.
 */

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <esp_timer.h>
#include <ESP_I2S.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include <string.h>
#include <stdio.h>

// ── Wi-Fi credentials ─────────────────────────────────────────────────────────
// Fill these in to enable the Wi-Fi/TCP path. Leave WIFI_SSID empty ("") to run
// USB-only. The ESP joins this network (keeps the laptop's internet) and appears
// as swim-timer.local:3333.
#define WIFI_SSID ""
#define WIFI_PASS ""
#define MDNS_HOSTNAME "swim-timer"   // -> swim-timer.local
#define TCP_PORT 3333

// ── Start signal: USB strobe light + I2S beep ────────────────────────────────
// GPIO5 drives a logic-level MOSFET gate switching a 5 V USB strobe/LED LIGHT
// (low-side switch on the light's USB 5V line; shared ground with the ESP). The
// light fires for SIGNAL_MS the instant the designated starter button is seen.
// There is NO wired start button: the start is a Shelly BLU button, designated by
// the host via "STARTER\t<mac>\n" (dashboard re-enrollment just works).
#define SIGNAL_PIN 5
#define SIGNAL_MS  1500     // how long the light + beep stay on at start, ms

// Start BEEP over I2S → MAX98357 3 W Class-D amp → speaker. The amp is USB-powered
// (VCC 2.5–5.5 V). Three signal pins (verify against the safe-GPIO list in
// HARDWARE.md before wiring): GPIO4 freed from the old wired start, GPIO6 freed
// from the old megaphone-AUX tone, GPIO10 for data.
#define I2S_BCLK   4        // MAX98357 BCLK  (bit clock)
#define I2S_LRC    6        // MAX98357 LRC   (word/LR clock)
#define I2S_DOUT   10       // MAX98357 DIN   (serial data)
#define SAMPLE_RATE 32000   // Hz (16 samples per 2 kHz cycle → clean sine)
#define TONE_HZ     2000    // start-beep frequency
// MAX98357 SD pin: leave enabled (tie high / board default) — silence is just the
// absence of I2S data. GAIN pin sets volume (see HARDWARE.md).

// BLE Wi-Fi provisioning GATT service — the dashboard writes credentials here
// over Web Bluetooth; the ESP saves them to flash (NVS) and joins the network.
#define BLE_DEVICE_NAME  "SwimTimer-Gateway"
#define PROV_SVC_UUID    "a1b2c3d4-0001-4a5b-8c6d-1234567890ab"
#define PROV_CREDS_UUID  "a1b2c3d4-0002-4a5b-8c6d-1234567890ab" // write "ssid\tpassword"
#define PROV_STATUS_UUID "a1b2c3d4-0003-4a5b-8c6d-1234567890ab" // read/notify status
#define PROV_SCAN_UUID   "a1b2c3d4-0004-4a5b-8c6d-1234567890ab" // write=trigger, read/notify="ssid\trssi\n…"

// ── Registered-button allowlist ──────────────────────────────────────────────
// REGISTERED_ONLY=0 emits every Shelly BLU button press (lane mapping is done
// host-side by enrollment). Set to 1 to restrict to the MACs below.
#define REGISTERED_ONLY 0
static const uint8_t REGISTERED[][6] = {
  {0x7c, 0xc6, 0xb6, 0x58, 0x6f, 0xc6},
  {0x7c, 0xc6, 0xb6, 0x08, 0xd4, 0xbd},
  {0x7c, 0xc6, 0xb6, 0x73, 0xe8, 0xc0},
  {0x7c, 0xc6, 0xb6, 0x61, 0xfe, 0x39},
};
static const int NUM_REGISTERED = sizeof(REGISTERED) / 6;
static bool isRegistered(const uint8_t *mac) {
  for (int i = 0; i < NUM_REGISTERED; i++)
    if (memcmp(REGISTERED[i], mac, 6) == 0) return true;
  return false;
}

// BTHome v2 service UUID + object IDs (see discover.ts parser).
static const uint16_t BTHOME_UUID  = 0xFCD2;
static const uint8_t  OBJ_PACKET_ID = 0x00;
static const uint8_t  OBJ_BATTERY   = 0x01;
static const uint8_t  OBJ_BUTTON    = 0x3A;

// One captured press — fixed-size POD, safe to pass through the queue.
struct PressEvt {
  uint8_t  mac[6];
  uint8_t  button;
  int16_t  packetId;
  int16_t  rssi;
  int64_t  ts;       // microseconds since boot
};
static QueueHandle_t pressQ = nullptr;

// ── Start signal state ────────────────────────────────────────────────────────
static uint8_t  starterMac[6] = {0};
static bool     starterSet    = false;
static uint32_t signalOffMs   = 0;       // millis() at which to switch the light+beep off (0 = off)
static I2SClass i2s;                      // MAX98357 start-beep output
static volatile bool toneOn = false;      // audioTask plays the beep while true

// ── Heat radio policy (Wi-Fi/BLE coexistence — see heatRadioBegin/End) ────────
static bool     heatActive  = false;            // true from the starter press until the heat goes quiet
static uint32_t heatStartMs = 0;                // millis() when the heat began
static uint32_t lastPressMs = 0;                // millis() of the most recent press during a heat
static const uint32_t HEAT_QUIET_MS = 20000;    // restore full-rate Wi-Fi this long after the last press
static const uint32_t HEAT_MAX_MS   = 300000;   // safety cap: never throttle Wi-Fi longer than 5 min

// ── Wi-Fi / TCP / provisioning ───────────────────────────────────────────────
static WiFiServer tcpServer(TCP_PORT);
static WiFiClient tcpClient;
static bool wifiEnabled = false;
static Preferences prefs;
static String wifiSsid, wifiPass;
static BLECharacteristic *statusChar = nullptr;
static BLECharacteristic *scanChar = nullptr;
static volatile bool scanRequested = false;   // set by BLE write, serviced in loop()

// Parse a BTHome v2 payload. Mirrors parseBtHome() in the TypeScript code.
static bool parseBtHome(const uint8_t *p, size_t len, uint8_t &button, int16_t &packetId) {
  if (len == 0) return false;
  bool haveButton = false;
  packetId = -1;
  size_t idx = 1; // skip device-info byte
  while (idx < len) {
    uint8_t objId = p[idx++];
    switch (objId) {
      case OBJ_PACKET_ID: if (idx < len) packetId = p[idx++]; break;
      case OBJ_BATTERY:   if (idx < len) idx++; break;
      case OBJ_BUTTON:    if (idx < len) { button = p[idx++]; haveButton = true; } break;
      default:            idx++; break;
    }
  }
  return haveButton;
}

// BLE scan callback. Keep MINIMAL — no Serial/Wi-Fi/STL — just enqueue.
class ScanCallbacks : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice dev) override {
    int64_t now = esp_timer_get_time();
    int count = dev.getServiceDataCount();
    for (int i = 0; i < count; i++) {
      if (!dev.getServiceDataUUID(i).equals(BLEUUID(BTHOME_UUID))) continue;
      String data = dev.getServiceData(i);
      size_t len = data.length();
      uint8_t buf[31];
      if (len > sizeof(buf)) len = sizeof(buf);
      for (size_t j = 0; j < len; j++) buf[j] = (uint8_t)data[j];

      PressEvt e;
      e.packetId = -1; e.button = 0;
      if (!parseBtHome(buf, len, e.button, e.packetId)) return;
      if (e.packetId < 0) return;

      // getNative() is little-endian on-air bytes; reverse to canonical MAC.
      const uint8_t *raw = dev.getAddress().getNative();
      for (int k = 0; k < 6; k++) e.mac[k] = raw[5 - k];
#if REGISTERED_ONLY
      if (!isRegistered(e.mac)) return;
#endif
      e.rssi = dev.getRSSI();
      e.ts = now;
      if (pressQ) xQueueSend(pressQ, &e, 0);
      return;
    }
  }
};

// ── Dedup state (owned by loop() only) ───────────────────────────────────────
static const int MAX_DEVICES = 16;
struct Seen { uint8_t mac[6]; int16_t pid; bool used; };
static Seen seen[MAX_DEVICES];

static bool isNewPress(const uint8_t *mac, int16_t pid) {
  int freeSlot = -1;
  for (int i = 0; i < MAX_DEVICES; i++) {
    if (!seen[i].used) { if (freeSlot < 0) freeSlot = i; continue; }
    if (memcmp(seen[i].mac, mac, 6) == 0) {
      if (seen[i].pid == pid) return false;
      seen[i].pid = pid; return true;
    }
  }
  if (freeSlot >= 0) { memcpy(seen[freeSlot].mac, mac, 6); seen[freeSlot].pid = pid; seen[freeSlot].used = true; }
  return true;
}

// Send a line to BOTH transports.
static void emitLine(const char *line) {
  Serial.print(line);
  if (wifiEnabled && tcpClient && tcpClient.connected()) {
    tcpClient.print(line);
  }
}

// Report Wi-Fi status over BLE notify + USB serial.
static void setStatus(const String &s) {
  if (statusChar) {
    statusChar->setValue((uint8_t *)s.c_str(), s.length());
    statusChar->notify();
  }
  Serial.print("WIFI\t");
  Serial.println(s);
}

// Join Wi-Fi using the current credentials (from NVS / provisioning). Non-fatal —
// USB serial keeps working regardless.
static void connectWifi() {
  if (wifiSsid.length() == 0) { setStatus("idle (no credentials — provision via Bluetooth)"); return; }
  WiFi.mode(WIFI_STA);
  // Full-rate when idle (low latency); if we reconnect mid-heat, stay in modem-sleep so BLE keeps the radio.
  WiFi.setSleep(heatActive ? WIFI_PS_MAX_MODEM : WIFI_PS_NONE);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  setStatus("connecting to " + wifiSsid);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) delay(200);
  if (WiFi.status() != WL_CONNECTED) {
    wifiEnabled = false;
    int st = WiFi.status();
    const char *reason = (st == WL_NO_SSID_AVAIL) ? "network not found" :
                         (st == WL_CONNECT_FAILED) ? "auth failed (check password)" :
                         (st == WL_DISCONNECTED)   ? "refused / disconnected" : "timeout";
    setStatus(String("failed: ") + reason + " (status " + st + ")");
    // Diagnostic scan: is the SSID visible, and on which band?
    int n = WiFi.scanNetworks();
    bool seen = false;
    for (int i = 0; i < n; i++) {
      if (WiFi.SSID(i) == wifiSsid) {
        seen = true;
        int ch = WiFi.channel(i);
        setStatus("network seen: rssi " + String(WiFi.RSSI(i)) + " ch " + String(ch) + (ch > 14 ? " (5GHz)" : " (2.4GHz)"));
      }
    }
    if (!seen) setStatus("network '" + wifiSsid + "' NOT visible in scan (range / hidden / name)");
    WiFi.scanDelete();
    return;
  }
  wifiEnabled = true;
  setStatus("connected " + WiFi.localIP().toString());
  if (MDNS.begin(MDNS_HOSTNAME)) MDNS.addService("swimtimer", "tcp", TCP_PORT);
  tcpServer.begin();
  tcpServer.setNoDelay(true);
}

// Persist new credentials to flash (NVS) and (re)connect.
static void applyWifi(const String &ssid, const String &pass) {
  wifiSsid = ssid; wifiPass = pass;
  prefs.begin("wifi", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.end();
  WiFi.disconnect();
  delay(100);
  connectWifi();
}

// BLE write callback: the dashboard sends "ssid\tpassword" over Web Bluetooth.
class CredsCallback : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String v = c->getValue().c_str();   // "ssid\tpassword"
    int t = v.indexOf('\t');
    String ssid = t < 0 ? v : v.substring(0, t);
    String pass = t < 0 ? "" : v.substring(t + 1);
    if (ssid.length()) applyWifi(ssid, pass);
  }
};

// BLE write to the scan characteristic = "please scan for Wi-Fi networks". The
// actual scan blocks ~2 s, so we just flag it here and run it from loop().
class ScanTriggerCallback : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *) override { scanRequested = true; }
};

// Scan for 2.4 GHz networks (the band this system uses) and publish a deduped,
// strongest-first "ssid\trssi\n…" list on the scan characteristic (read + notify).
// Called from loop() so the blocking scan never stalls press handling (ioTask).
static void doWifiScan() {
  setStatus("scanning for Wi-Fi networks…");
  int n = WiFi.scanNetworks();              // blocking; results sorted by RSSI desc
  String out, seen = "\n";
  int added = 0;
  for (int i = 0; i < n && added < 15 && out.length() < 440; i++) {
    if (WiFi.channel(i) > 14) continue;     // skip 5 GHz — the gateway joins 2.4 GHz
    String s = WiFi.SSID(i);
    if (s.length() == 0) continue;          // hidden network
    if (seen.indexOf("\n" + s + "\n") >= 0) continue; // dedup (keep strongest)
    seen += s + "\n";
    out += s + "\t" + String(WiFi.RSSI(i)) + "\n";
    added++;
  }
  WiFi.scanDelete();
  if (scanChar) {
    scanChar->setValue((uint8_t *)out.c_str(), out.length());
    scanChar->notify();
  }
  setStatus(String("scan complete: ") + added + " network(s)");
}

// Load saved credentials and stand up the BLE provisioning GATT service.
static void setupProvisioning() {
  prefs.begin("wifi", true);
  wifiSsid = prefs.getString("ssid", WIFI_SSID);
  wifiPass = prefs.getString("pass", WIFI_PASS);
  prefs.end();

  BLEServer *server = BLEDevice::createServer();
  BLEService *svc = server->createService(PROV_SVC_UUID);
  BLECharacteristic *creds = svc->createCharacteristic(PROV_CREDS_UUID, BLECharacteristic::PROPERTY_WRITE);
  creds->setCallbacks(new CredsCallback());
  statusChar = svc->createCharacteristic(PROV_STATUS_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  statusChar->addDescriptor(new BLE2902());
  statusChar->setValue((uint8_t *)"idle", 4);
  scanChar = svc->createCharacteristic(PROV_SCAN_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  scanChar->addDescriptor(new BLE2902());
  scanChar->setCallbacks(new ScanTriggerCallback());
  svc->start();

  // Advertise the NAME in the main packet (so it's identifiable in the browser's
  // Bluetooth chooser) and the 128-bit service UUID in the scan response — they
  // do not both fit in a single 31-byte advertisement.
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  BLEAdvertisementData advData;
  advData.setFlags(0x06); // LE General Discoverable, BR/EDR not supported
  advData.setName(BLE_DEVICE_NAME);
  adv->setAdvertisementData(advData);
  BLEAdvertisementData scanResp;
  scanResp.setCompleteServices(BLEUUID(PROV_SVC_UUID));
  adv->setScanResponseData(scanResp);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("WIFI\tBLE provisioning ready (" BLE_DEVICE_NAME ")");
}

static void ioTask(void *);     // defined below; forward-declared for setup()
static void audioTask(void *);  // defined below; forward-declared for setup()

void setup() {
  Serial.begin(115200);
  delay(200);

  pressQ = xQueueCreate(64, sizeof(PressEvt));

  // Start-signal light output (5 V USB strobe via MOSFET) — default OFF.
  pinMode(SIGNAL_PIN, OUTPUT);
  digitalWrite(SIGNAL_PIN, LOW);
  // Start-beep output: I2S → MAX98357. (bclk, ws, dout); din/mclk default -1.
  i2s.setPins(I2S_BCLK, I2S_LRC, I2S_DOUT);
  // Stereo (same sample on L+R) so the beep plays regardless of the MAX98357's
  // channel-select resistor.
  if (!i2s.begin(I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO)) {
    Serial.println("WIFI\tI2S init failed");
  }
  xTaskCreate(audioTask, "audio", 4096, nullptr, 1, nullptr);
  // Restore the starter MAC saved by a previous "STARTER" command.
  prefs.begin("cfg", true);
  starterSet = (prefs.getBytes("starter", starterMac, 6) == 6);
  prefs.end();

  BLEDevice::init(BLE_DEVICE_NAME);
  setupProvisioning();   // BLE Wi-Fi provisioning service + load saved creds from flash
  connectWifi();         // join Wi-Fi immediately if we already have credentials

  BLEScan *scan = BLEDevice::getScan();
  scan->setAdvertisedDeviceCallbacks(new ScanCallbacks(), /*wantDuplicates=*/true);
  scan->setActiveScan(false);
  scan->setInterval(100);
  scan->setWindow(100);
  scan->setDuplicateFilter(false);

  // Emit presses + service TCP from a dedicated task (prio 2 > loopTask prio 1)
  // so a press is sent within ms, not held until the 1 s scan window ends.
  xTaskCreate(ioTask, "io", 4096, nullptr, 2, nullptr);

  Serial.println("READY\tesp32-shelly-scanner\tv14");
  // Finite-window scan loop runs in loop(); start(0) (continuous) leaks RAM in
  // this BLE library (no public setMaxResults) -> bad_alloc abort.
}

static const uint32_t SCAN_SECONDS = 1;

// Re-announce the CURRENT Wi-Fi status on an interval. The boot-time announcement
// is one-shot, so a host (dashboard) that opens the serial/TCP link after boot
// would otherwise never learn the state. Cheap, and keeps the UI indicator honest.
static uint32_t lastStatusMs = 0;
static void reportCurrentStatus() {
  if (WiFi.status() == WL_CONNECTED) {
    setStatus("connected " + WiFi.localIP().toString());
  } else if (wifiSsid.length() == 0) {
    setStatus("idle (no credentials — provision via Bluetooth)");
  } else {
    setStatus("failed: not connected (status " + String(WiFi.status()) + ")");
  }
}

// Accept a TCP client if Wi-Fi is up and none is connected.
static void serviceTcp() {
  if (!wifiEnabled) return;
  if (!tcpClient || !tcpClient.connected()) {
    WiFiClient c = tcpServer.available();
    if (c) {
      tcpClient = c;
      tcpClient.setNoDelay(true);
    }
  }
}

// ── Start signal (USB light + I2S beep) ──────────────────────────────────────
// Fire the start signal: 5 V USB strobe light + I2S beep together. Non-blocking
// (both auto-off in ioTask after SIGNAL_MS); called when the start is triggered.
static void fireStartSignal() {
  digitalWrite(SIGNAL_PIN, HIGH);     // 5 V USB strobe light via MOSFET
  toneOn = true;                      // audioTask streams the beep to the MAX98357
  signalOffMs = millis() + SIGNAL_MS;
}

// ── Heat radio policy (Wi-Fi/BLE coexistence) ────────────────────────────────
// During a heat, drop Wi-Fi to max modem-sleep so the shared 2.4 GHz radio
// favours the BLE scan (finish capture). The station stays associated, so the
// TCP press stream keeps flowing; on-chip µs timestamps keep splits exact.
static void heatRadioBegin() {
  lastPressMs = millis();
  if (heatActive) return;
  heatActive  = true;
  heatStartMs = millis();
  if (wifiEnabled) {
    WiFi.setSleep(WIFI_PS_MAX_MODEM);
    setStatus("heat: Wi-Fi modem-sleep (BLE priority)");
  }
}

// Restore full-rate Wi-Fi once the heat has gone quiet (or the safety cap is hit).
static void heatRadioEnd() {
  if (!heatActive) return;
  heatActive = false;
  if (wifiEnabled) {
    WiFi.setSleep(WIFI_PS_NONE);
    setStatus("heat done: Wi-Fi full-rate");
  }
}

// Audio task — when toneOn, streams a SINE beep (stereo, same sample on L+R) to
// the MAX98357 over I2S. I2S.write() blocks on the DMA buffer, so it lives in its
// own task and never stalls press handling. Silence = simply not writing.
static void audioTask(void *) {
  const int PERIOD = SAMPLE_RATE / TONE_HZ;         // samples per cycle (e.g. 16)
  const int16_t AMP = 9000;                         // ~27% of full scale
  int16_t sine[PERIOD];
  for (int i = 0; i < PERIOD; i++)
    sine[i] = (int16_t)(AMP * sinf(2.0f * (float)PI * i / PERIOD));
  const int FRAMES = 128;
  int16_t buf[FRAMES * 2];                          // stereo interleaved L,R
  int phase = 0;
  for (;;) {
    if (toneOn) {
      for (int i = 0; i < FRAMES; i++) {
        int16_t s = sine[phase];
        buf[2 * i]     = s;                         // left
        buf[2 * i + 1] = s;                         // right
        if (++phase >= PERIOD) phase = 0;
      }
      i2s.write((uint8_t *)buf, sizeof(buf));
    } else {
      phase = 0;
      vTaskDelay(pdMS_TO_TICKS(10));
    }
  }
}

// Parse "aa:bb:cc:dd:ee:ff" into 6 bytes.
static bool parseMac(const String &s, uint8_t out[6]) {
  int v[6];
  if (sscanf(s.c_str(), "%x:%x:%x:%x:%x:%x", &v[0],&v[1],&v[2],&v[3],&v[4],&v[5]) != 6) return false;
  for (int i = 0; i < 6; i++) out[i] = (uint8_t)v[i];
  return true;
}

// Handle one inbound command line from the host (serial or TCP).
static void handleCommand(const String &line) {
  if (line.startsWith("STARTER\t")) {
    uint8_t m[6];
    if (parseMac(line.substring(8), m)) {
      memcpy(starterMac, m, 6);
      starterSet = true;
      prefs.begin("cfg", false);
      prefs.putBytes("starter", starterMac, 6);
      prefs.end();
    }
  }
}

// Feed one received char into a line buffer; dispatch on newline.
static void feedCmd(String &buf, char c) {
  if (c == '\n') { handleCommand(buf); buf = ""; }
  else if (c != '\r') { buf += c; if (buf.length() > 80) buf = ""; }
}

// Read any pending command bytes from both transports (host -> gateway).
static void pollCommands() {
  static String serBuf, tcpBuf;
  while (Serial.available()) feedCmd(serBuf, (char)Serial.read());
  if (wifiEnabled && tcpClient && tcpClient.connected())
    while (tcpClient.available()) feedCmd(tcpBuf, (char)tcpClient.read());
}

// I/O task — emits each press the INSTANT it's enqueued (blocking receive),
// and services the TCP client + periodic Wi-Fi status. Runs at higher priority
// than loop(), decoupled from the 1 s blocking BLE scan: the old in-loop drain
// could hold a press for up to a full scan window (~1 s), which made the live
// display start ~1 s late. On-chip press timestamps (e.ts) were always correct;
// this fixes only the transmit latency / live-clock lag.
static void ioTask(void *) {
  PressEvt e;
  char line[96];
  for (;;) {
    if (xQueueReceive(pressQ, &e, pdMS_TO_TICKS(50)) == pdTRUE) {
      if (isNewPress(e.mac, e.packetId)) {
        snprintf(line, sizeof(line),
                 "PRESS\t%02x:%02x:%02x:%02x:%02x:%02x\t%u\t%d\t%d\t%lld\n",
                 e.mac[0], e.mac[1], e.mac[2], e.mac[3], e.mac[4], e.mac[5],
                 e.button, e.packetId, e.rssi, (long long)e.ts);
        emitLine(line);
        if (heatActive) lastPressMs = millis();   // keep the heat alive while presses keep arriving
        if (starterSet && memcmp(e.mac, starterMac, 6) == 0) {
          fireStartSignal();
          heatRadioBegin();                        // starter press → hand the radio to BLE for the heat
        }
      }
    }
    pollCommands();                                   // host -> gateway (e.g. STARTER mac)
    if (signalOffMs && (int32_t)(millis() - signalOffMs) >= 0) {  // auto-off the start signal
      digitalWrite(SIGNAL_PIN, LOW);  // light off
      toneOn = false;                 // stop the I2S beep
      signalOffMs = 0;
    }
    // Heat over (quiet for HEAT_QUIET_MS, or the safety cap hit) → give Wi-Fi its slots back.
    if (heatActive &&
        ((uint32_t)(millis() - lastPressMs) > HEAT_QUIET_MS ||
         (uint32_t)(millis() - heatStartMs) > HEAT_MAX_MS)) {
      heatRadioEnd();
    }
    serviceTcp();
    if (millis() - lastStatusMs > 10000) { lastStatusMs = millis(); reportCurrentStatus(); }
  }
}

void loop() {
  if (scanRequested) { scanRequested = false; doWifiScan(); }  // Wi-Fi scan for provisioning
  BLEScan *scan = BLEDevice::getScan();
  scan->start(SCAN_SECONDS, false); // blocks ~1s; clears stored results first
  scan->clearResults();
}
