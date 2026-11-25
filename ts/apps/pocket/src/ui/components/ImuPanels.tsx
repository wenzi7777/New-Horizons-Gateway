// The live screen's IMU panels, drawn with react-native-svg the way the
// Desktop Visualization card and NH Studio draw them (components/ImuPanels.tsx
// there): Acc as a spirit level, Gyro as three centred bars, the magnetometer
// as a heading dial, each beside the last ten seconds of x / y / z, with the
// numbers underneath. One column on a phone.

import {
  gyroScale,
  headingFromMag,
  IMU_AXIS_COLORS,
  niceScale,
  tiltFromAcc,
  trendPolyline,
  vectorNorm,
  type ImuHistory,
  type ImuKey,
  type ImuPoint,
  type Vec3,
} from '@nhgw/host';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, G, Line, Polygon, Polyline, Rect, Text as SvgText } from 'react-native-svg';

import { useTheme } from '../theme';

export type ImuPanelLabels = {
  acc: string;
  gyro: string;
  mag: string;
  noMag: string;
  heading: string;
  tilt: string;
  magnitude: string;
};

const AXES = ['X', 'Y', 'Z'] as const;
const TREND_W = 200;
const TREND_H = 56;
const GAUGE = 64;
/** Points per trend line on a phone (the Desktop draws up to 300). */
const PHONE_POINTS = 120;

type TrendData = { points: ImuPoint[]; scale: number };

/** One sensor's trend points and scale, computed once per render. */
function trendData(history: ImuHistory, key: ImuKey, now: number): TrendData {
  const max = history.symmetricMax(key, now);
  const scale = key === 'gyro' ? gyroScale(max) : niceScale(max, key === 'acc' ? 1 : 50);
  return { points: history.series(key, now, PHONE_POINTS), scale };
}

function Trend({ data: { points, scale }, now, windowMs }: { data: TrendData; now: number; windowMs: number }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, height: TREND_H, borderRadius: 6, overflow: 'hidden', backgroundColor: theme.colors.panel }}>
      <Svg width="100%" height={TREND_H} viewBox={`0 0 ${TREND_W} ${TREND_H}`} preserveAspectRatio="none">
        <Line x1={0} y1={TREND_H / 2} x2={TREND_W} y2={TREND_H / 2} stroke={theme.colors.lineStrong} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {[0, 1, 2].map((axis) => (
          <Polyline
            key={axis}
            points={trendPolyline(points, axis as 0 | 1 | 2, now, windowMs, scale, TREND_W, TREND_H) || `0,${TREND_H / 2}`}
            fill="none"
            stroke={IMU_AXIS_COLORS[axis]}
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </Svg>
      <Text style={{ position: 'absolute', top: 2, right: 4, color: theme.colors.textMuted, fontSize: 10, fontVariant: ['tabular-nums'] }}>±{scale}</Text>
    </View>
  );
}

function AxisValues({ v, digits, unit }: { v: Vec3 | null; digits: number; unit: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 10 }}>
      {AXES.map((name, i) => (
        <Text key={name} style={{ color: IMU_AXIS_COLORS[i], fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] }}>
          {name} {v ? (v[i] ?? 0).toFixed(digits) : '--'}
        </Text>
      ))}
      <Text style={{ color: theme.colors.textMuted, fontSize: 13 }}>{unit}</Text>
    </View>
  );
}

function LevelGauge({ acc }: { acc: Vec3 | null }) {
  const { colors } = useTheme();
  const tilt = acc ? tiltFromAcc(acc) : null;
  const r = 30;
  return (
    <Svg width={GAUGE} height={GAUGE} viewBox="0 0 72 72" opacity={tilt ? 1 : 0.4}>
      <Circle cx={36} cy={36} r={r} fill={colors.panel} stroke={colors.lineStrong} strokeWidth={1} />
      <Circle cx={36} cy={36} r={r / 3} fill="none" stroke={colors.lineStrong} strokeWidth={1} />
      <Line x1={36 - r} y1={36} x2={36 + r} y2={36} stroke={colors.lineStrong} strokeWidth={1} />
      <Line x1={36} y1={36 - r} x2={36} y2={36 + r} stroke={colors.lineStrong} strokeWidth={1} />
      {tilt ? <Circle cx={36 + tilt.bubbleX * (r - 7)} cy={36 + tilt.bubbleY * (r - 7)} r={7} fill={colors.accent} fillOpacity={0.85} /> : null}
    </Svg>
  );
}

