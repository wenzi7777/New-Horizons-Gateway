// TIA-CTL v2.0.F: where each feedback resistor (Rfb0-13) sits on the back of
// the board, and which of them are soldered according to rfb_measure.
//
// Positions come from the board file (pcb/v2.0.F EasyEDA Final, the 2026-11-11
// export): component centres on the bottom layer, in mm from the board's
// top-left corner as seen from the FRONT. RfbN's pad 2 is on ADCx_N_GPIO(N+1),
// so RfbN belongs to analog pin A<N> = GPIO N+1. The Desktop keeps the same
// table in frontend/src/lib/rfbLayout.ts; change both together.

/** The v2.0.F board outline (mm). */
export const V20F_BOARD_MM = { width: 30, height: 40 } as const;

export type RfbPad = { rfb: number; gpio: number; x: number; y: number };

/** Rfb0-13, centre in mm, seen from the front (mirror x for the back). */
export const V20F_RFB_PADS: readonly RfbPad[] = [
  { rfb: 0, gpio: 1, x: 10.6, y: 21.3 },
  { rfb: 1, gpio: 2, x: 10.6, y: 23.1 },
  { rfb: 2, gpio: 3, x: 14.6, y: 23.1 },
  { rfb: 3, gpio: 4, x: 10.6, y: 24.9 },
  { rfb: 4, gpio: 5, x: 10.6, y: 26.7 },
  { rfb: 5, gpio: 6, x: 14.6, y: 26.7 },
  { rfb: 6, gpio: 7, x: 14.6, y: 24.9 },
  { rfb: 7, gpio: 8, x: 10.6, y: 28.5 },
  { rfb: 8, gpio: 9, x: 10.6, y: 30.3 },
  { rfb: 9, gpio: 10, x: 14.6, y: 30.3 },
  { rfb: 10, gpio: 11, x: 14.6, y: 28.5 },
  { rfb: 11, gpio: 12, x: 14.6, y: 32.1 },
  { rfb: 12, gpio: 13, x: 10.6, y: 33.9 },
  { rfb: 13, gpio: 14, x: 14.6, y: 33.9 },
];

/** x of a pad as seen from the back (the board flipped left-right). */
export function backX(x: number): number {
  return V20F_BOARD_MM.width - x;
}

/**
 * soldered: rfb_measure found a resistor (ohm holds it); empty: no feedback,
 * nothing soldered; fault: saturated / open / ADC failure; unknown: never
 * measured; unused: its pin is not in the matrix layout, so nothing measures it.
 */
export type RfbState = 'soldered' | 'empty' | 'fault' | 'unknown' | 'unused';

export type RfbBoardState = {
  rfb: number;
  gpio: number;
  /** The matrix row this Rfb is measured as (rfb_ohm / rfb_status index), null when unused. */
  row: number | null;
  state: RfbState;
  ohm: number | null;
  /** rfb_measure's own word for the row ('ok', 'no_feedback', ...). */
  status: string;
};

export function rfbStateOf(status: string, ohm: number): RfbState {
  if (status === 'ok') return ohm > 0 ? 'soldered' : 'unknown';
  if (status === 'no_feedback') return 'empty';
  if (status === 'saturated' || status === 'open' || status === 'adc_read_failed') return 'fault';
  // Older firmware sent no status: a value means it was measured.
  if (!status && ohm > 0) return 'soldered';
  return 'unknown';
}

/**
 * The firmware reports Rfb per matrix ROW (range.rfb_ohm / rfb_status, in the
 * order of matrix_layout.analog_pins), not per resistor: row r is the resistor
 * on analogPins[r]. Without a known layout the rows are taken as GPIO 1, 2, ...
 */
export function rfbBoard(analogPins: readonly number[] | null, ohms: readonly number[], statuses: readonly string[]): RfbBoardState[] {
  const pins = analogPins && analogPins.length ? analogPins : V20F_RFB_PADS.map((pad) => pad.gpio);
  return V20F_RFB_PADS.map((pad) => {
    const row = pins.indexOf(pad.gpio);
    if (row < 0) return { rfb: pad.rfb, gpio: pad.gpio, row: null, state: 'unused', ohm: null, status: '' };
    const ohm = Number.isFinite(ohms[row]) ? Number(ohms[row]) : 0;
    const status = statuses[row] ?? '';
    const state = rfbStateOf(status, ohm);
    return { rfb: pad.rfb, gpio: pad.gpio, row, state, ohm: state === 'soldered' ? ohm : null, status };
  });
}

/** How many Rfb are in each state. */
export function rfbBoardCounts(board: readonly RfbBoardState[]): Record<RfbState, number> {
  const counts: Record<RfbState, number> = { soldered: 0, empty: 0, fault: 0, unknown: 0, unused: 0 };
  for (const item of board) counts[item.state] += 1;
  return counts;
}
