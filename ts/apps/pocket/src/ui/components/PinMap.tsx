// The "Illustrated" IO Visualizer on a phone: the board with every FPC contact
// fanned out to a label. Picked pins light up (rows in the accent colour,
// columns in orange) with their matrix order; tapping a label picks or drops
// that pin. The phone version of Studio's components/callout/PinMap.tsx: same
// layout (@nhgw/host calloutLayout), drawn with react-native-svg.
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { calloutLayout, fpcContact, type BoardArt, type BoardPinSlot, type CalloutSpec } from '@nhgw/host';


import { useTheme } from '../theme';
import { BoardDrawingNative } from './CalloutDiagram';

type Side = 'analog' | 'digital';
type Kind = 'row' | 'col' | 'free' | 'fixed';

const LABEL_HEIGHT = 26;

type Colors = ReturnType<typeof useTheme>['colors'];

type Leader = { id: string; points: readonly (readonly number[])[]; anchor: readonly number[] };
type LabelBox = { id: string; side: string; x: number; y: number; w: number; h: number };

function tintOf(kind: Kind, colors: Colors): string {
  return kind === 'row' ? colors.accent : kind === 'col' ? colors.warning : colors.textMuted;
}

// One leader line / one label each: memoized, so a tap redraws only the pins it changed.
const PinLeader = memo(function PinLeader({ leader, kind, pressed, colors }: { leader: Leader; kind: Kind; pressed: boolean; colors: Colors }) {
  const lit = kind === 'row' || kind === 'col' || pressed;
  const tint = tintOf(kind, colors);
  return (
    <G>
      <Polyline points={leader.points.map((p) => p.join(',')).join(' ')} fill="none" stroke={tint} strokeWidth={lit ? 1.2 : 0.8} strokeDasharray={lit ? undefined : '2 2'} opacity={kind === 'fixed' ? 0.35 : lit ? 1 : 0.6} />
      <Circle cx={leader.anchor[0]} cy={leader.anchor[1]} r={lit ? 2.2 : 1.6} fill={lit ? tint : colors.panelSolid} stroke={tint} strokeWidth={1} />
    </G>
  );
});

const PinLabel = memo(function PinLabel({
  box,
  label,
  kind,
  order,
  pressed,
  colors,
  onPressIn,
  onPressOut,
  onPress,
}: {
  box: LabelBox;
  label: string;
  kind: Kind;
  order: number;
  pressed: boolean;
  colors: Colors;
  onPressIn: (id: string) => void;
  onPressOut: (id: string) => void;
  onPress: (id: string) => void;
}) {
  const selectable = kind !== 'fixed';
  const tint = tintOf(kind, colors);
  const left = box.side === 'left';
  const x = box.x + 1;
  const y = box.y + 2;
  const w = box.w - 2;
  const h = box.h - 4;
  const badge = 16;
  const badgeX = left ? x + w - badge - 3 : x + 3;
  const textX = left ? badgeX - 5 : badgeX + badge + 5;
  const anchor = left ? 'end' : 'start';
  const chosen = kind === 'row' || kind === 'col';
  return (
    <G
      opacity={selectable ? 1 : 0.5}
      onPressIn={selectable ? () => onPressIn(box.id) : undefined}
      onPressOut={selectable ? () => onPressOut(box.id) : undefined}
      onPress={selectable ? () => onPress(box.id) : undefined}
    >
      <Rect x={x} y={y} width={w} height={h} rx={h / 2} fill={chosen ? tint : colors.panelSolid} fillOpacity={chosen ? 0.16 : pressed ? 0.7 : 1} stroke={chosen ? tint : colors.line} strokeWidth={chosen ? 1.2 : 0.8} />
      <Circle cx={badgeX + badge / 2} cy={y + h / 2} r={badge / 2} fill={chosen ? tint : 'transparent'} stroke={chosen ? 'none' : colors.line} strokeWidth={0.8} />
      {order ? (
        <SvgText x={badgeX + badge / 2} y={y + h / 2 + 3.6} fontSize={10} fontWeight="700" fill="#fff" textAnchor="middle">
          {order}
        </SvgText>
      ) : null}
      <SvgText x={textX} y={y + h / 2 + 4} fontSize={11.5} fontWeight={chosen ? '700' : '500'} fontFamily="monospace" fill={selectable ? colors.text : colors.textMuted} textAnchor={anchor}>
        {label}
      </SvgText>
    </G>
  );
});

