// The "Illustrated" interface's path diagram on a phone: boxes joined by
// wires, the live path lit. The phone version of Studio's
// components/callout/FlowPath.tsx (graphs from @nhgw/host flowPath); drawn
// still, without the flowing dashes.
import { View } from 'react-native';
import Svg, { G, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { fitMiddle, flowLayout, type FlowGraph } from '@nhgw/host';

import { useTheme } from '../theme';

export type FlowLabel = { title: string; value?: string };

export function FlowPath({ graph, labels, accessibilityLabel }: { graph: FlowGraph; labels: Readonly<Record<string, FlowLabel>>; accessibilityLabel: string }) {
  const { colors } = useTheme();
  const layout = flowLayout(graph, { cellW: 100, cellH: 46, gapX: 18, gapY: 22 });
  const pad = 3;
  const width = layout.width + pad * 2;
  const height = layout.height + pad * 2;
  return (
    <View accessibilityLabel={accessibilityLabel} style={{ width: '100%', maxWidth: width * 1.2, alignSelf: 'center' }}>
      <Svg width="100%" style={{ aspectRatio: width / height }} viewBox={`${-pad} ${-pad} ${width} ${height}`}>
        {layout.wires.map((wire) => (
          <Polyline
            key={`${wire.from}-${wire.to}`}
            points={wire.points.map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke={wire.active ? colors.accent : colors.lineStrong}
            strokeWidth={wire.active ? 2.4 : 1.3}
            strokeDasharray={wire.active ? undefined : '3 4'}
            strokeLinejoin="round"
          />
        ))}
        {layout.boxes.map((box) => {
          const label = labels[box.id] ?? { title: box.id };
          const cx = box.x + box.w / 2;
          return (
            <G key={box.id}>
              <Rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10} fill={colors.panelSolid} stroke={box.active ? colors.accent : colors.lineStrong} strokeWidth={box.active ? 1.6 : 1} strokeDasharray={box.active ? undefined : '4 3'} />
              {box.active ? <Rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10} fill={colors.accent} fillOpacity={0.1} /> : null}
              <SvgText x={cx} y={label.value ? box.y + 18 : box.y + box.h / 2 + 4} fontSize={11} fontWeight="600" fill={box.active ? colors.textDim : colors.textMuted} textAnchor="middle">
                {fitMiddle(label.title, box.w - 10, 11)}
              </SvgText>
              {label.value ? (
                <SvgText x={cx} y={box.y + 35} fontSize={12.5} fontWeight="700" fill={box.active ? colors.text : colors.textMuted} textAnchor="middle">
                  {fitMiddle(label.value, box.w - 10, 12.5)}
                </SvgText>
              ) : null}
            </G>
          );
        })}
      </Svg>
    </View>
  );
}
