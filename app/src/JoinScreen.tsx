import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { parseJoinUrl, theme } from './config';

type Props = {
  initialServer: string;
  error: string | null;
  onJoin: (server: string, code: string) => void;
};

export default function JoinScreen({ initialServer, error, onJoin }: Props) {
  const [perm, requestPerm] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState('');
  const [server, setServer] = useState(initialServer);
  const [showServer, setShowServer] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const handled = useRef(false);

  const startScan = async () => {
    if (!perm?.granted) {
      const r = await requestPerm();
      if (!r.granted) {
        setScanMsg('Camera blocked. Type the room code instead.');
        return;
      }
    }
    handled.current = false;
    setScanMsg(null);
    setScanning(true);
  };

  const onScanned = ({ data }: { data: string }) => {
    if (handled.current) return;
    const parsed = parseJoinUrl(data);
    if (!parsed) {
      setScanMsg("That QR isn't a Tilt Maze code.");
      return;
    }
    handled.current = true;
    setScanning(false);
    onJoin(parsed.server, parsed.code);
  };

  const canJoin = /^\d{4}$/.test(code) && /^wss?:\/\//.test(server.trim());

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.header}>
        <Text style={s.logo}>◐</Text>
        <View>
          <Text style={s.title}>Tilt Maze</Text>
          <Text style={s.sub}>controller</Text>
        </View>
      </View>

      <View style={s.scanBox}>
        {scanning ? (
          <>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onScanned}
            />
            <View style={s.reticle} pointerEvents="none" />
            <Pressable style={s.cancel} onPress={() => setScanning(false)}>
              <Text style={s.cancelText}>Cancel</Text>
            </Pressable>
          </>
        ) : (
          <Pressable style={s.scanIdle} onPress={startScan}>
            <Text style={s.scanIcon}>⌗</Text>
            <Text style={s.scanTitle}>Scan QR on the laptop</Text>
            <Text style={s.scanHint}>fastest way to pair</Text>
          </Pressable>
        )}
      </View>
      {scanMsg && <Text style={s.warn}>{scanMsg}</Text>}

      <Text style={s.or}>or type the room code</Text>

      <View style={s.row}>
        <TextInput
          style={s.codeInput}
          value={code}
          onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 4))}
          keyboardType="number-pad"
          placeholder="0000"
          placeholderTextColor={theme.line}
          maxLength={4}
        />
        <Pressable
          style={[s.joinBtn, !canJoin && s.disabled]}
          disabled={!canJoin}
          onPress={() => onJoin(server.trim(), code)}
        >
          <Text style={s.joinText}>Join</Text>
        </Pressable>
      </View>

      <Pressable onPress={() => setShowServer((v) => !v)}>
        <Text style={s.serverToggle}>server: {server.replace(/^wss?:\/\//, '')} {showServer ? '▴' : '▾'}</Text>
      </Pressable>
      {showServer && (
        <TextInput
          style={s.serverInput}
          value={server}
          onChangeText={setServer}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="wss://your-relay.fly.dev"
          placeholderTextColor={theme.dim}
        />
      )}

      {error && <Text style={s.error}>{error}</Text>}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 22, paddingTop: 64 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 26 },
  logo: { fontSize: 36, color: theme.accent },
  title: { color: theme.text, fontSize: 24, fontWeight: '700' },
  sub: { color: theme.dim, fontSize: 13 },
  scanBox: {
    height: 300,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: theme.panel,
    borderWidth: 1,
    borderColor: theme.line,
  },
  scanIdle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  scanIcon: { fontSize: 54, color: theme.accent },
  scanTitle: { color: theme.text, fontSize: 18, fontWeight: '600' },
  scanHint: { color: theme.dim, fontSize: 13 },
  reticle: {
    position: 'absolute',
    top: 50,
    left: '50%',
    marginLeft: -100,
    width: 200,
    height: 200,
    borderWidth: 3,
    borderColor: theme.accent,
    borderRadius: 18,
  },
  cancel: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 99,
  },
  cancelText: { color: '#fff', fontWeight: '600' },
  warn: { color: theme.warn, marginTop: 10, textAlign: 'center' },
  or: { color: theme.dim, textAlign: 'center', marginVertical: 20, fontSize: 13 },
  row: { flexDirection: 'row', gap: 10 },
  codeInput: {
    flex: 1,
    backgroundColor: theme.panel,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 14,
    color: theme.text,
    fontSize: 30,
    letterSpacing: 10,
    textAlign: 'center',
    paddingVertical: 12,
    fontVariant: ['tabular-nums'],
  },
  joinBtn: { backgroundColor: theme.accent, borderRadius: 14, paddingHorizontal: 26, justifyContent: 'center' },
  joinText: { color: '#0b0c12', fontSize: 18, fontWeight: '700' },
  disabled: { opacity: 0.35 },
  serverToggle: { color: theme.dim, fontSize: 12, marginTop: 16, textAlign: 'center' },
  serverInput: {
    marginTop: 8,
    backgroundColor: theme.panel,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 10,
    color: theme.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  error: { color: theme.bad, marginTop: 18, textAlign: 'center' },
});
