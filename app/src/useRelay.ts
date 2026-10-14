import { useCallback, useEffect, useRef, useState } from 'react';

export type ConnStatus = 'connecting' | 'live' | 'nohost' | 'lost';
export type Fx = 'hit' | 'fall' | 'win' | 'lose';

// One id per app run, so a reconnect lands back in the same player slot.
const PLAYER_ID = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type Options = {
  server: string;
  code: string;
  onFx: (kind: Fx) => void;
  onFatal: (msg: string) => void;
};

export function useRelay({ server, code, onFx, onFatal }: Options) {
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [slot, setSlot] = useState<number | null>(null);
  const [latency, setLatency] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const cbs = useRef({ onFx, onFatal });
  cbs.current = { onFx, onFatal };

  useEffect(() => {
    let retry = 0;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      if (stopped) return;
      setStatus('connecting');
      const ws = new WebSocket(server);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'join', code, pid: PLAYER_ID }));
      };

      ws.onmessage = (e) => {
        let m: any;
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        switch (m.t) {
          case 'joined':
            retry = 0;
            setSlot(m.p);
            setStatus(m.host ? 'live' : 'nohost');
            break;
          case 'host':
            setStatus(m.on ? 'live' : 'nohost');
            break;
          case 'pong': {
            // full trip: phone -> server -> laptop -> server -> phone, halved
            const ms = Math.round((Date.now() - m.ts) / 2);
            setLatency(ms);
            if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'lat', ms }));
            break;
          }
          case 'fx':
            cbs.current.onFx(m.kind);
            break;
          case 'error':
            stopped = true;
            cbs.current.onFatal(m.msg);
            ws.close();
            break;
        }
      };

      ws.onerror = () => {};
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (stopped) return;
        setStatus('lost');
        setLatency(null);
        const wait = Math.min(5000, 500 * 2 ** retry++);
        retryTimer = setTimeout(connect, wait);
      };
    };

    connect();
    pingTimer = setInterval(() => {
      const ws = wsRef.current;
      if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
    }, 1000);

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [server, code]);

  // Hot path. Called ~60x/s, so no state updates and no allocations beyond the string.
  const sendInput = useCallback((x: number, y: number, jump: boolean) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return false;
    // drop the frame if the socket is backed up: stale tilt is worse than skipped tilt
    if ((ws as any).bufferedAmount > 1024) return false;
    ws.send(`{"t":"i","x":${x.toFixed(3)},"y":${y.toFixed(3)},"j":${jump ? 1 : 0}}`);
    return true;
  }, []);

  return { status, slot, latency, sendInput };
}
