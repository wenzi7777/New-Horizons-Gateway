// The "Illustrated" interface on the phone: a board drawing (@nhgw/host
// boardArt) with live values in a column each side, joined to their parts by
// dashed leader lines. The phone version of Studio's
// components/callout/CalloutDiagram.tsx: same layout (calloutLayout), drawn
// with react-native-svg. Tapping a value runs its onPress.
import { memo, useMemo, useState, type ReactNode } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Path, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { calloutLayout, type BoardArt, type BoardArtPart, type BoardArtTarget, type FpcContacts } from '@nhgw/host';

import { useTheme } from '../theme';

export type CalloutTone = 'ok' | 'warn' | 'danger' | 'muted';

export type CalloutItem = {
  id: string;
  target: BoardArtTarget;
  /** More parts the same label points at; each gets its own branch of the leader. */
  branches?: readonly BoardArtTarget[];
  side?: 'left' | 'right';
  title: string;
  value: string;
  detail?: string;
  tone?: CalloutTone;
  onPress?: () => void;
};

const GOLD = '#c9a95a';

type Colors = ReturnType<typeof useTheme>['colors'];

function partLabel(part: BoardArtPart, colors: Colors, box?: Partial<BoardArtPart>) {
  if (!part.label) return null;
  const p = { ...part, ...box };
  const vertical = p.h > p.w * 1.6;
  const long = vertical ? p.h : p.w;
  const size = Math.min(1.7, (long * 0.8) / Math.max(3, part.label.length * 0.62), (vertical ? p.w : p.h) * 0.42);
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2 + size * 0.35;
  return (
    <SvgText x={cx} y={cy} fontSize={size} fontWeight="600" fill={colors.textMuted} textAnchor="middle" transform={vertical ? `rotate(-90 ${cx} ${p.y + p.h / 2})` : undefined}>
      {part.label}
    </SvgText>
  );
}

function Contacts({ fpc }: { fpc: FpcContacts }) {
  const vertical = fpc.step.x === 0;
  return (
    <G>
      {Array.from({ length: fpc.count }, (_, i) => {
        const x = fpc.pin1.x + i * fpc.step.x;
        const y = fpc.pin1.y + i * fpc.step.y;
        return vertical ? <Rect key={i} x={x - 0.45} y={y - 0.13} width={0.9} height={0.26} fill={GOLD} /> : <Rect key={i} x={x - 0.13} y={y - 0.45} width={0.26} height={0.9} fill={GOLD} />;
      })}
    </G>
  );
}

