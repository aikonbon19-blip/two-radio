/* ============================================================
   TWO RADIO — client
   Half-duplex push-to-talk over WebSocket.
   ============================================================ */
(() => {
  'use strict';

  /* ----------------------------- dom ----------------------------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    sheet: $('sheet'),
    joinSheet: $('joinSheet'),
    joinForm: $('joinForm'),
    joinBtn: $('joinBtn'),
    leaveBtn: $('leaveBtn'),
    callsign: $('callsign'),
    channel: $('channel'),
    swatches: $('swatches'),
    micNote: $('micNote'),
    ctxWarning: $('ctxWarning'),
    freqDisplay: $('freqDisplay'),
    bandTag: $('bandTag'),
    chSub: $('chSub'),
    dial: $('dial'),
    dialTick: $('dialTick'),
    startFreq: $('startFreq'),
    quickFreqs: $('quickFreqs'),
    presetList: $('presetList'),
    bandList: $('bandList'),
    panePresets: $('panePresets'),
    paneKeypad: $('paneKeypad'),
    kpDisplay: $('kpDisplay'),
    kpGrid: $('kpGrid'),
    kpTune: $('kpTune'),
    sheetClose: $('sheetClose'),
    scanbar: $('scanbar'),
    scanText: $('scanText'),
    scanStop: $('scanStop'),
    statusPill: $('statusPill'),
    statusText: $('statusText'),
    linkState: $('linkState'),
    linkText: $('linkText'),
    roster: $('roster'),
    vu: $('vu'),
    vuDb: $('vuDb'),
    pttHold: $('pttHold'),
    pttBtn: $('pttBtn'),
    pttText: $('pttText'),
    pttHint: $('pttHint'),
    stageNote: $('stageNote'),
    btnScan: $('btnScan'),
    btnPresets: $('btnPresets'),
    btnKeypad: $('btnKeypad'),
    btnLock: $('btnLock'),
    lockLabel: $('lockLabel'),
    btnMute: $('btnMute'),
    muteLabel: $('muteLabel'),
    toast: $('toast'),
  };

  const COLORS = ['#6ee7b7', '#7dd3fc', '#fca5a5', '#fcd34d', '#c4b5fd', '#f9a8d4', '#a3e635', '#fdba74'];

  /* ---- the bands this radio tunes ---- */
  const PMR446 = ['446.00625','446.01875','446.03125','446.04375',
                  '446.05625','446.06875','446.08125','446.09375'];
  const FRS = ['462.56250','462.58750','462.61250','462.63750','462.66250',
               '462.68750','462.71250','467.56250','467.58750','467.61250',
               '467.63750','467.66250','467.68750','467.71250'];

  const BANDS = [
    { id: 'PMR446', label: 'PMR446', from: 446.000, to: 446.100, ch: PMR446, step: 1 },
    { id: 'FRS',    label: 'FRS/GMRS', from: 462.550, to: 462.725, ch: FRS, step: 1 },
    { id: 'VHF',    label: '2m CALL', from: 145.400, to: 145.600, ch: [], step: 1 },
    { id: 'UHF',    label: '70cm CALL', from: 433.400, to: 433.600, ch: [], step: 1 },
    { id: 'FREE',   label: 'FREE', from: 400.000, to: 470.000, ch: [], step: 1 },
  ];

  /** Every frequency a scan sweeps. */
  const SCAN_LIST = [].concat(
    PMR446,
    FRS,
    Array.from({ length: 41 }, (_, i) => (145.400 + i * 0.005).toFixed(5)),   // 2m calling
    Array.from({ length: 41 }, (_, i) => (433.400 + i * 0.005).toFixed(5)),   // 70cm calling
    Array.from({ length: 36 }, (_, i) => (462.550 + i * 0.005).toFixed(5))    // FRS gap
  );

  /* ----------------------------- state ----------------------------- */
  const S = {
    ws: null,
    joined: false,
    intent: { callsign: '', freq: '446.00625', color: COLORS[0] },
    freq: '446.00625',      // what we're tuned to
    scan: { on: false, timer: null, idx: 0, results: [], wait: 0 },
    me: null,               // { id, name, color }
    members: [],
    talker: null,           // remote talker { id, name } — set by server 'busy'
    pttDown: false,
    tx: false,              // we are transmitting (granted)
    handsFree: false,       // tap-to-talk mode
    muted: false,
    micStream: null,
    recorder: null,
    seq: 0,
    retry: 0,
    reconnectTimer: null,
    txAnalyser: null,
    txData: null,
    vuPulse: 0,             // 0..1 decayed level for RX
    vuLevel: 0,
  };

  // Audio slice length. Every millisecond here is added end-to-end latency,
  // because a slice can't be relayed until it's complete.
  // 120 ms is the sweet spot: noticeably live, still efficient to encode.
  const SLICE_MS = 120;

  // diagnostics, handy for debugging a link between two devices
  const D = window.__TWO_RADIO = {
    rx: 0, pushed: 0, got: 0, mode: '', mime: '',
    granted: 0, recChunks: 0, sent: 0, errors: [],
  };

  /* --------------------------- frequency --------------------------- */
  function normFreq(v) {
    const raw = String(v == null ? '' : v).trim();
    const legacy = raw.match(/^CH[\s_-]?(\d{1,2})$/i) || raw.match(/^(\d{1,2})$/);
    if (legacy) {
      const n = Number(legacy[1]);
      if (n >= 1 && n <= 8) return PMR446[n - 1];
    }
    const num = Number(raw.replace(/[^0-9.]/g, ''));
    if (!isFinite(num) || num <= 0) return PMR446[0];
    return Math.min(999.99999, Math.max(1, num)).toFixed(5);
  }

  /** Split "446.00625" into the big display parts. */
  function freqParts(f) {
    const p = f.split('.');
    return { mhz: p[0], frac: p[1] || '00000' };
  }

  function fmtFreq(f) { return normFreq(f); }

  function bandFor(freq) {
    const n = Number(freq);
    for (const b of BANDS) if (n >= b.from && n <= b.to) return b;
    return BANDS[4];                    // FREE
  }

  /** Nearest preset channel in the current band, 1-based (for "CH 3" labels). */
  function channelNumber(freq) {
    const b = bandFor(freq);
    if (!b.ch.length) return null;
    const idx = b.ch.indexOf(normFreq(freq));
    return idx === -1 ? null : idx + 1;
  }

  /* ------------------------- vu meter build ------------------------- */
  const SEGMENTS = 26;
  const segs = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const d = document.createElement('div');
    d.className = 'vu-seg';
    if (i > SEGMENTS - 5) d.dataset.zone = 'hot';
    else if (i > SEGMENTS - 10) d.dataset.zone = 'warn';
    el.vu.appendChild(d);
    segs.push(d);
  }

  function paintVu(level) {
    const lit = Math.round(Math.max(0, Math.min(1, level)) * SEGMENTS);
    for (let i = 0; i < SEGMENTS; i++) {
      const on = i < lit;
      const seg = segs[i];
      seg.classList.toggle('lit', on);
      const zone = seg.dataset.zone;
      if (zone) seg.classList.toggle(zone, on);
    }
    el.vuDb.textContent = level > 0.01 ? `${Math.round(-60 + level * 60)}dB` : '--';
  }

  function vuLoop() {
    let level = 0;
    if (S.tx && S.txAnalyser) {
      const buf = new Uint8Array(S.txAnalyser.frequencyBinCount);
      S.txAnalyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
      level = Math.min(1, peak * 2.4);
    } else if (S.talker && S.talker.id !== S.me?.id) {
      const real = Receiver.level();
      if (real > 0.02) { level = real; S.vuPulse = Math.max(S.vuPulse, real); }
      else { S.vuPulse *= 0.88; level = Math.min(1, S.vuPulse * 0.9); }
    } else {
      S.vuPulse *= 0.9;
      level = 0;
    }
    S.vuLevel += (level - S.vuLevel) * 0.35;
    paintVu(S.vuLevel);

    // Someone is transmitting but nothing has arrived for a while: say so,
    // instead of leaving the user wondering why it's silent.
    if (S.talker && !S.muted) {
      const stale = S.lastAudioAt > 0 && Date.now() - S.lastAudioAt > 2500;
      if (stale !== S._stale) { S._stale = stale; setStaleNote(stale); }
    }

    requestAnimationFrame(vuLoop);
  }

  /* ----------------------------- toast ----------------------------- */
  let toastTimer = null;
  function toast(text, ms = 2200) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  function buzz(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch { /* noop */ } }
  }

  /* ---------------------------- ui paint --------------------------- */
  function setLink(state) {
    el.linkState.className = 'link-state ' + state;
    el.linkText.textContent = state === 'online' ? 'ON AIR' : state === 'offline' ? 'NO LINK' : 'CONNECTING';
  }

  function setStatus(kind, text) {
    el.statusPill.className = 'status-pill mono ' + kind;
    el.statusText.textContent = text;
  }

  function paintUi() {
    const listening = !!(S.talker && S.talker.id !== S.me?.id);

    if (S.tx) {
      setStatus('tx', 'TX');
      el.pttText.textContent = 'ON AIR';
      el.pttHint.textContent = S.handsFree ? 'tap to stop' : 'release to send';
      el.stageNote.innerHTML = '<b>TRANSMITTING</b> — channel is yours';
    } else if (listening) {
      setStatus('rx', 'RX');
      el.pttText.textContent = 'HOLD';
      el.pttHint.textContent = 'channel busy';
      setTalkerNote(!S.lastAudioAt || Date.now() - S.lastAudioAt > 800);
      S._stale = false;
    } else {
      setStatus('', 'STANDBY');
      el.pttText.textContent = S.joined ? (S.handsFree ? 'TAP' : 'HOLD') : 'JOIN';
      el.pttHint.textContent = S.joined ? 'to talk' : 'to start';
      el.stageNote.textContent = S.joined
        ? (S.members.length > 1 ? `${S.members.length} operators on channel` : 'Waiting for others to join')
        : 'Press and hold to transmit';
    }

    el.pttHold.classList.toggle('down', S.tx || S.pttDown);
    el.pttHold.classList.toggle('locked', S.handsFree && !S.tx);

    // roster — rebuilt only when the roster or the talker changes,
    // otherwise re-rendering restarts the talking animation every frame
    const list = S.members.length ? S.members : [];
    const rosterKey = JSON.stringify([
      list.map((m) => m.id + m.name),
      S.talker ? S.talker.id : null,
      S.tx,
      S.me ? S.me.id : null,
    ]);
    if (rosterKey === S._rosterKey) return;   // roster unchanged: leave the animation alone
    S._rosterKey = rosterKey;
    el.roster.innerHTML = list.map((m) => {
      const speaking = (S.tx && S.me && m.id === S.me.id) || (S.talker && S.talker.id === m.id);
      const mine = S.me && m.id === S.me.id;
      const initials = m.name.slice(0, 2).toUpperCase();
      const meter = '<span class="meter" aria-hidden="true"><i></i><i></i><i></i></span>';
      return `<div class="who ${speaking ? 'speaking' : ''} ${mine ? 'me' : ''}" ${speaking ? 'aria-live="polite"' : ''}>
        <span class="av" style="background:${m.color}">${escapeHtml(initials)}</span>
        <span class="name">${escapeHtml(m.name)}</span>
        ${meter}
      </div>`;
    }).join('') || '<div class="who" style="opacity:.5"><span class="av" style="background:#2a313b">–</span><span class="name">No one yet</span></div>';

    paintRest();
  }

  /* Everything that is cheap and must update on every paint,
     kept separate so the roster animation isn't restarted. */
  function paintRest() {
    // frequency readout
    const { mhz, frac } = freqParts(S.freq);
    el.freqDisplay.innerHTML = `${mhz}<span class="dot">.</span>${frac}`;
    el.dialTick.textContent = S.freq;

    const band = bandFor(S.freq);
    const chNo = channelNumber(S.freq);
    el.bandTag.textContent = band.id;
    el.bandTag.title = band.label;

    el.chSub.textContent = S.joined
      ? [
          chNo ? `CH ${chNo}` : 'VFO',
          `${S.members.length} OPERATOR${S.members.length === 1 ? '' : 'S'}`,
          S.muted ? 'MUTED' : 'LIVE',
        ].join(' · ')
      : 'NO LINK';

    el.muteLabel.textContent = S.muted ? 'MUTED' : 'SPEAKER';
    el.btnMute.classList.toggle('active', S.muted);
    el.lockLabel.textContent = S.handsFree ? 'TAP-TALK' : 'LOCK';
    el.btnLock.classList.toggle('active', S.handsFree);

    if (typeof drawDial === 'function') drawDial();
  }


  /** Talker status line; `waiting` shows a subtle "no audio yet" hint. */
  function setTalkerNote(waiting) {
    if (!S.talker) return;
    const name = escapeHtml(S.talker.name);
    el.stageNote.innerHTML = waiting
      ? `<i>${name}</i> is talking <span style="opacity:.55">(connecting audio…)</span>`
      : `<i>${name}</i> is talking`;
  }

  /** Called when a talker has been transmitting with nothing arriving. */
  function setStaleNote(stale) {
    if (!S.talker) return;
    const name = escapeHtml(S.talker.name);
    el.stageNote.innerHTML = stale
      ? `<i>${name}</i> is keyed up <span style="color:var(--red)">— no audio arriving</span>`
      : `<i>${name}</i> is talking`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* --------------------------- swatches --------------------------- */
  let chosenColor = COLORS[0];
  COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(i === 0));
    b.addEventListener('click', () => {
      chosenColor = c;
      [...el.swatches.children].forEach((n) => n.setAttribute('aria-checked', String(n === b)));
    });
    el.swatches.appendChild(b);
  });

  /* ---------------------------- storage --------------------------- */
  function savePrefs() {
    try {
      localStorage.setItem('two-radio:prefs', JSON.stringify({
        callsign: S.intent.callsign, freq: S.intent.freq, color: S.intent.color,
      }));
    } catch { /* private mode */ }
  }
  function loadPrefs() {
    try {
      const raw = localStorage.getItem('two-radio:prefs');
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.callsign) el.callsign.value = p.callsign;
      if (p.freq) el.startFreq.value = normFreq(p.freq);
      if (p.color && COLORS.includes(p.color)) {
        chosenColor = p.color;
        [...el.swatches.children].forEach((n) => n.setAttribute('aria-checked',
          String(n.style.background && rgbToHex(n.style.background) === p.color.toLowerCase())));
      }
    } catch { /* noop */ }
  }
  function rgbToHex(rgb) {
    const m = rgb.match(/\d+/g);
    if (!m) return '';
    return '#' + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  }

  /* --------------------------- websocket --------------------------- */
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connect() {
    if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
    setLink('connecting');
    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      setLink('offline');
      scheduleReconnect();
      return;
    }
    S.ws = ws;

    ws.onopen = () => {
      S.retry = 0;
      ws.send(JSON.stringify({
        t: 'join',
        freq: S.intent.freq,
        name: S.intent.callsign,
        color: S.intent.color,
      }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };

    ws.onclose = () => {
      S.ws = null;
      S.joined = false;
      S.tx = false;
      S.talker = null;
      setLink('offline');
      paintUi();
      if (S.intent.callsign) scheduleReconnect();
    };

    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  }

  function scheduleReconnect() {
    if (S.reconnectTimer) return;
    const delay = Math.min(8000, 600 * 2 ** S.retry++);
    setLink('offline');
    S.reconnectTimer = setTimeout(() => {
      S.reconnectTimer = null;
      if (S.intent.callsign) connect();
    }, delay);
  }

  function send(msg) {
    if (S.ws && S.ws.readyState === 1) {
      try { S.ws.send(JSON.stringify(msg)); } catch { /* noop */ }
    }
  }

  /* ------------------------ incoming messages ---------------------- */
  function handle(msg) {
    switch (msg.t) {
      case 'welcome': {
        S.joined = true;
        S.me = msg.you;
        S.members = msg.members || [];
        S.freq = normFreq(msg.channel);
        S.intent.freq = S.freq;
        setLink('online');
        if (msg.talker && msg.talker.id !== S.me.id) {
          S.talker = { id: msg.talker.id, name: msg.talker.name };
          Receiver.begin(msg.talker.mime);
          toast(`${msg.talker.name} is already talking`);
        } else {
          S.talker = null;
        }
        el.sheet.hidden = true;
        paintUi();
        break;
      }

      case 'members':
        S.members = msg.members || [];
        paintUi();
        break;

      case 'granted':
        S.tx = true;
        paintUi();
        break;

      case 'denied':
        S.tx = false;
        S.pttDown = false;
        S.handsFree = false;
        S.talker = { id: msg.by.id, name: msg.by.name };
        el.pttHold.classList.add('denied');
        setTimeout(() => el.pttHold.classList.remove('denied'), 420);
        buzz([30, 60, 30]);
        toast(`Channel busy — ${msg.by.name} is talking`);
        paintUi();
        break;

      case 'busy': {
        if (S.me && msg.by.id === S.me.id) break;   // our own echo
        S.talker = { id: msg.by.id, name: msg.by.name };
        S.lastAudioAt = 0;
        S._stale = false;
        S.tx = false;                                // half duplex: stop our output
        Receiver.begin(msg.mime);
        buzz(18);
        paintUi();
        break;
      }

      case 'free':
        if (S.talker && S.talker.id === msg.by.id) S.talker = null;
        Receiver.end();
        paintUi();
        break;

      case 'audio':
        D.rx++;
        S.lastAudioAt = Date.now();
        if (S.talker) setTalkerNote(false);
        if (S.muted) return;
        S.vuPulse = Math.min(1, S.vuPulse + 0.45);
        Receiver.push(msg.data);
        break;

      case 'tuned':
        S.freq = normFreq(msg.freq);
        S.intent.freq = S.freq;
        S.members = msg.members || [];
        S.talker = msg.talker && S.me && msg.talker.id !== S.me.id
          ? { id: msg.talker.id, name: msg.talker.name }
          : null;
        if (S.talker) Receiver.begin(msg.talker.mime);
        paintUi();
        break;

      case 'scanResult':
        handleScanResult(msg.active || []);
        break;

      case 'released':
        break;

      default:
        break;
    }
  }

  /* --------------------------- tuning --------------------------- */
  function tuneTo(freq, opts) {
    const target = normFreq(freq);
    const o = opts || {};
    if (!S.joined) { S.intent.freq = target; return; }
    if (target === S.freq && !o.force) return;

    if (S.tx) stopTx();                 // never transmit across a retune
    S.freq = target;
    S.intent.freq = target;
    S.talker = null;
    S.members = [];
    el.freqDisplay.classList.add('tuning');
    setTimeout(() => el.freqDisplay.classList.remove('tuning'), 420);
    paintUi();
    send({ t: 'retune', freq: target });
    savePrefs();
  }

  function tuneStep(dir) {
    const band = bandFor(S.freq);
    const n = Number(S.freq);
    if (band.ch.length) {
      // step through the band's preset channels
      let idx = band.ch.indexOf(normFreq(S.freq));
      if (idx === -1) {
        idx = band.ch.findIndex((c) => Number(c) > n);
        idx = idx === -1 ? 0 : idx;
        tuneTo(band.ch[dir > 0 ? idx : (idx - 1 + band.ch.length) % band.ch.length]);
      } else {
        const next = (idx + dir + band.ch.length) % band.ch.length;
        tuneTo(band.ch[next]);
      }
    } else {
      // step 25 kHz inside a raw band
      const step = 0.025;
      let next = n + dir * step;
      if (next < band.from) next = band.to;
      if (next > band.to) next = band.from;
      tuneTo(next.toFixed(5));
    }
    stopScan();
  }

  /* ----------------------------- scan ----------------------------- */
  function startScan() {
    if (!S.joined) { toast('Switch the radio on first'); return; }
    if (S.tx) stopTx();
    S.scan.on = true;
    S.scan.idx = 0;
    S.scan.results = [];
    S.scan.wait = 0;
    el.scanbar.hidden = false;
    el.btnScan.classList.add('active');
    el.scanText.textContent = `SCANNING ${SCAN_LIST.length} FREQUENCIES`;
    send({ t: 'scan', freqs: SCAN_LIST });
    stepScan();
  }

  function stepScan() {
    if (!S.scan.on) return;
    if (S.scan.idx >= SCAN_LIST.length) {
      // one full pass done — sweep again so it keeps listening
      S.scan.idx = 0;
      S.scan.results = [];
    }
    const f = SCAN_LIST[S.scan.idx++];
    tuneTo(f);
    el.scanText.textContent = `SCAN ${f}`;
    clearTimeout(S.scan.timer);
    S.scan.timer = setTimeout(stepScan, S.scan.wait > 0 ? S.scan.wait-- : 300);
  }

  function handleScanResult(active) {
    if (!S.scan.on || !active.length) return;
    S.scan.results = active;
    // stop on the first frequency with somebody on it
    const hit = active[0];
    stopScan();
    tuneTo(hit.freq, { force: true });
    buzz([20, 60, 20]);
    toast(hit.talker
      ? `${hit.freq} — ${hit.talker} is talking`
      : `${hit.freq} — ${hit.members} operator${hit.members > 1 ? 's' : ''} found`, 3200);
  }

  function stopScan() {
    if (!S.scan.on) return;
    S.scan.on = false;
    clearTimeout(S.scan.timer);
    S.scan.timer = null;
    el.scanbar.hidden = true;
    el.btnScan.classList.remove('active');
  }

  /* ============================================================
     Receiver — plays relayed audio chunks.
     Uses MediaSource for low-latency streaming where available,
     falls back to buffered blob playback (e.g. iOS Safari).
     ============================================================ */
  const Receiver = (() => {
    const audio = new Audio();
    audio.setAttribute('playsinline', '');
    audio.style.display = 'none';
    if (document.body) document.body.appendChild(audio);
    audio.autoplay = true;
    audio.preload = 'auto';

    let ms = null, sb = null, url = null, pending = [], draining = false;
    let mode = 'mse';
    let blobParts = [];
    let mime = 'audio/webm;codecs=opus';
    let unlocked = false;

    function canMse(candidate) {
      if (typeof MediaSource === 'undefined') return false;
      const ok = MediaSource.isTypeSupported(candidate) || MediaSource.isTypeSupported('audio/webm;codecs=opus');
      return !!ok;
    }

    function unlock() {
      if (unlocked) return;
      unlocked = true;
      audio.play().catch(() => { /* needs a gesture; retried on next tap */ });
    }

    function begin(announcedMime) {
      mime = announcedMime || 'audio/webm;codecs=opus';
      mode = canMse(mime) ? 'mse' : 'blob';
      D.mime = mime; D.mode = mode;
      blobParts = [];

      if (mode === 'mse') {
        teardown();
        try {
          ms = new MediaSource();
          url = URL.createObjectURL(ms);
          audio.src = url;
          ms.addEventListener('sourceopen', () => {
            let type = mime;
            if (!MediaSource.isTypeSupported(type)) type = 'audio/webm;codecs=opus';
            try {
              sb = ms.addSourceBuffer(type);
              sb.mode = 'sequence';
              sb.addEventListener('updateend', drain);
              drain();
            } catch {
              mode = 'blob';           // give up on streaming, keep chunks
              ms = null;
            }
          }, { once: true });
          audio.play().catch(() => { /* gesture gate */ });
        } catch {
          mode = 'blob';
        }
      }
    }

    function teardown() {
      try { if (ms && ms.readyState === 'open') ms.endOfStream(); } catch { /* noop */ }
      try { sb && sb.abort && ms && ms.readyState === 'open' && sb.abort(); } catch { /* noop */ }
      sb = null;
      if (ms) { ms = null; }
      if (url) { URL.revokeObjectURL(url); url = null; }
      pending = [];
      draining = false;
    }

    function push(b64) {
      D.pushed++;
      if (D.pushed === 1 && D.firstChunkAt === 0) D.firstChunkAt = performance.now();
      let bin;
      try { bin = atob(b64); } catch { return; }
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      if (mode === 'blob' || !ms) {
        blobParts.push(bytes);
        D.got++;
        scheduleBlobFlush();
        return;
      }
      pending.push(bytes);
      drain();
    }

    function drain() {
      if (draining || !sb || !ms || ms.readyState !== 'open') return;
      if (sb.updating) return;
      if (!pending.length) return;
      draining = true;
      const chunk = pending.shift();
      try {
        sb.appendBuffer(chunk);
      } catch (err) {
        if (err && err.name === 'QuotaExceededError') {
          // Drop the backlog and jump to live.
          try { const t = audio.currentTime; sb.remove(0, Math.max(0, t - 1)); } catch { /* noop */ }
          draining = false;
          return;
        }
        draining = false;
        return;
      }
      draining = false;
      if (pending.length) queueMicrotask(drain);

      // Stay at the live edge. Without this the buffer creeps forward and the
      // delay grows into seconds over a long transmission.
      try {
        if (audio.buffered.length) {
          const edge = audio.buffered.end(audio.buffered.length - 1);
          if (edge - audio.currentTime > 0.6) audio.currentTime = edge - 0.15;
        }
      } catch { /* noop */ }
    }

    let blobTimer = null;
    function scheduleBlobFlush() {
      if (blobTimer) return;
      blobTimer = setTimeout(() => {
        blobTimer = null;
        flushBlob();
      }, 700);
    }

    function flushBlob() {
      if (!blobParts.length) return;
      try {
        const b = new Blob(blobParts, { type: mime.split(';')[0] });
        blobParts = [];
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(b);
        audio.src = url;
        audio.play().catch(() => { /* gesture gate */ });
      } catch { /* keep chunks */ }
    }

    function end() {
      if (mode === 'blob' && blobParts.length) {
        try {
          const b = new Blob(blobParts, { type: mime.split(';')[0] });
          blobParts = [];
          audio.src = URL.createObjectURL(b);
          audio.play().catch(() => { /* noop */ });
        } catch { /* noop */ }
        return;
      }
      // let the MSE buffer flush, then close the stream
      const close = () => {
        try {
          if (!sb || !ms || ms.readyState !== 'open') return;
          if (sb.updating) { setTimeout(close, 60); return; }
          if (pending.length) { drain(); setTimeout(close, 60); return; }
          if (ms.readyState === 'open') ms.endOfStream();
        } catch { /* noop */ }
      };
      close();
    }

    /** Peak level of what is actually playing (0..1). */
    function level() {
      try {
        if (!rxCtx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return 0;
          rxCtx = new AC();
          rxSource = rxCtx.createMediaElementSource(audio);
          rxAnalyser = rxCtx.createAnalyser();
          rxAnalyser.fftSize = 512;
          rxSource.connect(rxAnalyser);
          rxAnalyser.connect(rxCtx.destination);   // keep the audio audible
        }
        if (rxCtx.state === 'suspended') { rxCtx.resume().catch(() => {}); }
        const buf = new Uint8Array(rxAnalyser.fftSize);
        rxAnalyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
        return Math.min(1, peak * 2.4);
      } catch {
        return 0;      // analyser unavailable (some iOS versions): meter falls back
      }
    }

    let rxCtx = null, rxSource = null, rxAnalyser = null;

    audio.addEventListener('click', unlock);
    return { begin, push, end, unlock, element: audio, level, get playing() { return !audio.paused; } };
  })();

  /* ============================================================
     Transmitter — captures mic only while transmitting.
     ============================================================ */
  function pickMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    if (typeof MediaRecorder === 'undefined') return '';
    for (const c of candidates) {
      try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* noop */ }
    }
    return '';
  }

  async function ensureMic() {
    if (S.micStream && S.micStream.active) return S.micStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('no-media');
    }
    S.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    return S.micStream;
  }

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return btoa(s);
  }

  async function startTx() {
    if (!S.joined || S.tx) return;
    if (S.talker && S.talker.id !== S.me?.id) {
      toast(`Channel busy — ${S.talker.name} is talking`);
      buzz([25, 50, 25]);
      return;
    }
    try {
      await ensureMic();
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      const framed = window.self !== window.top;
      if (denied && framed) {
        toast('Mic blocked in this preview frame — open the app in its own tab', 4200);
      } else if (denied) {
        toast('Microphone blocked — allow mic access, then hold again', 3600);
      } else if (err && err.message === 'no-media') {
        toast('This browser has no microphone access — use https', 3600);
      } else {
        toast('No microphone available', 3000);
      }
      S.pttDown = false;
      paintUi();
      return;
    }

    Receiver.unlock();
    // ask the server for the channel lock; we start recording on 'granted'
    send({ t: 'ptt', on: true, mime: pickMime() || 'audio/webm;codecs=opus' });

    // optimistic local feedback; the server confirms with 'granted'
    S.pttDown = true;
    paintUi();
  }

  function beginRecorder() {
    const stream = S.micStream;
    if (!stream || typeof MediaRecorder === 'undefined') return;

    // meter
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!S.txCtx) S.txCtx = new AC();
      if (S.txCtx.state === 'suspended') S.txCtx.resume();
      if (!S.txSource || S.txSourceStreamId !== stream.id) {
        S.txSource = S.txCtx.createMediaStreamSource(stream);
        S.txAnalyser = S.txCtx.createAnalyser();
        S.txAnalyser.fftSize = 1024;
        S.txSource.connect(S.txAnalyser);
        S.txSourceStreamId = stream.id;
      }
    } catch { /* meter is cosmetic */ }

    const mime = pickMime();
    let rec;
    try {
      rec = new MediaRecorder(stream, mime
        ? { mimeType: mime, audioBitsPerSecond: 32000 }
        : { audioBitsPerSecond: 32000 });
    } catch {
      try { rec = new MediaRecorder(stream); } catch {
        toast('Recording is not supported in this browser');
        stopTx();
        return;
      }
    }

    S.seq = 0;
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      D.recChunks++;
      e.data.arrayBuffer().then((buf) => {
        D.sent++;
        send({ t: 'audio', seq: S.seq++, data: b64(buf) });
      }).catch(() => { /* skip chunk */ });
    };
    rec.onstop = () => {
      S.recorder = null;
      // stop is always followed by the release so the channel frees up
      send({ t: 'ptt', on: false });
    };
    rec.start(SLICE_MS);       // short slices = low latency; see SLICE_MS
    S.recorder = rec;
  }

  function stopTx() {
    const rec = S.recorder;
    if (rec && rec.state === 'recording') {
      try { rec.stop(); } catch { send({ t: 'ptt', on: false }); }
    } else {
      send({ t: 'ptt', on: false });
    }
    S.tx = false;
    S.pttDown = false;
    paintUi();
  }

  // server confirmation → actually start the recorder
  const origHandle = handle;
  handle = function (msg) {
    if (msg.t === 'granted') {
      D.granted++;
      S.tx = true;
      beginRecorder();
    }
    origHandle(msg);
  };

  /* ============================================================
     Push-to-talk interaction
     ============================================================ */
  let pressStartedTx = false;
  let suppressNextUp = false;

  function pttDown(ev) {
    if (ev && ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (!S.joined) { el.joinSheet.hidden = false; el.callsign.focus(); return; }

    Receiver.unlock();

    // hands-free mode: a tap toggles transmission
    if (S.tx) { stopTx(); S.handsFree = true; paintUi(); return; }

    if (S.talker && S.talker.id !== S.me?.id) {
      toast(`Channel busy — ${S.talker.name} is talking`);
      buzz([25, 50, 25]);
      return;
    }

    pressStartedTx = true;
    startTx();
  }

  function pttUp() {
    if (!pressStartedTx) return;
    pressStartedTx = false;
    if (S.handsFree) return;          // stay on air
    if (S.tx) stopTx();
    S.pttDown = false;
    paintUi();
  }

  el.pttBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { el.pttBtn.setPointerCapture(e.pointerId); } catch { /* noop */ }
    pttDown(e);
  });
  el.pttBtn.addEventListener('pointerup', (e) => { e.preventDefault(); pttUp(); });
  el.pttBtn.addEventListener('pointercancel', () => pttUp());
  el.pttBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  el.pttBtn.addEventListener('dragstart', (e) => e.preventDefault());

  // keyboard: space or enter to talk
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    e.preventDefault();
    pttDown({});
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    pttUp();
  });

  /* ---------------------- presets & bands ---------------------- */
  function buildPresets() {
    const band = bandFor(S.freq);
    const list = band.ch.length ? band.ch : [];
    el.presetList.innerHTML = '';

    if (!list.length) {
      el.presetList.innerHTML =
        '<p class="sub" style="grid-column:1/-1">This band is tune-anywhere. Use the dial or the keypad.</p>';
    } else {
      list.forEach((f, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'preset' + (normFreq(f) === S.freq ? ' current' : '');
        b.innerHTML = `<span class="p-ch">CH ${i + 1}</span>
          <span class="p-freq">${f}</span>
          <span class="p-idle"></span>`;
        b.addEventListener('click', () => { tuneTo(f, { force: true }); el.sheet.hidden = true; });
        el.presetList.appendChild(b);
      });
    }

    el.bandList.innerHTML = '';
    BANDS.forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'band' + (b.id === band.id ? ' on' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        tuneTo((b.ch[0] || b.from.toFixed(5)), { force: true });
        el.sheet.hidden = true;
      });
      el.bandList.appendChild(btn);
    });
  }

  /* --------------------------- keypad --------------------------- */
  let kpValue = '';

  function openKeypad() {
    kpValue = '';                       // first key press replaces, like a real radio
    el.kpDisplay.textContent = S.freq;  // current frequency shown as a hint
    el.kpDisplay.style.opacity = '.55';
    el.panePresets.hidden = true;
    el.paneKeypad.hidden = false;
    el.sheet.hidden = false;
  }

  function openPresets() {
    el.paneKeypad.hidden = true;
    el.panePresets.hidden = false;
    buildPresets();
    el.sheet.hidden = false;
  }

  el.kpGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-k]');
    if (!btn) return;
    const k = btn.dataset.k;
    if (k === 'del') kpValue = kpValue.slice(0, -1) || '0';
    else if (k === '.') { if (!kpValue.includes('.')) kpValue += '.'; }
    else if (kpValue.replace('.', '').length < 8) kpValue += k;
    el.kpDisplay.style.opacity = '1';
    el.kpDisplay.textContent = kpValue || S.freq;
  });

  el.kpTune.addEventListener('click', () => {
    if (!kpValue) { el.sheet.hidden = true; return; }   // nothing typed: leave as-is
    tuneTo(kpValue, { force: true });
    el.sheet.hidden = true;
  });

  el.sheetClose.addEventListener('click', () => { el.sheet.hidden = true; });

  el.btnPresets.addEventListener('click', openPresets);
  el.btnKeypad.addEventListener('click', openKeypad);

  /* ------------------------ tuning dial ------------------------ */
  const dialCtx = el.dial.getContext('2d');
  const DIAL = { dragging: false, startX: 0, startFreq: 0, pxPerStep: 42 };

  function dialBand() { return bandFor(S.freq); }
  function dialStep() {
    const b = dialBand();
    return b.ch.length ? 0 : 0.025;      // presets store, or 25 kHz VFO
  }

  function drawDial() {
    const w = el.dial.width, h = el.dial.height;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (el.dial.width !== Math.round(el.dial.clientWidth * dpr)) {
      el.dial.width = Math.round(el.dial.clientWidth * dpr);
      el.dial.height = Math.round(88 * dpr);
    }
    const c = dialCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, el.dial.width, el.dial.height);
    c.scale(dpr, dpr);

    const W = el.dial.clientWidth, H = 88;
    const band = dialBand();
    const n = Number(S.freq);
    const span = 0.06;                              // MHz visible across the dial
    const centre = W / 2;

    // tick marks
    const kHz = (v) => Math.round(v * 1000);
    const first = Math.ceil((n - span) * 1000) / 1000;
    const labelEvery = W < 340 ? 20 : 10;          // kHz between labels

    for (let v = first; v <= n + span; v += 0.001) {
      const x = centre + ((v - n) / span) * (W / 2);
      if (x < -2 || x > W + 2) continue;

      const k = kHz(v);
      const major = k % labelEvery === 0;
      const mid = k % 5 === 0;
      c.strokeStyle = major ? 'rgba(255,176,32,.8)' : mid ? 'rgba(255,176,32,.32)' : 'rgba(255,255,255,.10)';
      c.lineWidth = major ? 1.6 : 1;
      const len = major ? 13 : mid ? 8 : 4;
      c.beginPath();
      c.moveTo(x, H - 11 - len);
      c.lineTo(x, H - 11);
      c.stroke();

      if (major) {
        c.fillStyle = 'rgba(232,237,244,.55)';
        c.font = '600 9px ui-monospace, Menlo, monospace';
        c.textAlign = 'center';
        // show only the fractional part: 446.0 -> ".020"
        c.fillText('.' + String(k % 1000).padStart(3, '0'), x, H - 26);
      }
    }

    // preset channel blips
    if (band.ch.length) {
      band.ch.forEach((f, i) => {
        const x = centre + ((Number(f) - n) / span) * (W / 2);
        if (x < -10 || x > W + 10) return;
        c.fillStyle = normFreq(f) === S.freq ? '#3ddc84' : 'rgba(61,220,132,.45)';
        c.beginPath();
        c.arc(x, 20, normFreq(f) === S.freq ? 4 : 2.4, 0, Math.PI * 2);
        c.fill();
        if (Math.abs(x - centre) < 120) {
          c.fillStyle = 'rgba(61,220,132,.6)';
          c.font = '700 9px ui-monospace, Menlo, monospace';
          c.textAlign = 'center';
          c.fillText(String(i + 1), x, 38);
        }
      });
    }

    // needle
    c.strokeStyle = '#ff4d4d';
    c.lineWidth = 2;
    c.shadowColor = 'rgba(255,77,77,.9)';
    c.shadowBlur = 10;
    c.beginPath();
    c.moveTo(centre, 6);
    c.lineTo(centre, H - 8);
    c.stroke();
    c.shadowBlur = 0;

    // band label
    c.fillStyle = 'rgba(139,149,165,.55)';
    c.font = '700 9px ui-monospace, Menlo, monospace';
    c.textAlign = 'left';
    c.fillText(band.label.toUpperCase(), 10, 16);
    c.textAlign = 'right';
    c.fillText('MHz', W - 10, 16);
  }

  function dialFreqAt(dx) {
    const band = dialBand();
    const span = 0.06;
    const W = el.dial.clientWidth;
    const raw = S.dialStartFreq + (-dx / (W / 2)) * span;
    const clamped = Math.min(band.to, Math.max(band.from, raw));
    if (band.ch.length) {
      // snap to the nearest preset channel
      let best = band.ch[0], bestD = Infinity;
      for (const f of band.ch) {
        const d = Math.abs(Number(f) - clamped);
        if (d < bestD) { bestD = d; best = f; }
      }
      return best;
    }
    return (Math.round(clamped / 0.005) * 0.005).toFixed(5);   // 5 kHz grid
  }

  el.dial.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { el.dial.setPointerCapture(e.pointerId); } catch {}
    stopScan();
    DIAL.dragging = true;
    DIAL.startX = e.clientX;
    DIAL.startFreq = Number(S.freq);
    S.dialStartFreq = DIAL.startFreq;
  });

  el.dial.addEventListener('pointermove', (e) => {
    if (!DIAL.dragging) return;
    tuneTo(dialFreqAt(e.clientX - DIAL.startX));
    drawDial();
  });

  const endDrag = () => { DIAL.dragging = false; };
  el.dial.addEventListener('pointerup', endDrag);
  el.dial.addEventListener('pointercancel', endDrag);

  // wheel tuning on desktop
  el.dial.addEventListener('wheel', (e) => {
    e.preventDefault();
    stopScan();
    tuneStep(e.deltaY < 0 ? 1 : -1);
    drawDial();
  }, { passive: false });

  /* --------------------------- controls --------------------------- */
  el.btnScan.addEventListener('click', () => { S.scan.on ? stopScan() : startScan(); });
  el.btnScan.classList.toggle('active', S.scan.on);
  el.scanStop.addEventListener('click', stopScan);

  el.btnLock.addEventListener('click', () => {
    S.handsFree = !S.handsFree;
    if (!S.handsFree && S.tx) stopTx();
    toast(S.handsFree ? 'Hands-free on — tap the button to talk' : 'Hands-free off — hold to talk');
    paintUi();
  });

  el.btnMute.addEventListener('click', () => {
    S.muted = !S.muted;
    Receiver.element.muted = S.muted;
    if (S.muted) S.vuPulse = 0;
    paintUi();
  });

  /* ---------------------------- joining ---------------------------- */
  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const callsign = el.callsign.value.trim().slice(0, 20);
    const freq = normFreq(el.startFreq.value);
    if (!callsign) { el.callsign.focus(); return; }

    const sameChannel = S.joined && S.freq === freq;
    el.startFreq.value = freq;
    S.freq = freq;
    S.intent = { callsign, freq, color: chosenColor };
    savePrefs();
    Receiver.unlock();

    // best-effort mic permission up front so the first key-up isn't delayed
    ensureMic().catch(() => { /* asked again on transmit with a clear message */ });

    if (S.joined) {
      // retune cleanly instead of reconnecting
      if (!sameChannel) {
        if (S.tx) stopTx();
        try { S.ws && S.ws.close(); } catch { /* noop */ }
        S.ws = null;
        S.joined = false;
        clearTimeout(S.reconnectTimer);
        S.reconnectTimer = null;
        setTimeout(connect, 120);
      }
    } else {
      connect();
    }
    el.joinSheet.hidden = true;
    setLink('connecting');
  });



  /* -------------------------- environment -------------------------- */
  function checkSecureContext() {
    const insecure = location.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    if (insecure) {
      el.ctxWarning.hidden = false;
      el.micNote.hidden = true;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      el.ctxWarning.hidden = false;
      el.ctxWarning.innerHTML = 'This browser has no microphone API available. Try Chrome, Edge, Firefox or Safari over <b>https</b>.';
    }
  }

  /* ----------------------------- boot ----------------------------- */
  loadPrefs();
  checkSecureContext();

  // quick frequency buttons on the join screen
  [['446.00625', 'PMR 1'], ['446.03125', 'PMR 3'], ['462.56250', 'FRS 1'],
   ['145.50000', '2m CALL'], ['433.50000', '70cm']].forEach(([f, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quick';
    b.textContent = label;
    b.title = f + ' MHz';
    b.addEventListener('click', () => { el.startFreq.value = f; });
    el.quickFreqs.appendChild(b);
  });

  el.startFreq.value = normFreq(el.startFreq.value || '446.00625');

  paintUi();
  vuLoop();
  drawDial();
  window.addEventListener('resize', drawDial);
  el.joinSheet.hidden = false;
  el.callsign.focus();

  // resume audio on the first gesture (mobile autoplay policy)
  ['pointerdown', 'touchstart', 'keydown'].forEach((t) => {
    window.addEventListener(t, () => Receiver.unlock(), { once: true, passive: true });
  });

  // deep link: #f=446.03125 or #ch=3 (shareable frequency)
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const urlFreq = hash.get('f') || hash.get('ch');
  const saved = (() => { try { return JSON.parse(localStorage.getItem('two-radio:prefs') || 'null'); } catch { return null; } })();
  if (urlFreq) {
    el.startFreq.value = normFreq(urlFreq);
    if (saved && saved.callsign) {
      el.joinSheet.hidden = true;
      el.joinForm.requestSubmit();
    }
  }

  // keep the mic released while the tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.tx) stopTx();
  });
  window.addEventListener('pagehide', () => { if (S.tx) stopTx(); });

  // Close the socket deliberately when the page goes away, so the server removes
  // this operator immediately instead of keeping a ghost until the next sweep.
  function dropConnection() {
    if (S.recorder) { try { S.recorder.stop(); } catch { /* noop */ } S.recorder = null; }
    S.tx = false;
    S.handsFree = false;
    clearTimeout(S.reconnectTimer);
    S.reconnectTimer = null;
    const ws = S.ws;
    S.ws = null;
    S.joined = false;
    if (ws) {
      try { ws.send(JSON.stringify({ t: 'bye' })); } catch { /* noop */ }
      try { ws.close(1000, 'leaving'); } catch { /* noop */ }
    }
  }

  window.addEventListener('pagehide', dropConnection);
  window.addEventListener('beforeunload', dropConnection);
})();
