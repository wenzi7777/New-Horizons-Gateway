import { describe, expect, it } from 'vitest';

import { backX, rfbBoard, rfbBoardCounts, rfbStateOf, V20F_BOARD_MM, V20F_RFB_PADS, vrefOf } from '../src';

describe('v2.0.F Rfb layout', () => {
  it('has Rfb0-13 on GPIO 1-14, inside the board', () => {
    expect(V20F_RFB_PADS.map((pad) => pad.rfb)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    for (const pad of V20F_RFB_PADS) {
      expect(pad.gpio).toBe(pad.rfb + 1);
      expect(backX(pad.x)).toBeGreaterThan(0);
      expect(backX(pad.x)).toBeLessThan(V20F_BOARD_MM.width);
      expect(pad.y).toBeGreaterThan(0);
      expect(pad.y).toBeLessThan(V20F_BOARD_MM.height);
    }
    // No two pads on the same spot.
    expect(new Set(V20F_RFB_PADS.map((pad) => `${pad.x},${pad.y}`)).size).toBe(14);
  });

  it('maps rfb_measure statuses to states', () => {
    expect(rfbStateOf('ok', 20000)).toBe('soldered');
    expect(rfbStateOf('ok', 0)).toBe('unknown');
    expect(rfbStateOf('no_feedback', 0)).toBe('empty');
    expect(rfbStateOf('saturated', 0)).toBe('fault');
    expect(rfbStateOf('open', 0)).toBe('fault');
    expect(rfbStateOf('adc_read_failed', 0)).toBe('fault');
    expect(rfbStateOf('unknown', 0)).toBe('unknown');
    expect(rfbStateOf('', 5000)).toBe('soldered');
    expect(rfbStateOf('', 0)).toBe('unknown');
  });

  it('follows the matrix layout: row r is the Rfb on analogPins[r]', () => {
    // A 3-row layout in reverse order: row 0 is GPIO 3 = Rfb2.
    const board = rfbBoard([3, 2, 1], [20000, 0, 5100], ['ok', 'no_feedback', 'ok']);
    expect(board[2]).toEqual({ rfb: 2, gpio: 3, row: 0, state: 'soldered', ohm: 20000, status: 'ok' });
    expect(board[1]).toMatchObject({ rfb: 1, row: 1, state: 'empty', ohm: null });
    expect(board[0]).toMatchObject({ rfb: 0, row: 2, state: 'soldered', ohm: 5100 });
    expect(board.slice(3).every((item) => item.state === 'unused' && item.row === null)).toBe(true);
    expect(rfbBoardCounts(board)).toEqual({ soldered: 2, empty: 1, fault: 0, unknown: 0, unused: 11 });
  });

  it('reads the layout from status in vrefOf', () => {
    const view = vrefOf({
      vref: { supported: true, mv: 330 },
      matrix_layout: { analog_pins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], select_pins: [17] },
      range: { mode: 'raw', rfb_ohm: [20000, 20000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], rfb_status: ['ok', 'ok', 'no_feedback', ...Array(11).fill('unknown')] },
    });
    const counts = rfbBoardCounts(view!.rfbBoard);
    expect(counts).toEqual({ soldered: 2, empty: 1, fault: 0, unknown: 7, unused: 4 });
  });
});
