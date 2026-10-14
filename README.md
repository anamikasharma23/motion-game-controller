# Tilt Maze

Your phone becomes a motion controller for a ball maze running in a laptop browser. Tilt to roll, shake (or tap Jump) to hop over low walls and pits, reach the green ring. Up to 4 phones can play in the same room.

```
app/      Expo (React Native) controller app, builds to an APK
game/     Browser game (Vite + canvas)
server/   Node WebSocket relay that pairs phones with the game
```

## Tech stack

| Part | Stack | Why |
|---|---|---|
| Phone app | Expo SDK 57, React Native, TypeScript, expo-sensors, expo-camera, expo-haptics | Real sensor access and a real APK without writing Android code |
| Game | Vite, plain Canvas 2D, `qrcode` | No game engine needed for a ball maze. Small bundle (13 KB gzip), loads instantly |
| Server | Node 22, `ws` | Tiny relay, about 200 lines, one dependency |
| Hosting | Fly.io (Mumbai region) for the relay, Vercel for the game | Lowest round trip from India, free tiers |

## How pairing works

1. The game opens a WebSocket to the relay and sends `{t:"host"}`. The relay creates a room and replies with a 4 digit code.
2. The game shows the code and a QR containing `tiltmaze://join?c=<code>&s=<server url>`. The server URL is inside the QR, so the phone always connects to the same relay the game is using.
3. The phone scans the QR in the app (or with the normal camera, which opens the app through the `tiltmaze://` link), or the player types the code.
4. The phone sends `{t:"join", code, pid}`. The relay assigns a player slot (P1 to P4), tells the game, and both screens switch to live.

`pid` is a random id the phone keeps for the whole app run. If the phone drops and reconnects with the same `pid`, it gets the same slot back, so a player never turns into a new ball mid game.

## Latency approach

The target was input that feels instant, which in practice means under about 50 ms end to end.

**What the phone sends.** Around 60 packets a second, each one about 35 bytes: `{"t":"i","x":0.412,"y":-0.108,"j":0}`. Only the current state is sent, never a history. Every packet fully replaces the previous one, so a lost or late packet doesn't matter. The string is built by hand in the hot path to avoid object allocation.

**Dropping instead of queueing.** If the socket's send buffer backs up (bad Wi-Fi), the phone skips that frame instead of queueing it. Late tilt data is worse than missing tilt data, because a queue turns a brief hiccup into seconds of lag. The jump flag stays pending until a packet actually goes out, so a jump is never lost.

**Relay hot path.** Input messages are checked first and forwarded with no other work. Per-message compression is off (it costs more time than it saves on 35 byte packets), and Nagle's algorithm is disabled on every socket so small packets leave immediately instead of being batched.

**Game side.** The game always uses the latest packet. Tilt is lightly smoothed (35% per frame) so sensor noise doesn't jitter the ball, which adds well under one frame of perceived delay. If no packet arrives for 300 ms the tilt eases to neutral, so a frozen connection never leaves the ball rolling on its own.

**Sensors.** Tilt comes from the OS fused rotation (gyroscope, accelerometer and magnetometer combined by Android), not raw gyro, so there's no drift to correct. Raw linear acceleration is used only for shake detection, with a threshold and a 400 ms cooldown. While the phone is being shaken, tilt holds its last steady value so a jump doesn't also fling the ball sideways.

**Measuring it.** Every second the phone sends a timestamped ping. The relay forwards it to the game, the game bounces it straight back, and the phone halves the round trip. That number shows on the phone and next to each player on the laptop. This measures the whole path (phone to relay to laptop and back), not just the phone to server leg.

**Hosted vs local.** A hosted relay works on any network, including college Wi-Fi that blocks devices from talking to each other, and the extra hop is roughly 20 to 60 ms from central India to Mumbai. On a home network, local mode (below) runs everything on the laptop and latency drops to a few ms. The automated relay test measures about 2 ms round trip locally.

## Calibration

