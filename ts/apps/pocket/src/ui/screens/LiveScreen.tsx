import { Stack, useIsFocused } from 'expo-router';
import { Activity } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, useWindowDimensions, View } from 'react-native';

import { Heatmap, HeatmapLegend } from '../components/Heatmap';
import { Caption, Card, Empty, Screen, SegmentedControl } from '../components/primitives';
import { formatDuration, formatValue, frameStats } from '../format';
import { useI18n } from '../i18n';
import { RANGE_PRESETS } from '../pressureColor';
import { useDevice, useLiveFrame } from '../store';
import { useTheme } from '../theme';
import { useRecordingElapsed, useRecordingToggle } from './DeviceScreen';

function Stat({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 2, paddingVertical: 10, backgroundColor: theme.colors.panelSoft, borderRadius: theme.radius.md }}>
      <Text style={{ color: theme.colors.textDim, fontSize: 12, fontWeight: '500' }}>{label}</Text>
      <Text style={{ color: theme.colors.text, fontSize: 22, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}

/** The big round record button: accent ring, danger core; a square while recording. */
function RecordButton({ recording, finishing, busy, disabled, onPress, label }: {
  recording: boolean;
  finishing: boolean;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
  label: string;
}) {
  const theme = useTheme();
  const size = 76;
  const inner = recording ? 28 : 56;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy || finishing}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy || finishing, busy: busy || finishing }}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 4,
        borderColor: recording ? theme.colors.danger : theme.colors.lineStrong,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      {busy || finishing ? (
        <ActivityIndicator color={theme.colors.danger} />
      ) : (
        <View style={{ width: inner, height: inner, borderRadius: recording ? theme.radius.sm : inner / 2, backgroundColor: theme.colors.danger }} />
      )}
    </Pressable>
  );
}

export function LiveScreen({ uid }: { uid: string }) {
  const theme = useTheme();
  const { t } = useI18n();
  const focused = useIsFocused();
  const device = useDevice(uid);
  const frame = useLiveFrame(uid, focused);
  const elapsed = useRecordingElapsed(uid);
  const recording = useRecordingToggle(uid);
  const [rangeIndex, setRangeIndex] = useState(0);
  const range = RANGE_PRESETS[rangeIndex] ?? RANGE_PRESETS[0]!;
  const { height } = useWindowDimensions();
  const stats = useMemo(() => (frame ? frameStats(frame.values) : null), [frame]);

  const rows = frame?.rows ?? device?.matrix?.rows ?? 0;
  const cols = frame?.cols ?? device?.matrix?.cols ?? 0;
  const recState = device?.recording ?? { enabled: false, finishing: false, error: '' };

  return (
    <Screen topInset={false}>
      <Stack.Screen options={{ title: device ? `${device.displayName}` : t('liveTitle') }} />
      <Card>
        {rows > 0 && cols > 0 ? (
          <>
            <Heatmap values={frame?.values ?? null} rows={rows} cols={cols} range={range} maxHeight={Math.max(240, height * 0.55)} />
            {!frame ? <Caption style={{ textAlign: 'center' }}>{t('liveWaiting')}</Caption> : null}
            <HeatmapLegend range={range} />
          </>
        ) : (
          <Empty icon={Activity}>{device?.matrix === null ? t('liveNoMatrix') : t('liveWaiting')}</Empty>
        )}
      </Card>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Stat label={t('liveMax')} value={stats ? formatValue(stats.max) : '-'} />
        <Stat label={t('liveMean')} value={stats ? formatValue(stats.mean) : '-'} />
        <Stat label={t('liveFps')} value={frame ? String(frame.fps) : '-'} />
      </View>

      <Card>
        <Caption>{t('liveRange')}</Caption>
        <SegmentedControl
          accessibilityLabel={t('liveRange')}
          options={RANGE_PRESETS.map((r, i) => ({ value: i, label: `${r.min}–${r.max}` }))}
          value={rangeIndex}
          onChange={setRangeIndex}
        />
      </Card>

      <Card style={{ alignItems: 'center', gap: 10, paddingVertical: 20 }}>
        <RecordButton
          recording={recState.enabled}
          finishing={recState.finishing}
          busy={recording.busy}
          disabled={!device?.online && !recState.enabled}
          onPress={() => recording.toggle(!recState.enabled)}
          label={recState.enabled ? t('stopRecording') : t('startRecording')}
        />
        <Text
          style={{
            color: recState.enabled ? theme.colors.danger : theme.colors.textDim,
            fontSize: recState.enabled ? 22 : 15,
            fontWeight: '600',
            fontVariant: ['tabular-nums'],
          }}
        >
          {recState.finishing ? t('recordingFinishing') : recState.enabled ? formatDuration(elapsed ?? 0) : t('startRecording')}
        </Text>
      </Card>
    </Screen>
  );
}
