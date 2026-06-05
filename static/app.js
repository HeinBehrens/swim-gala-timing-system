/* ============================================================
   SwimTimer Pro — Complete Application Logic
   ============================================================ */

class SwimTimerApp {
  constructor() {
    this.ws = null;
    this.raceState = 'idle';
    this.startTime = null;
    this.elapsed = 0;
    this.laneTimes = { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
    this.laneFinished = { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false };
    this.batteries = { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
    this.clockRAF = null;
    this.audioCtx = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 10000;
    this.reconnectTimer = null;
    this.settingsOpen = false;
    this.enrolling = false;
    this.init();
  }

  init() {
    this.cacheDOM();
    this.bindUIEvents();
    this.bindKeyboardShortcuts();
    this.connectWebSocket();
    this.runEntranceAnimations();
    this.updateButtonStates();
  }

  cacheDOM() {
    this.els = {
      masterTimer: document.getElementById('master-timer'),
      raceStateBadge: document.getElementById('race-state-badge'),
      stateText: document.querySelector('#race-state-badge .state-text'),
      stateDot: document.querySelector('#race-state-badge .state-dot'),
      eventInput: document.getElementById('event-number'),
      heatInput: document.getElementById('heat-number'),
      btnPrepare: document.getElementById('btn-prepare'),
      btnStart: document.getElementById('btn-start'),
      btnStop: document.getElementById('btn-stop'),
      btnReset: document.getElementById('btn-reset'),
      btnExport: document.getElementById('btn-export'),
      dashboard: document.querySelector('.dashboard'),
      laneGrid: document.getElementById('lane-grid'),
      laneCards: document.querySelectorAll('.lane-card'),
      resultsPanel: document.getElementById('results-panel'),
      resultsTbody: document.getElementById('results-tbody'),
      settingsPanel: document.getElementById('settings-panel'),
      settingsOverlay: document.getElementById('settings-overlay'),
      settingsToggle: document.getElementById('settings-toggle-btn'),
      settingsClose: document.getElementById('settings-close-btn'),
      bleStatus: document.getElementById('ble-status'),
      wifiStatus: document.getElementById('wifi-status'),
      toastContainer: document.getElementById('toast-container'),
      btnSimStart: document.getElementById('btn-sim-start'),
      btnExportDo3: document.getElementById('btn-export-do3'),
      btnExportLif: document.getElementById('btn-export-lif'),
      btnReenroll: document.getElementById('btn-reenroll'),
      enrollStatus: document.getElementById('enroll-status'),
      btnWifiProv: document.getElementById('btn-wifi-prov'),
      wifiSsid: document.getElementById('wifi-ssid'),
      wifiPass: document.getElementById('wifi-pass'),
      wifiProvStatus: document.getElementById('wifi-prov-status'),
    };
  }

  bindUIEvents() {
    // Control buttons
    this.els.btnPrepare.addEventListener('click', () => this.prepareRace());
    this.els.btnStart.addEventListener('click', () => this.startRace());
    this.els.btnStop.addEventListener('click', () => this.stopRace());
    this.els.btnReset.addEventListener('click', () => this.resetRace());
    this.els.btnExport.addEventListener('click', () => this.exportResults());

    // Settings panel
    this.els.settingsToggle.addEventListener('click', () => this.toggleSettings());
    this.els.settingsClose.addEventListener('click', () => this.closeSettings());
    this.els.settingsOverlay.addEventListener('click', () => this.closeSettings());

    // Simulation buttons
    this.els.btnSimStart.addEventListener('click', () => {
      this.sendAction('simulate_start', {});
    });

    document.querySelectorAll('.btn-sim-lane').forEach(btn => {
      btn.addEventListener('click', () => {
        const lane = parseInt(btn.dataset.simLane, 10);
        this.sendAction('simulate_lane', { lane });
      });
    });

    // Meet import (Lenex) — friendly drag-drop + browse picker
    this.setupMeetImport();

    // Export buttons
    this.els.btnExportDo3.addEventListener('click', () => this.sendAction('export_do3', {}));
    this.els.btnExportLif.addEventListener('click', () => this.sendAction('export_lif', {}));

    // Configure ESP32 Wi-Fi over Bluetooth (Web Bluetooth)
    if (this.els.btnWifiProv) {
      this.els.btnWifiProv.addEventListener('click', () => this.configureWifiOverBluetooth());
    }

    // Re-enroll buttons (admin) — confirm to avoid an accidental wipe of the lane map
    if (this.els.btnReenroll) {
      this.els.btnReenroll.addEventListener('click', () => {
        if (this.enrolling) {
          this.sendAction('cancel_enroll', {});
          return;
        }
        const ok = window.confirm(
          'Re-enroll all buttons?\n\nThis clears the current lane mapping. You will press each button in order: Lane 1 → … → Lane 6 → Starter.'
        );
        if (ok) this.sendAction('start_enroll', {});
      });
    }

    // MAC address config inputs
    document.querySelectorAll('.mac-input').forEach(input => {
      input.addEventListener('change', () => {
        const lane = input.dataset.lane;
        const value = input.value.trim();
        if (lane) {
          this.sendAction('set_config', { key: `mac_lane_${lane}`, value });
        }
      });
    });

    // Starter MAC
    const starterMac = document.getElementById('mac-starter');
    if (starterMac) {
      starterMac.addEventListener('change', () => {
        this.sendAction('set_config', { key: 'mac_starter', value: starterMac.value.trim() });
      });
    }

    // HA config
    const haUrl = document.getElementById('ha-url');
    const haToken = document.getElementById('ha-token');
    if (haUrl) {
      haUrl.addEventListener('change', () => {
        this.sendAction('set_config', { key: 'ha_url', value: haUrl.value.trim() });
      });
    }
    if (haToken) {
      haToken.addEventListener('change', () => {
        this.sendAction('set_config', { key: 'ha_token', value: haToken.value.trim() });
      });
    }

    // Ripple effect on all buttons
    document.querySelectorAll('.btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.initAudio();
        const rect = btn.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        btn.style.setProperty('--ripple-x', `${x}%`);
        btn.style.setProperty('--ripple-y', `${y}%`);
        btn.classList.remove('ripple');
        void btn.offsetWidth;
        btn.classList.add('ripple');
        setTimeout(() => btn.classList.remove('ripple'), 600);
      });
    });

