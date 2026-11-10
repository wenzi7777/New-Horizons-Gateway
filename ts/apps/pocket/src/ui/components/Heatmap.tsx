// 2D pressure heatmap of a device's matrix (row-major values), drawn with
// react-native-svg in the Desktop Visualization's style: rounded cells with
// a gap, the Desktop colour scale, values in the cells when they fit.

import { memo, useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Rect, Text as SvgText } from 'react-native-svg';

import { formatValue } from '../format';
import { CELL_INK, colorForValue, type PressureRange } from '../pressureColor';
import { useTheme } from '../theme';

const GAP = 3;

export const Heatmap = memo(function Heatmap({
  values,
  rows,
  cols,
  range,
  maxHeight,
}: {
  values: readonly number[] | null;
  rows: number;
  cols: number;
  range: PressureRange;
  /** Cap on the drawing's height (tablet landscape, small screens). */
  maxHeight?: number;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const aspect = (cols * 1.0) / Math.max(rows, 1);
  let drawWidth = width;
  let drawHeight = width / aspect;
  if (maxHeight && drawHeight > maxHeight) {
    drawHeight = maxHeight;
    drawWidth = maxHeight * aspect;
  }
  const cellW = (drawWidth - GAP * (cols + 1)) / Math.max(cols, 1);
  const cellH = (drawHeight - GAP * (rows + 1)) / Math.max(rows, 1);
  // Same thresholds as the Desktop canvas: too small to read is not drawn.
  const showText = cellW >= 34 && cellH >= 22;
  const radius = Math.min(6, cellW * 0.18, cellH * 0.18);
  const fontSize = Math.max(9, Math.min(12, cellW * 0.28));

  const cells = [];
  if (width > 0 && cellW > 0 && cellH > 0) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const value = values?.[i];
        const x = GAP + c * (cellW + GAP);
        const y = GAP + r * (cellH + GAP);
        cells.push(
          <Rect
            key={`r${i}`}
            x={x}
            y={y}
            width={cellW}
            height={cellH}
            rx={radius}
            ry={radius}
            fill={value === undefined ? theme.colors.panelSoft : colorForValue(value, range)}
          />,
        );
        if (showText && value !== undefined) {
          cells.push(
            <SvgText key={`t${i}`} x={x + cellW / 2} y={y + cellH / 2 + fontSize * 0.35} fontSize={fontSize} fill={CELL_INK} textAnchor="middle">
              {formatValue(value)}
            </SvgText>,
          );
        }
      }
    }
  }

  return (
    <View
      onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}
      style={{ width: '100%', alignItems: 'center' }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${rows} × ${cols}`}
    >
      {width > 0 ? (
        <Svg width={drawWidth} height={drawHeight}>
          {cells}
        </Svg>
      ) : (
        <View style={{ height: 200 }} />
      )}
    </View>
  );
});

/** The colour scale as a bar with its range (the Desktop's legend). */
export function HeatmapLegend({ range }: { range: PressureRange }) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const steps = 24;
  return (
    <View style={{ gap: 4 }}>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ height: 10 }}>
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
        <SvgLabel color={theme.colors.textDim} text={String(range.min)} />
        <SvgLabel color={theme.colors.textDim} text={String(range.max)} />
      </View>
    </View>
  );
}

function SvgLabel({ text, color }: { text: string; color: string }) {
  return <Text style={{ color, fontSize: 12, fontVariant: ['tabular-nums'] }}>{text}</Text>;
}
