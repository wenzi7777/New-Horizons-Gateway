// TIA-CTL v2.0.F: the back of the board with Rfb0-13 where they really sit,
// coloured by what rfb_measure found (soldered / not soldered / problem / not
// measured / not in the layout). Same drawing as the Desktop's
// components/RfbBoardMap.tsx; positions and states from @nhgw/host rfbLayout.
import { backX, rfbBoardCounts, V20F_BOARD_MM, V20F_RFB_PADS, type RfbBoardState, type RfbState } from '@nhgw/host';

type T = (key: string, vars?: Readonly<Record<string, unknown>>) => string;

// Only the lower part of the board holds the Rfb: the view starts below the
// ESP32 module so the resistors are drawn large enough to read.
const VIEW = { x: -1, y: 15, width: V20F_BOARD_MM.width + 2, height: V20F_BOARD_MM.height - 15 + 1 };
// 0805: 2.0 x 1.25 mm, pads at both ends.
const PART_W = 2.0;
const PART_H = 1.25;
const PAD_W = 0.55;
// Reference outlines, seen from the back (mirrored from the front artwork).
const HOLES = [
  { x: V20F_BOARD_MM.width - 2.1, y: 38.2 },
  { x: V20F_BOARD_MM.width - 28.4, y: 38.2 },
];
const ANALOG_FPC = { x: V20F_BOARD_MM.width - 6.5, y: 25.2, width: 6.5, height: 11 };
const DIGITAL_FPC = { x: 0, y: 25.2, width: 6.5, height: 11 };
const STATES: RfbState[] = ['soldered', 'empty', 'fault', 'unknown', 'unused'];

function kOhmShort(ohm: number): string {
  const k = ohm / 1000;
  return `${k >= 100 ? k.toFixed(0) : k.toFixed(1)}k`;
}

function tooltip(item: RfbBoardState, ds: T): string {
  const parts = [`Rfb${item.rfb}`, `A${item.rfb} / GPIO ${item.gpio}`, ds(`rfbState_${item.state}`)];
  if (item.ohm !== null) parts.push(`${(item.ohm / 1000).toFixed(2)} kΩ`);
  if (item.state === 'fault' && item.status) parts.push(ds(`rfbStatus_${item.status}`));
  if (item.row !== null) parts.push(ds('rfbMapRow', { row: item.row }));
  return parts.join(' · ');
}

function Part({ item, ds }: { item: RfbBoardState; ds: T }) {
  const pad = V20F_RFB_PADS.find((entry) => entry.rfb === item.rfb);
  if (!pad) return null;
  const cx = backX(pad.x);
  const cy = pad.y;
  // Labels go outward, away from the other column.
  const outward = cx > V20F_BOARD_MM.width / 2 + 2 ? 1 : -1;
  const label = item.state === 'soldered' && item.ohm !== null ? `R${item.rfb} ${kOhmShort(item.ohm)}` : item.state === 'fault' ? `R${item.rfb} !` : `R${item.rfb}`;
  const showBody = item.state === 'soldered' || item.state === 'fault' || item.state === 'unknown';
  return (
    <g className={`rfb-part rfb-${item.state}`}>
      <title>{tooltip(item, ds)}</title>
      <rect className="rfb-hit" x={cx - PART_W / 2 - 0.3} y={cy - PART_H / 2 - 0.25} width={PART_W + 0.6} height={PART_H + 0.5} />
      <rect className="rfb-pad" x={cx - PART_W / 2} y={cy - PART_H / 2} width={PAD_W} height={PART_H} rx={0.08} />
      <rect className="rfb-pad" x={cx + PART_W / 2 - PAD_W} y={cy - PART_H / 2} width={PAD_W} height={PART_H} rx={0.08} />
      {showBody ? <rect className="rfb-body" x={cx - PART_W / 2 + PAD_W * 0.6} y={cy - PART_H / 2 + 0.08} width={PART_W - PAD_W * 1.2} height={PART_H - 0.16} rx={0.1} /> : null}
      <text className="rfb-label" x={cx + outward * (PART_W / 2 + 0.45)} y={cy} textAnchor={outward > 0 ? 'start' : 'end'} dominantBaseline="central">
        {label}
      </text>
    </g>
  );
}

export function RfbBoardMap({ board, ds }: { board: RfbBoardState[]; ds: T }) {
  if (!board.length) return null;
  const counts = rfbBoardCounts(board);
  const measured = counts.soldered + counts.empty + counts.fault;
  const inLayout = board.length - counts.unused;
  return (
    <figure className="rfb-map">
      <figcaption>
        <strong>{ds('rfbMapTitle')}</strong>
        <span>{measured ? ds('rfbMapSummary', { soldered: counts.soldered, total: inLayout, empty: counts.empty }) : ds('rfbMapNotMeasured')}</span>
      </figcaption>
      <svg viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`} role="img" aria-label={ds('rfbMapTitle')}>
        <path
          className="rfb-board"
          d={`M0 ${VIEW.y} V${V20F_BOARD_MM.height - 1} Q0 ${V20F_BOARD_MM.height} 1 ${V20F_BOARD_MM.height} H${V20F_BOARD_MM.width - 1} Q${V20F_BOARD_MM.width} ${V20F_BOARD_MM.height} ${V20F_BOARD_MM.width} ${V20F_BOARD_MM.height - 1} V${VIEW.y}`}
        />
        <line className="rfb-board-cut" x1={0} y1={VIEW.y + 0.05} x2={V20F_BOARD_MM.width} y2={VIEW.y + 0.05} />
        <text className="rfb-ref-label" x={V20F_BOARD_MM.width / 2} y={VIEW.y + 1.3} textAnchor="middle">
          {ds('rfbMapBack')}
        </text>
        <rect className="rfb-ref" {...ANALOG_FPC} rx={0.4} />
        <text className="rfb-ref-label" x={ANALOG_FPC.x + ANALOG_FPC.width / 2} y={ANALOG_FPC.y + ANALOG_FPC.height + 1.1} textAnchor="middle">
          ANALOG
        </text>
        <rect className="rfb-ref" {...DIGITAL_FPC} rx={0.4} />
        <text className="rfb-ref-label" x={DIGITAL_FPC.x + DIGITAL_FPC.width / 2} y={DIGITAL_FPC.y + DIGITAL_FPC.height + 1.1} textAnchor="middle">
          DIGITAL
        </text>
        {HOLES.map((hole) => (
          <circle key={`${hole.x}`} className="rfb-ref" cx={hole.x} cy={hole.y} r={1} />
        ))}
        {board.map((item) => (
          <Part key={item.rfb} item={item} ds={ds} />
        ))}
      </svg>
      <ul className="rfb-legend">
        {STATES.filter((state) => counts[state] > 0).map((state) => (
          <li key={state} className={`rfb-${state}`}>
            <svg viewBox="0 0 2.6 1.4" aria-hidden="true">
              <rect className="rfb-pad" x={0.05} y={0.075} width={0.7} height={1.25} rx={0.08} />
              <rect className="rfb-pad" x={1.85} y={0.075} width={0.7} height={1.25} rx={0.08} />
              {state === 'soldered' || state === 'fault' || state === 'unknown' ? <rect className="rfb-body" x={0.45} y={0.155} width={1.7} height={1.09} rx={0.1} /> : null}
            </svg>
            {ds(`rfbState_${state}`)} {counts[state]}
          </li>
        ))}
      </ul>
    </figure>
  );
}
