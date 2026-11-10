// A recording's timeline: summed pressure per bucket as a min..max band with
// the max as a line, event markers, and the time axis (0 .. duration).

import { useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';

import type { RecordingTimeline } from '../../host/contract';
import { formatDuration } from '../format';
import { useTheme } from '../theme';

const HEIGHT = 160;
const PAD_Y = 8;

export function TimelineChart({ timeline }: { timeline: RecordingTimeline }) {
  const theme = useTheme();
  const { colors } = theme;
  const [width, setWidth] = useState(0);
  const { buckets, durationMs, events } = timeline;

  let band = '';
  let top = '';
  if (width > 0 && buckets.length > 0) {
    const lo = Math.min(...buckets.map((b) => b.min));
    const hi = Math.max(...buckets.map((b) => b.max));
    const span = Math.max(hi - lo, 1);
    const x = (i: number) => (buckets.length === 1 ? width / 2 : (i / (buckets.length - 1)) * width);
    const y = (v: number) => PAD_Y + (1 - (v - lo) / span) * (HEIGHT - 2 * PAD_Y);
    const upper = buckets.map((b, i) => `${x(i).toFixed(1)},${y(b.max).toFixed(1)}`);
    const lower = buckets.map((b, i) => `${x(i).toFixed(1)},${y(b.min).toFixed(1)}`).reverse();
    band = `M${upper.join(' L')} L${lower.join(' L')} Z`;
    top = `M${upper.join(' L')}`;
  }

  return (
    <View style={{ gap: 6 }}>
      <View
        onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}
        style={{ height: HEIGHT, borderRadius: theme.radius.sm, backgroundColor: colors.panelSoft, overflow: 'hidden' }}
        accessible
        accessibilityRole="image"
      >
        {width > 0 ? (
          <Svg width={width} height={HEIGHT}>
            {[0.25, 0.5, 0.75].map((f) => (
              <Line key={f} x1={0} x2={width} y1={HEIGHT * f} y2={HEIGHT * f} stroke={colors.line} strokeWidth={1} />
            ))}
            {band ? <Path d={band} fill={colors.accentSoft} /> : null}
            {top ? <Path d={top} stroke={colors.accent} strokeWidth={1.5} fill="none" strokeLinejoin="round" /> : null}
            {durationMs > 0
              ? events.map((ev, i) => {
                  const ex = Math.max(1, Math.min(width - 1, (ev.atMs / durationMs) * width));
                  return <Line key={i} x1={ex} x2={ex} y1={0} y2={HEIGHT} stroke={colors.warning} strokeWidth={1.5} strokeDasharray="4 3" />;
                })
              : null}
          </Svg>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: colors.textDim, fontSize: 12, fontVariant: ['tabular-nums'] }}>0:00</Text>
        <Text style={{ color: colors.textDim, fontSize: 12, fontVariant: ['tabular-nums'] }}>{formatDuration(durationMs)}</Text>
      </View>
    </View>
  );
}
