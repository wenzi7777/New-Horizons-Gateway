// 2D pressure heat map of a device's matrix (row-major values), drawn with
// react-native-svg exactly like the Desktop Visualization's 2D canvas: dark
// field, 2 px gaps, rounded cells in the Desktop colour scale, the sensor's
// P number (CSV column, from P1) in the corner and the value in the middle
// when the cell is big enough. Tapping a cell shows its value underneath.
// With a sensor-layout profile it draws the profile's background and one dot
// per enabled sensor at its profile position instead (the Desktop's dot map).

import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Circle, Image as SvgImage, Rect, Text as SvgText } from 'react-native-svg';
import { fitProfileRect, profilePoints, type Profile } from '@nhgw/host';

import {
  cellAt,
  cellOrigin,
  cellValueText,
  HEATMAP_BG,
  HEATMAP_VALUE_INK,
  heatmapLayout,
  streamSensorLabel,
} from '../heatmapLayout';
import { useI18n } from '../i18n';
import { CELL_INK, colorForValue, type PressureRange } from '../pressureColor';
import { useTheme } from '../theme';

export const Heatmap = memo(function Heatmap({
  values,
  rows,
  cols,
  range,
  maxHeight,
  pinLabels,
  indices,
  profile,
}: {
  values: readonly number[] | null;
  rows: number;
  cols: number;
  range: PressureRange;
  /** Cap on the drawing's height (tablet landscape, small screens). */
  maxHeight?: number;
  /** The pin each row (A..) and column (D..) is scanned on, for the tap readout. */
  pinLabels?: { rows: readonly string[]; cols: readonly string[] } | null;
  /** indices[i]: the stream index drawn at cell i (after Transpose / mirrors) -- its P number. */
  indices?: readonly number[] | null;
  /** A sensor-layout profile: its sensors over its background instead of the grid; values are then in stream order. */
  profile?: (Pick<Profile, 'sensors' | 'background'> & { display?: { dotSize?: number } }) | null;
}) {
  if (profile && profilePoints(profile, null, values?.length ?? Infinity).length > 0) {
    return <ProfileDots values={values} range={range} maxHeight={maxHeight} profile={profile} />;
  }
  return <GridHeatmap values={values} rows={rows} cols={cols} range={range} maxHeight={maxHeight} pinLabels={pinLabels} indices={indices} />;
});

const GridHeatmap = memo(function GridHeatmap({
  values,
  rows,
  cols,
  range,
  maxHeight,
  pinLabels,
  indices,
}: {
  values: readonly number[] | null;
  rows: number;
  cols: number;
  range: PressureRange;
  maxHeight?: number;
  pinLabels?: { rows: readonly string[]; cols: readonly string[] } | null;
  indices?: readonly number[] | null;
}) {
  const theme = useTheme();
  const { t } = useI18n();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const layout = heatmapLayout(width, rows, cols, maxHeight);
  const sel = selected !== null && selected < rows * cols ? selected : null;

  const cells = [];
  if (width > 0) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const value = values?.[i];
        const { x, y } = cellOrigin(layout, r, c);
        cells.push(
          <Rect
            key={`r${i}`}
            x={x}
            y={y}
            width={layout.cellW}
            height={layout.cellH}
            rx={layout.radius}
            ry={layout.radius}
            fill={value === undefined ? theme.colors.panelSoft : colorForValue(value, range)}
            stroke={i === sel ? theme.colors.accent : undefined}
            strokeWidth={i === sel ? 2 : 0}
          />,
        );
        if (layout.showLabels) {
          cells.push(
            <SvgText key={`l${i}`} x={x + 3} y={y + 2 + layout.labelFont} fontSize={layout.labelFont} fontWeight="600" fill={CELL_INK}>
              {streamSensorLabel(indices?.[i] ?? i)}
            </SvgText>,
          );
        }
        if (layout.showText && value !== undefined) {
          cells.push(
            <SvgText
              key={`t${i}`}
              x={x + layout.cellW / 2}
              y={y + layout.cellH / 2 + layout.valueFont * 0.35}
              fontSize={layout.valueFont}
              fill={HEATMAP_VALUE_INK}
              textAnchor="middle"
            >
              {cellValueText(value)}
            </SvgText>,
          );
        }
      }
    }
  }

  const selValue = sel !== null ? values?.[sel] : undefined;
  return (
    <View style={{ width: '100%', alignItems: 'center', gap: 8 }}>
      <View onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))} style={{ width: '100%', alignItems: 'center' }}>
        {width > 0 ? (
          <Pressable
            accessibilityRole="image"
            accessibilityLabel={`${rows} × ${cols}`}
            accessibilityHint={t('heatmapTapHint')}
            onPress={(e) => {
              const hit = cellAt(layout, rows, cols, e.nativeEvent.locationX, e.nativeEvent.locationY);
              setSelected((prev) => (hit === prev ? null : hit));
            }}
            style={{ width: layout.width, height: layout.height, borderRadius: theme.radius.sm, overflow: 'hidden' }}
          >
            <Svg width={layout.width} height={layout.height} pointerEvents="none">
              <Rect x={0} y={0} width={layout.width} height={layout.height} fill={HEATMAP_BG} />
              {cells}
            </Svg>
          </Pressable>
        ) : (
          <View style={{ height: 220 }} />
        )}
      </View>
      <Text
        accessibilityLiveRegion="polite"
        style={{ color: sel !== null ? theme.colors.text : theme.colors.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] }}
      >
        {sel !== null
          ? pinLabels && pinLabels.rows.length === rows && pinLabels.cols.length === cols
            ? t('heatmapReadoutPins', {
                label: streamSensorLabel(indices?.[sel] ?? sel),
                row: pinLabels.rows[Math.floor(sel / cols)] ?? '-',
                col: pinLabels.cols[sel % cols] ?? '-',
                value: selValue === undefined ? '-' : cellValueText(selValue),
              })
            : t('heatmapReadout', {
                label: streamSensorLabel(indices?.[sel] ?? sel),
                row: Math.floor(sel / cols) + 1,
                col: (sel % cols) + 1,
                value: selValue === undefined ? '-' : cellValueText(selValue),
              })
          : t('heatmapTapHint')}
      </Text>
    </View>
  );
});

