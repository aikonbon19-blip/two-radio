/**
 * TWO RADIO — push-to-talk server
 * -------------------------------------------------
 * Static file host + WebSocket relay that enforces
 * walkie-talkie behaviour: ONE talker per channel.
 *
 * Audio never touches disk. Chunks are relayed in
 * memory, in order, to everyone else on the channel.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const LIMITS = {
  maxName: 20,
  maxChannel: 24,
  maxChunkBytes: 256 * 1024, // ~1s of opus audio, generous
  msgsPerSecond: 60,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webmanifest.json': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------------ *
 * HTTP: static files
 * ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      channels: [...channels.values()].map((c) => ({
        freq: c.id,
        members: c.members.size,
        talker: c.talker ? c.talker.name : null,
      })),
    }));
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  // Resolve inside PUBLIC_DIR only.
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA-ish fallback so deep links still load the app.
      if (!path.extname(filePath)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) return res.writeHead(404).end('Not found');
          res.writeHead(200, { 'content-type': MIME['.html'] }).end(html);
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // The service worker file must never be cached, or updates never ship.
    const isSw = path.basename(filePath) === 'service-worker.js';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': isSw ? 'no-store' : 'no-cache',
      // Mic needs a secure context; the platform proxy already gives us https.
      'permissions-policy': 'microphone=(self)',
    });
    res.end(buf);
  });
});

/* ------------------------------------------------------------------ *
 * Channels — in-memory radio state
 * ------------------------------------------------------------------ */

/**
 * @typedef {{ id: string, name: string, color: string, ws: import('ws').WebSocket,
 *             lastSeen: number, bucket: { tokens: number, at: number } }} Member
 * @typedef {{ id: string, members: Map<string, Member>,
 *             talker: null | { id: string, name: string, since: number, mime: string } }} Channel
 */

/** @type {Map<string, Channel>} */
const channels = new Map();

const COLORS = ['#6ee7b7', '#7dd3fc', '#fca5a5', '#fcd34d', '#c4b5fd', '#f9a8d4', '#a3e635', '#fdba74'];

function getChannel(id) {
  let ch = channels.get(id);
  if (!ch) {
    ch = { id, members: new Map(), talker: null };
    channels.set(id, ch);
  }
  return ch;
}

function sweepChannel(ch) {
  if (ch.members.size === 0 && !ch.talker) channels.delete(ch.id);
}

function memberList(ch) {
  return [...ch.members.values()].map((m) => ({ id: m.id, name: m.name, color: m.color }));
}

function send(ws, msg) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket died mid-send */ }
  }
}

function broadcast(ch, msg, exceptId) {
  const raw = JSON.stringify(msg);
  for (const m of ch.members.values()) {
    if (m.id === exceptId) continue;
    if (m.ws.readyState === 1) {
      try { m.ws.send(raw); } catch { /* ignore */ }
    }
  }
}

