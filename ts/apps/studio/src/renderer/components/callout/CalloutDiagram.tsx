// The "Illustrated" interface's centrepiece: a board drawing with live values
// around it, each joined to its part by a dashed leader line (like a printer's
// touch screen pointing at its fans). Labels are buttons when they lead
// somewhere. Layout from @nhgw/host calloutLayout; the Desktop has the same
// file (components/callout/CalloutDiagram.tsx).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { calloutLayout, type BoardArt, type BoardArtTarget } from '@nhgw/host';

import { BoardDrawing } from './BoardDrawing';
import './callout.css';

export type CalloutTone = 'ok' | 'warn' | 'danger' | 'muted';

export type CalloutItem = {
  id: string;
  target: BoardArtTarget;
  /** More parts the same label points at; each gets its own branch of the leader. */
  branches?: readonly BoardArtTarget[];
  side?: 'left' | 'right';
  icon?: ReactNode;
  title: string;
  value: string;
  /** A second, smaller line under the value. */
  detail?: string;
  tone?: CalloutTone;
  onSelect?: () => void;
};

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? node.clientWidth)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function CalloutDiagram({ art, items, ariaLabel, maxBoardHeight = 340, className }: { art: BoardArt; items: readonly CalloutItem[]; ariaLabel: string; maxBoardHeight?: number; className?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const narrow = width > 0 && width < 560;
  const labelWidth = narrow ? Math.max(104, Math.round(width * 0.3)) : Math.min(200, Math.round(width * 0.26));
  const layout = useMemo(
    () => (width > 0 ? calloutLayout(art, items, { width, labelWidth, labelHeight: narrow ? 58 : 66, maxBoardHeight, gap: narrow ? 10 : 20 }) : null),
    [art, items, width, labelWidth, narrow, maxBoardHeight],
  );
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const highlight = useMemo(() => {
    const item = hover ? byId.get(hover) : undefined;
    return item ? new Set<BoardArtTarget>([item.target, ...(item.branches ?? [])]) : null;
  }, [hover, byId]);

  return (
    <div ref={ref} className={`callout-diagram${narrow ? ' is-narrow' : ''}${className ? ` ${className}` : ''}`} style={{ height: layout?.height ?? maxBoardHeight }} role="group" aria-label={ariaLabel}>
      {layout ? (
        <>
          <svg className="callout-canvas" width={layout.width} height={layout.height} aria-hidden="true">
            <g transform={`translate(${layout.board.x} ${layout.board.y}) scale(${layout.board.scale}) translate(${-layout.board.bounds.x} ${-layout.board.bounds.y})`}>
              <BoardDrawing art={art} highlight={highlight} />
            </g>
            {layout.leaders.map((leader) => {
              const item = byId.get(leader.id);
              const active = hover === leader.id;
              return (
                <g key={leader.id} className={`callout-leader tone-${item?.tone ?? 'ok'}${active ? ' is-active' : ''}`}>
                  <polyline points={leader.points.map((p) => p.join(',')).join(' ')} />
                  {leader.branches.map((branch, index) => (
                    <polyline key={index} points={branch.points.map((p) => p.join(',')).join(' ')} />
                  ))}
                  <circle cx={leader.anchor[0]} cy={leader.anchor[1]} r={active ? 4 : 3} />
                  {leader.branches.map((branch, index) => (
                    <circle key={index} cx={branch.anchor[0]} cy={branch.anchor[1]} r={active ? 4 : 3} />
                  ))}
                </g>
              );
            })}
          </svg>
          {layout.labels.map((box) => {
            const item = byId.get(box.id);
            if (!item) return null;
            const body = (
              <>
                <span className="callout-title">
                  {item.icon ? <span className="callout-icon">{item.icon}</span> : null}
                  <span className="callout-title-text">{item.title}</span>
                  {item.onSelect ? <ChevronRight className="callout-chevron" size={14} aria-hidden="true" /> : null}
                </span>
                <span className={`callout-value tone-${item.tone ?? 'ok'}`}>{item.value}</span>
                {item.detail ? <span className="callout-detail">{item.detail}</span> : null}
              </>
            );
            const style = { left: box.x, top: box.y, width: box.w, height: box.h };
            const common = {
              className: `callout-label side-${box.side}${hover === box.id ? ' is-active' : ''}`,
              style,
              onMouseEnter: () => setHover(box.id),
              onMouseLeave: () => setHover((current) => (current === box.id ? null : current)),
              onFocus: () => setHover(box.id),
              onBlur: () => setHover((current) => (current === box.id ? null : current)),
            };
            return item.onSelect ? (
              <button key={box.id} type="button" {...common} onClick={item.onSelect}>
                {body}
              </button>
            ) : (
              <div key={box.id} {...common} tabIndex={0}>
                {body}
              </div>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
