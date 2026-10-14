import QRCode from 'qrcode';
import { LEVELS } from './levels.js';
import { Relay } from './net.js';

// ---------- tuning ----------
const ACCEL = 2600; // px/s² at full tilt (cell units scaled below)
const FRICTION = 0.9; // velocity kept per 1/60 s
const MAX_SPEED = 900;
const JUMP_TIME = 0.55; // seconds airborne
const TILT_SMOOTH = 0.35; // 0..1, how fast displayed tilt follows input
const STALE_MS = 300; // input older than this fades to neutral
const HIT_SPEED = 160; // impact speed that triggers vibration
const COLORS = ['#ff6b4a', '#43d3ff', '#ffd23f', '#a78bfa'];

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

let cell = 48; // px per grid cell, recomputed on resize
let levelIdx = 0;
let grid = [];
let start = { x: 1, y: 1 };
let goal = { x: 1, y: 1 };
let state = 'waiting'; // waiting | ready | playing | cleared | done
let timer = 0;
let bannerUntil = 0;
const results = [];

/** slot -> player */
const players = new Map();

function makePlayer(slot) {
  return {
    slot,
    on: true,
    lat: null,
    tx: 0, ty: 0, // smoothed tilt
    ix: 0, iy: 0, // latest raw tilt
    lastInput: 0,
    jumpQueued: false,
    ball: { x: 0, y: 0, vx: 0, vy: 0, z: 0, air: 0 },
    lastHit: 0,
    trail: [],
  };
}

// ---------- level ----------
function loadLevel(i) {
  levelIdx = i;
  const { map } = LEVELS[i];
  grid = map.map((row) => row.split(''));
  grid.forEach((row, y) =>
    row.forEach((c, x) => {
      if (c === 'S') start = { x, y };
      if (c === 'G') goal = { x, y };
    }),
  );
  resize();
  for (const p of players.values()) resetBall(p);
  timer = 0;
  state = players.size ? 'ready' : 'waiting';
  $('level').textContent = `${i + 1}/${LEVELS.length}`;
}

function resetBall(p) {
  // spread players a little around the start so balls don't overlap
  const off = [[0, 0], [0.35, 0], [0, 0.35], [0.35, 0.35]][p.slot % 4];
  Object.assign(p.ball, {
    x: (start.x + 0.35 + off[0]) * cell,
    y: (start.y + 0.35 + off[1]) * cell,
    vx: 0, vy: 0, z: 0, air: 0,
  });
  p.trail.length = 0;
}

const at = (cx, cy) => (grid[cy] && grid[cy][cx]) || '#';

// ---------- physics ----------
function step(p, dt, now) {
  const b = p.ball;
  const R = cell * 0.28;

  // stale input guard: if packets stop, ease to neutral instead of rolling forever
  const fresh = now - p.lastInput < STALE_MS;
  const ix = fresh ? p.ix : 0;
  const iy = fresh ? p.iy : 0;
  p.tx += (ix - p.tx) * TILT_SMOOTH;
  p.ty += (iy - p.ty) * TILT_SMOOTH;

  if (p.jumpQueued) {
    p.jumpQueued = false;
    if (b.air <= 0) b.air = JUMP_TIME;
  }
  if (b.air > 0) {
    b.air = Math.max(0, b.air - dt);
    const t = 1 - b.air / JUMP_TIME;
    b.z = Math.sin(t * Math.PI); // 0..1..0
  } else b.z = 0;
  const airborne = b.air > 0;

  const scale = cell / 48;
  b.vx += p.tx * ACCEL * scale * dt;
  b.vy += p.ty * ACCEL * scale * dt;
  const f = Math.pow(FRICTION, dt * 60);
  b.vx *= f;
  b.vy *= f;
  const sp = Math.hypot(b.vx, b.vy);
  const max = MAX_SPEED * scale;
  if (sp > max) {
    b.vx *= max / sp;
    b.vy *= max / sp;
  }

  const blocks = (c) => c === '#' || (c === '=' && !airborne);
  let impact = 0;

  // move one axis at a time and push out of solid cells
  for (const axis of ['x', 'y']) {
    b[axis] += (axis === 'x' ? b.vx : b.vy) * dt;
    const cx0 = Math.floor((b.x - R) / cell), cx1 = Math.floor((b.x + R) / cell);
    const cy0 = Math.floor((b.y - R) / cell), cy1 = Math.floor((b.y + R) / cell);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        if (!blocks(at(cx, cy))) continue;
        // closest point on cell to ball center
        const nx = Math.max(cx * cell, Math.min(b.x, (cx + 1) * cell));
        const ny = Math.max(cy * cell, Math.min(b.y, (cy + 1) * cell));
        const dx = b.x - nx, dy = b.y - ny;
        const d2 = dx * dx + dy * dy;
        if (d2 >= R * R) continue;
        if (axis === 'x') {
          impact = Math.max(impact, Math.abs(b.vx));
          b.x = b.vx > 0 ? cx * cell - R - 0.01 : (cx + 1) * cell + R + 0.01;
          b.vx *= -0.35;
        } else {
          impact = Math.max(impact, Math.abs(b.vy));
          b.y = b.vy > 0 ? cy * cell - R - 0.01 : (cy + 1) * cell + R + 0.01;
          b.vy *= -0.35;
        }
      }
  }
  if (impact > HIT_SPEED * scale && now - p.lastHit > 150) {
    p.lastHit = now;
    relay.fx(p.slot, 'hit');
  }

  const gx = Math.floor(b.x / cell), gy = Math.floor(b.y / cell);
  const here = at(gx, gy);
  if (here === 'o' && !airborne) {
    relay.fx(p.slot, 'fall');
    resetBall(p);
    return;
  }
  if (here === 'G' && !airborne && state === 'playing') {
    clearLevel(p);
  }

  p.trail.push({ x: b.x, y: b.y });
  if (p.trail.length > 14) p.trail.shift();
}