function sanitize(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

/** PMR446 (EU) channels 1-8, 6.25 kHz spacing. Also the legacy CH-1..CH-8 aliases. */
const PMR446 = ['446.00625', '446.01875', '446.03125', '446.04375',
                '446.05625', '446.06875', '446.08125', '446.09375'];

/**
 * Every channel in this app is identified by its frequency in MHz.
 * Canonical form is always 5 decimal places, so 446.1 and 446.10000 are the same channel.
 */
function normalizeFrequency(value) {
  let raw = String(value ?? '').trim();

  // Legacy support: "CH-3" and "3" mean PMR446 channel 3.
  const legacy = raw.match(/^CH[\s_-]?(\d{1,2})$/i) || raw.match(/^(\d{1,2})$/);
  if (legacy) {
    const n = Number(legacy[1]);
    if (n >= 1 && n <= 8) return PMR446[n - 1];
  }

  const num = Number(raw.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(num) || num <= 0) return PMR446[0];
  const clamped = Math.min(999.99999, Math.max(1, num));
  return clamped.toFixed(5);                       // "446.00625"
}

/** Put a member on a channel and tell everybody involved. */
function joinChannel(member, freq) {
  const target = getChannel(freq);
  target.members.set(member.id, member);

  send(member.ws, {
    t: 'welcome',
    you: { id: member.id, name: member.name, color: member.color },
    channel: target.id,
    members: memberList(target),
    talker: target.talker
      ? { id: target.talker.id, name: target.talker.name, mime: target.talker.mime }
      : null,
  });
  broadcast(target, { t: 'members', members: memberList(target) }, member.id);
  return target;
}

/** Remove a member from a channel, releasing the lock if they held it. */
function leaveChannel(member, source) {
  if (!source || !source.members.has(member.id)) return;
  if (source.talker && source.talker.id === member.id) {
    source.talker = null;
    broadcast(source, { t: 'free', by: { id: member.id, name: member.name } }, member.id);
  }
  source.members.delete(member.id);
  broadcast(source, { t: 'members', members: memberList(source) }, member.id);
  sweepChannel(source);
}

function rateOk(member) {
  const now = Date.now();
  const b = member.bucket;
  const elapsed = (now - b.at) / 1000;
  b.at = now;
  b.tokens = Math.min(LIMITS.msgsPerSecond, b.tokens + elapsed * LIMITS.msgsPerSecond);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/* ------------------------------------------------------------------ *
 * WebSocket transport
 * ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* noop */ }
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  /** @type {Member | null} */
  let me = null;
  /** @type {Channel | null} */
  let ch = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (me && !rateOk(me)) return;
    me && (me.lastSeen = Date.now());

    switch (msg.t) {
      /* ---------------- join ---------------- */
      case 'join': {
        if (me) return; // already joined
        const name = sanitize(msg.name, LIMITS.maxName) || 'OPERATOR';
        const color = /^#[0-9a-f]{6}$/i.test(msg.color || '')
          ? msg.color
          : COLORS[Math.floor(Math.random() * COLORS.length)];

        me = {
          id: crypto.randomUUID(),
          name,
          color,
          ws,
          lastSeen: Date.now(),
          bucket: { tokens: LIMITS.msgsPerSecond, at: Date.now() },
        };
        ch = joinChannel(me, normalizeFrequency(msg.freq ?? msg.channel));
        break;
      }

      /* ---------------- retune (scan / dial) ---------------- */
      case 'retune': {
        if (!me) return;
        const target = normalizeFrequency(msg.freq ?? msg.channel);
        if (ch && ch.id === target) {           // already there: just re-confirm
          send(ws, { t: 'tuned', freq: target, members: memberList(ch),
                     talker: ch.talker ? { id: ch.talker.id, name: ch.talker.name, mime: ch.talker.mime } : null });
          return;
        }
        leaveChannel(me, ch);
        ch = joinChannel(me, target);
        break;
      }

      /* ---------------- spectrum scan ---------------- */
      case 'scan': {
        if (!me) return;
        const list = Array.isArray(msg.freqs) ? msg.freqs.slice(0, 220) : [];
        const active = [];
        for (const f of list) {
          const id = normalizeFrequency(f);
          const target = channels.get(id);
          if (!target) continue;
          const others = [...target.members.values()].filter((m) => m.id !== me.id);
          if (others.length === 0) continue;
          active.push({
            freq: id,
            members: others.length,
            talker: target.talker ? target.talker.name : null,
          });
        }
        send(ws, { t: 'scanResult', active });
        break;
      }

      /* ---------------- push to talk ---------------- */
      case 'ptt': {
        if (!me || !ch) return;
        const wants = msg.on === true;

        if (wants) {
          // Someone else already holds the channel?
          if (ch.talker && ch.talker.id !== me.id) {
            send(ws, { t: 'denied', by: { id: ch.talker.id, name: ch.talker.name } });
            return;
          }
          const mime = sanitize(msg.mime, 60) || 'audio/webm;codecs=opus';
          ch.talker = { id: me.id, name: me.name, since: Date.now(), mime };
          broadcast(ch, { t: 'busy', by: { id: me.id, name: me.name, color: me.color }, mime }, me.id);
          send(ws, { t: 'granted' });
        } else {
          if (ch.talker && ch.talker.id === me.id) {
            ch.talker = null;
            broadcast(ch, { t: 'free', by: { id: me.id, name: me.name } }, me.id);
          }
          send(ws, { t: 'released' });
        }
        break;
      }

      /* ---------------- relay audio ---------------- */
      case 'audio': {
        if (!me || !ch) return;
        if (!ch.talker || ch.talker.id !== me.id) return; // not your turn: drop
        const data = msg.data;
        if (typeof data !== 'string' || data.length > LIMITS.maxChunkBytes) return;
        broadcast(ch, { t: 'audio', from: me.id, seq: msg.seq | 0, data }, me.id);
        break;
      }

      /* ---------------- liveness ---------------- */
      case 'ping':
        send(ws, { t: 'pong', at: Date.now() });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!me) return;
    leaveChannel(me, ch);
  });

  ws.on('error', () => { /* close handler cleans up */ });
});

// Keep dead sockets from squatting on the channel lock.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`TWO RADIO listening on http://${HOST}:${PORT}`);
  console.log('frequencies: ' + PMR446.join(' '));
});
