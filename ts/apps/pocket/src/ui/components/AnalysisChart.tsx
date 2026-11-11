// The analysis screen's trace: a min..max band and line of one metric over the visible rows,
// event markers, a time axis, and a cursor you drag with a finger (also what playback moves).

import { useMemo, useRef, useState } from 'react';
import { PanResponder, Text, View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import { bucketSeries, nearestIndex, niceTicks, type PlacedEvent, type Recording } from '@nhgw/analysis';

import { formatDuration, formatValue } from '../format';
import { useTheme } from '../theme';

const HEIGHT = 200;
const PAD_Y = 10;

export type AnalysisMetric = 'total' | 'peak' | 'contact' | 'sensor';

export function metricValue(rec: Recording, metric: AnalysisMetric, sensor: number): (row: number) => number {
  if (metric === 'peak') return (row) => rec.peak[row] ?? 0;
  if (metric === 'contact') return (row) => rec.active[row] ?? 0;
  if (metric === 'sensor') return (row) => rec.pressure[row * rec.sensorCount + sensor] ?? 0;
  return (row) => rec.total[row] ?? 0;
}

export function AnalysisChart({
  recording,
  metric,
  sensor,
  start,
  end,
  cursor,
  events,
  onCursor,
}: {
  recording: Recording;
  metric: AnalysisMetric;
  sensor: number;
  /** Visible rows [start, end). */
  start: number;
  end: number;
  cursor: number;
  events: readonly PlacedEvent[];
  onCursor: (row: number) => void;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const [width, setWidth] = useState(0);
  const t0 = recording.time[start] ?? 0;
  const t1 = recording.time[Math.max(start, end - 1)] ?? t0 + 1;
  const originMs = recording.time[0] ?? 0;

  const { band, line, lo, hi } = useMemo(() => {
    if (width <= 0 || end <= start) return { band: '', line: '', lo: 0, hi: 0 };
    const columns = Math.max(2, Math.floor(width / 2));
    const buckets = bucketSeries(recording.time, metricValue(recording, metric, sensor), start, end, t0, t1, columns);
    let min = Infinity;
    let max = -Infinity;
    for (const b of buckets) {
      if (!b) continue;
      if (b.min < min) min = b.min;
      if (b.max > max) max = b.max;
    }
    if (!Number.isFinite(min)) return { band: '', line: '', lo: 0, hi: 0 };
    const ticks = niceTicks(min, max, 4);
    const floor = Math.min(min, ticks[0] ?? min);
    const ceil = Math.max(max, ticks[ticks.length - 1] ?? max);
    const span = Math.max(ceil - floor, 1e-9);
    const x = (i: number) => ((i + 0.5) / columns) * width;
    const y = (v: number) => PAD_Y + (1 - (v - floor) / span) * (HEIGHT - 2 * PAD_Y);
    const up: string[] = [];
    const down: string[] = [];
    buckets.forEach((b, i) => {
      if (!b) return;
      up.push(`${x(i).toFixed(1)},${y(b.max).toFixed(1)}`);
      down.push(`${x(i).toFixed(1)},${y(b.min).toFixed(1)}`);
    });
    return { band: up.length ? `M${up.join(' L')} L${down.reverse().join(' L')} Z` : '', line: up.length ? `M${up.join(' L')}` : '', lo: floor, hi: ceil };
  }, [recording, metric, sensor, start, end, t0, t1, width]);

  const xOf = (ms: number) => ((ms - t0) / Math.max(1e-9, t1 - t0)) * width;
  const pick = (x: number) => {
    const ms = t0 + (Math.max(0, Math.min(width, x)) / Math.max(1, width)) * (t1 - t0);
    onCursor(nearestIndex(recording.time, ms, recording.rowCount));
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => pickRef.current(e.nativeEvent.locationX),
        onPanResponderMove: (e) => pickRef.current(e.nativeEvent.locationX),
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );

  const cursorMs = recording.time[cursor] ?? t0;
  const cursorX = width > 0 ? Math.max(0, Math.min(width, xOf(cursorMs))) : 0;
  return (
    <View style={{ gap: 6 }}>
      <View
        onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}
        style={{ height: HEIGHT, borderRadius: theme.radius.sm, backgroundColor: colors.panelSoft, overflow: 'hidden' }}
        {...responder.panHandlers}
      >
        {width > 0 ? (
          <Svg width={width} height={HEIGHT} pointerEvents="none">
            {[0.25, 0.5, 0.75].map((f) => (
              <Line key={f} x1={0} x2={width} y1={HEIGHT * f} y2={HEIGHT * f} stroke={colors.line} strokeWidth={1} />
            ))}
            {band ? <Path d={band} fill={colors.accentSoft} /> : null}
            {line ? <Path d={line} stroke={colors.accent} strokeWidth={1.5} fill="none" strokeLinejoin="round" /> : null}
            {events.map((ev, i) => {
              if (ev.index < start || ev.index >= end) return null;
              const ex = Math.max(1, Math.min(width - 1, xOf(ev.atMs)));
              return <Line key={i} x1={ex} x2={ex} y1={0} y2={HEIGHT} stroke={colors.warning} strokeWidth={1.5} strokeDasharray="4 3" />;
            })}
            <Line x1={cursorX} x2={cursorX} y1={0} y2={HEIGHT} stroke={colors.text} strokeWidth={1.5} />
          </Svg>
        ) : null}
        <Text pointerEvents="none" style={{ position: 'absolute', left: 6, top: 2, color: colors.textDim, fontSize: 11, fontVariant: ['tabular-nums'] }}>
          {formatValue(hi)}
        </Text>
        <Text pointerEvents="none" style={{ position: 'absolute', left: 6, bottom: 2, color: colors.textDim, fontSize: 11, fontVariant: ['tabular-nums'] }}>
          {formatValue(lo)}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: colors.textDim, fontSize: 12, fontVariant: ['tabular-nums'] }}>{formatDuration(t0 - originMs)}</Text>
        <Text style={{ color: colors.text, fontSize: 12, fontVariant: ['tabular-nums'] }}>{formatDuration(cursorMs - originMs)}</Text>
        <Text style={{ color: colors.textDim, fontSize: 12, fontVariant: ['tabular-nums'] }}>{formatDuration(t1 - originMs)}</Text>
      </View>
    </View>
  );
}