    // Event/Heat input changes
    this.els.eventInput.addEventListener('change', () => {
      this.sendAction('set_event_heat', {
        event: parseInt(this.els.eventInput.value, 10) || 1,
        heat: parseInt(this.els.heatInput.value, 10) || 1,
      });
    });
    this.els.heatInput.addEventListener('change', () => {
      this.sendAction('set_event_heat', {
        event: parseInt(this.els.eventInput.value, 10) || 1,
        heat: parseInt(this.els.heatInput.value, 10) || 1,
      });
    });
  }

  bindKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Don't fire shortcuts if typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (this.raceState === 'ready') {
            this.startRace();
          } else if (this.raceState === 'running') {
            this.stopRace();
          }
          break;
        case 'r':
        case 'R':
          this.resetRace();
          break;
        case 'p':
        case 'P':
          this.prepareRace();
          break;
        case 'e':
        case 'E':
          this.exportResults();
          break;
        case 's':
        case 'S':
          this.sendAction('simulate_start', {});
          break;
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
          this.sendAction('simulate_lane', { lane: parseInt(e.key, 10) });
          break;
        case 'Escape':
          this.closeSettings();
          break;
      }
    });
  }

  /* ── WebSocket ── */

  connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.showToast('Connected to server', 'success');
      this.sendAction('get_state', {});
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (err) {
        console.error('Failed to parse message:', err);
      }
    };

    this.ws.onclose = () => {
      this.showToast('Connection lost — reconnecting...', 'warning');
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      if (this.ws) this.ws.close();
    };
  }

  scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connectWebSocket(), delay);
  }

  sendAction(action, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action, ...payload }));
    } else {
      this.showToast('Not connected to server', 'error');
    }
  }

  /* ── Message Handling ── */

  handleMessage(data) {
    switch (data.type) {
      case 'race_state':
        this.setRaceState(data.state, data.start_time, data.elapsed);
        break;

      case 'lane_time':
        this.handleLaneTime(data.lane, data.time, data.is_finish);
        break;

      case 'connection_status':
        this.updateConnectionStatus(data.ble, data.wifi, data.wifi_detail);
        break;

      case 'battery_status':
        this.updateBattery(data.lane, data.level);
        break;

      case 'full_state':
        this.hydrateFullState(data);
        break;

      case 'config':
        this.hydrateConfig(data);
        break;

      case 'toast':
        this.showToast(data.message, data.level || 'info');
        break;

      case 'export_ready':
        this.showToast(`Export ready: ${data.filename}`, 'success');
        if (data.url) {
          const a = document.createElement('a');
          a.href = data.url;
          a.download = data.filename || 'export';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
        break;

      case 'enroll':
        this.handleEnroll(data);
        break;

      default:
        console.log('Unknown message type:', data.type, data);
    }
  }

  handleEnroll(data) {
    switch (data.status) {
      case 'started':
        this.enrolling = true;
        this.updateReenrollButton();
        this.setEnrollStatus(`Registering… press the ${data.slot} button (1/${data.total}).`);
        break;
      case 'assigned':
        if (data.role && data.role.startsWith('lane')) {
          const input = document.getElementById(`mac-lane-${data.role.replace('lane', '')}`);
          if (input) input.value = data.mac;
        } else if (data.role === 'start') {
          const el = document.getElementById('mac-starter');
          if (el) el.value = data.mac;
        }
        this.showToast(`${data.slot} ✓ ${data.mac}`, 'success');
        if (data.next) this.setEnrollStatus(`Press the ${data.next} button (${data.index + 1}/${data.total}).`);
        break;
      case 'done':
        this.enrolling = false;
        this.updateReenrollButton();
        this.setEnrollStatus('All buttons registered ✓');
        this.showToast('Re-enrollment complete', 'success');
        break;
      case 'cancelled':
        this.enrolling = false;
        this.updateReenrollButton();
        this.setEnrollStatus('Re-enrollment cancelled.');
        this.showToast('Re-enrollment cancelled', 'info');
        break;
    }
  }

  setEnrollStatus(text) {
    if (this.els.enrollStatus) this.els.enrollStatus.textContent = text;
  }

  updateReenrollButton() {
    const btn = this.els.btnReenroll;
    if (!btn) return;
    btn.textContent = this.enrolling ? 'Cancel Re-enroll' : 'Re-enroll Buttons';
    btn.classList.toggle('enrolling', this.enrolling);
  }

  setWifiProvStatus(text) {
    if (this.els.wifiProvStatus) this.els.wifiProvStatus.textContent = text;
  }

  // Send Wi-Fi credentials to the ESP32 gateway over Web Bluetooth. The ESP saves
  // them to flash and joins the network — must match the firmware's GATT UUIDs.
  async configureWifiOverBluetooth() {
    if (!navigator.bluetooth) {
      this.showToast('Web Bluetooth not available — open the dashboard in Chrome or Edge at http://localhost:8000', 'error');
      return;
    }
    const ssid = (this.els.wifiSsid.value || '').trim();
    const pass = this.els.wifiPass.value || '';
    if (!ssid) { this.showToast('Enter the Wi-Fi network name (SSID)', 'error'); return; }

    const SVC = 'a1b2c3d4-0001-4a5b-8c6d-1234567890ab';
    const CREDS = 'a1b2c3d4-0002-4a5b-8c6d-1234567890ab';
    const STATUS = 'a1b2c3d4-0003-4a5b-8c6d-1234567890ab';

    try {
      this.setWifiProvStatus('Select “SwimTimer-Gateway” in the Bluetooth prompt…');
      // Match by name (advertised in the main packet) OR the service UUID
      // (advertised in the scan response) — robust either way.
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'SwimTimer' }, { services: [SVC] }],
        optionalServices: [SVC],
      });
      this.setWifiProvStatus('Connecting to ' + (device.name || 'gateway') + '…');
      const server = await device.gatt.connect();
      const svc = await server.getPrimaryService(SVC);

      // Listen for status notifications from the ESP (connecting / connected / failed).
      try {
        const statusCh = await svc.getCharacteristic(STATUS);
        await statusCh.startNotifications();
        statusCh.addEventListener('characteristicvaluechanged', (e) => {
          const v = new TextDecoder().decode(e.target.value);
          this.setWifiProvStatus('ESP32: ' + v);
          if (/connected/i.test(v)) this.showToast('ESP32 joined Wi-Fi: ' + v, 'success');
          else if (/failed/i.test(v)) this.showToast('ESP32 could not join: ' + v, 'error');
        });
      } catch (e) { /* status characteristic optional */ }

      const credsCh = await svc.getCharacteristic(CREDS);
      await credsCh.writeValue(new TextEncoder().encode(ssid + '\t' + pass));
      this.setWifiProvStatus('Credentials sent — ESP32 is connecting to “' + ssid + '”…');
      this.showToast('Wi-Fi sent to ESP32 over Bluetooth', 'success');
      this.els.wifiPass.value = '';
    } catch (e) {
      this.setWifiProvStatus('Bluetooth failed: ' + e.message);
      this.showToast('Bluetooth provisioning failed: ' + e.message, 'error');
    }
  }

  hydrateFullState(data) {
    // Set event/heat
    if (data.event != null) this.els.eventInput.value = data.event;
    if (data.heat != null) this.els.heatInput.value = data.heat;
    this.setEventName(data.event_name || '');

    // Set race state
    if (data.state) {
      this.setRaceState(data.state, data.start_time, data.elapsed);
    }

    // Set lane times + swimmer names
    if (data.lanes) {
      for (const [lane, info] of Object.entries(data.lanes)) {
        const laneNum = parseInt(lane, 10);
        this.setLaneSwimmer(laneNum, info.name || '', info.club || '');
        if (info.time != null) {
          this.laneTimes[laneNum] = info.time;
          this.laneFinished[laneNum] = !!info.finished;
          this.updateLaneCard(laneNum, info.time, !!info.finished);
        }
        if (info.battery != null) {
          this.updateBattery(laneNum, info.battery);
        }
      }
    }

    // Connection statuses
    if (data.ble != null || data.wifi != null) {
      this.updateConnectionStatus(data.ble, data.wifi, data.wifi_detail);
    }

    // Config
    if (data.config) {
      this.hydrateConfig(data.config);
    }
  }

  hydrateConfig(config) {
    if (!config) return;
    for (let i = 1; i <= 6; i++) {
      const key = `mac_lane_${i}`;
      if (config[key]) {
        const input = document.getElementById(`mac-lane-${i}`);
        if (input) input.value = config[key];
      }
    }
    if (config.mac_starter) {
      const el = document.getElementById('mac-starter');
      if (el) el.value = config.mac_starter;
    }
    if (config.ha_url) {
      const el = document.getElementById('ha-url');
      if (el) el.value = config.ha_url;
    }
    if (config.ha_token) {
      const el = document.getElementById('ha-token');
      if (el) el.value = config.ha_token;
    }
  }

  /* ── Race State ── */

  setRaceState(state, serverStartTime, serverElapsed) {
    const prevState = this.raceState;
    this.raceState = state;

    // Update state badge
    const badge = this.els.raceStateBadge;
    badge.className = 'race-state-badge';
    badge.classList.add(`state-${state}`);
    this.els.stateText.textContent = state.toUpperCase();

    // Update master timer appearance
    this.els.masterTimer.classList.toggle('running', state === 'running');

    // Handle clock
    if (state === 'running') {
      if (serverStartTime) {
        this.startTime = serverStartTime;
      } else if (serverElapsed != null) {
        this.startTime = Date.now() / 1000 - serverElapsed;
      } else if (!this.startTime) {
        this.startTime = Date.now() / 1000;
      }
      this.startClock();

      // Update lane statuses to "Timing" for unfinished lanes
      for (let i = 1; i <= 6; i++) {
        if (!this.laneFinished[i]) {
          this.setLaneStatus(i, 'timing');
        }
      }

      // Play start beep if transitioning from ready
      if (prevState === 'ready') {
        this.playStartBeep();
      }
    } else {
      this.stopClock();
      if (state === 'completed') {
        if (serverElapsed != null) {
          this.elapsed = serverElapsed;
          this.els.masterTimer.textContent = this.formatTime(this.elapsed);
        }
        this.updateResults();
      }
    }

    // Once finished, float the results up above the lane grid (flex order).
    if (this.els.dashboard) this.els.dashboard.classList.toggle('race-complete', state === 'completed');

    if (state === 'idle') {
      this.els.masterTimer.textContent = '00:00.00';
      this.resetLaneCards();
      this.els.resultsPanel.classList.add('hidden');
    }

    this.updateButtonStates();
  }

  updateButtonStates() {
    const s = this.raceState;
    this.els.btnPrepare.disabled = s === 'running';
    this.els.btnStart.disabled = s !== 'ready';
    this.els.btnStop.disabled = s !== 'running';
    this.els.btnReset.disabled = s === 'idle';
    this.els.btnExport.disabled = s !== 'completed';

    // Pulsing start button when ready
    this.els.btnStart.classList.toggle('pulsing', s === 'ready');
  }

  prepareRace() {
    this.sendAction('prepare', {
      event: parseInt(this.els.eventInput.value, 10) || 1,
      heat: parseInt(this.els.heatInput.value, 10) || 1,
    });
  }

  startRace() {
    if (this.raceState === 'ready') {
      this.sendAction('start', {});
    }
  }

  stopRace() {
    if (this.raceState === 'running') {
      this.sendAction('stop', {});
    }
  }

  resetRace() {
    this.sendAction('reset', {});
  }

  exportResults() {
    this.sendAction('export', {});
  }

  /* ── Clock ── */

  startClock() {
    if (this.clockRAF) cancelAnimationFrame(this.clockRAF);

    const tick = () => {
      if (this.raceState !== 'running') return;
      const now = Date.now() / 1000;
      this.elapsed = now - this.startTime;
      this.els.masterTimer.textContent = this.formatTime(this.elapsed);

      // Update running lane timers
      for (let i = 1; i <= 6; i++) {
        if (!this.laneFinished[i]) {
          const laneTimerEl = this.getLaneTimerEl(i);
          if (laneTimerEl) {
            laneTimerEl.textContent = this.formatTime(this.elapsed);
          }
        }
      }

      this.clockRAF = requestAnimationFrame(tick);
    };

    this.clockRAF = requestAnimationFrame(tick);
  }

  stopClock() {
    if (this.clockRAF) {
      cancelAnimationFrame(this.clockRAF);
      this.clockRAF = null;
    }
  }

  formatTime(seconds) {
    if (seconds == null || seconds === undefined || isNaN(seconds)) return '--:--.--';
    const totalSeconds = Math.max(0, seconds);
    const mins = Math.floor(totalSeconds / 60);
    const secs = Math.floor(totalSeconds % 60);
    const hundredths = Math.floor((totalSeconds % 1) * 100);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  /* ── Lane Management ── */

  getLaneCard(lane) {
    return document.querySelector(`.lane-card[data-lane="${lane}"]`);
  }

  getLaneTimerEl(lane) {
    const card = this.getLaneCard(lane);
    return card ? card.querySelector('.lane-timer') : null;
  }

  setLaneStatus(lane, status) {
    const card = this.getLaneCard(lane);
    if (!card) return;
    const statusEl = card.querySelector('.lane-status');
    if (!statusEl) return;

    statusEl.className = 'lane-status';
    card.classList.remove('timing', 'finished');

    switch (status) {
      case 'waiting':
        statusEl.classList.add('status-waiting');
        statusEl.textContent = 'Waiting';
        break;
      case 'timing':
        statusEl.classList.add('status-timing');
        statusEl.textContent = 'Timing...';
        card.classList.add('timing');
        break;
      case 'finished':
        statusEl.classList.add('status-finished');
        statusEl.textContent = 'Finished';
        card.classList.add('finished');
        break;
      case 'nt':
        statusEl.classList.add('status-nt');
        statusEl.textContent = 'NT';
        break;
    }
  }

  handleLaneTime(lane, time, isFinish) {
    if (isFinish) {
      this.laneTimes[lane] = time;
      this.laneFinished[lane] = true;
      this.updateLaneCard(lane, time, true);
      this.playFinishChime(lane);
    } else {
      this.laneTimes[lane] = time;
      this.updateLaneCard(lane, time, false);
    }
  }

  // Show the swimmer's name (and club) on a lane card. The element is created on
  // demand so we don't have to hand-edit all six lane cards in the HTML.
  setLaneSwimmer(lane, name, club) {
    const card = this.getLaneCard(lane);
    if (!card) return;
    let el = card.querySelector('.lane-swimmer');
    if (!el) {
      el = document.createElement('div');
      el.className = 'lane-swimmer';
      const header = card.querySelector('.lane-header');
      if (header) header.insertAdjacentElement('afterend', el);
      else card.insertBefore(el, card.firstChild);
    }
    if (name) {
      el.innerHTML = `<span class="swimmer-name"></span><span class="swimmer-club"></span>`;
      el.querySelector('.swimmer-name').textContent = name;
      el.querySelector('.swimmer-club').textContent = club || '';
      el.classList.remove('empty');
    } else {
      el.textContent = '';
      el.classList.add('empty');
    }
  }

  // Show the event name (from events.csv) in the event/heat bar.
  setEventName(name) {
    let el = document.getElementById('event-name-display');
    if (!el) {
      const bar = document.querySelector('.event-heat-bar');
      if (!bar) return;
      el = document.createElement('div');
      el.id = 'event-name-display';
      el.className = 'event-name-display';
      bar.appendChild(el);
    }
    el.textContent = name || '';
    el.style.display = name ? '' : 'none';
  }

  // Meet import: drag-drop / browse a Lenex file, upload it, show the result.
  setupMeetImport() {
    const drop = document.getElementById('import-drop');
    const input = document.getElementById('import-file');
    const nameEl = document.getElementById('import-file-name');
    const importBtn = document.getElementById('btn-import-meet');
    const reloadBtn = document.getElementById('btn-reload-roster');
    const statusEl = document.getElementById('import-status');
    if (!drop || !input || !importBtn) return;
    let chosen = null;

    const setFile = (file) => {
      chosen = file || null;
      nameEl.textContent = chosen ? chosen.name : 'Drop a .lef / .lxf file here';
      drop.classList.toggle('has-file', !!chosen);
      importBtn.disabled = !chosen;
      if (statusEl) statusEl.textContent = '';
    };

    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => setFile(input.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]); });

    importBtn.addEventListener('click', async () => {
      if (!chosen) return;
      importBtn.disabled = true;
      if (statusEl) { statusEl.className = 'import-status'; statusEl.textContent = 'Importing…'; }
      try {
        const buf = await chosen.arrayBuffer();
        const res = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Import failed');
        const s = data.summary;
        if (statusEl) { statusEl.className = 'import-status ok'; statusEl.textContent = `✓ ${s.entries} swimmers · ${s.eventCount} events · ${s.heatCount} heats`; }
      } catch (err) {
        if (statusEl) { statusEl.className = 'import-status err'; statusEl.textContent = '✗ ' + err.message; }
      } finally {
        importBtn.disabled = !chosen;
      }
    });

    if (reloadBtn) reloadBtn.addEventListener('click', () => this.sendAction('reload_roster', {}));
  }

  updateLaneCard(lane, time, isFinish) {
    const card = this.getLaneCard(lane);
    if (!card) return;

    const timerEl = card.querySelector('.lane-timer');
    if (timerEl) {
      timerEl.textContent = this.formatTime(time);
    }

    if (isFinish) {
      this.setLaneStatus(lane, 'finished');
      // Trigger flash animation
      card.classList.remove('finished');
      void card.offsetWidth;
      card.classList.add('finished');

      // Calculate and show place
      this.updatePlaces();
    }
  }

  updatePlaces() {
    const finishedLanes = [];
    for (let i = 1; i <= 6; i++) {
      if (this.laneFinished[i] && this.laneTimes[i] != null) {
        finishedLanes.push({ lane: i, time: this.laneTimes[i] });
      }
    }

    finishedLanes.sort((a, b) => a.time - b.time);

    // Clear all place badges first
    for (let i = 1; i <= 6; i++) {
      const card = this.getLaneCard(i);
      if (!card) continue;
      const badge = card.querySelector('.lane-place-badge');
      if (badge) {
        badge.classList.add('hidden');
        badge.classList.remove('visible', 'place-1', 'place-2', 'place-3', 'place-other');
      }
    }

    finishedLanes.forEach((entry, index) => {
      const place = index + 1;
      const card = this.getLaneCard(entry.lane);
      if (!card) return;
      const badge = card.querySelector('.lane-place-badge');
      if (!badge) return;

      const ordinal = this.getOrdinal(place);
      badge.textContent = ordinal;
      badge.classList.remove('hidden');

      if (place === 1) badge.classList.add('place-1');
      else if (place === 2) badge.classList.add('place-2');
      else if (place === 3) badge.classList.add('place-3');
      else badge.classList.add('place-other');

      // Animate in with slight delay
      setTimeout(() => badge.classList.add('visible'), 50);
    });
  }

  getOrdinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  resetLaneCards() {
    for (let i = 1; i <= 6; i++) {
      this.laneTimes[i] = null;
      this.laneFinished[i] = false;
      this.setLaneStatus(i, 'waiting');
      const timerEl = this.getLaneTimerEl(i);
      if (timerEl) timerEl.textContent = '--:--.--';
      const card = this.getLaneCard(i);
      if (card) {
        const badge = card.querySelector('.lane-place-badge');
        if (badge) {
          badge.classList.add('hidden');
          badge.classList.remove('visible', 'place-1', 'place-2', 'place-3', 'place-other');
        }
      }
    }
  }

  /* ── Results ── */

  updateResults() {
    const finishedLanes = [];
    for (let i = 1; i <= 6; i++) {
      if (this.laneFinished[i] && this.laneTimes[i] != null) {
        finishedLanes.push({ lane: i, time: this.laneTimes[i] });
      }
    }

    finishedLanes.sort((a, b) => a.time - b.time);

    const winnerTime = finishedLanes.length > 0 ? finishedLanes[0].time : 0;

    const tbody = this.els.resultsTbody;
    tbody.innerHTML = '';

    finishedLanes.forEach((entry, index) => {
      const place = index + 1;
      const delta = entry.time - winnerTime;
      const tr = document.createElement('tr');

      const placeTd = document.createElement('td');
      placeTd.classList.add('place-cell');
      if (place === 1) placeTd.classList.add('gold');
      else if (place === 2) placeTd.classList.add('silver');
      else if (place === 3) placeTd.classList.add('bronze');
      placeTd.textContent = this.getOrdinal(place);
      tr.appendChild(placeTd);

      const laneTd = document.createElement('td');
      laneTd.textContent = entry.lane;
      tr.appendChild(laneTd);

      const timeTd = document.createElement('td');
      timeTd.textContent = this.formatTime(entry.time);
      tr.appendChild(timeTd);

      const deltaTd = document.createElement('td');
      deltaTd.classList.add('delta-cell');
      deltaTd.textContent = place === 1 ? '—' : `+${this.formatTime(delta)}`;
      tr.appendChild(deltaTd);

      tbody.appendChild(tr);
    });

    // Add NT entries for unfinished lanes
    for (let i = 1; i <= 6; i++) {
      if (!this.laneFinished[i] || this.laneTimes[i] == null) {
        const tr = document.createElement('tr');

        const placeTd = document.createElement('td');
        placeTd.classList.add('place-cell');
        placeTd.textContent = '—';
        tr.appendChild(placeTd);

        const laneTd = document.createElement('td');
        laneTd.textContent = i;
        tr.appendChild(laneTd);

        const timeTd = document.createElement('td');
        timeTd.textContent = 'NT';
        tr.appendChild(timeTd);

        const deltaTd = document.createElement('td');
        deltaTd.classList.add('delta-cell');
        deltaTd.textContent = '';
        tr.appendChild(deltaTd);

        tbody.appendChild(tr);

        this.setLaneStatus(i, 'nt');
      }
    }

    this.els.resultsPanel.classList.remove('hidden');
  }

  /* ── Connection Status ── */

  updateConnectionStatus(ble, wifi, wifiDetail) {
    if (ble != null) {
      const dot = this.els.bleStatus.querySelector('.dot');
      dot.className = 'dot';
      if (ble === true || ble === 'connected') {
        dot.classList.add('dot-connected');
      } else if (ble === false || ble === 'disconnected') {
        dot.classList.add('dot-disconnected');
      } else {
        dot.classList.add('dot-unknown');
      }
    }
    if (wifi != null && this.els.wifiStatus) {
      const dot = this.els.wifiStatus.querySelector('.dot');
      dot.className = 'dot';
      if (wifi === true || wifi === 'connected') {
        dot.classList.add('dot-connected');
      } else if (wifi === 'connecting') {
        dot.classList.add('dot-unknown');
      } else if (wifi === false || wifi === 'failed' || wifi === 'idle' || wifi === 'disconnected') {
        dot.classList.add('dot-disconnected');
      } else {
        dot.classList.add('dot-unknown');
      }
      // Surface SSID / IP / failure reason on hover.
      const base = 'Gateway Wi-Fi Connection';
      this.els.wifiStatus.title = wifiDetail ? `${base} — ${wifiDetail}` : base;
    }
  }

  /* ── Battery ── */

  updateBattery(lane, level) {
    this.batteries[lane] = level;
    const card = this.getLaneCard(lane);
    if (!card) return;
    const indicator = card.querySelector('.battery-indicator');
    const text = card.querySelector('.battery-text');
    if (!indicator || !text) return;

    if (level == null) {
      text.textContent = '--%';
      indicator.className = 'battery-indicator';
      return;
    }

    text.textContent = `${Math.round(level)}%`;
    indicator.classList.remove('low', 'mid', 'high');

    if (level <= 20) {
      indicator.classList.add('low');
    } else if (level <= 50) {
      indicator.classList.add('mid');
    } else {
      indicator.classList.add('high');
    }

    // Update the battery fill rect width based on level
    const fillRect = card.querySelector('.battery-fill');
    if (fillRect) {
      const maxWidth = 14;
      const fillWidth = (level / 100) * maxWidth;
      fillRect.setAttribute('width', String(Math.max(0, fillWidth)));
    }
  }

  /* ── Toast Notifications ── */

  showToast(message, type = 'info') {
    const container = this.els.toastContainer;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const iconMap = {
      info: 'ℹ',
      success: '✓',
      warning: '!',
      error: '✕',
    };

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = iconMap[type] || 'ℹ';
    toast.appendChild(icon);

    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);

    container.appendChild(toast);

    // Auto-remove after 3s
    setTimeout(() => {
      toast.classList.add('removing');
      toast.addEventListener('animationend', () => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      });
    }, 3000);

    // Limit visible toasts to 5
    const toasts = container.querySelectorAll('.toast:not(.removing)');
    if (toasts.length > 5) {
      const oldest = toasts[0];
      oldest.classList.add('removing');
      oldest.addEventListener('animationend', () => {
        if (oldest.parentNode) oldest.parentNode.removeChild(oldest);
      });
    }
  }

  /* ── Settings Panel ── */

  toggleSettings() {
    if (this.settingsOpen) {
      this.closeSettings();
    } else {
      this.openSettings();
    }
  }

  openSettings() {
    this.settingsOpen = true;
    this.els.settingsPanel.classList.add('open');
    this.els.settingsOverlay.classList.add('open');
  }

  closeSettings() {
    this.settingsOpen = false;
    this.els.settingsPanel.classList.remove('open');
    this.els.settingsOverlay.classList.remove('open');
  }

  /* ── Entrance Animations ── */

  runEntranceAnimations() {
    this.els.laneCards.forEach((card, index) => {
      setTimeout(() => {
        card.classList.add('visible');
      }, 100 + index * 100);
    });
  }

  /* ── Audio (Web Audio API) ── */

  initAudio() {
    if (this.audioCtx) return;
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('Web Audio API not available:', e);
    }
  }

  playTone(frequency, startDelay, duration, volume = 0.3) {
    if (!this.audioCtx) this.initAudio();
    if (!this.audioCtx) return;

    const ctx = this.audioCtx;
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);

    const startAt = ctx.currentTime + startDelay;
    gainNode.gain.setValueAtTime(0, startAt);
    gainNode.gain.linearRampToValueAtTime(volume, startAt + 0.01);
    gainNode.gain.setValueAtTime(volume, startAt + duration - 0.02);
    gainNode.gain.linearRampToValueAtTime(0, startAt + duration);

    oscillator.start(startAt);
    oscillator.stop(startAt + duration);
  }

  playStartBeep() {
    // Three short beeps at 440Hz, 100ms each, 400ms apart
    // Then one long beep at 880Hz, 500ms
    this.playTone(440, 0, 0.1, 0.3);
    this.playTone(440, 0.4, 0.1, 0.3);
    this.playTone(440, 0.8, 0.1, 0.3);
    this.playTone(880, 1.2, 0.5, 0.4);
  }

  playFinishChime(lane) {
    // A pleasant two-note ascending chime
    this.playTone(523, 0, 0.15, 0.2);      // C5
    this.playTone(659, 0.15, 0.15, 0.25);   // E5
  }
}

/* ── Initialize on DOM ready ── */
document.addEventListener('DOMContentLoaded', () => {
  window.swimTimerApp = new SwimTimerApp();
});
