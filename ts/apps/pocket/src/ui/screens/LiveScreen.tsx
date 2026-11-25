import { Stack, useIsFocused } from 'expo-router';
import {
  computeCop,
  computePointsCop,
  interpolateGrid,
  matrixPinLabels,
  mirrorProfileSensors,
  profilePoints,
  transformGrid,
  transformPinLabels,
} from '@nhgw/host';
import { Activity, Check } from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import { ActivityIndicator, Pressable, Text, useWindowDimensions, View } from 'react-native';

import { getLiveViews } from '../../host';
import type { LiveViewState } from '../../host/liveViews';
import { Heatmap, HeatmapLegend } from '../components/Heatmap';
import { ImuPanels, type ImuPanelLabels } from '../components/ImuPanels';
import { Caption, Card, Empty, Screen, SegmentedControl } from '../components/primitives';
import { Select } from '../components/Select';
import { Surface3D } from '../components/Surface3D';
import { formatDuration, formatValue, frameStats } from '../format';
import { useI18n } from '../i18n';
import { useFeed, useFeedFrame, useLiveFeed, noteRender, renderFps, type LiveFeed } from '../liveFeed';
import { RANGE_PRESETS, type PressureRange } from '../pressureColor';
import { sameData } from '../shareData';
import { useStoreSelector } from '../store';
import { useTheme } from '../theme';
import { useRecordingElapsed, useRecordingToggle } from './DeviceScreen';

const DOT_SIZES = [0.5, 1, 1.5, 2, 3, 4] as const;
/** Render caps on a phone: the map, the IMU panels, the numbers. */
const MAP_HZ = 15;
const IMU_HZ = 8;
const STATS_HZ = 4;

type Transform = { rowMirror: boolean; colMirror: boolean; transpose: boolean };
type ShownProfile = ComponentProps<typeof Heatmap>["profile"] | null;

/** One cell of the stats grid (the Desktop card's Samples / FPS / Max P / Gyro / Acc). */
function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ flexBasis: '47%', flexGrow: 1, alignItems: 'center', gap: 2, paddingVertical: 10, paddingHorizontal: 6, backgroundColor: theme.colors.panelSoft, borderRadius: theme.radius.md }}>
      <Text style={{ color: theme.colors.textDim, fontSize: 12, fontWeight: '500' }}>{label}</Text>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{ color: theme.colors.text, fontSize: small ? 15 : 22, fontWeight: '600', fontVariant: ['tabular-nums'] }}
      >
        {value}
      </Text>
    </View>
  );
}

