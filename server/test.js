// End-to-end check of the relay: pairing, input forwarding, ping relay,
// reconnect into the same slot, and host reconnect into the same room.
// Run: npm test   (starts its own server on a random port)
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';

const PORT = 9000 + Math.floor(Math.random() * 500);
const URL = `ws://localhost:${PORT}`;
const srv = spawn(process.execPath, ['index.js'], { env: { ...process.env, PORT }, stdio: 'pipe' });
await new Promise((r) => srv.stdout.once('data', r));

function client() {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const w = waiters.findIndex((x) => x.pred(m));
    if (w >= 0) waiters.splice(w, 1)[0].res(m);
    else inbox.push(m);
  });
  const next = (pred, ms = 2000) =>
    new Promise((res, rej) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) return res(inbox.splice(i, 1)[0]);
      const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
      waiters.push({ pred, res: (m) => (clearTimeout(t), res(m)) });
    });
  const open = new Promise((r) => ws.once('open', r));
  return { ws, next, open, send: (m) => ws.send(JSON.stringify(m)) };
}

try {
  const host = client();
  await host.open;
  host.send({ t: 'host' });
  const { code } = await host.next((m) => m.t === 'room');
  assert.match(code, /^\d{4}$/);

  const p1 = client();
  await p1.open;
  p1.send({ t: 'join', code, pid: 'phone-a' });
  const j = await p1.next((m) => m.t === 'joined');
  assert.equal(j.p, 0);
  assert.equal(j.host, true);
  await host.next((m) => m.t === 'player' && m.p === 0 && m.on);

  // input forwarding
  p1.send({ t: 'i', x: 0.5, y: -0.25, j: 1 });
  const inp = await host.next((m) => m.t === 'i');
  assert.deepEqual(inp, { t: 'i', x: 0.5, y: -0.25, j: 1, p: 0 });

  // ping relay round trip timing
  const t0 = performance.now();
  p1.send({ t: 'ping', ts: 123 });
  const pg = await host.next((m) => m.t === 'ping');
  host.send({ t: 'pong', p: pg.p, ts: pg.ts });
  const back = await p1.next((m) => m.t === 'pong');
  assert.equal(back.ts, 123);
  console.log(`  local relay round trip: ${(performance.now() - t0).toFixed(2)} ms`);

  // fx to the right phone
  host.send({ t: 'fx', p: 0, kind: 'hit' });
  await p1.next((m) => m.t === 'fx' && m.kind === 'hit');

  // second phone gets slot 1
  const p2 = client();
  await p2.open;
  p2.send({ t: 'join', code, pid: 'phone-b' });
  assert.equal((await p2.next((m) => m.t === 'joined')).p, 1);

  // phone drops and reconnects -> same slot
  p1.ws.close();
  await host.next((m) => m.t === 'player' && m.p === 0 && m.on === false);
  const p1b = client();
  await p1b.open;
  p1b.send({ t: 'join', code, pid: 'phone-a' });
  assert.equal((await p1b.next((m) => m.t === 'joined')).p, 0);

  // host drops -> phones told, host rejoins same code -> phones told
  host.ws.close();
  await p1b.next((m) => m.t === 'host' && m.on === false);
  const host2 = client();
  await host2.open;
  host2.send({ t: 'host', code });
  assert.equal((await host2.next((m) => m.t === 'room')).code, code);
  await p1b.next((m) => m.t === 'host' && m.on === true);
  p1b.send({ t: 'i', x: 0.1, y: 0.1, j: 0 });
  await host2.next((m) => m.t === 'i' && m.p === 0);

  // bad code
  const p3 = client();
  await p3.open;
  p3.send({ t: 'join', code: '0000', pid: 'x' });
  await p3.next((m) => m.t === 'error');

  console.log('✓ all relay tests passed');
  process.exitCode = 0;
} catch (e) {
  console.error('✗', e);
  process.exitCode = 1;
} finally {
  srv.kill();
  setTimeout(() => process.exit(), 100);
}
