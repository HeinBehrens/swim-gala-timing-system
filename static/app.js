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
    this.laneSplits = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }; // cumulative split times per lane
    this.laneSwimmers = {}; // lane -> display name (for the results table)
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
      scheduleSelect: document.getElementById('schedule-select'),
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
      btnReenroll: document.getElementById('btn-reenroll'),
      btnRestartEsp: document.getElementById('btn-restart-esp'),
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
        // One tap = one wall touch, fired by N "buttons" (watches). The server groups
        // presses inside its split window into a single touch and consolidates them.
        const watches = parseInt(document.getElementById('sim-watches')?.value || '1', 10);
        for (let i = 0; i < watches; i++) this.sendAction('simulate_lane', { lane });
      });
    });

    // Timing & Splits settings: pool length + per-length splits toggle (saved server-side).
    const poolLen = document.getElementById('pool-length');
    if (poolLen) poolLen.addEventListener('change', () =>
      this.sendAction('set_config', { key: 'pool_length_m', value: String(poolLen.value || '25') }));
    const collectSplits = document.getElementById('collect-splits');
    if (collectSplits) collectSplits.addEventListener('change', () =>
      this.sendAction('set_config', { key: 'collect_splits', value: collectSplits.checked ? '1' : '0' }));
    const reviewToggle = document.getElementById('review-before-export');
    if (reviewToggle) reviewToggle.addEventListener('change', () =>
      this.sendAction('set_config', { key: 'review_before_export', value: reviewToggle.checked ? '1' : '0' }));
    // Name-display checkboxes → set_config (any combination).
    for (const [id, key] of [['name-show-first', 'name_show_first'], ['name-show-last-initial', 'name_show_last_initial'], ['name-show-age', 'name_show_age']]) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => this.sendAction('set_config', { key, value: el.checked ? '1' : '0' }));
    }
    // Sport Systems .do3 export: meet number + round (used in the Dolphin file name).
    const dMeet = document.getElementById('dolphin-meet');
    if (dMeet) dMeet.addEventListener('change', () =>
      this.sendAction('set_config', { key: 'dolphin_meet', value: String(dMeet.value || '1') }));
    const dRound = document.getElementById('dolphin-round');
    if (dRound) dRound.addEventListener('change', () =>
      this.sendAction('set_config', { key: 'dolphin_round', value: dRound.value || 'H' }));

    // Review table: confirm writes the .do3 and ends the hold.
    const btnConfirm = document.getElementById('btn-confirm-export');
    if (btnConfirm) btnConfirm.addEventListener('click', () => this.sendAction('confirm_export', {}));

    // Roster: import a start list (Sport Systems .txt / Lenex) + reload.
    this.setupRosterReload();
    this.setupStartListImport();

    // Configure ESP32 Wi-Fi over Bluetooth (Web Bluetooth)
    if (this.els.btnWifiProv) {
      this.els.btnWifiProv.addEventListener('click', () => this.configureWifiOverBluetooth());
    }
    const btnWifiScan = document.getElementById('btn-wifi-scan');
    if (btnWifiScan) {
      btnWifiScan.addEventListener('click', () => this.scanWifiNetworks());
    }

    // Re-enroll buttons (admin) — confirm to avoid an accidental wipe of the lane map
    if (this.els.btnReenroll) {
      this.els.btnReenroll.addEventListener('click', () => {
        if (this.enrolling) {
          this.sendAction('cancel_enroll', {});
          return;
        }
        const n = parseInt(document.getElementById('buttons-per-lane')?.value || '1', 10);
        const per = n > 1 ? ` ${n} buttons per lane (Lane 1 A→${n === 3 ? 'C' : 'B'}, Lane 2 A→…)` : ' each lane';
        const ok = window.confirm(
          `Re-enroll all buttons?\n\nThis clears the current lane mapping. You will press${per}, then the Starter.`
        );
        if (ok) this.sendAction('start_enroll', { buttons_per_lane: n });
      });
    }

    // Test beep — fire the start signal so the operator can check the speaker.
    const btnTestBeep = document.getElementById('btn-test-beep');
    if (btnTestBeep) btnTestBeep.addEventListener('click', () => this.sendAction('test_beep', {}));

    // Restart ESP32 gateway — confirm first (it briefly drops the link).
    if (this.els.btnRestartEsp) {
      this.els.btnRestartEsp.addEventListener('click', () => {
        const ok = window.confirm(
          'Restart the ESP32 gateway?\n\nThe board reboots and the link drops for a few seconds, then reconnects automatically. Do this only between heats.'
        );
        if (ok) this.sendAction('restart_gateway', {});
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

    // Optional 2nd/3rd button MAC inputs per lane (shown when Buttons-per-lane > 1).
    this.setupExtraButtonInputs();


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
    // Schedule dropdown — value is "event-heat"; mirror it into the number inputs
    // and tell the server, reusing the same set_event_heat action.
    if (this.els.scheduleSelect) {
      this.els.scheduleSelect.addEventListener('change', () => {
        const val = this.els.scheduleSelect.value;
        if (!val) return;
        const [ev, ht] = val.split('-').map((n) => parseInt(n, 10));
        if (!ev || !ht) return;
        this.els.eventInput.value = ev;
        this.els.heatInput.value = ht;
        this.sendAction('set_event_heat', { event: ev, heat: ht });
      });
    }
  }

  /* ── Schedule selector ── */
  renderSchedule(schedule, curEvent, curHeat) {
    const sel = this.els.scheduleSelect;
    if (!sel) return;
    if (!Array.isArray(schedule) || schedule.length === 0) {
      sel.innerHTML = '<option value="">— import a meet file —</option>';
      return;
    }
    const cur = `${curEvent}-${curHeat}`;
    let matched = false;
    sel.innerHTML = schedule.map((s) => {
      const val = `${s.event}-${s.heat}`;
      const done = s.completed ? '✓ ' : '';
      const name = s.event_name ? ` — ${s.event_name}` : '';
      const sel = val === cur ? ' selected' : '';
      if (val === cur) matched = true;
      return `<option value="${val}"${sel}>${done}E${s.event} H${s.heat}${name}</option>`;
    }).join('');
    // If the current event/heat isn't in the schedule (manual entry), show it too.
    if (!matched && curEvent != null) {
      const opt = document.createElement('option');
      opt.value = cur;
      opt.textContent = `E${curEvent} H${curHeat} (manual)`;
      opt.selected = true;
      sel.appendChild(opt);
    }
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
        this.handleLaneTime(data.lane, data.time, data.is_finish, data.split_index);
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
          const m = /^lane(\d)([bc])?$/.exec(data.role);
          const id = m ? `mac-lane-${m[1]}${m[2] ? '-' + m[2] : ''}` : null;
          const input = id && document.getElementById(id);
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

  // Firmware provisioning GATT UUIDs (must match esp32_shelly_scanner.ino).
  static get WIFI_GATT() {
    return {
      SVC: 'a1b2c3d4-0001-4a5b-8c6d-1234567890ab',
      CREDS: 'a1b2c3d4-0002-4a5b-8c6d-1234567890ab',
      STATUS: 'a1b2c3d4-0003-4a5b-8c6d-1234567890ab',
      SCAN: 'a1b2c3d4-0004-4a5b-8c6d-1234567890ab',
    };
  }

  // Connect to the gateway's provisioning service, reusing an open connection so
  // Scan + Configure don't each trigger a separate Bluetooth chooser prompt.
  async connectWifiGatt() {
    const G = SwimTimerApp.WIFI_GATT;
    if (this._wifiGatt && this._wifiGatt.device.gatt.connected) return this._wifiGatt;
    this.setWifiProvStatus('Select “SwimTimer-Gateway” in the Bluetooth prompt…');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'SwimTimer' }, { services: [G.SVC] }],
      optionalServices: [G.SVC],
    });
    this.setWifiProvStatus('Connecting to ' + (device.name || 'gateway') + '…');
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(G.SVC);
    // Surface ESP status (connecting / connected / failed) once per connection.
    try {
      const statusCh = await svc.getCharacteristic(G.STATUS);
      await statusCh.startNotifications();
      statusCh.addEventListener('characteristicvaluechanged', (e) => {
        const v = new TextDecoder().decode(e.target.value);
        this.setWifiProvStatus('ESP32: ' + v);
        if (/connected\s+\d/i.test(v)) this.showToast('ESP32 joined Wi-Fi: ' + v, 'success');
        else if (/failed/i.test(v)) this.showToast('ESP32 could not join: ' + v, 'error');
      });
    } catch (e) { /* status characteristic optional */ }
    this._wifiGatt = { device, server, svc };
    return this._wifiGatt;
  }

  // Ask the gateway to scan for nearby 2.4 GHz networks and fill the SSID dropdown.
  async scanWifiNetworks() {
    if (!navigator.bluetooth) {
      this.showToast('Web Bluetooth not available — open the dashboard in Chrome or Edge', 'error');
      return;
    }
    try {
      const { svc } = await this.connectWifiGatt();
      const scanCh = await svc.getCharacteristic(SwimTimerApp.WIFI_GATT.SCAN);
      await scanCh.startNotifications();
      scanCh.addEventListener('characteristicvaluechanged', async (e) => {
        // Read the full value (long read) in case the notify was MTU-truncated.
        let buf = e.target.value;
        try { buf = await scanCh.readValue(); } catch (_) { /* use notify payload */ }
        this.populateSsidList(new TextDecoder().decode(buf));
      });
      await scanCh.writeValue(new Uint8Array([1])); // trigger the scan
      this.setWifiProvStatus('Scanning for Wi-Fi networks…');
    } catch (e) {
      this.setWifiProvStatus('Scan failed: ' + e.message);
      this.showToast('Wi-Fi scan failed: ' + e.message, 'error');
    }
  }

  // Parse "ssid\trssi\n…" into the <datalist> so the SSID box autocompletes.
  populateSsidList(text) {
    const dl = document.getElementById('wifi-ssid-options');
    if (!dl) return;
    const nets = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [ssid, rssi] = l.split('\t');
      return { ssid, rssi: parseInt(rssi || '0', 10) };
    }).filter((n) => n.ssid);
    dl.innerHTML = '';
    for (const n of nets) {
      const o = document.createElement('option');
      o.value = n.ssid;
      o.label = `${n.rssi} dBm`;
      dl.appendChild(o);
    }
    if (nets.length) {
      this.setWifiProvStatus(`Found ${nets.length} network(s) — pick one from the SSID box.`);
      if (!this.els.wifiSsid.value) this.els.wifiSsid.value = nets[0].ssid;
    } else {
      this.setWifiProvStatus('No 2.4 GHz networks found — type the SSID manually.');
    }
  }

  // Send Wi-Fi credentials to the ESP32 gateway over Web Bluetooth. The ESP saves
  // them to flash and joins the network.
  async configureWifiOverBluetooth() {
    if (!navigator.bluetooth) {
      this.showToast('Web Bluetooth not available — open the dashboard in Chrome or Edge at http://localhost:8000', 'error');
      return;
    }
    const ssid = (this.els.wifiSsid.value || '').trim();
    const pass = this.els.wifiPass.value || '';
    if (!ssid) { this.showToast('Enter or scan the Wi-Fi network name (SSID)', 'error'); return; }
    try {
      const { svc } = await this.connectWifiGatt();
      const credsCh = await svc.getCharacteristic(SwimTimerApp.WIFI_GATT.CREDS);
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
    // Keep a finished heat on screen until the NEXT heat is prepared. Clear lane
    // times / places / results only when a new heat is armed ('ready') or the
    // event/heat changes (e.g. Reset auto-advances) — never on completion or idle.
    const heatKey = `${data.event}-${data.heat}`;
    if (data.state === 'ready' || (this._shownHeat != null && heatKey !== this._shownHeat)) {
      this.resetLaneCards();
      if (this.els.resultsPanel) this.els.resultsPanel.classList.add('hidden');
      this.els.masterTimer.textContent = '00:00.00';
    }
    this._shownHeat = heatKey;

    // Set event/heat
    if (data.event != null) this.els.eventInput.value = data.event;
    if (data.heat != null) this.els.heatInput.value = data.heat;
    const rn = document.getElementById('race-number');
    if (rn) rn.textContent = data.race_id != null ? String(data.race_id) : '—';
    this.setEventName(data.event_name || '');
    this.renderSchedule(data.schedule, data.event, data.heat);

    // Set race state
    if (data.state) {
      this.setRaceState(data.state, data.start_time, data.elapsed);
    }

    // Set lane times + swimmer names
    if (data.lanes) {
      for (const [lane, info] of Object.entries(data.lanes)) {
        const laneNum = parseInt(lane, 10);
        this.laneSwimmers[laneNum] = info.name || '';
        this.setLaneSwimmer(laneNum, info.name || '', info.club || '', info.seed || '');
        this.laneSplits[laneNum] = Array.isArray(info.splits) ? info.splits.slice() : [];
        this.renderLaneSplits(laneNum);
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

    // Review-before-export: show the editable table while a finished heat is held.
    this.renderReviewPanel(data.review_pending, data.lanes);

    // Connection statuses
    if (data.ble != null || data.wifi != null) {
      this.updateConnectionStatus(data.ble, data.wifi, data.wifi_detail);
    }

    // Config
    if (data.config) {
      this.hydrateConfig(data.config);
    }
  }

  // Append optional B/C MAC inputs to each lane's settings field. They share no
  // class with the primary .mac-input (so the primary handler ignores them) and
  // stay hidden until Buttons-per-lane is raised.
  setupExtraButtonInputs() {
    for (let i = 1; i <= 6; i++) {
      const field = document.querySelector(`.settings-field[data-lane-cfg="${i}"]`);
      if (!field) continue;
      for (const suffix of ['b', 'c']) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text-input mac-extra';
        input.id = `mac-lane-${i}-${suffix}`;
        input.placeholder = `Lane ${i} · button ${suffix.toUpperCase()} (optional)`;
        input.dataset.btn = suffix;
        input.style.display = 'none';
        input.addEventListener('change', () =>
          this.sendAction('set_config', { key: `mac_lane_${i}_${suffix}`, value: input.value.trim() }));
        field.appendChild(input);
      }
    }
    const bpl = document.getElementById('buttons-per-lane');
    if (bpl) bpl.addEventListener('change', () => this.updateExtraButtonVisibility());
  }

  // Editable review table, shown while a finished heat is held before export.
  renderReviewPanel(reviewPending, lanes) {
    const panel = document.getElementById('review-panel');
    if (!panel) return;
    if (!reviewPending || !lanes) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    const resultsPanel = document.getElementById('results-panel');
    if (resultsPanel) resultsPanel.classList.add('hidden'); // show the editable table instead
    const tbody = document.getElementById('review-tbody');
    if (!tbody) return;
    // Preserve focus if the operator is mid-edit (a broadcast could re-render under them).
    const act = document.activeElement;
    const editingLane = act && act.classList && act.classList.contains('review-time') ? act.dataset.lane : null;
    tbody.replaceChildren();
    const rows = Object.entries(lanes).map(([l, info]) => [parseInt(l, 10), info]).sort((a, b) => a[0] - b[0]);
    for (const [lane, info] of rows) {
      const tr = document.createElement('tr');
      const tdLane = document.createElement('td'); tdLane.textContent = String(lane);
      const tdName = document.createElement('td');
      if (info.name) tdName.textContent = info.name; else { tdName.innerHTML = '<span class="muted">—</span>'; }
      const tdTime = document.createElement('td');
      const input = document.createElement('input');
      input.className = 'review-time text-input';
      input.dataset.lane = String(lane);
      const shown = info.time != null ? this.formatTime(info.time) : '';
      input.value = shown;
      input.dataset.orig = shown;            // last valid value, for revert
      input.placeholder = '00:00.00';
      input.inputMode = 'numeric';
      input.setAttribute('aria-label', `Lane ${lane} time`);
      input.addEventListener('focus', () => input.select());
      // Auto-format digits into a time as you type (calculator style — newest digit
      // is hundredths; digits fill leftward into seconds : minutes : hours).
      input.addEventListener('input', () => {
        input.value = this.maskRaceTime(input.value);
        input.setSelectionRange(input.value.length, input.value.length);
      });
      // Commit only a valid time / NT / blank; otherwise revert + warn.
      input.addEventListener('change', () => {
        const v = input.value.trim();
        if (this.isValidRaceTime(v)) {
          input.classList.remove('invalid');
          input.dataset.orig = v;
          this.sendAction('set_lane_result', { lane, time: v });
        } else {
          input.classList.add('invalid');
          input.value = input.dataset.orig || '';
          this.showToast('Time must look like 32.10 or 1:05.30 (or NT)', 'error');
          setTimeout(() => input.classList.remove('invalid'), 1600);
        }
      });
      tdTime.appendChild(input);
      const tdNt = document.createElement('td');
      const ntBtn = document.createElement('button');
      ntBtn.className = 'btn btn-small review-nt';
      ntBtn.textContent = 'NT';
      ntBtn.addEventListener('click', () => this.sendAction('set_lane_result', { lane, time: 'NT' }));
      tdNt.appendChild(ntBtn);
      tr.append(tdLane, tdName, tdTime, tdNt);
      tbody.appendChild(tr);
    }
    if (editingLane) { const el = tbody.querySelector(`.review-time[data-lane="${editingLane}"]`); if (el) el.focus(); }
  }

  // Format raw keystrokes into a time as the user types (calculator style): the
  // newest digit is hundredths; digits fill leftward into ss, then :mm, then :hh.
  // "" → ""  ·  "5" → "0.05"  ·  "3210" → "32.10"  ·  "10530" → "1:05.30"  ·  8 digits → "00:00:00.00"
  maskRaceTime(raw) {
    const d = String(raw).replace(/\D/g, '').slice(0, 8);
    if (!d) return '';
    if (d.length <= 2) return '0.' + d.padStart(2, '0');
    const hund = d.slice(-2);
    let rest = d.slice(0, -2);
    const groups = [];
    while (rest.length > 2) { groups.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
    groups.unshift(rest);
    return groups.join(':') + '.' + hund;
  }

  // A valid edited race time: blank/NT (no time), or seconds / minutes / hours form.
  isValidRaceTime(s) {
    s = String(s).trim();
    if (s === '' || /^nt$/i.test(s)) return true;
    return /^\d{1,2}(\.\d{1,2})?$/.test(s)                  // ss(.hh):      00.00 / 32.10
        || /^\d{1,2}:[0-5]\d(\.\d{1,2})?$/.test(s)          // m:ss(.hh):    0:00.00 / 00:32.10
        || /^\d{1,2}:[0-5]\d:[0-5]\d(\.\d{1,2})?$/.test(s); // h:mm:ss(.hh): 00:00:00.00
  }

  updateExtraButtonVisibility() {
    const n = parseInt(document.getElementById('buttons-per-lane')?.value || '1', 10);
    document.querySelectorAll('.mac-extra').forEach((inp) => {
      const show = (inp.dataset.btn === 'b' && n >= 2) || (inp.dataset.btn === 'c' && n >= 3);
      inp.style.display = show ? '' : 'none';
    });
  }

  hydrateConfig(config) {
    if (!config) return;
    for (let i = 1; i <= 6; i++) {
      const primary = document.getElementById(`mac-lane-${i}`);
      if (primary && config[`mac_lane_${i}`]) primary.value = config[`mac_lane_${i}`];
      for (const suffix of ['b', 'c']) {
        const el = document.getElementById(`mac-lane-${i}-${suffix}`);
        if (el) el.value = config[`mac_lane_${i}_${suffix}`] || '';
      }
    }
    if (config.mac_starter) {
      const el = document.getElementById('mac-starter');
      if (el) el.value = config.mac_starter;
    }
    // Timing & Splits controls.
    const pool = document.getElementById('pool-length');
    if (pool && config.pool_length_m) pool.value = config.pool_length_m;
    const cs = document.getElementById('collect-splits');
    if (cs) cs.checked = config.collect_splits === '1';
    const rb = document.getElementById('review-before-export');
    if (rb) rb.checked = (config.review_before_export ?? '1') === '1';
    for (const [id, key, dflt] of [['name-show-first', 'name_show_first', '1'], ['name-show-last-initial', 'name_show_last_initial', '1'], ['name-show-age', 'name_show_age', '0']]) {
      const el = document.getElementById(id);
      if (el) el.checked = (config[key] ?? dflt) === '1';
    }
    // Sport Systems .do3 export settings.
    const dMeet = document.getElementById('dolphin-meet');
    if (dMeet && config.dolphin_meet) dMeet.value = config.dolphin_meet;
    const dRound = document.getElementById('dolphin-round');
    if (dRound && config.dolphin_round) dRound.value = config.dolphin_round;
    // Buttons-per-lane is derived from which extra buttons are configured.
    let bpl = 1;
    for (let i = 1; i <= 6; i++) {
      if (config[`mac_lane_${i}_c`]) bpl = Math.max(bpl, 3);
      else if (config[`mac_lane_${i}_b`]) bpl = Math.max(bpl, 2);
    }
    const bplSel = document.getElementById('buttons-per-lane');
    if (bplSel) bplSel.value = String(bpl);
    this.updateExtraButtonVisibility();
  }

  /* ── Race State ── */

  setRaceState(state, serverStartTime, serverElapsed) {
    const prevState = this.raceState;
    this.raceState = state;

    // Whole-deck background cue: red until armed, green when ready to start,
    // black while the race is running. (Styled in style.css.)
    document.body.classList.remove(
      'race-bg-idle', 'race-bg-ready', 'race-bg-running', 'race-bg-completed');
    document.body.classList.add(`race-bg-${state}`);

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

    // NB: results are NOT cleared on idle/completion — they stay on screen until the
    // next heat is PREPARED. The clear happens in hydrateFullState (on 'ready' / new heat).

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
    // Sport Systems' CTS Dolphin capture reads the Colorado .do3 (finish times).
    this.sendAction('export_do3', {});
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

  handleLaneTime(lane, time, isFinish, splitIndex) {
    // Record the touch at its split slot (a 2nd/3rd watch of the same touch just
    // overwrites with the consolidated value the server re-sends).
    if (splitIndex != null) {
      if (!this.laneSplits[lane]) this.laneSplits[lane] = [];
      this.laneSplits[lane][splitIndex] = time;
    }
    this.laneTimes[lane] = time;
    if (isFinish) {
      this.laneFinished[lane] = true;
      this.updateLaneCard(lane, time, true);
      this.playFinishChime(lane);
    } else {
      this.updateLaneCard(lane, time, false);
    }
    this.renderLaneSplits(lane);
  }

  // Show the per-length split times under a lane's timer (only when >1 split). The
  // element is created on demand, like the swimmer label.
  renderLaneSplits(lane) {
    const card = this.getLaneCard(lane);
    if (!card) return;
    const splits = (this.laneSplits[lane] || []).filter((t) => t != null);
    let el = card.querySelector('.lane-splits');
    if (splits.length <= 1) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'lane-splits';
      const timer = card.querySelector('.lane-timer');
      if (timer) timer.insertAdjacentElement('afterend', el);
      else card.appendChild(el);
    }
    el.innerHTML = splits
      .map((t, i) => {
        const last = i === splits.length - 1;
        return `<span class="split-chip${last ? ' split-finish' : ''}">${i + 1}: ${this.formatTime(t)}</span>`;
      })
      .join('');
  }

  // Show the swimmer's name (and club) on a lane card. The element is created on
  // demand so we don't have to hand-edit all six lane cards in the HTML.
  setLaneSwimmer(lane, name, club, seed) {
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
      const meta = [club, seed ? `seed ${seed}` : ''].filter(Boolean).join(' · ');
      el.querySelector('.swimmer-club').textContent = meta;
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
  setupRosterReload() {
    const reloadBtn = document.getElementById('btn-reload-roster');
    if (reloadBtn) reloadBtn.addEventListener('click', () => this.sendAction('reload_roster', {}));
  }

  // Import a start list (Sport Systems heat-sheet .txt or Lenex .lef/.lxf) by POSTing
  // the file to /api/import; the server writes roster.csv/events.csv and broadcasts.
  setupStartListImport() {
    const input = document.getElementById('startlist-file');
    const btn = document.getElementById('btn-import-startlist');
    const statusEl = document.getElementById('import-status');
    if (!input || !btn) return;
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (statusEl) { statusEl.className = 'import-status'; statusEl.textContent = `Importing ${file.name}…`; }
      try {
        const buf = await file.arrayBuffer();
        const res = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Import failed');
        const s = data.summary;
        const msg = `${s.entries} swimmers · ${s.eventCount} events · ${s.heatCount} heats`;
        if (statusEl) { statusEl.className = 'import-status ok'; statusEl.textContent = '✓ ' + msg; }
        this.showToast('Imported ' + msg, 'success');
      } catch (err) {
        if (statusEl) { statusEl.className = 'import-status err'; statusEl.textContent = '✗ ' + err.message; }
        this.showToast('Import failed: ' + err.message, 'error');
      } finally {
        input.value = '';
      }
    });
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
      this.laneSplits[i] = [];
      this.setLaneStatus(i, 'waiting');
      const timerEl = this.getLaneTimerEl(i);
      if (timerEl) timerEl.textContent = '--:--.--';
      const card = this.getLaneCard(i);
      if (card) {
        const splitsEl = card.querySelector('.lane-splits');
        if (splitsEl) splitsEl.remove();
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

      const nameTd = document.createElement('td');
      nameTd.textContent = this.laneSwimmers[entry.lane] || '';
      tr.appendChild(nameTd);

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

        const nameTd = document.createElement('td');
        nameTd.textContent = this.laneSwimmers[i] || '';
        tr.appendChild(nameTd);

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