/** A profile's sensors as dots over its background (the Desktop's 2D profile view). */
function ProfileDots({
  values,
  range,
  maxHeight,
  profile,
}: {
  values: readonly number[] | null;
  range: PressureRange;
  maxHeight?: number;
  profile: Pick<Profile, 'sensors' | 'background'> & { display?: { dotSize?: number } };
}) {
  const theme = useTheme();
  const { t } = useI18n();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const aspect = Math.max(0.01, profile.background?.aspectRatio || 1);
  const height = Math.min(Math.max(1, width / aspect), maxHeight ?? Infinity);
  const fit = fitProfileRect(width, height, aspect);
  const points = profilePoints(profile, values, values ? values.length : Infinity);
  const dot = Math.min(22, Math.max(5, Math.min(fit.drawWidth, fit.drawHeight) * 0.028 * (profile.display?.dotSize ?? 1)));
  const at = (p: { xRatio: number; yRatio: number }) => ({ x: fit.offsetX + p.xRatio * fit.drawWidth, y: fit.offsetY + p.yRatio * fit.drawHeight });
  const sel = points.find((p) => p.index === selected) ?? null;
  const image = profile.background?.imageData;
  return (
    <View style={{ width: '100%', alignItems: 'center', gap: 8 }}>
      <View onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))} style={{ width: '100%', alignItems: 'center' }}>
        {width > 0 ? (
          <Pressable
            accessibilityRole="image"
            accessibilityLabel={`${points.length} P`}
            accessibilityHint={t('heatmapTapHint')}
            onPress={(e) => {
              const { locationX: x, locationY: y } = e.nativeEvent;
              let best: { index: number; d: number } | null = null;
              for (const p of points) {
                const c = at(p);
                const d = Math.hypot(c.x - x, c.y - y);
                if (d <= Math.max(dot * 1.6, 22) && (!best || d < best.d)) best = { index: p.index, d };
              }
              setSelected((prev) => (best && best.index !== prev ? best.index : null));
            }}
            style={{ width, height, borderRadius: theme.radius.sm, overflow: 'hidden' }}
          >
            <Svg width={width} height={height} pointerEvents="none">
              <Rect x={0} y={0} width={width} height={height} fill={theme.colors.panelSoft} />
              {image ? (
                <SvgImage x={fit.offsetX} y={fit.offsetY} width={fit.drawWidth} height={fit.drawHeight} href={{ uri: image }} preserveAspectRatio="xMidYMid meet" />
              ) : null}
              {points.map((p) => {
                const c = at(p);
                return (
                  <Circle
                    key={p.index}
                    cx={c.x}
                    cy={c.y}
                    r={dot}
                    fill={colorForValue(values ? p.value : range.min, range)}
                    opacity={values ? 0.92 : 0.35}
                    stroke={p.index === selected ? theme.colors.accent : undefined}
                    strokeWidth={p.index === selected ? 2 : 0}
                  />
                );
              })}
            </Svg>
          </Pressable>
        ) : (
          <View style={{ height: 220 }} />
        )}
      </View>
      <Text accessibilityLiveRegion="polite" style={{ color: sel ? theme.colors.text : theme.colors.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] }}>
        {sel ? `${sel.label} · ${values ? cellValueText(sel.value) : '-'}` : t('heatmapTapHint')}
      </Text>
    </View>
  );
}

/** The colour scale as a bar with its range and midpoint (the Desktop's legend). */
export function HeatmapLegend({ range }: { range: PressureRange }) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const steps = 32;
  const mid = Math.round((range.min + range.max) / 2);
  return (
    <View style={{ gap: 4 }}>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ height: 10, borderRadius: 5, overflow: 'hidden' }}>
        {width > 0 ? (
          <Svg width={width} height={10}>
            {Array.from({ length: steps }, (_, i) => (
              <Rect
                key={i}
                x={(i * width) / steps}
                y={0}
                width={width / steps + 0.5}
                height={10}
                fill={colorForValue(range.min + ((range.max - range.min) * i) / (steps - 1), range)}
              />
            ))}
          </Svg>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {[range.min, mid, range.max].map((v) => (
          <Text key={v} style={{ color: theme.colors.textDim, fontSize: 12, fontVariant: ['tabular-nums'] }}>
            {v}
          </Text>
        ))}
      </View>
    </View>
  );
}
