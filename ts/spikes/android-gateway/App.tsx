// Phase 0 spike screen. Colours are the Desktop tokens (styles.css :root /
// [data-theme="dark"]) and the theme follows the system for now; the real
// app gets the shared ui-tokens package and the auto/light/dark switch.
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';

import NhGatewayNative from './modules/nh-gateway-native/src/NhGatewayNativeModule';
import { GatewaySnapshot, SpikeGateway } from './src/gateway';

const LIGHT = {
  bg: '#f5f5f7',
  panel: '#ffffff',
  panelSoft: '#f2f2f7',
  line: 'rgba(0,0,0,0.08)',
  text: '#1d1d1f',
  dim: '#6e6e73',
  accent: '#1f6b54',
  onAccent: '#ffffff',
  danger: '#d70015',
  success: '#248a3d',
  warning: '#b25000',
};
const DARK = {
  bg: '#1c1c1e',
  panel: '#2c2c2e',
  panelSoft: '#333336',
  line: 'rgba(255,255,255,0.1)',
  text: '#f5f5f7',
  dim: '#aeaeb2',
  accent: '#3fa585',
  onAccent: '#ffffff',
  danger: '#ff453a',
  success: '#32d74b',
  warning: '#ff9f0a',
};

function useGateway(gateway: SpikeGateway) {
  const [snap, setSnap] = useState<GatewaySnapshot>(() => gateway.snapshot());
  useEffect(() => gateway.subscribe(() => setSnap(gateway.snapshot())), [gateway]);
  return snap;
}

export default function App() {
  const c = useColorScheme() === 'dark' ? DARK : LIGHT;
  const s = useMemo(() => styles(c), [c]);
  const [gatewayId, setGatewayId] = useState('nh-gateway-android-spike');
  const gatewayRef = useRef(new SpikeGateway(gatewayId));
  const gateway = gatewayRef.current;
  const snap = useGateway(gateway);
  const [running, setRunning] = useState(false);
  const [batteryOk, setBatteryOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      void PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as never);
    }
    setBatteryOk(NhGatewayNative?.isIgnoringBatteryOptimizations() ?? null);
  }, []);

  const interfaces = NhGatewayNative?.networkInterfaces() ?? [];
  const nativeStats = NhGatewayNative?.stats();

  const toggle = () => {
    if (running) {
      gateway.stop();
    } else {
      gateway.gatewayId = gatewayId.trim() || 'nh-gateway-android-spike';
      gateway.start();
    }
    setRunning(!running);
  };

  const upstreamColor = snap.upstream === 'online' ? c.success : snap.upstream === 'connecting' ? c.warning : c.danger;

  return (
    <View style={s.root}>
      <StatusBar style={c === DARK ? 'light' : 'dark'} />
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.title}>NH Gateway</Text>
        <Text style={s.subtitle}>Phase 0 spike · {snap.nativeAvailable ? 'native UDP' : 'upstream only (Expo Go)'}</Text>

        <View style={s.cards}>
          <Card s={s} label="Upstream" value={snap.upstream} color={upstreamColor} />
          <Card s={s} label="Devices" value={String(snap.devices.length)} />
          <Card s={s} label="Forwarded" value={String(snap.packetsForwarded)} />
          <Card s={s} label="Time req" value={String(snap.timeRequests)} />
        </View>

        <View style={s.panel}>
          <Text style={s.label}>Gateway ID</Text>
          <TextInput
            style={s.input}
            value={gatewayId}
            onChangeText={setGatewayId}
            editable={!running}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={[s.button, running && s.buttonDanger]} onPress={toggle}>
            <Text style={s.buttonText}>{running ? 'Stop' : 'Start gateway'}</Text>
          </Pressable>
          {snap.nativeAvailable && batteryOk === false ? (
            <Pressable
              style={[s.button, s.buttonGhost]}
              onPress={() => {
                NhGatewayNative?.requestIgnoreBatteryOptimizations();
                setTimeout(() => setBatteryOk(NhGatewayNative?.isIgnoringBatteryOptimizations() ?? null), 3000);
              }}
            >
              <Text style={[s.buttonText, { color: c.accent }]}>Allow running in background</Text>
            </Pressable>
          ) : null}
        </View>

        <Section s={s} title="Network">
          {interfaces.length ? (
            interfaces.map((n) => <Row s={s} key={`${n.name}${n.address}`} k={n.name} v={n.address} />)
          ) : (
            <Text style={s.dim}>{snap.nativeAvailable ? 'No IPv4 interface up' : 'Needs the Android build'}</Text>
          )}
          <Row s={s} k="Service" v={snap.serviceRunning ? 'running' : 'stopped'} />
          <Row s={s} k="Battery optimisation" v={batteryOk == null ? '-' : batteryOk ? 'ignored (good)' : 'active'} />
          {nativeStats?.lastError ? <Row s={s} k="Last error" v={nativeStats.lastError} /> : null}
          {snap.upstreamError ? <Row s={s} k="Upstream error" v={snap.upstreamError} /> : null}
        </Section>

        <Section s={s} title="Devices">
          {snap.devices.length === 0 ? <Text style={s.dim}>None yet</Text> : null}
          {snap.devices.map((d) => (
            <Row
              s={s}
              key={d.uid}
              k={d.uid}
              v={`${d.ip} · ${d.fps} fps · ${d.forwarded} fwd · ${Math.round((Date.now() - d.lastSeenMs) / 1000)} s ago`}
            />
          ))}
          <Row s={s} k="FindMe requests / offers" v={`${snap.findmeRequests} / ${snap.offersSent}`} />
          <Row s={s} k="Commands sent / acked" v={`${snap.commandsSent} / ${snap.commandsAcked}`} />
        </Section>

        <Section s={s} title="Timing">
          <Row
            s={s}
            k="Time reply t3-t2 (µs)"
            v={`last ${snap.turnaroundUs.last.toFixed(0)} · avg ${snap.turnaroundUs.avg.toFixed(0)} · max ${snap.turnaroundUs.max.toFixed(0)}`}
          />
          <Row
            s={s}
            k="Native → JS lag (ms)"
            v={`last ${snap.jsLagMs.last.toFixed(1)} · avg ${snap.jsLagMs.avg.toFixed(1)} · max ${snap.jsLagMs.max.toFixed(1)}`}
          />
          <Row
            s={s}
            k="Phone vs Backend clock (ms)"
            v={snap.clockOffsetMs == null ? '-' : String(snap.clockOffsetMs)}
          />
        </Section>

        <Section s={s} title="Per minute (screen-off check)">
          {snap.minutes.length === 0 ? <Text style={s.dim}>First sample after one minute</Text> : null}
          {snap.minutes.slice(0, 40).map((m) => (
            <Row
              s={s}
              key={m.at}
              k={new Date(m.at).toLocaleTimeString()}
              v={`${m.packets} pkts · ${m.timeReqs} time · ${m.upstream ? 'online' : 'OFFLINE'}`}
            />
          ))}
        </Section>

        <Section s={s} title="Log">
          {snap.log.slice(0, 30).map((line, i) => (
            <Text key={i} style={s.mono}>
              {line}
            </Text>
          ))}
        </Section>
      </ScrollView>
    </View>
  );
}