/** The board in mm; place it inside a transformed <G>. Memoized: the drawing is static, redrawn only for a new board, highlight or theme. */
export const BoardDrawingNative = memo(function BoardDrawingNative({ art, highlight, children }: { art: BoardArt; highlight?: ReadonlySet<BoardArtTarget> | null; children?: ReactNode }) {
  const { colors } = useTheme();
  const base = { stroke: colors.lineStrong, strokeWidth: 0.14 };
  const shade = (amount: number) => ({ fill: colors.text, fillOpacity: amount });
  return (
    <G>
      <Rect x={0} y={0} width={art.width} height={art.height} rx={1} fill={colors.panelSoft} stroke={colors.lineStrong} strokeWidth={0.18} />
      {art.holes.map((hole) => (
        <Circle key={`${hole.x},${hole.y}`} cx={hole.x} cy={hole.y} r={hole.d / 2} fill={colors.bg} stroke={colors.lineStrong} strokeWidth={0.15} />
      ))}
      {art.parts.map((part, index) => {
        const active = Boolean(part.target && highlight?.has(part.target));
        const outline = active ? { stroke: colors.accent, strokeWidth: 0.35 } : base;
        const { x, y, w, h } = part;
        const body = (fill: { fill: string; fillOpacity?: number }, rx = 0.4) => (
          <>
            <Rect x={x} y={y} width={w} height={h} rx={rx} fill={colors.panelSolid} {...outline} />
            <Rect x={x} y={y} width={w} height={h} rx={rx} {...(active ? { fill: colors.accent, fillOpacity: 0.2 } : fill)} />
          </>
        );
        switch (part.kind) {
          case 'antenna': {
            const steps = 7;
            let d = `M${x + 1} ${y + h - 0.8}`;
            for (let i = 0; i < steps; i++) {
              const sx = x + 1 + ((w - 2) * (i + 0.5)) / steps;
              const half = (w - 2) / steps / 2;
              d += ` L${sx} ${y + h - 0.8} L${sx} ${y + 0.9} L${sx + half} ${y + 0.9} L${sx + half} ${y + h - 0.8}`;
            }
            return (
              <G key={index}>
                {body(shade(0.06), 0.5)}
                <Path d={d} fill="none" stroke={GOLD} strokeWidth={0.28} strokeLinejoin="round" />
              </G>
            );
          }
          case 'module':
            return (
              <G key={index}>
                {body(shade(0.12))}
                <Rect x={x + 0.9} y={y + 0.9} width={w - 1.8} height={h - 1.8} rx={0.6} fill={colors.text} fillOpacity={0.05} stroke={colors.line} strokeWidth={0.12} />
                {partLabel(part, colors, { h: h * 0.45 })}
              </G>
            );
          case 'usb':
            return (
              <G key={index}>
                {body(shade(0.2), 1)}
                <Rect x={x + w * 0.18} y={y + 0.8} width={w * 0.64} height={Math.min(2.2, h * 0.3)} rx={1} fill={colors.bg} />
                {partLabel(part, colors, { y: y + h * 0.35, h: h * 0.65 })}
              </G>
            );
          case 'connector':
            return (
              <G key={index}>
                {body(shade(0.16), 0.5)}
                <Rect x={x + 0.8} y={y + 0.8} width={w - 1.6} height={h - 1.6} rx={0.3} fill={colors.bg} stroke={colors.line} strokeWidth={0.1} />
                {partLabel(part, colors)}
              </G>
            );
          case 'fpc': {
            const fpc = part.target === 'digitalFpc' ? art.digitalFpc : art.analogFpc;
            return (
              <G key={index}>
                {body(shade(0.16), 0.5)}
                <Contacts fpc={fpc} />
                {partLabel(part, colors, h > w ? { x: x + 0.3, w: w * 0.55 } : { y: y + 0.3, h: h * 0.55 })}
              </G>
            );
          }
          case 'switch':
            return (
              <G key={index}>
                {body(shade(0.05), 0.5)}
                <Rect x={w > h ? x + w * 0.3 : x + w * 0.25} y={w > h ? y + h * 0.25 : y + h * 0.3} width={w > h ? w * 0.3 : w * 0.5} height={w > h ? h * 0.5 : h * 0.3} rx={0.3} fill={colors.textMuted} fillOpacity={0.5} />
              </G>
            );
          case 'button':
            return (
              <G key={index}>
                {body(shade(0.05))}
                <Circle cx={x + w / 2} cy={y + h / 2} r={Math.min(w, h) * 0.3} fill={colors.textMuted} fillOpacity={0.5} />
              </G>
            );
          case 'led':
            return <G key={index}>{body(shade(0.2), 0.3)}</G>;
          default:
            return (
              <G key={index}>
                <Rect x={x} y={y} width={w} height={h} rx={0.25} fill={active ? colors.accent : colors.text} fillOpacity={active ? 0.6 : 0.22} />
                {partLabel(part, colors)}
              </G>
            );
        }
      })}
      {children}
    </G>
  );
});

