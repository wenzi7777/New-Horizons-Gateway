// Analysis of one recording (the Desktop's Tools > Data analysis, at phone size): overview, a trace
// you can scrub and play back, the pressure heatmap at the cursor, sampling quality, per-sensor
// statistics and events. Parsing is shared with NH Studio (@nhgw/analysis).

import { Stack } from 'expo-router';
import { Minus, Pause, Play, Plus, RotateCcw } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';
import {
  defaultGridColumns,
  intervalHistogram,
  metaGridColumns,
  nearestIndex,
  nextSpeed,
  playbackTime,
  sensorFrame,
  sensorStats,
  summarizeRecording,
  type SensorStat,
} from '@nhgw/analysis';

import { AnalysisChart, type AnalysisMetric } from '../components/AnalysisChart';
import { Heatmap } from '../components/Heatmap';
import { Body, Button, Caption, Card, Divider, Empty, FactRow, Screen, SectionHeader, SegmentedControl } from '../components/primitives';
import { loadRecordingForAnalysis, type LoadedRecording } from '../analysis/loadRecording';
import { formatDuration, formatValue } from '../format';
import { useI18n } from '../i18n';
import { DEFAULT_RANGE } from '../pressureColor';
import { useStore } from '../store';
import { useTheme } from '../theme';

type HeatMode = 'frame' | 'mean' | 'peak';
type StatSort = 'mean' | 'peak';

const MIN_VISIBLE_ROWS = 20;
const ISSUES_STEP = 12;
const UI_FRAME_MS = 40;