/** A checkbox chip (the Desktop card's Row Mirror / Col Mirror / Transpose checkboxes). */
function CheckChip({ label, checked, disabled, hint, onChange }: { label: string; checked: boolean; disabled?: boolean; hint?: string; onChange: (next: boolean) => void }) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <Pressable
      onPress={() => onChange(!checked)}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 38,
        paddingHorizontal: 10,
        borderRadius: theme.radius.sm,
        backgroundColor: colors.panelSoft,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          borderWidth: 1.5,
          borderColor: checked ? colors.accent : colors.lineStrong,
          backgroundColor: checked ? colors.accent : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? <Check size={13} color={colors.onAccent} strokeWidth={3} /> : null}
      </View>
      <Text style={{ color: colors.text, fontSize: 14, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

/** The centre of pressure on a small board (the Desktop's cop-mini-board). */
function CopBoard({ cop, aspect, label }: { cop: ReturnType<typeof computeCop>; aspect: number; label: string }) {
  const theme = useTheme();
  const { colors } = theme;
  const size = 64;
  const w = aspect >= 1 ? size : size * aspect;
  const h = aspect >= 1 ? size / aspect : size;
  return (
    <View style={{ flexBasis: '100%', flexDirection: 'row', alignItems: 'center', gap: 14, padding: 10, backgroundColor: colors.panelSoft, borderRadius: theme.radius.md }}>
      <View style={{ width: w, height: h, borderRadius: 6, borderWidth: 1, borderColor: colors.lineStrong }}>
        {cop.hasData ? (
          <View
            style={{
              position: 'absolute',
              left: `${cop.xRatio * 100}%`,
              top: `${cop.yRatio * 100}%`,
              width: 10,
              height: 10,
              marginLeft: -5,
              marginTop: -5,
              borderRadius: 5,
              backgroundColor: colors.danger,
            }}
          />
        ) : null}
      </View>
      <View style={{ gap: 2 }}>
        <Text style={{ color: colors.textDim, fontSize: 12, fontWeight: '500' }}>{label}</Text>
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] }}>
          {`X ${cop.hasData ? cop.x.toFixed(2) : '--'} · Y ${cop.hasData ? cop.y.toFixed(2) : '--'}`}
        </Text>
      </View>
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

type Shape = { rows: number; cols: number; length: number } | null;
const frameShape = (frame: { rows: number; cols: number; values: readonly number[] } | null): Shape =>
  frame ? { rows: frame.rows, cols: frame.cols, length: frame.values.length } : null;

/** The heat map / 3D surface: its own frame subscription, at most MAP_HZ renders a second. */
const LiveMap = memo(function LiveMap({
  feed,
  mode,
  transform,
  streamRows,
  streamCols,
  shownProfile,
  pinLabels,
  range,
  viewHeight,
  mapHeight,
  active,
  label,
  onNo3d,
}: {
  feed: LiveFeed;
  mode: '3d' | '2d';
  transform: Transform;
  streamRows: number;
  streamCols: number;
  shownProfile: ShownProfile;
  pinLabels: { rows: readonly string[]; cols: readonly string[] } | null;
  range: PressureRange;
  viewHeight: number;
  mapHeight: number;
  active: boolean;
  label: string;
  onNo3d: () => void;
}) {
  const { t } = useI18n();
  const frame = useFeedFrame(feed, MAP_HZ);
  // Transpose first, then the mirrors on what is drawn (@nhgw/host transformGrid).
  const grid = useMemo(() => (frame ? transformGrid(frame.values, streamRows, streamCols, transform) : null), [frame, streamRows, streamCols, transform]);
  const rows = transform.transpose ? streamCols : streamRows;
  const cols = transform.transpose ? streamRows : streamCols;
  const surface = useMemo(() => (grid && mode === '3d' ? interpolateGrid(grid.values, rows, cols) : null), [grid, mode, rows, cols]);
  useEffect(() => {
    if (frame) noteRender(feed);
  }, [feed, frame]);
  return (
    <>
      {mode === '3d' ? (
        <Surface3D
          values={surface?.values ?? null}
          rows={surface?.rows ?? rows}
          cols={surface?.cols ?? cols}
          range={range}
          height={viewHeight}
          active={active}
          label={label}
          onUnavailable={onNo3d}
        />
      ) : (
        <Heatmap
          values={shownProfile ? (frame?.values ?? null) : (grid?.values ?? null)}
          rows={rows}
          cols={cols}
          range={range}
          maxHeight={mapHeight}
          pinLabels={pinLabels}
          indices={grid?.indices ?? null}
          profile={shownProfile}
        />
      )}
      {!frame ? <Caption style={{ textAlign: 'center' }}>{t('liveWaiting')}</Caption> : null}
    </>
  );
});

/** Samples / FPS / Max / Mean / COP, a few times a second. */
const LiveStats = memo(function LiveStats({
  feed,
  transform,
  streamRows,
  streamCols,
  shownProfile,
}: {
  feed: LiveFeed;
  transform: Transform;
  streamRows: number;
  streamCols: number;
  shownProfile: ShownProfile;
}) {
  const { t } = useI18n();
  const frame = useFeedFrame(feed, STATS_HZ);
  const rows = transform.transpose ? streamCols : streamRows;
  const cols = transform.transpose ? streamRows : streamCols;
  const stats = frame ? frameStats(frame.values) : null;
  const cop =
    shownProfile && frame
      ? computePointsCop(profilePoints(shownProfile, frame.values, frame.values.length), rows, cols)
      : computeCop(frame ? transformGrid(frame.values, streamRows, streamCols, transform).values : [], rows, cols);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      <Stat label={t('liveSamples')} value={frame ? String(feed.samples) : '-'} />
      <Stat label={t('liveDeviceFps')} value={frame ? frame.fps.toFixed(1) : '-'} />
      <Stat label={t('liveRenderFps')} value={frame ? renderFps(feed).toFixed(1) : '-'} />
      <Stat label={t('liveMaxP')} value={stats ? formatValue(stats.max) : '-'} />
      <Stat label={t('liveMean')} value={stats ? formatValue(stats.mean) : '-'} />
      <CopBoard cop={cop} aspect={cols > 0 && rows > 0 ? cols / rows : 1} label={t('liveCop')} />
    </View>
  );
});

