// TIA-CTL v2.0.F: the back of the board with Rfb0-13 where they really sit,
// coloured by what rfb_measure found. The phone version of Studio's
// pages/device/RfbBoardMap.tsx (and the Desktop's); positions and states come
// from @nhgw/host rfbLayout. Tapping a resistor shows its details.
import { Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { backX, rfbBoardCounts, V20F_BOARD_MM, V20F_RFB_PADS, type RfbBoardState, type RfbState } from '@nhgw/host';

import { useI18n } from '../i18n';
import { useTheme } from '../theme';

// Only the lower part of the board holds the Rfb (same crop as Studio).
const VIEW = { x: -1, y: 15, width: V20F_BOARD_MM.width + 2, height: V20F_BOARD_MM.height - 15 + 1 };
const PART_W = 2.0;
const PART_H = 1.25;
const PAD_W = 0.55;
/** The part plus its label, as one tap target. */
const HIT_W = PART_W + 6.4;
const HOLES = [
  { x: V20F_BOARD_MM.width - 2.1, y: 38.2 },
  { x: V20F_BOARD_MM.width - 28.4, y: 38.2 },
];
const ANALOG_FPC = { x: V20F_BOARD_MM.width - 6.5, y: 25.2, width: 6.5, height: 11 };
const DIGITAL_FPC = { x: 0, y: 25.2, width: 6.5, height: 11 };
const STATES: RfbState[] = ['soldered', 'empty', 'fault', 'unknown', 'unused'];
const PAD_FILL = '#d6bd7a';
const PAD_STROKE = '#8a7034';
const BOARD_GREEN = '#2e6f57';

function kOhmShort(ohm: number): string {
  const k = ohm / 1000;
  return `${k >= 100 ? k.toFixed(0) : k.toFixed(1)}k`;
}

export function RfbBoardMap({ board, onDetail }: { board: RfbBoardState[]; onDetail: (text: string) => void }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  if (!board.length) return null;
  const tk = t as (key: string, vars?: Record<string, string | number>) => string;
  const counts = rfbBoardCounts(board);
  const measured = counts.soldered + counts.empty + counts.fault;
  const inLayout = board.length - counts.unused;

  const bodyStyle = (state: RfbState) => {
    if (state === 'soldered') return { fill: colors.success, stroke: colors.success, dash: undefined as string | undefined };
    if (state === 'fault') return { fill: 'transparent', stroke: colors.danger, dash: undefined };
    if (state === 'unknown') return { fill: 'transparent', stroke: colors.textMuted, dash: '0.25 0.18' };
    return null;
  };
  const detail = (item: RfbBoardState) => {
    const parts = [`Rfb${item.rfb}`, `A${item.rfb} / GPIO ${item.gpio}`, tk(`rfbState_${item.state}`)];
    if (item.ohm !== null) parts.push(`${(item.ohm / 1000).toFixed(2)} kΩ`);
    if (item.state === 'fault' && item.status) parts.push(item.status);
    if (item.row !== null) parts.push(tk('rfbMapRow', { row: item.row }));
    return parts.join(' · ');
  };

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 13, color: colors.textMuted }}>
        {measured ? tk('rfbMapSummary', { soldered: counts.soldered, total: inLayout, empty: counts.empty }) : tk('rfbMapNotMeasured')}
      </Text>
      <View style={{ borderRadius: 10, overflow: 'hidden', borderWidth: 0.5, borderColor: colors.line, backgroundColor: colors.panelSoft }}>
        <Svg width="100%" style={{ aspectRatio: VIEW.width / VIEW.height }} viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`}>
          <Path
            d={`M0 ${VIEW.y} V${V20F_BOARD_MM.height - 1} Q0 ${V20F_BOARD_MM.height} 1 ${V20F_BOARD_MM.height} H${V20F_BOARD_MM.width - 1} Q${V20F_BOARD_MM.width} ${V20F_BOARD_MM.height} ${V20F_BOARD_MM.width} ${V20F_BOARD_MM.height - 1} V${VIEW.y}`}
            fill={BOARD_GREEN}
            fillOpacity={0.12}
            stroke={BOARD_GREEN}
            strokeOpacity={0.6}
            strokeWidth={0.25}
          />
          <Line x1={0} y1={VIEW.y + 0.05} x2={V20F_BOARD_MM.width} y2={VIEW.y + 0.05} stroke={colors.textMuted} strokeWidth={0.12} strokeDasharray="0.5 0.4" opacity={0.6} />
          <SvgText x={V20F_BOARD_MM.width / 2} y={VIEW.y + 1.3} fontSize={0.85} fill={colors.textMuted} textAnchor="middle">
            {tk('rfbMapBack')}
          </SvgText>
          {[ANALOG_FPC, DIGITAL_FPC].map((fpc, index) => (
            <G key={index}>
              <Rect {...fpc} rx={0.4} fill="none" stroke={colors.textMuted} strokeWidth={0.12} strokeDasharray="0.4 0.3" opacity={0.55} />
              <SvgText x={fpc.x + fpc.width / 2} y={fpc.y + fpc.height + 1.1} fontSize={0.85} fill={colors.textMuted} textAnchor="middle">
                {index === 0 ? 'ANALOG' : 'DIGITAL'}
              </SvgText>
            </G>
          ))}
          {HOLES.map((hole) => (
            <Circle key={hole.x} cx={hole.x} cy={hole.y} r={1} fill="none" stroke={colors.textMuted} strokeWidth={0.12} strokeDasharray="0.4 0.3" opacity={0.55} />
          ))}
          {board.map((item) => {
            const pad = V20F_RFB_PADS.find((entry) => entry.rfb === item.rfb);
            if (!pad) return null;
            const cx = backX(pad.x);
            const cy = pad.y;
            const outward = cx > V20F_BOARD_MM.width / 2 + 2 ? 1 : -1;
            const body = bodyStyle(item.state);
            const label = item.state === 'soldered' && item.ohm !== null ? `R${item.rfb} ${kOhmShort(item.ohm)}` : item.state === 'fault' ? `R${item.rfb} !` : `R${item.rfb}`;
            const labelColor = item.state === 'fault' ? colors.danger : item.state === 'soldered' ? colors.text : colors.textMuted;
            return (
              <G key={item.rfb} opacity={item.state === 'unused' ? 0.3 : 1} onPress={() => onDetail(detail(item))}>
                {/* Tap target: the part and its label. */}
                <Rect
                  x={outward > 0 ? cx - PART_W / 2 - 0.4 : cx + PART_W / 2 + 0.4 - HIT_W}
                  y={cy - PART_H / 2 - 0.25}
                  width={HIT_W}
                  height={PART_H + 0.5}
                  fill="transparent"
                />
                <Rect x={cx - PART_W / 2} y={cy - PART_H / 2} width={PAD_W} height={PART_H} rx={0.08} fill={PAD_FILL} stroke={PAD_STROKE} strokeWidth={0.06} />
                <Rect x={cx + PART_W / 2 - PAD_W} y={cy - PART_H / 2} width={PAD_W} height={PART_H} rx={0.08} fill={PAD_FILL} stroke={PAD_STROKE} strokeWidth={0.06} />
                {body ? (
                  <Rect
                    x={cx - PART_W / 2 + PAD_W * 0.6}
                    y={cy - PART_H / 2 + 0.08}
                    width={PART_W - PAD_W * 1.2}
                    height={PART_H - 0.16}
                    rx={0.1}
                    fill={body.fill}
                    fillOpacity={item.state === 'fault' ? 0.25 : 1}
                    stroke={body.stroke}
                    strokeWidth={0.1}
                    strokeDasharray={body.dash}
                  />
                ) : null}
                <SvgText
                  x={cx + outward * (PART_W / 2 + 0.45)}
                  y={cy + 0.33}
                  fontSize={0.95}
                  fontFamily="monospace"
                  fontWeight={item.state === 'fault' ? '700' : '400'}
                  fill={labelColor}
                  textAnchor={outward > 0 ? 'start' : 'end'}
                >
                  {label}
                </SvgText>
              </G>
            );
          })}
        </Svg>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 4 }}>
        {STATES.filter((state) => counts[state] > 0).map((state) => {
          const body = bodyStyle(state);
          return (
            <View key={state} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, opacity: state === 'unused' ? 0.55 : 1 }}>
              <Svg width={22} height={12} viewBox="0 0 2.6 1.4">
                <Rect x={0.05} y={0.075} width={0.7} height={1.25} rx={0.08} fill={PAD_FILL} stroke={PAD_STROKE} strokeWidth={0.06} />
                <Rect x={1.85} y={0.075} width={0.7} height={1.25} rx={0.08} fill={PAD_FILL} stroke={PAD_STROKE} strokeWidth={0.06} />
                {body ? (
                  <Rect x={0.45} y={0.155} width={1.7} height={1.09} rx={0.1} fill={body.fill} fillOpacity={state === 'fault' ? 0.25 : 1} stroke={body.stroke} strokeWidth={0.1} strokeDasharray={body.dash} />
                ) : null}
              </Svg>
              <Text style={{ fontSize: 12, color: colors.textMuted }}>
                {tk(`rfbState_${state}`)} {counts[state]}
              </Text>
            </View>
          );
        })}
      </View>
      <Text style={{ fontSize: 12, color: colors.textMuted }}>{tk('rfbMapHint')}</Text>
    </View>
  );
}
