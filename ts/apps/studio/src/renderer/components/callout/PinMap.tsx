// The "Illustrated" IO Visualizer: the board with every FPC contact fanned out
// to a label, the way a printer shows its filament slots. Picked pins light up
// (rows in the accent colour, columns in orange) with their matrix order;
// clicking a label picks or drops that pin. Contacts from @nhgw/host boardArt;
// the Desktop has the same file (components/callout/PinMap.tsx).
import { useEffect, useMemo, useRef, useState } from 'react';
import { calloutLayout, fpcContact, type BoardArt, type BoardPinSlot, type CalloutSpec } from '@nhgw/host';

import { BoardDrawing } from './BoardDrawing';
import './callout.css';

type Side = 'analog' | 'digital';

export function PinMap({
  art,
  analogSlots,
  digitalSlots,
  analogChosen,
  selectChosen,
  onToggle,
  ariaLabel,
}: {
  art: BoardArt;
  analogSlots: readonly BoardPinSlot[];
  digitalSlots: readonly BoardPinSlot[];
  analogChosen: readonly number[];
  selectChosen: readonly number[];
  onToggle: (slot: BoardPinSlot) => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? node.clientWidth)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const pins = useMemo(() => {
    const out: { id: string; side: Side; slot: BoardPinSlot; index: number; x: number; y: number }[] = [];
    analogSlots.forEach((slot, index) => out.push({ id: `a${index}`, side: 'analog', slot, index, ...fpcContact(art.analogFpc, index) }));
    digitalSlots.forEach((slot, index) => out.push({ id: `d${index}`, side: 'digital', slot, index, ...fpcContact(art.digitalFpc, index) }));
    return out;
  }, [art, analogSlots, digitalSlots]);

  const centre = art.width / 2;
  const analogSide = art.analogFpc.pin1.x < centre ? 'left' : 'right';
  const digitalSide = analogSide === 'left' ? 'right' : 'left';
  const specs = useMemo<CalloutSpec[]>(() => pins.map((pin) => ({ id: pin.id, anchor: { x: pin.x, y: pin.y }, side: pin.side === 'analog' ? analogSide : digitalSide })), [pins, analogSide, digitalSide]);
  const labelHeight = 24;
  const layout = useMemo(
    () => (width > 0 ? calloutLayout(art, specs, { width, labelWidth: Math.min(170, Math.round(width * 0.27)), labelHeight, maxBoardHeight: Math.max(analogSlots.length, digitalSlots.length) * labelHeight, gap: 18, padding: 4 }) : null),
    [art, specs, width, analogSlots.length, digitalSlots.length],
  );
  const byId = useMemo(() => new Map(pins.map((pin) => [pin.id, pin])), [pins]);
  const orderOf = (pin: { side: Side; slot: BoardPinSlot }) => {
    if (!pin.slot.role || pin.slot.gpio === undefined) return 0;
    const chosen = pin.slot.role === 'analog' ? analogChosen : selectChosen;
    return chosen.indexOf(pin.slot.gpio) + 1;
  };

  return (
    <div ref={ref} className="callout-diagram pin-map" style={{ height: layout?.height ?? 360 }} role="group" aria-label={ariaLabel}>
      {layout ? (
        <>
          <svg className="callout-canvas" width={layout.width} height={layout.height} aria-hidden="true">
            <g transform={`translate(${layout.board.x} ${layout.board.y}) scale(${layout.board.scale}) translate(${-layout.board.bounds.x} ${-layout.board.bounds.y})`}>
              <BoardDrawing art={art} />
            </g>
            {layout.leaders.map((leader) => {
              const pin = byId.get(leader.id);
              if (!pin) return null;
              const order = orderOf(pin);
              const kind = !pin.slot.role ? 'fixed' : order ? (pin.slot.role === 'analog' ? 'row' : 'col') : 'free';
              return (
                <g key={leader.id} className={`pin-leader is-${kind}${hover === leader.id ? ' is-active' : ''}`}>
                  <polyline points={leader.points.map((p) => p.join(',')).join(' ')} />
                  <circle cx={leader.anchor[0]} cy={leader.anchor[1]} r={2.2} />
                </g>
              );
            })}
          </svg>
          {layout.labels.map((box) => {
            const pin = byId.get(box.id);
            if (!pin) return null;
            const selectable = Boolean(pin.slot.role) && pin.slot.gpio !== undefined;
            const order = orderOf(pin);
            const kind = !selectable ? 'fixed' : order ? (pin.slot.role === 'analog' ? 'row' : 'col') : 'free';
            return (
              <button
                key={box.id}
                type="button"
                className={`pin-label side-${box.side} is-${kind}`}
                style={{ left: box.x, top: box.y + 1, width: box.w, height: box.h - 2 }}
                disabled={!selectable}
                aria-pressed={selectable ? order > 0 : undefined}
                onClick={() => onToggle(pin.slot)}
                onMouseEnter={() => setHover(box.id)}
                onMouseLeave={() => setHover((current) => (current === box.id ? null : current))}
              >
                <span className="pin-order">{order || ''}</span>
                <strong>{pin.slot.label}</strong>
                <em>{pin.slot.gpio !== undefined ? `GPIO ${pin.slot.gpio}` : ''}</em>
              </button>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
