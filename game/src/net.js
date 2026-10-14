// Host side of the relay connection: creates/keeps a room, reconnects with
// backoff, and answers phone pings immediately so latency is measured end to end.

function resolveServer() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  if (import.meta.env.VITE_SERVER_URL) return import.meta.env.VITE_SERVER_URL;
  // same origin: game is being served by the relay itself (local mode)
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

const isLocalHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';

export class Relay {
  constructor(handlers) {
    this.handlers = handlers;
    this.url = resolveServer();
    this.ws = null;
    this.code = null;
    this.retry = 0;
  }

  // The URL the phone should use. If the game was opened at localhost,
  // swap in the laptop's LAN IP so the phone can actually reach it.
  async phoneServerUrl() {
    const u = new URL(this.url);
    if (!isLocalHost(u.hostname)) return this.url;
    try {
      const http = this.url.replace(/^ws/, 'http');
      const info = await (await fetch(`${http}/info`)).json();
      if (info.ips?.length) {
        this.handlers.onHint(`phone connects to ${info.ips[0]}:${u.port || info.port}`);
        return `${u.protocol}//${info.ips[0]}:${u.port || info.port}`;
      }
    } catch {}
    this.handlers.onHint('open this page via your LAN IP so the phone can reach it');
    return this.url;
  }

  connect() {
    this.handlers.onStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.handlers.onStatus('live');
      // ask for our old room back after a drop so phones don't need to rescan
      ws.send(JSON.stringify({ t: 'host', code: this.code }));
    };

    ws.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      switch (m.t) {
        case 'i':
          this.handlers.onInput(m);
          break;
        case 'ping':
          // bounce straight back: phone measures phone -> server -> laptop -> server -> phone
          ws.send(JSON.stringify({ t: 'pong', p: m.p, ts: m.ts }));
          break;
        case 'lat':
          this.handlers.onLatency(m.p, m.ms);
          break;
        case 'player':
          this.handlers.onPlayer(m);
          break;
        case 'room': {
          this.code = m.code;
          const server = await this.phoneServerUrl();
          const joinUrl = `tiltmaze://join?c=${m.code}&s=${encodeURIComponent(server)}`;
          this.handlers.onRoom(m.code, joinUrl);
          break;
        }
      }
    };

    ws.onclose = () => {
      this.handlers.onStatus('lost');
      const wait = Math.min(5000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), wait);
    };
  }

  fx(slot, kind) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'fx', p: slot, kind }));
  }
}
