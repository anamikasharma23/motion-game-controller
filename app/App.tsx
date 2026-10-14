import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import JoinScreen from './src/JoinScreen';
import ControllerScreen from './src/ControllerScreen';
import { DEFAULT_SERVER, parseJoinUrl } from './src/config';

type Session = { server: string; code: string };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [lastServer, setLastServer] = useState(DEFAULT_SERVER);
  const [error, setError] = useState<string | null>(null);

  const join = (server: string, code: string) => {
    setError(null);
    setLastServer(server);
    setSession({ server, code });
  };

  // Scanning the QR with the phone's normal camera / Google Lens also works:
  // the tiltmaze:// link opens the app straight into the room.
  useEffect(() => {
    const handle = (url: string | null) => {
      const p = url && parseJoinUrl(url);
      if (p) join(p.server, p.code);
    };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  return (
    <>
      <StatusBar style="light" />
      {session ? (
        <ControllerScreen
          key={`${session.server}|${session.code}`}
          server={session.server}
          code={session.code}
          onLeave={(err) => {
            setError(err ?? null);
            setSession(null);
          }}
        />
      ) : (
        <JoinScreen initialServer={lastServer} error={error} onJoin={join} />
      )}
    </>
  );
}
