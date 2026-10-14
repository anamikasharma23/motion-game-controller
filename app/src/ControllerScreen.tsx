import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { PLAYER_COLORS, theme } from './config';
import { useMotion, type Tilt } from './useMotion';
import { useRelay, type ConnStatus, type Fx } from './useRelay';

type Props = {
  server: string;
  code: string;
  onLeave: (error?: string) => void;
};

const STATUS: Record<ConnStatus, { label: string; color: string }> = {
  connecting: { label: 'Connecting', color: theme.warn },
  live: { label: 'Live', color: theme.ok },
  nohost: { label: 'Waiting for game', color: theme.warn },
  lost: { label: 'Reconnecting', color: theme.bad },
};

const PAD = 220; // tilt visualiser size
const DOT = 34;

export default function ControllerScreen({ server, code, onLeave }: Props) {
  useKeepAwake(); // screen must not sleep mid-game

  const [invertX, setInvertX] = useState(false);
  const [invertY, setInvertY] = useState(false);
  const [view, setView] = useState<Tilt>({ x: 0, y: 0 });
  const [jumpFlash, setJumpFlash] = useState(false);
  const pendingJump = useRef(false);
  const lastViewUpdate = useRef(0);

  const onFx = useCallback((kind: Fx) => {
    if (kind === 'hit') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (kind === 'fall') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    else if (kind === 'win') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else if (kind === 'lose') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  }, []);

  const { status, slot, latency, sendInput } = useRelay({
    server,
    code,
    onFx,
    onFatal: (msg) => onLeave(msg),
  });

  const flashJump = () => {
    setJumpFlash(true);
    setTimeout(() => setJumpFlash(false), 180);
  };

  const { calibrate } = useMotion({
    invertX,
    invertY,
    onSample: (tilt, shake) => {
      if (shake) {
        pendingJump.current = true;
        flashJump();
      }
      // jump flag rides on the next packet; keep it pending if the send was dropped
      if (sendInput(tilt.x, tilt.y, pendingJump.current)) pendingJump.current = false;

      // UI only needs ~20 fps; sensor runs at 60
      const now = Date.now();
      if (now - lastViewUpdate.current > 50) {
        lastViewUpdate.current = now;
        setView(tilt);
      }
    },
  });

  const jump = () => {
    pendingJump.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    flashJump();
  };

  const doCalibrate = () => {
    calibrate();
    Haptics.selectionAsync();
  };

  // calibrate once on entry so whatever grip the player has is "level"
  useEffect(() => {
    const t = setTimeout(calibrate, 300);
    return () => clearTimeout(t);
  }, []);

  const st = STATUS[status];
  const color = slot != null ? PLAYER_COLORS[slot] : theme.accent;
  const dx = (view.x * (PAD - DOT)) / 2;
  const dy = (view.y * (PAD - DOT)) / 2;

  return (
    <View style={s.root}>
      <View style={s.top}>
        <View style={s.pill}>
          <View style={[s.dot, { backgroundColor: st.color }]} />
          <Text style={s.pillText}>{st.label}</Text>
        </View>
        <Text style={s.latency}>{latency != null ? `${latency} ms` : '-- ms'}</Text>
      </View>

      <View style={s.meta}>
        <Text style={s.metaText}>
          Room <Text style={s.metaStrong}>{code}</Text>
        </Text>
        {slot != null && (
          <View style={[s.badge, { backgroundColor: color }]}>
            <Text style={s.badgeText}>P{slot + 1}</Text>
          </View>
        )}
      </View>

      <View style={s.padWrap}>
        <View style={s.pad}>
          <View style={s.crossH} />
          <View style={s.crossV} />
          <View
            style={[
              s.ball,
              { backgroundColor: color, transform: [{ translateX: dx }, { translateY: dy }] },
            ]}
          />
        </View>
        <Text style={s.padHint}>hold the phone flat like a tray and tilt</Text>
      </View>

      <View style={s.actions}>
        <Pressable style={({ pressed }) => [s.calBtn, pressed && s.pressed]} onPress={doCalibrate}>
          <Text style={s.calText}>Set neutral</Text>
        </Pressable>
        <View style={s.inverts}>
          <Toggle label="Flip X" on={invertX} onPress={() => setInvertX((v) => !v)} />
          <Toggle label="Flip Y" on={invertY} onPress={() => setInvertY((v) => !v)} />
        </View>
      </View>

      <Pressable
        onPressIn={jump}
        style={[s.jumpBtn, { backgroundColor: color }, jumpFlash && s.jumpFlash]}
      >
        <Text style={s.jumpText}>JUMP</Text>
        <Text style={s.jumpSub}>or shake</Text>
      </Pressable>

      <Pressable onPress={() => onLeave()}>
        <Text style={s.leave}>Leave room</Text>
      </Pressable>
    </View>
  );
}

function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.toggle, on && s.toggleOn]}>
      <Text style={[s.toggleText, on && s.toggleTextOn]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 22, paddingTop: 58, paddingBottom: 28 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.panel,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: theme.line,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  pillText: { color: theme.text, fontSize: 14, fontWeight: '600' },
  latency: { color: theme.dim, fontSize: 15, fontVariant: ['tabular-nums'] },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  metaText: { color: theme.dim, fontSize: 14 },
  metaStrong: { color: theme.text, fontWeight: '700', letterSpacing: 2 },
  badge: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8 },
  badgeText: { color: '#0b0c12', fontWeight: '800' },
  padWrap: { alignItems: 'center', marginTop: 26 },
  pad: {
    width: PAD,
    height: PAD,
    borderRadius: PAD / 2,
    backgroundColor: theme.panel,
    borderWidth: 1,
    borderColor: theme.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  crossH: { position: 'absolute', width: PAD - 40, height: 1, backgroundColor: theme.line },
  crossV: { position: 'absolute', height: PAD - 40, width: 1, backgroundColor: theme.line },
  ball: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  padHint: { color: theme.dim, fontSize: 12, marginTop: 10 },
  actions: { marginTop: 22, gap: 12 },
  calBtn: {
    backgroundColor: theme.panel,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  calText: { color: theme.text, fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.6 },
  inverts: { flexDirection: 'row', gap: 10 },
  toggle: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.line,
    alignItems: 'center',
  },
  toggleOn: { backgroundColor: theme.line },
  toggleText: { color: theme.dim, fontSize: 13 },
  toggleTextOn: { color: theme.text, fontWeight: '600' },
  jumpBtn: {
    flex: 1,
    marginTop: 18,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 110,
  },
  jumpFlash: { opacity: 0.6, transform: [{ scale: 0.97 }] },
  jumpText: { color: '#0b0c12', fontSize: 34, fontWeight: '900', letterSpacing: 4 },
  jumpSub: { color: 'rgba(11,12,18,0.6)', fontSize: 13, fontWeight: '600' },
  leave: { color: theme.dim, textAlign: 'center', marginTop: 14, fontSize: 13 },
});
