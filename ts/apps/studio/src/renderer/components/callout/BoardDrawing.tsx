// One of the NHOS Native boards (@nhgw/host boardArt) drawn in mm: the outline,
// the parts worth pointing at and the FPC contacts. Coloured by CSS tokens so
// it follows the theme. Place it inside an <svg> with a transform; parts whose
// target is in `highlight` are drawn in the accent colour. The Desktop has the
// same file (components/callout/BoardDrawing.tsx).
import type { ReactNode } from 'react';
import type { BoardArt, BoardArtPart, BoardArtTarget, FpcContacts } from '@nhgw/host';

function partLabel(part: BoardArtPart) {
  if (!part.label) return null;
  const vertical = part.h > part.w * 1.6;
  const long = vertical ? part.h : part.w;
  const size = Math.min(1.7, (long * 0.8) / Math.max(3, part.label.length * 0.62), (vertical ? part.w : part.h) * 0.42);
  const cx = part.x + part.w / 2;
  const cy = part.y + part.h / 2;
  return (
    <text className="ba-label" x={cx} y={cy} fontSize={size} textAnchor="middle" dominantBaseline="central" transform={vertical ? `rotate(-90 ${cx} ${cy})` : undefined}>
      {part.label}
    </text>
  );
}

function Contacts({ fpc }: { fpc: FpcContacts }) {
  const along = fpc.step.x !== 0 ? 'x' : 'y';
  return (
    <g className="ba-contacts">
      {Array.from({ length: fpc.count }, (_, i) => {
        const x = fpc.pin1.x + i * fpc.step.x;
        const y = fpc.pin1.y + i * fpc.step.y;
        return along === 'y' ? <rect key={i} x={x - 0.45} y={y - 0.13} width={0.9} height={0.26} /> : <rect key={i} x={x - 0.13} y={y - 0.45} width={0.26} height={0.9} />;
      })}
    </g>
  );
}

function Part({ part, art, active }: { part: BoardArtPart; art: BoardArt; active: boolean }) {
  const cls = `ba-part ba-${part.kind}${active ? ' is-active' : ''}`;
  const { x, y, w, h } = part;
  switch (part.kind) {
    case 'antenna': {
      // A meander like the module's printed antenna.
      const steps = 7;
      let d = `M${x + 1} ${y + h - 0.8}`;
      for (let i = 0; i < steps; i++) {
        const sx = x + 1 + ((w - 2) * (i + 0.5)) / steps;
        d += ` L${sx} ${y + h - 0.8} L${sx} ${y + 0.9} L${sx + (w - 2) / steps / 2} ${y + 0.9} L${sx + (w - 2) / steps / 2} ${y + h - 0.8}`;
      }
      return (
        <g className={cls}>
          <rect x={x} y={y} width={w} height={h} rx={0.5} />
          <path className="ba-trace" d={d} />
        </g>
      );
    }
    case 'module':
      return (
        <g className={cls}>
          <rect x={x} y={y} width={w} height={h} rx={0.4} />
          <rect className="ba-shield" x={x + 0.9} y={y + 0.9} width={w - 1.8} height={h - 1.8} rx={0.6} />
          {/* The name sits high: callouts land in the middle. */}
          {partLabel({ ...part, h: h * 0.45 })}
        </g>
      );
    case 'usb':
      return (
        <g className={cls}>
          <rect x={x} y={y} width={w} height={h} rx={1} />
          <rect className="ba-slot" x={x + w * 0.18} y={y + 0.8} width={w * 0.64} height={Math.min(2.2, h * 0.3)} rx={1} />
          {partLabel({ ...part, y: y + h * 0.35, h: h * 0.65 })}
        </g>
      );
    case 'connector':
      return (
        <g className={cls}>
          <rect x={x} y={y} width={w} height={h} rx={0.5} />
          <rect className="ba-slot" x={x + 0.8} y={y + 0.8} width={w - 1.6} height={h - 1.6} rx={0.3} />
          {partLabel(part)}
        </g>
      );
    case 'fpc': {
      const fpc = part.target === 'digitalFpc' ? art.digitalFpc : art.analogFpc;
      return (
        <g className={cls}>
          <rect x={x} y={y} width={w} height={h} rx={0.5} />
          <Contacts fpc={fpc} />
          {partLabel(part.h > part.w ? { ...part, x: x + 0.3, w: w * 0.55 } : { ...part, y: y + 0.3, h: h * 0.55 })}
        </g>
      );
    }
    case 'switch':
      return (
        <g className={cls}>
          <rect x={x} y={y} width={w} height={h} rx={0.5} />
          <rect className="ba-knob" x={w > h ? x + w * 0.3 : x + w * 0.25} y={w > h ? y + h * 0.25 : y + h * 0.3} width={w > h ? w * 0.3 : w * 0.5} height={w > h ? h * 0.5 : h * 0.3} rx={0.3} />
        </g>
      );
    case 'button':
      return (
        <g className={cls}>
          <rect x={x} y={y} width={w} height={h} rx={0.4} />
          <circle className="ba-knob" cx={x + w / 2} cy={y + h / 2} r={Math.min(w, h) * 0.3} />
        </g>
      );
    case 'led':
      return <rect className={cls} x={x} y={y} width={w} height={h} rx={0.3} />;
    default:
      return (
        <g className={cls}>
          <rect x={x} y={y} width={w} height={h} rx={0.25} />
          {partLabel(part)}
        </g>
      );
  }
}

export function BoardDrawing({ art, highlight, children }: { art: BoardArt; highlight?: ReadonlySet<BoardArtTarget> | null; children?: ReactNode }) {
  return (
    <g className="ba-drawing">
      <rect className="ba-board" x={0} y={0} width={art.width} height={art.height} rx={1} />
      {art.holes.map((hole) => (
        <circle key={`${hole.x},${hole.y}`} className="ba-hole" cx={hole.x} cy={hole.y} r={hole.d / 2} />
      ))}
      {art.parts.map((part, index) => (
        <Part key={index} part={part} art={art} active={Boolean(part.target && highlight?.has(part.target))} />
      ))}
      {children}
    </g>
  );
}