export const PinMap = memo(function PinMap({
  art,
  analogSlots,
  digitalSlots,
  analogChosen,
  selectChosen,
  onToggle,
  accessibilityLabel,
}: {
  art: BoardArt;
  analogSlots: readonly BoardPinSlot[];
  digitalSlots: readonly BoardPinSlot[];
  analogChosen: readonly number[];
  selectChosen: readonly number[];
  onToggle: (slot: BoardPinSlot) => void;
  accessibilityLabel: string;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const [pressed, setPressed] = useState<string | null>(null);

  const pins = useMemo(() => {
    const out: { id: string; side: Side; slot: BoardPinSlot; x: number; y: number }[] = [];
    analogSlots.forEach((slot, index) => out.push({ id: `a${index}`, side: 'analog', slot, ...fpcContact(art.analogFpc, index) }));
    digitalSlots.forEach((slot, index) => out.push({ id: `d${index}`, side: 'digital', slot, ...fpcContact(art.digitalFpc, index) }));
    return out;
  }, [art, analogSlots, digitalSlots]);

  const analogSide = art.analogFpc.pin1.x < art.width / 2 ? 'left' : 'right';
  const digitalSide = analogSide === 'left' ? 'right' : 'left';
  const specs = useMemo<CalloutSpec[]>(() => pins.map((pin) => ({ id: pin.id, anchor: { x: pin.x, y: pin.y }, side: pin.side === 'analog' ? analogSide : digitalSide })), [pins, analogSide, digitalSide]);
  const maxBoardHeight = Math.max(analogSlots.length, digitalSlots.length) * LABEL_HEIGHT;
  const labelWidth = Math.max(84, Math.round(width * 0.27));
  const layout = useMemo(
    () => (width > 0 ? calloutLayout(art, specs, { width, labelWidth, labelHeight: LABEL_HEIGHT, maxBoardHeight, gap: 12, padding: 2 }) : null),
    [art, specs, width, labelWidth, maxBoardHeight],
  );
  const byId = useMemo(() => new Map(pins.map((pin) => [pin.id, pin])), [pins]);
  const orderOf = (slot: BoardPinSlot) => {
    if (!slot.role || slot.gpio === undefined) return 0;
    return (slot.role === 'analog' ? analogChosen : selectChosen).indexOf(slot.gpio) + 1;
  };
  const kindOf = (slot: BoardPinSlot): Kind => {
    if (!slot.role || slot.gpio === undefined) return 'fixed';
    if (!orderOf(slot)) return 'free';
    return slot.role === 'analog' ? 'row' : 'col';
  };
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const pressIn = useCallback((id: string) => setPressed(id), []);
  const pressOut = useCallback((id: string) => setPressed((current) => (current === id ? null : current)), []);
  const press = useCallback((id: string) => {
    const pin = byIdRef.current.get(id);
    if (pin) toggleRef.current(pin.slot);
  }, []);

  return (
    <View accessibilityLabel={accessibilityLabel} onLayout={(e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width))} style={{ width: '100%', height: layout?.height ?? maxBoardHeight }}>
      {layout ? (
        <Svg width={layout.width} height={layout.height}>
          <G transform={`translate(${layout.board.x} ${layout.board.y}) scale(${layout.board.scale}) translate(${-layout.board.bounds.x} ${-layout.board.bounds.y})`}>
            <BoardDrawingNative art={art} />
          </G>
          {layout.leaders.map((leader) => {
            const pin = byId.get(leader.id);
            return pin ? <PinLeader key={leader.id} leader={leader} kind={kindOf(pin.slot)} pressed={pressed === leader.id} colors={colors} /> : null;
          })}
          {layout.labels.map((box) => {
            const pin = byId.get(box.id);
            return pin ? (
              <PinLabel
                key={box.id}
                box={box}
                label={pin.slot.label}
                kind={kindOf(pin.slot)}
                order={orderOf(pin.slot)}
                pressed={pressed === box.id}
                colors={colors}
                onPressIn={pressIn}
                onPressOut={pressOut}
                onPress={press}
              />
            ) : null;
          })}
        </Svg>
      ) : null}
    </View>
  );
});