When the controller screen opens, it calibrates automatically after 300 ms, so however the player is holding the phone becomes level. **Set neutral** re-calibrates at any time. A deadzone of 6% around neutral removes hand tremor. Flip X and Flip Y are there for devices that report an axis in the opposite direction.

## Connection status and reconnection

Both sides show their state: connecting, live, waiting for game, or reconnecting. The phone also shows its player number and live latency, and the game lists every player with theirs.

- Phone or laptop drops: it retries with backoff (0.5 s, 1 s, 2 s, 4 s, then every 5 s).
- The relay keeps a room alive for 30 s after the game disconnects, and a player's slot for 30 s after the phone disconnects. The game asks for its old room code back on reconnect, so phones don't need to scan again after a laptop Wi-Fi blip.
- The relay pings every socket every 10 s and terminates ones that don't answer, so a phone that was locked or lost signal shows as disconnected quickly instead of waiting for a TCP timeout.

## Bonus features

- Local multiplayer with up to 4 phones, each with its own colour, and first to the ring wins the level
- On-screen Jump button
- Vibration feedback for wall hits, falling into a pit, winning and losing a level
- Live latency on both screens

## Run it locally

Needs Node 20+.

```bash
# 1. build the game so the relay can serve it
cd game && npm install && npm run build && cd ..

# 2. start the relay (it also serves the game in local mode)
cd server && npm install && npm start
#   prints: local mode: open http://192.168.x.x:8080 on the laptop
```

Open that LAN address on the laptop. Even if you open `localhost:8080`, the game asks the relay for the laptop's LAN IP and puts that in the QR, so the phone can reach it.

For the phone, either install the APK (below) or run `cd app && npm install && npx expo run:android` with a phone connected over USB.

Testing the game without a phone: open `http://localhost:8080/?keys` and use the arrow keys and space.

Relay tests: `cd server && npm test` (pairing, input forwarding, ping relay, phone reconnect into the same slot, game reconnect into the same room, bad codes).

## Deploy

**Relay on Fly.io**

```bash
cd server
fly launch --copy-config --no-deploy   # keeps fly.toml (Mumbai, always on)
fly deploy
```

This gives you `wss://<app-name>.fly.dev`. Render or Railway also work: point them at `server/`, start command `npm start`. If you change hosts, update `DEFAULT_SERVER` in `app/src/config.ts`.

**Game on Vercel**

Import the repo, set the root directory to `game`, and add the environment variable `VITE_SERVER_URL=wss://<app-name>.fly.dev`. Any game URL also accepts `?server=wss://...` to point at a different relay without rebuilding.

**APK with EAS**

```bash
cd app
npx eas-cli@latest login
npx eas-cli@latest build -p android --profile preview
```

EAS builds in the cloud and returns a download link for the APK. The `preview` profile in `eas.json` produces an installable APK, not a Play Store bundle.

## Message protocol

All messages are JSON with a `t` (type) field.

| From | Message | Meaning |
|---|---|---|
| game | `{t:"host", code?}` | Create a room, or reclaim `code` after a reconnect |
| relay | `{t:"room", code}` | Room ready |
| phone | `{t:"join", code, pid}` | Join a room |
| relay | `{t:"joined", p, host}` | Joined as slot `p`; `host` says whether the game is online |
| relay | `{t:"player", p, on, gone?}` | Tells the game a player connected, dropped, or was removed |
| relay | `{t:"host", on}` | Tells phones the game went offline or came back |
| phone | `{t:"i", x, y, j}` | Input: tilt x and y in -1..1, `j`=1 for jump |
| phone | `{t:"ping", ts}` / game `{t:"pong", p, ts}` | Latency measurement |
| phone | `{t:"lat", ms}` | Phone reports its measured latency to the game |
| game | `{t:"fx", p, kind}` | Haptic event for one phone: `hit`, `fall`, `win`, `lose` |
| relay | `{t:"error", msg}` | Bad code, full room, or game closed |
