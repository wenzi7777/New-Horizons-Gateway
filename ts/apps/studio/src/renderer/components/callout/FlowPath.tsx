// The "Illustrated" interface's path diagram: boxes on a small grid joined by
// wires, the live path lit and flowing (a printer's filament path, here power
// or data). Graphs from @nhgw/host flowPath (powerFlow / connectionFlow); the
// Desktop has the same file.
import { fitMiddle, flowCellWidth, flowLayout, type FlowGraph } from '@nhgw/host';

import './callout.css';

export type FlowLabel = { title: string; value?: string };

export function FlowPath({ graph, labels, ariaLabel }: { graph: FlowGraph; labels: Readonly<Record<string, FlowLabel>>; ariaLabel: string }) {
  // Boxes as wide as their text needs (within bounds); longer text is cut in
  // the middle so both ends of a name stay readable.
  const cellW = flowCellWidth(graph.nodes.map((node) => labels[node.id] ?? { title: node.id }));
  const layout = flowLayout(graph, { cellW });
  const room = cellW - 14;
  const pad = 4;
  return (
    <svg
      className="flow-path"
      viewBox={`${-pad} ${-pad} ${layout.width + pad * 2} ${layout.height + pad * 2}`}
      style={{ maxWidth: layout.width + pad * 2 }}
      role="img"
      aria-label={ariaLabel}
    >
      {layout.wires.map((wire) => (
        <g key={`${wire.from}-${wire.to}`} className={`flow-wire${wire.active ? ' is-active' : ''}`}>
          <polyline points={wire.points.map((p) => p.join(',')).join(' ')} />
          {wire.active ? <polyline className="flow-pulse" points={wire.points.map((p) => p.join(',')).join(' ')} /> : null}
        </g>
      ))}
      {layout.boxes.map((box) => {
        const label = labels[box.id] ?? { title: box.id };
        const full = label.value ? `${label.title}: ${label.value}` : label.title;
        return (
          <g key={box.id} className={`flow-node${box.active ? ' is-active' : ''}`}>
            <title>{full}</title>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10} />
            <text className="flow-title" x={box.x + box.w / 2} y={label.value ? box.y + 19 : box.y + box.h / 2 + 4} textAnchor="middle">
              {fitMiddle(label.title, room, 11.5)}
            </text>
            {label.value ? (
              <text className="flow-value" x={box.x + box.w / 2} y={box.y + 36} textAnchor="middle">
                {fitMiddle(label.value, room, 13)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