function GyroBars({ gyro, scale }: { gyro: Vec3 | null; scale: number }) {
  const { colors } = useTheme();
  const left = 14;
  const right = 86;
  const mid = (left + right) / 2;
  const half = (right - left) / 2;
  return (
    <Svg width={GAUGE * (88 / 72)} height={GAUGE} viewBox="0 0 88 72" opacity={gyro ? 1 : 0.4}>
      {AXES.map((name, i) => {
        const y = 10 + i * 22;
        const value = gyro ? Math.max(-1, Math.min(1, (gyro[i] ?? 0) / scale)) : 0;
        const x = value >= 0 ? mid : mid + value * half;
        return (
          <G key={name}>
            <SvgText x={0} y={y + 9} fontSize={10} fontWeight="700" fill={IMU_AXIS_COLORS[i]}>
              {name}
            </SvgText>
            <Rect x={left} y={y} width={right - left} height={12} rx={3} fill={colors.panel} stroke={colors.lineStrong} strokeWidth={1} />
            <Rect x={x} y={y} width={Math.abs(value) * half} height={12} rx={3} fill={IMU_AXIS_COLORS[i]} />
          </G>
        );
      })}
      <Line x1={mid} y1={6} x2={mid} y2={66} stroke={colors.lineStrong} strokeWidth={1} />
    </Svg>
  );
}

function HeadingDial({ heading }: { heading: number | null }) {
  const { colors } = useTheme();
  const r = 30;
  return (
    <Svg width={GAUGE} height={GAUGE} viewBox="0 0 72 72" opacity={heading === null ? 0.4 : 1}>
      <Circle cx={36} cy={36} r={r} fill={colors.panel} stroke={colors.lineStrong} strokeWidth={1} />
      {[0, 90, 180, 270].map((deg, i) => {
        const a = (deg * Math.PI) / 180;
        return (
          <SvgText
            key={deg}
            x={36 + Math.sin(a) * (r - 8)}
            y={36 - Math.cos(a) * (r - 8) + 3.5}
            fontSize={10}
            fontWeight="700"
            textAnchor="middle"
            fill={i === 0 ? colors.danger : colors.textMuted}
          >
            {'NESW'[i]}
          </SvgText>
        );
      })}
      {heading !== null ? (
        <G transform={`rotate(${heading} 36 36)`}>
          <Polygon points={`36,${36 - r + 12} 40,40 36,37 32,40`} fill={colors.danger} />
        </G>
      ) : null}
      <Circle cx={36} cy={36} r={2.5} fill={colors.text} />
    </Svg>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View accessibilityLabel={title} style={{ gap: 6, padding: 10, backgroundColor: theme.colors.panelSoft, borderRadius: theme.radius.md }}>
      <Text style={{ color: theme.colors.textDim, fontSize: 12, fontWeight: '600' }}>{title}</Text>
      {children}
    </View>
  );
}

function Extra({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={{ color: theme.colors.textMuted, fontSize: 12, fontVariant: ['tabular-nums'] }}>{children}</Text>;
}

/** The three panels for one device; the live screen re-renders them a few times a second (`now` moves the trend lines). */
export function ImuPanels({ history, now, labels }: { history: ImuHistory; now: number; labels: ImuPanelLabels }) {
  const theme = useTheme();
  const w = history.windowMs;
  const accTrend = trendData(history, 'acc', now);
  const gyroTrend = trendData(history, 'gyro', now);
  const magTrend = history.has('mag') ? trendData(history, 'mag', now) : null;
  const acc = history.latest('acc');
  const gyro = history.latest('gyro');
  const mag = history.latest('mag');
  const tilt = acc ? tiltFromAcc(acc) : null;
  const heading = mag ? headingFromMag(mag, acc) : null;
  const row = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10 };
  return (
    <View style={{ gap: 10 }}>
      <Panel title={labels.acc}>
        <View style={row}>
          <LevelGauge acc={acc} />
          <Trend data={accTrend} now={now} windowMs={w} />
        </View>
        <AxisValues v={acc} digits={2} unit="g" />
        <Extra>
          {labels.magnitude} {acc ? vectorNorm(acc).toFixed(2) : '--'} g · {labels.tilt} {tilt ? `${tilt.rollDeg.toFixed(0)}° / ${tilt.pitchDeg.toFixed(0)}°` : '--'}
        </Extra>
      </Panel>
      <Panel title={labels.gyro}>
        <View style={row}>
          <GyroBars gyro={gyro} scale={gyroTrend.scale} />
          <Trend data={gyroTrend} now={now} windowMs={w} />
        </View>
        <AxisValues v={gyro} digits={1} unit="°/s" />
      </Panel>
      <Panel title={labels.mag}>
        {magTrend ? (
          <>
            <View style={row}>
              <HeadingDial heading={heading} />
              <Trend data={magTrend} now={now} windowMs={w} />
            </View>
            <AxisValues v={mag} digits={1} unit="µT" />
            <Extra>
              {labels.magnitude} {mag ? vectorNorm(mag).toFixed(1) : '--'} µT · {labels.heading} {heading !== null ? `${heading.toFixed(0)}°` : '--'}
            </Extra>
          </>
        ) : (
          <Text style={{ color: theme.colors.textMuted, fontSize: 13 }}>{labels.noMag}</Text>
        )}
      </Panel>
    </View>
  );
}