export function AnalysisScreen({ id }: { id: string }) {
  const theme = useTheme();
  const { t } = useI18n();
  const store = useStore();
  const [loaded, setLoaded] = useState<LoadedRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    setProgress(0);
    loadRecordingForAnalysis(store, id, id.split('/').pop() ?? id, setProgress, () => cancelled)
      .then((value) => !cancelled && value && setLoaded(value))
      .catch((cause: unknown) => !cancelled && setError(String((cause as Error)?.message ?? cause)));
    return () => {
      cancelled = true;
    };
  }, [store, id, attempt]);

  if (!loaded) {
    return (
      <Screen topInset={false}>
        <Stack.Screen options={{ title: t('analysisTitle') }} />
        <Card>
          {error ? (
            <View style={{ gap: 8, alignItems: 'flex-start' }}>
              <Caption style={{ color: theme.colors.danger }}>{t('analysisFailed', { error })}</Caption>
              <Button label={t('retry')} compact onPress={() => setAttempt((n) => n + 1)} />
            </View>
          ) : (
            <View style={{ height: 120, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <ActivityIndicator color={theme.colors.accent} />
              <Caption>{t('analysisLoading', { percent: Math.floor(progress * 100) })}</Caption>
            </View>
          )}
        </Card>
      </Screen>
    );
  }
  return <Loaded id={id} loaded={loaded} />;
}

function Loaded({ id, loaded }: { id: string; loaded: LoadedRecording }) {
  const theme = useTheme();
  const { t, locale } = useI18n();
  const { recording: rec, meta, events } = loaded;
  const summary = useMemo(() => summarizeRecording(rec), [rec]);
  const histogram = useMemo(() => intervalHistogram(rec, summary), [rec, summary]);

  const [view, setView] = useState({ start: 0, end: rec.rowCount });
  const [cursor, setCursor] = useState(0);
  const [metric, setMetric] = useState<AnalysisMetric>('total');
  const [sensor, setSensor] = useState(0);
  const [heatMode, setHeatMode] = useState<HeatMode>('frame');
  const [statSort, setStatSort] = useState<StatSort>('peak');
  const [statsShown, setStatsShown] = useState(8);
  const [issuesShown, setIssuesShown] = useState(ISSUES_STEP);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const viewRef = useRef(view);
  viewRef.current = view;

  const clampCursor = (row: number, v = view) => Math.max(v.start, Math.min(v.end - 1, row));

  // -- playback: the cursor follows real time at `speed`; leaving the screen or the app pauses it.
  useEffect(() => {
    if (!playing) return;
    const { start, end } = viewRef.current;
    const endMs = rec.time[end - 1] ?? 0;
    let from = cursorRef.current;
    if (from >= end - 1) from = start; // at the end: play again from the start
    const fromMs = rec.time[from] ?? 0;
    const startedAt = Date.now();
    let frame = 0;
    let lastUi = 0;
    const tick = () => {
      const now = Date.now();
      const { ms, finished } = playbackTime(fromMs, endMs, now - startedAt, speed);
      const row = nearestIndex(rec.time, ms, rec.rowCount);
      if (finished) {
        setCursor(end - 1);
        setPlaying(false);
        return;
      }
      if (row !== cursorRef.current && now - lastUi >= UI_FRAME_MS) {
        lastUi = now;
        setCursor(row);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const sub = AppState.addEventListener('change', (next) => next !== 'active' && setPlaying(false));
    return () => {
      cancelAnimationFrame(frame);
      sub.remove();
    };
  }, [playing, speed, rec]);

  const moveCursor = useCallback((row: number) => {
    setPlaying(false); // touching the trace takes over from playback
    setCursor(row);
  }, []);

  const jumpTo = (row: number) => {
    setPlaying(false);
    const whole = { start: 0, end: rec.rowCount };
    const inView = row >= view.start && row < view.end;
    if (!inView) setView(whole);
    setCursor(row);
  };

  const zoom = (factor: number) => {
    const length = view.end - view.start;
    const next = Math.max(MIN_VISIBLE_ROWS, Math.min(rec.rowCount, Math.round(length * factor)));
    const center = cursor;
    let start = Math.round(center - next / 2);
    start = Math.max(0, Math.min(rec.rowCount - next, start));
    const v = { start, end: start + next };
    setView(v);
    setCursor(clampCursor(cursor, v));
  };

  const columns = metaGridColumns(meta, rec.sensorCount) ?? defaultGridColumns(rec.sensorCount);
  const rows = Math.max(1, Math.ceil(rec.sensorCount / columns));
  const heat = useMemo(() => {
    const row = Math.max(view.start, Math.min(view.end - 1, cursor));
    return Array.from(heatMode === 'frame' ? sensorFrame(rec, 'frame', row, row + 1) : sensorFrame(rec, heatMode, view.start, view.end));
  }, [rec, heatMode, cursor, view]);
  const range = useMemo(() => ({ min: DEFAULT_RANGE.min, max: Math.max(DEFAULT_RANGE.max, rec.maxValue) }), [rec]);
  const stats = useMemo<SensorStat[]>(() => [...sensorStats(rec, view.start, view.end)].sort((a, b) => (statSort === 'mean' ? b.mean - a.mean : b.peak - a.peak)), [rec, view, statSort]);

  const zoomed = view.start > 0 || view.end < rec.rowCount;
  const issueText = (issue: (typeof summary.issues)[number]) =>
    issue.kind === 'lost_frames'
      ? t('analysisIssueLost', { count: Math.round(issue.amount) })
      : issue.kind === 'restart'
        ? t('analysisIssueRestart')
        : issue.kind === 'time_backwards'
          ? t('analysisIssueBackwards', { ms: Math.round(Math.abs(issue.amount)) })
          : t('analysisIssueGap', { ms: Math.round(issue.amount) });
  const originMs = rec.time[0] ?? 0;
  const maxCount = Math.max(1, ...histogram.counts);
  const model = meta?.device.hardwareModel ?? null;

  return (
    <Screen topInset={false}>
      <Stack.Screen options={{ title: t('analysisTitle') }} />

      <Card padded={false}>
        <FactRow label={t('infoDuration')} value={formatDuration(summary.durationMs)} />
        <Divider />
        <FactRow label={t('analysisSamples')} value={summary.rowCount.toLocaleString(locale)} />
        <Divider />
        <FactRow label={t('analysisRate')} value={`${summary.rateHz.toFixed(1)} Hz`} />
        <Divider />
        <FactRow label={t('analysisIntervalMedian')} value={`${summary.intervalMs.median.toFixed(1)} ms`} />
        <Divider />
        <FactRow label={t('analysisSensors')} value={`${rec.sensorCount}`} />
        <Divider />
        <FactRow label={t('lostFrames')} value={String(summary.lostFrames)} />
        <Divider />
        <FactRow label={t('gapsLabel')} value={String(summary.timeGaps)} />
        <Divider />
        <FactRow label={t('analysisRestarts')} value={String(summary.restarts)} />
        <Divider />
        <FactRow label={t('analysisDevice')} value={model ? `${model}${meta?.device.firmwareVersion ? ` · ${meta.device.firmwareVersion}` : ''}` : t('analysisNoMeta')} />
      </Card>

      <SectionHeader title={t('analysisTrace')} />
      <Card>
        <SegmentedControl<AnalysisMetric>
          accessibilityLabel={t('analysisTrace')}
          options={[
            { value: 'total', label: t('analysisMetricTotal') },
            { value: 'peak', label: t('analysisMetricPeak') },
            { value: 'contact', label: t('analysisMetricContact') },
            { value: 'sensor', label: t('analysisMetricSensor') },
          ]}
          value={metric}
          onChange={setMetric}
        />
        {metric === 'sensor' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Button label="−" compact onPress={() => setSensor((s) => (s + rec.sensorCount - 1) % rec.sensorCount)} />
            <Body>{t('analysisSensorLabel', { n: sensor + 1 })}</Body>
            <Button label="+" compact onPress={() => setSensor((s) => (s + 1) % rec.sensorCount)} />
          </View>
        ) : null}
        <AnalysisChart recording={rec} metric={metric} sensor={sensor} start={view.start} end={view.end} cursor={clampCursor(cursor)} events={events} onCursor={moveCursor} />
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            label={playing ? t('analysisPause') : t('analysisPlay')}
            icon={playing ? Pause : Play}
            variant="primary"
            compact
            onPress={() => setPlaying((p) => !p)}
          />
          <Button label={t('analysisSpeed', { speed: speed })} compact onPress={() => setSpeed((s) => nextSpeed(s))} />
          <View style={{ flex: 1 }} />
          <IconButton label={t('analysisZoomOut')} icon={Minus} disabled={!zoomed} onPress={() => zoom(2)} />
          <IconButton label={t('analysisZoomIn')} icon={Plus} disabled={view.end - view.start <= MIN_VISIBLE_ROWS} onPress={() => zoom(0.5)} />
          <IconButton label={t('analysisZoomReset')} icon={RotateCcw} disabled={!zoomed} onPress={() => setView({ start: 0, end: rec.rowCount })} />
        </View>
      </Card>

      <SectionHeader title={t('analysisHeatmap')} />
      <Card>
        <SegmentedControl<HeatMode>
          accessibilityLabel={t('analysisHeatmap')}
          options={[
            { value: 'frame', label: t('analysisHeatFrame') },
            { value: 'mean', label: t('analysisHeatMean') },
            { value: 'peak', label: t('analysisHeatPeak') },
          ]}
          value={heatMode}
          onChange={setHeatMode}
        />
        <Heatmap values={heat} rows={rows} cols={columns} range={range} maxHeight={320} />
        <Caption>{t('analysisHeatCopy')}</Caption>
      </Card>

      <SectionHeader title={t('analysisQuality')} />
      <Card padded={false}>
        {summary.issues.length === 0 ? (
          <View style={{ padding: 16 }}>
            <Caption>{t('analysisQualityOk')}</Caption>
          </View>
        ) : (
          summary.issues.slice(0, issuesShown).map((issue, i) => (
            <View key={`${issue.index}-${i}`}>
              {i > 0 ? <Divider /> : null}
              <Pressable onPress={() => jumpTo(issue.index)} accessibilityRole="button" style={({ pressed }) => ({ paddingHorizontal: 16, paddingVertical: 12, opacity: pressed ? 0.6 : 1 })}>
                <FactRow label={formatDuration((rec.time[issue.index] ?? originMs) - originMs)} value={issueText(issue)} />
              </Pressable>
            </View>
          ))
        )}
        {summary.issues.length > issuesShown ? (
          <View style={{ padding: 12 }}>
            <Button label={t('analysisShowMore')} compact onPress={() => setIssuesShown((n) => n + ISSUES_STEP)} />
          </View>
        ) : null}
        <Divider inset={0} />
        <View style={{ padding: 16, gap: 8 }}>
          <Caption>{t('analysisHistogram', { limit: Math.round(histogram.limitMs) })}</Caption>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 64, gap: 1 }}>
            {histogram.counts.map((count, i) => (
              <View key={i} style={{ flex: 1, height: Math.max(1, (count / maxCount) * 64), backgroundColor: theme.colors.accent, borderRadius: 1 }} />
            ))}
          </View>
        </View>
      </Card>

      <SectionHeader title={t('analysisStats')} />
      <Card>
        <SegmentedControl<StatSort>
          accessibilityLabel={t('analysisStats')}
          options={[
            { value: 'peak', label: t('analysisStatPeak') },
            { value: 'mean', label: t('analysisStatMean') },
          ]}
          value={statSort}
          onChange={setStatSort}
        />
        {stats.slice(0, statsShown).map((s) => (
          <View key={s.sensor} style={{ flexDirection: 'row', gap: 8, alignItems: 'baseline' }}>
            <Text style={{ width: 52, color: theme.colors.text, fontWeight: '600' }}>{s.name}</Text>
            <Text style={{ flex: 1, color: theme.colors.textDim, fontSize: 12, fontVariant: ['tabular-nums'] }}>
              {t('analysisStatMean')} {formatValue(s.mean)} · {t('analysisStatPeak')} {formatValue(s.peak)} · {t('analysisStatStd')} {formatValue(s.std)} · {t('analysisStatActive')} {Math.round(s.activeShare * 100)}%
            </Text>
          </View>
        ))}
        {stats.length > statsShown ? <Button label={t('analysisShowMore')} compact onPress={() => setStatsShown((n) => n + 16)} /> : null}
      </Card>

      {events.length > 0 ? (
        <>
          <SectionHeader title={t('eventsLabel')} />
          <Card padded={false}>
            {events.slice(0, 40).map((ev, i) => (
              <View key={`${ev.seq}-${i}`}>
                {i > 0 ? <Divider /> : null}
                <Pressable onPress={() => jumpTo(ev.index)} accessibilityRole="button" style={({ pressed }) => ({ paddingHorizontal: 16, paddingVertical: 12, opacity: pressed ? 0.6 : 1 })}>
                  <FactRow label={formatDuration(ev.atMs - originMs)} value={`${ev.app}: ${ev.event}${ev.edge ? ` ${ev.edge}` : ''}`} mono />
                </Pressable>
              </View>
            ))}
          </Card>
        </>
      ) : null}
      {rec.rowCount === 0 ? <Empty>{t('analysisQualityOk')}</Empty> : null}
    </Screen>
  );
}

function IconButton({ label, icon: Icon, disabled, onPress }: { label: string; icon: typeof Plus; disabled?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.panelSoft, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
    >
      <Icon size={18} color={colors.text} />
    </Pressable>
  );
}
