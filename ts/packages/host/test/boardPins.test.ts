import { describe, expect, it } from 'vitest';

import { BOARD_PINS, boardPinsFor, matrixPinLabels, pinLayoutCommandLine, quickCommandPayload, togglePin } from '../src';

describe('board pins (IO Visualizer)', () => {
  it('finds each board, old spellings included, and falls back to v1.0.F', () => {
    expect(boardPinsFor('TIA-CTL v2.0.F 2026.10').artwork).toBe('v20f');
    expect(boardPinsFor('VD-CTL/R v1.5.F 2026.7').artwork).toBe('v15f');
    expect(boardPinsFor('TIA-CTL v2.3.D GCU LTS').artwork).toBe('gcu_v23d');
    expect(boardPinsFor('something else').artwork).toBe('v10f');
    expect(boardPinsFor(null)).toBe(BOARD_PINS[0]);
  });

  it('every default pin is a selectable slot of its own kind', () => {
    for (const board of BOARD_PINS) {
      const analog = new Set(board.analogPinSlots.concat(board.digitalPinSlots).filter((p) => p.role === 'analog').map((p) => p.gpio));
      const select = new Set(board.analogPinSlots.concat(board.digitalPinSlots).filter((p) => p.role === 'select').map((p) => p.gpio));
      for (const pin of board.defaultAnalogPins) expect(analog.has(pin), `${board.hardwareModel} analog ${pin}`).toBe(true);
      for (const pin of board.defaultSelectPins) expect(select.has(pin), `${board.hardwareModel} select ${pin}`).toBe(true);
    }
  });

  it('picks in order and applies with set_matrix_layout', () => {
    expect(togglePin([3, 1], 2)).toEqual([3, 1, 2]);
    expect(togglePin([3, 1, 2], 1)).toEqual([3, 2]);
    expect(pinLayoutCommandLine([1, 2], [17])).toBe('set-matrix-layout --analog-pins 1,2 --select-pins 17');
    expect(quickCommandPayload({ kind: 'matrix_layout', analogPins: [1, 2], selectPins: [17] })).toEqual({
      command: 'set_matrix_layout',
      analog_pins: [1, 2],
      select_pins: [17],
    });
  });
});

describe('matrixPinLabels', () => {
  it('names rows by A pins and columns by D pins, in scan order', () => {
    const labels = matrixPinLabels('TIA-CTL v2.0.F 2026.10', { analog: [1, 2, 14], select: [17, 18, 45, 99] }, 3, 4);
    expect(labels).toEqual({ rows: ['A0', 'A1', 'A13'], cols: ['D0', 'D1', 'D13', 'GPIO99'] });
  });
  it('gives nothing when the layout does not match the matrix', () => {
    expect(matrixPinLabels('TIA-CTL v2.0.F 2026.10', { analog: [1], select: [17] }, 2, 1)).toBeNull();
    expect(matrixPinLabels('TIA-CTL v2.0.F 2026.10', null, 2, 1)).toBeNull();
  });
});