type S = ReturnType<typeof styles>;

function Card({ s, label, value, color }: { s: S; label: string; value: string; color?: string }) {
  return (
    <View style={s.card}>
      <Text style={s.cardLabel}>{label}</Text>
      <Text style={[s.cardValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

function Section({ s, title, children }: { s: S; title: string; children: React.ReactNode }) {
  return (
    <View style={s.panel}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ s, k, v }: { s: S; k: string; v: string }) {
  return (
    <View style={s.row}>
      <Text style={s.rowKey}>{k}</Text>
      <Text style={s.rowValue}>{v}</Text>
    </View>
  );
}

const styles = (c: typeof LIGHT) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    scroll: { padding: 16, paddingTop: 56, gap: 12 },
    title: { fontSize: 28, fontWeight: '700', color: c.text },
    subtitle: { fontSize: 13, color: c.dim, marginBottom: 4 },
    cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    card: {
      flexGrow: 1,
      flexBasis: '45%',
      backgroundColor: c.panel,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      padding: 14,
    },
    cardLabel: { fontSize: 12, color: c.dim },
    cardValue: { fontSize: 22, fontWeight: '700', color: c.text, marginTop: 4 },
    panel: {
      backgroundColor: c.panel,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      padding: 14,
      gap: 8,
    },
    sectionTitle: { fontSize: 15, fontWeight: '600', color: c.text, marginBottom: 2 },
    label: { fontSize: 12, color: c.dim },
    input: {
      backgroundColor: c.panelSoft,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: c.text,
      fontSize: 15,
    },
    button: { backgroundColor: c.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
    buttonDanger: { backgroundColor: c.danger },
    buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.accent },
    buttonText: { color: c.onAccent, fontWeight: '600', fontSize: 15 },
    row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
    rowKey: { color: c.dim, fontSize: 13, flexShrink: 0 },
    rowValue: { color: c.text, fontSize: 13, flexShrink: 1, textAlign: 'right' },
    dim: { color: c.dim, fontSize: 13 },
    mono: { color: c.text, fontSize: 11, fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo' },
  });