function clearLevel(winner) {
  state = 'cleared';
  results.push({ level: levelIdx + 1, slot: winner.slot, time: timer });
  for (const p of players.values()) relay.fx(p.slot, p === winner ? 'win' : 'lose');
  const multi = players.size > 1;
  showBanner(
    `${multi ? `<span style="color:${COLORS[winner.slot]}">P${winner.slot + 1}</span> cleared` : 'Cleared'} in ${timer.toFixed(1)}s`,
    2200,
  );
  setTimeout(() => {
    if (levelIdx + 1 < LEVELS.length) loadLevel(levelIdx + 1);
    else finish();
  }, 2200);
}

function finish() {
  state = 'done';
  const total = results.reduce((s, r) => s + r.time, 0);
  showBanner(`All levels done · ${total.toFixed(1)}s total<br><small>tilt to play again</small>`, 0);
  results.length = 0;
}

function showBanner(html, ms) {
  const el = $('banner');
  el.innerHTML = html;
  el.classList.remove('hidden');
  bannerUntil = ms ? performance.now() + ms : Infinity;
}

// ---------- render ----------
function resize() {
  const wrap = canvas.parentElement.getBoundingClientRect();
  const cols = grid[0].length, rows = grid.length;
  cell = Math.floor(Math.min(wrap.width / cols, wrap.height / rows));
  const dpr = window.devicePixelRatio || 1;
  const prevCell = canvas.dataset.cell ? Number(canvas.dataset.cell) : cell;
  canvas.width = cols * cell * dpr;
  canvas.height = rows * cell * dpr;
  canvas.style.width = `${cols * cell}px`;
  canvas.style.height = `${rows * cell}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // keep balls in the same grid position after a resize
  if (prevCell !== cell)
    for (const p of players.values()) {
      p.ball.x *= cell / prevCell;
      p.ball.y *= cell / prevCell;
      p.trail.length = 0;
    }
  canvas.dataset.cell = cell;
}
window.addEventListener('resize', resize);

function draw(now) {
  const W = grid[0].length * cell, H = grid.length * cell;
  ctx.fillStyle = '#12141c';
  ctx.fillRect(0, 0, W, H);

  // floor grid dots
  ctx.fillStyle = '#1d2130';
  for (let y = 0; y < grid.length; y++)
    for (let x = 0; x < grid[0].length; x++) ctx.fillRect(x * cell + cell / 2 - 1, y * cell + cell / 2 - 1, 2, 2);

  for (let y = 0; y < grid.length; y++)
    for (let x = 0; x < grid[0].length; x++) {
      const c = grid[y][x], px = x * cell, py = y * cell;
      if (c === '#') {
        ctx.fillStyle = '#2a2f42';
        ctx.fillRect(px, py, cell, cell);
        ctx.fillStyle = '#353b52';
        ctx.fillRect(px, py, cell, cell * 0.18);
      } else if (c === '=') {
        ctx.fillStyle = '#3b3354';
        ctx.fillRect(px + 2, py + cell * 0.3, cell - 4, cell * 0.4);
        ctx.fillStyle = '#5a4b85';
        ctx.fillRect(px + 2, py + cell * 0.3, cell - 4, cell * 0.08);
      } else if (c === 'o') {
        const g = ctx.createRadialGradient(px + cell / 2, py + cell / 2, 2, px + cell / 2, py + cell / 2, cell * 0.45);
        g.addColorStop(0, '#000');
        g.addColorStop(1, '#0a0b10');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px + cell / 2, py + cell / 2, cell * 0.42, 0, Math.PI * 2);
        ctx.fill();
      } else if (c === 'G') {
        const pulse = 0.5 + 0.5 * Math.sin(now / 250);
        ctx.strokeStyle = `rgba(110, 255, 170, ${0.5 + pulse * 0.5})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(px + cell / 2, py + cell / 2, cell * (0.3 + pulse * 0.06), 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(110,255,170,0.12)';
        ctx.fill();
      }
    }

  const R = cell * 0.28;
  for (const p of players.values()) {
    const b = p.ball, col = COLORS[p.slot];
    // trail
    p.trail.forEach((t, i) => {
      ctx.fillStyle = col + Math.floor((i / p.trail.length) * 60).toString(16).padStart(2, '0');
      ctx.beginPath();
      ctx.arc(t.x, t.y, R * (0.3 + 0.5 * (i / p.trail.length)), 0, Math.PI * 2);
      ctx.fill();
    });
    // shadow stays on the floor, ball rises
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(b.x + 3, b.y + 4, R * (1 - b.z * 0.3), R * 0.8 * (1 - b.z * 0.3), 0, 0, Math.PI * 2);
    ctx.fill();
    const lift = b.z * cell * 0.45;
    const r = R * (1 + b.z * 0.35);
    const g = ctx.createRadialGradient(b.x - r * 0.35, b.y - lift - r * 0.35, r * 0.1, b.x, b.y - lift, r);
    g.addColorStop(0, '#fff');
    g.addColorStop(0.25, col);
    g.addColorStop(1, shade(col));
    ctx.fillStyle = p.on ? g : '#555';
    ctx.beginPath();
    ctx.arc(b.x, b.y - lift, r, 0, Math.PI * 2);
    ctx.fill();
    if (players.size > 1) {
      ctx.fillStyle = '#0b0c12';
      ctx.font = `700 ${Math.round(r * 0.9)}px Space Grotesk, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.slot + 1, b.x, b.y - lift + 1);
    }
  }
}

function shade(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.floor(v * 0.45);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

// ---------- loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;

  if (state === 'ready') {
    // timer starts on first real tilt so pairing time doesn't count
    for (const p of players.values()) if (Math.hypot(p.ix, p.iy) > 0.12) state = 'playing';
  }
  if (state === 'done') {
    for (const p of players.values())
      if (Math.hypot(p.ix, p.iy) > 0.4) {
        $('banner').classList.add('hidden');
        loadLevel(0);
        break;
      }
  }
  if (state === 'playing') timer += dt;
  if (state === 'playing' || state === 'ready') for (const p of players.values()) if (p.on) step(p, dt, now);

  if (now > bannerUntil) $('banner').classList.add('hidden');
  draw(now);
  $('timer').textContent = timer.toFixed(1);
  requestAnimationFrame(frame);
}

// ---------- side panel ----------
function renderPlayers() {
  const ul = $('players');
  if (!players.size) {
    ul.innerHTML = '<li class="empty">Scan the QR with the app to join</li>';
    return;
  }
  ul.innerHTML = [...players.values()]
    .sort((a, b) => a.slot - b.slot)
    .map(
      (p) => `<li>
        <i style="background:${COLORS[p.slot]}"></i>
        <span>Player ${p.slot + 1}</span>
        <em class="${p.on ? 'ok' : 'off'}">${p.on ? (p.lat != null ? `${p.lat} ms` : 'live') : 'reconnecting'}</em>
      </li>`,
    )
    .join('');
}

function setConn(status, text) {
  const el = $('conn');
  el.dataset.status = status;
  el.querySelector('span').textContent = text;
}

// ---------- networking ----------
const relay = new Relay({
  onStatus: (s) => setConn(s, { connecting: 'connecting to server', live: 'server connected', lost: 'server lost, retrying' }[s]),
  onRoom: async (code, joinUrl) => {
    $('code').textContent = code;
    await QRCode.toCanvas($('qr'), joinUrl, { width: 200, margin: 1, color: { dark: '#0b0c12', light: '#ffffff' } });
  },
  onHint: (txt) => ($('server-hint').textContent = txt),
  onPlayer: (m) => {
    if (m.gone) {
      players.delete(m.p);
    } else {
      let p = players.get(m.p);
      if (!p) {
        p = makePlayer(m.p);
        players.set(m.p, p);
        resetBall(p);
      }
      p.on = m.on;
    }
    if (players.size && state === 'waiting') state = 'ready';
    if (!players.size && state !== 'done') state = 'waiting';
    renderPlayers();
  },
  onInput: (m) => {
    const p = players.get(m.p);
    if (!p) return;
    p.ix = m.x;
    p.iy = m.y;
    p.lastInput = performance.now();
    if (m.j) p.jumpQueued = true;
  },
  onLatency: (slot, ms) => {
    const p = players.get(slot);
    if (!p) return;
    p.lat = ms;
    renderPlayers();
  },
});

// Keyboard fallback for testing without a phone: arrows + space, as player 1
const keys = new Set();
addEventListener('keydown', (e) => {
  if (!new URLSearchParams(location.search).has('keys')) return;
  keys.add(e.key);
  if (!players.has(0)) relay.handlers.onPlayer({ p: 0, on: true });
  if (e.key === ' ') players.get(0).jumpQueued = true;
});
addEventListener('keyup', (e) => keys.delete(e.key));
setInterval(() => {
  if (!keys.size || !players.has(0)) return;
  relay.handlers.onInput({
    p: 0,
    x: (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0),
    y: (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0),
    j: 0,
  });
}, 16);

loadLevel(0);
relay.connect();
requestAnimationFrame(frame);
