// Change this to your deployed relay before building the APK.
// Scanning the game's QR overrides it, so it only matters for typed codes.
export const DEFAULT_SERVER = 'wss://tilt-controller-relay.fly.dev';

export const SEND_INTERVAL_MS = 16; // ~60 packets per second
export const MAX_TILT_RAD = 0.45; // ~26 degrees of tilt = full speed
export const DEADZONE = 0.06; // ignore hand tremor around neutral
export const SHAKE_THRESHOLD = 13; // m/s² of linear acceleration
export const SHAKE_COOLDOWN_MS = 400;

export const theme = {
  bg: '#0b0c12',
  panel: '#151824',
  line: '#242a3b',
  text: '#e9ecf5',
  dim: '#8189a3',
  accent: '#ff6b4a',
  ok: '#5ef0a0',
  warn: '#ffc24a',
  bad: '#ff5d5d',
};

export const PLAYER_COLORS = ['#ff6b4a', '#43d3ff', '#ffd23f', '#a78bfa'];

// tiltmaze://join?c=1234&s=wss%3A%2F%2Fhost
export function parseJoinUrl(data: string): { code: string; server: string } | null {
  const m = data.trim().match(/^tiltmaze:\/\/join\?c=(\d{4})&s=(.+)$/);
  if (!m) return null;
  try {
    return { code: m[1], server: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}