/** The IMU panels, redrawn IMU_HZ times a second from the feed's history. */
const LiveImu = memo(function LiveImu({ feed, labels }: { feed: LiveFeed; labels: ImuPanelLabels }) {
  useFeedFrame(feed, IMU_HZ);
  return <ImuPanels history={feed.imu} now={Date.now()} labels={labels} />;
});

/** The record button and elapsed time (ticks every second on its own). */
const RecordCard = memo(function RecordCard({ uid, recState, online }: { uid: string; recState: { enabled: boolean; finishing: boolean }; online: boolean }) {
  const theme = useTheme();
  const { t } = useI18n();
  const elapsed = useRecordingElapsed(uid);
  const recording = useRecordingToggle(uid);
  return (
    <Card style={{ alignItems: 'center', gap: 10, paddingVertical: 20 }}>
      <RecordButton
        recording={recState.enabled}
        finishing={recState.finishing}
        busy={recording.busy}
        disabled={!online && !recState.enabled}
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
  );
});

export function LiveScreen({ uid }: { uid: string }) {
  const theme = useTheme();
  const { t } = useI18n();
  const focused = useIsFocused();
  // Only what the screen itself shows: fps / battery ticking must not redraw it.
  const device = useStoreSelector((s) => {
    const d = s.devices().find((entry) => entry.uid === uid);
    return d
      ? {
          displayName: d.displayName,
          online: d.online,
          hardwareModel: d.hardwareModel,
          matrix: d.matrix,
          pins: d.pins ?? null,
          recording: { enabled: d.recording.enabled, finishing: d.recording.finishing },
        }
      : null;
  });
  const feed = useLiveFeed(uid, focused);
  // The screen re-renders for a new matrix shape only; the parts below read the frames.
  const shape = useFeed(feed, STATS_HZ, frameShape, sameData);
  const [rangeIndex, setRangeIndex] = useState(0);
  const range = RANGE_PRESETS[rangeIndex] ?? RANGE_PRESETS[0]!;
  const { height } = useWindowDimensions();
  const recState = device?.recording ?? { enabled: false, finishing: false };

  // The card's view (3D / 2D, profile, mirrors, Transpose, dot size), kept per device.
  const liveViews = getLiveViews();
  const [view, setView] = useState<LiveViewState>(() => liveViews.view(uid));
  useEffect(() => setView(liveViews.view(uid)), [liveViews, uid]);
  const update = (patch: Partial<LiveViewState>) => setView(liveViews.setView(uid, patch));
  const [no3d, setNo3d] = useState(false);
  const onNo3d = useCallback(() => setNo3d(true), []);
  const mode = no3d ? '2d' : view.mode;
  // Profiles arrive with sync; re-read when the screen comes to the front.
  const profileList = useMemo(() => (focused ? liveViews.profiles() : []), [liveViews, focused]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const profile = useMemo(() => (view.profile ? liveViews.profile(view.profile) : null), [liveViews, view.profile, focused]);

  const streamRows = shape?.rows ?? device?.matrix?.rows ?? 0;
  const streamCols = shape?.cols ?? device?.matrix?.cols ?? 0;
  // A profile places its sensors over its own picture: the mirrors flip those
  // positions (values stay with their sensor) and Transpose does not apply.
  const usesProfile = useMemo(() => Boolean(profile && profilePoints(profile, null, shape?.length ?? Infinity).length), [profile, shape?.length]);
  const transform = useMemo(
    () => ({ rowMirror: view.rowMirror, colMirror: view.colMirror, transpose: view.transpose && !usesProfile }),
    [view.rowMirror, view.colMirror, view.transpose, usesProfile],
  );
  const rows = transform.transpose ? streamCols : streamRows;
  const cols = transform.transpose ? streamRows : streamCols;
  const hardwareModel = device?.hardwareModel;
  const pins = device?.pins ?? null;
  const pinLabels = useMemo(() => {
    if (!hardwareModel) return null;
    const labels = matrixPinLabels(hardwareModel, pins, streamRows, streamCols);
    return labels ? transformPinLabels(labels, transform) : null;
  }, [hardwareModel, pins, streamRows, streamCols, transform]);
  const shownProfile = useMemo(
    () => (profile && usesProfile ? { ...mirrorProfileSensors(profile, view.rowMirror, view.colMirror), display: { ...(profile.display ?? {}), dotSize: view.dotSize } } : null),
    [profile, usesProfile, view.rowMirror, view.colMirror, view.dotSize],
  );

  const imuLabels = useMemo<ImuPanelLabels>(
    () => ({
      acc: t('liveImuAcc'),
      gyro: t('liveImuGyro'),
      mag: t('liveImuMag'),
      noMag: t('liveImuNoMag'),
      heading: t('liveImuHeading'),
      tilt: t('liveImuTilt'),
      magnitude: '|v|',
    }),
    [t],
  );

  const viewHeight = Math.max(240, height * 0.5);
  const mapHeight = Math.max(240, height * 0.55);
  const label = device ? device.displayName : t('liveTitle');

  return (
    <Screen topInset={false}>
      <Stack.Screen options={{ title: device ? `${device.displayName}` : t('liveTitle') }} />
      <Card style={{ gap: 10 }}>
        <SegmentedControl<'3d' | '2d'>
          accessibilityLabel={t('liveViewMode')}
          options={[
            { value: '3d', label: t('liveSurface3d') },
            { value: '2d', label: t('liveHeatmap2d') },
          ]}
          value={mode}
          onChange={(next) => {
            setNo3d(false);
            update({ mode: next });
          }}
        />
        <Select<string>
          label={t('liveProfile')}
          options={[{ value: '', label: t('liveProfileNone') }, ...profileList.map((p) => ({ value: p.name, label: p.displayName }))]}
          value={view.profile ?? ''}
          onChange={(next) => update({ profile: next || null })}
        />
        {profileList.length === 0 ? <Caption>{t('liveProfileHint')}</Caption> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <CheckChip label={t('liveRowMirror')} checked={view.rowMirror} onChange={(v) => update({ rowMirror: v })} />
          <CheckChip label={t('liveColMirror')} checked={view.colMirror} onChange={(v) => update({ colMirror: v })} />
          <CheckChip
            label={t('liveTranspose')}
            checked={transform.transpose}
            disabled={usesProfile}
            hint={usesProfile ? t('liveTransposeHint') : undefined}
            onChange={(v) => update({ transpose: v })}
          />
          <View style={{ flex: 1 }} />
          {rows > 0 && cols > 0 ? (
            <Text style={{ color: theme.colors.textDim, fontSize: 14, fontVariant: ['tabular-nums'] }}>
              {rows} × {cols}
            </Text>
          ) : null}
        </View>
        {usesProfile ? (
          <View style={{ gap: 6 }}>
            <Caption>{t('liveDotSize', { size: view.dotSize.toFixed(2) })}</Caption>
            <SegmentedControl<number>
              accessibilityLabel={t('liveDotSize', { size: view.dotSize.toFixed(2) })}
              options={DOT_SIZES.map((size) => ({ value: size, label: `${size}×` }))}
              value={DOT_SIZES.includes(view.dotSize as (typeof DOT_SIZES)[number]) ? view.dotSize : 1}
              onChange={(size) => update({ dotSize: size })}
            />
          </View>
        ) : null}
      </Card>

      <Card>
        {streamRows > 0 && streamCols > 0 ? (
          <>
            <LiveMap
              feed={feed}
              mode={mode}
              transform={transform}
              streamRows={streamRows}
              streamCols={streamCols}
              shownProfile={shownProfile}
              pinLabels={pinLabels}
              range={range}
              viewHeight={viewHeight}
              mapHeight={mapHeight}
              active={focused}
              label={label}
              onNo3d={onNo3d}
            />
            {no3d && view.mode === '3d' ? <Caption style={{ textAlign: 'center' }}>{t('live3dUnavailable')}</Caption> : null}
            <HeatmapLegend range={range} />
          </>
        ) : (
          <Empty icon={Activity}>{device?.matrix === null ? t('liveNoMatrix') : t('liveWaiting')}</Empty>
        )}
      </Card>

      <LiveStats feed={feed} transform={transform} streamRows={streamRows} streamCols={streamCols} shownProfile={shownProfile} />

      <LiveImu feed={feed} labels={imuLabels} />

      <Card>
        <Caption>{t('liveRange')}</Caption>
        <SegmentedControl
          accessibilityLabel={t('liveRange')}
          options={RANGE_PRESETS.map((r, i) => ({ value: i, label: `${r.min}–${r.max}` }))}
          value={rangeIndex}
          onChange={setRangeIndex}
        />
      </Card>

      <RecordCard uid={uid} recState={recState} online={Boolean(device?.online)} />
    </Screen>
  );
}