export const CalloutDiagram = memo(function CalloutDiagram({ art, items, maxBoardHeight = 260, accessibilityLabel }: { art: BoardArt; items: readonly CalloutItem[]; maxBoardHeight?: number; accessibilityLabel: string }) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const [pressed, setPressed] = useState<string | null>(null);
  const labelWidth = Math.max(96, Math.round(width * 0.29));
  // The layout depends only on which parts are called out, not on the values
  // shown (a ticking fps must not lay the diagram out again).
  const specsKey = items.map((item) => `${item.id}:${item.target}:${(item.branches ?? []).join('+')}:${item.side ?? ''}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const specs = useMemo(() => items, [specsKey]);
  const layout = useMemo(() => (width > 0 ? calloutLayout(art, specs, { width, labelWidth, labelHeight: 54, maxBoardHeight, gap: 8, padding: 4 }) : null), [art, specs, width, labelWidth, maxBoardHeight]);
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const highlight = useMemo(() => {
    const item = pressed ? byId.get(pressed) : undefined;
    return item ? new Set<BoardArtTarget>([item.target, ...(item.branches ?? [])]) : null;
  }, [pressed, byId]);
  const toneColor = (tone: CalloutTone | undefined) => (tone === 'warn' ? colors.warning : tone === 'danger' ? colors.danger : tone === 'muted' ? colors.textMuted : colors.text);

  return (
    <View accessibilityLabel={accessibilityLabel} onLayout={(e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width))} style={{ width: '100%', height: layout?.height ?? maxBoardHeight }}>
      {layout ? (
        <Svg width={layout.width} height={layout.height}>
          <G transform={`translate(${layout.board.x} ${layout.board.y}) scale(${layout.board.scale}) translate(${-layout.board.bounds.x} ${-layout.board.bounds.y})`}>
            <BoardDrawingNative art={art} highlight={highlight} />
          </G>
          {layout.leaders.map((leader) => {
            const active = pressed === leader.id;
            const tone = byId.get(leader.id)?.tone;
            return (
              <G key={leader.id}>
                {[leader, ...leader.branches].map((line, index) => (
                  <G key={index}>
                    <Polyline points={line.points.map((p) => p.join(',')).join(' ')} fill="none" stroke={active ? colors.accent : colors.textMuted} strokeWidth={1} strokeDasharray="3 3" opacity={active ? 1 : 0.7} />
                    <Circle cx={line.anchor[0]} cy={line.anchor[1]} r={active ? 3.5 : 2.6} fill={active ? colors.accent : colors.panelSolid} stroke={tone === 'warn' ? colors.warning : tone === 'danger' ? colors.danger : active ? colors.accent : colors.textMuted} strokeWidth={1.3} />
                  </G>
                ))}
              </G>
            );
          })}
          {layout.labels.map((box) => {
            const item = byId.get(box.id);
            if (!item) return null;
            const left = box.side === 'left';
            const tx = left ? box.x + box.w - 4 : box.x + 4;
            const anchor = left ? 'end' : 'start';
            const title = item.onPress ? `${item.title} ›` : item.title;
            return (
              <G
                key={box.id}
                onPressIn={() => setPressed(box.id)}
                onPressOut={() => setPressed((current) => (current === box.id ? null : current))}
                onPress={item.onPress}
              >
                <Rect x={box.x} y={box.y} width={box.w} height={box.h} rx={8} fill={pressed === box.id ? colors.accent : 'transparent'} fillOpacity={pressed === box.id ? 0.1 : 0} />
                <SvgText x={tx} y={box.y + 16} fontSize={12} fontWeight="600" fill={colors.textDim} textAnchor={anchor}>
                  {title}
                </SvgText>
                <SvgText x={tx} y={box.y + 35} fontSize={17} fontWeight="700" fill={toneColor(item.tone)} textAnchor={anchor}>
                  {item.value}
                </SvgText>
                {item.detail ? (
                  <SvgText x={tx} y={box.y + 49} fontSize={11} fill={colors.textMuted} textAnchor={anchor}>
                    {item.detail}
                  </SvgText>
                ) : null}
              </G>
            );
          })}
        </Svg>
      ) : null}
    </View>
  );
});
