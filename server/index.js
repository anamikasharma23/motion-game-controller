// Tilt Controller relay server
// Pairs one laptop game ("host") with up to 4 phones ("players") per room
// and forwards messages between them with as little work as possible.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const HOLD_MS = 30_000; // keep a room / player slot alive this long after a drop
const MAX_PLAYERS = 4;
const HEARTBEAT_MS = 10_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, '../game/dist');

/** code -> { code, host, hostTimer, players: Map<pid, {ws, slot, timer}> } */
const rooms = new Map();

const send = (ws, msg) => {
  if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
};

function newCode() {
  let code;
  do code = String(Math.floor(1000 + Math.random() * 9000));
  while (rooms.has(code));
  return code;
}

function freeSlot(room) {
  const used = new Set([...room.players.values()].map((p) => p.slot));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return -1;
}

function closeRoom(room) {
  for (const p of room.players.values()) {
    clearTimeout(p.timer);
    send(p.ws, { t: 'error', msg: 'Game closed. Scan the new code.' });
    p.ws?.close();
  }
  rooms.delete(room.code);
  log(`room ${room.code} closed`);
}

function lanIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

// ---------- HTTP: health check + optional static game (local mode) ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  if (url.pathname === '/info') {
    // LAN addresses, so a game opened at localhost can put a reachable URL in its QR
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ port: PORT, ips: lanIps() }));
  }
  if (!fs.existsSync(STATIC_DIR)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('Tilt Controller relay is running.');
  }
  let file = path.join(STATIC_DIR, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(STATIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(STATIC_DIR, 'index.html');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// perMessageDeflate off: compression adds CPU latency for tiny packets
const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  // Disable Nagle so each small packet leaves immediately
  req.socket.setNoDelay(true);

  ws.role = null; // 'host' | 'player'
  ws.room = null;

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    // ---- hot path first: player input / latency, forwarded to host ----
    if (ws.role === 'player') {
      const room = ws.room;
      if (!room) return;
      if (m.t === 'i' || m.t === 'ping' || m.t === 'lat') {
        m.p = ws.slot;
        return send(room.host, m);
      }
      return;
    }

    if (ws.role === 'host') {
      const room = ws.room;
      // host -> one player (pong, fx) or all players
      if (m.t === 'pong' || m.t === 'fx') {
        for (const p of room.players.values()) if (p.slot === m.p) send(p.ws, m);
      } else if (m.t === 'state') {
        for (const p of room.players.values()) send(p.ws, m);
      }
      return;
    }

    // ---- handshake ----
    if (m.t === 'host') {
      let room = m.code && rooms.get(String(m.code));
      if (room && room.host && room.host.readyState === 1 && room.host !== ws) {
        room = null; // code taken by a live host, make a new room
      }
      if (room) {
        clearTimeout(room.hostTimer);
        log(`host rejoined ${room.code}`);
      } else {
        room = { code: newCode(), host: null, hostTimer: null, players: new Map() };
        rooms.set(room.code, room);
        log(`room ${room.code} created`);
      }
      room.host = ws;
      ws.role = 'host';
      ws.room = room;
      send(ws, { t: 'room', code: room.code });
      for (const [pid, p] of room.players) {
        send(ws, { t: 'player', p: p.slot, on: p.ws?.readyState === 1 });
        send(p.ws, { t: 'host', on: true });
      }
      return;
    }

    if (m.t === 'join') {
      const code = String(m.code || '').trim();
      const pid = String(m.pid || '').slice(0, 64);
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'error', msg: `No game with code ${code}` });
      if (!pid) return send(ws, { t: 'error', msg: 'Missing player id' });

      let p = room.players.get(pid);
      if (p) {
        clearTimeout(p.timer);
        if (p.ws && p.ws !== ws) p.ws.close();
      } else {
        const slot = freeSlot(room);
        if (slot < 0) return send(ws, { t: 'error', msg: 'Room is full (4 players)' });
        p = { slot, ws: null, timer: null };
        room.players.set(pid, p);
      }
      p.ws = ws;
      ws.role = 'player';
      ws.room = room;
      ws.slot = p.slot;
      ws.pid = pid;
      const hostOn = room.host?.readyState === 1;
      send(ws, { t: 'joined', code, p: p.slot, host: hostOn });
      send(room.host, { t: 'player', p: p.slot, on: true });
      log(`player ${p.slot} joined ${code}`);
      return;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room || !rooms.has(room.code)) return;

    if (ws.role === 'host' && room.host === ws) {
      room.host = null;
      for (const p of room.players.values()) send(p.ws, { t: 'host', on: false });
      room.hostTimer = setTimeout(() => closeRoom(room), HOLD_MS);
      log(`host dropped from ${room.code}, holding ${HOLD_MS / 1000}s`);
    }

    if (ws.role === 'player') {
      const p = room.players.get(ws.pid);
      if (!p || p.ws !== ws) return;
      p.ws = null;
      send(room.host, { t: 'player', p: p.slot, on: false });
      p.timer = setTimeout(() => {
        room.players.delete(ws.pid);
        send(room.host, { t: 'player', p: p.slot, gone: true });
        log(`player ${p.slot} removed from ${room.code}`);
      }, HOLD_MS);
    }
  });
});

// Drop sockets that stopped answering (phone locked, wifi gone) so the
// other side sees the disconnect quickly instead of waiting for TCP.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  log(`relay listening on :${PORT}`);
  if (fs.existsSync(STATIC_DIR)) {
    for (const ip of lanIps()) log(`local mode: open http://${ip}:${PORT} on the laptop`);
  }
});
