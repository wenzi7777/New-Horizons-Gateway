// Each board's matrix pins: the FPC slots in connector order, which of them
// are analog rows or select columns, and the factory default layout. Shared
// by NH Studio and NH Pocket (the IO Visualizer); the same data as the
// Desktop's frontend/src/lib/boardProfile.ts.

export type BoardPinSlot = {
  label: string;
  gpio?: number;
  role?: 'analog' | 'select';
};

export type BoardPins = {
  hardwareModel: string;
  /** Which overview artwork the app shows (each app ships its own copy). */
  artwork: 'v10f' | 'v15f' | 'v20f' | 'gcu_v21' | 'gcu_v22c' | 'gcu_v23d';
  defaultAnalogPins: number[];
  defaultSelectPins: number[];
  analogPinSlots: BoardPinSlot[];
  digitalPinSlots: BoardPinSlot[];
  analogPinHeading: string;
  digitalPinHeading: string;
};

export const V1_ANALOG_PIN_SLOTS: BoardPinSlot[] = [
  { label: 'A0', gpio: 1, role: 'analog' },
  { label: 'A1', gpio: 2, role: 'analog' },
  { label: 'A2', gpio: 3, role: 'analog' },
  { label: 'A3', gpio: 4, role: 'analog' },
  { label: 'A4', gpio: 5, role: 'analog' },
  { label: 'A5', gpio: 6, role: 'analog' },
  { label: 'A6', gpio: 7, role: 'analog' },
  { label: 'A7', gpio: 8, role: 'analog' },
  { label: 'A8', gpio: 9, role: 'analog' },
  { label: 'A9', gpio: 10, role: 'analog' },
  { label: 'D19', gpio: 40, role: 'select' },
  { label: 'D20', gpio: 41, role: 'select' },
  { label: 'NC' },
  { label: 'NC' },
  { label: 'LED' },
  { label: 'SDA' },
  { label: 'SCL' },
  { label: 'GND' },
  { label: '3V3' },
  { label: '5V' },
];

export const V1_DIGITAL_PIN_SLOTS: BoardPinSlot[] = [
  { label: 'D0', gpio: 13, role: 'select' },
  { label: 'D1', gpio: 14, role: 'select' },
  { label: 'D2', gpio: 15, role: 'select' },
  { label: 'D3', gpio: 16, role: 'select' },
  { label: 'D4', gpio: 17, role: 'select' },
  { label: 'D5', gpio: 18, role: 'select' },
  { label: 'D6', gpio: 19, role: 'select' },
  { label: 'D7', gpio: 20, role: 'select' },
  { label: 'D8', gpio: 21, role: 'select' },
  { label: 'D9', gpio: 26, role: 'select' },
  { label: 'D10', gpio: 47, role: 'select' },
  { label: 'D11', gpio: 33, role: 'select' },
  { label: 'D12', gpio: 34, role: 'select' },
  { label: 'D13', gpio: 48, role: 'select' },
  { label: 'NC' },
  { label: 'D14', gpio: 35, role: 'select' },
  { label: 'D15', gpio: 36, role: 'select' },
  { label: 'D16', gpio: 37, role: 'select' },
  { label: 'D17', gpio: 38, role: 'select' },
  { label: 'D18', gpio: 39, role: 'select' },
];

export const V15F_ANALOG_PIN_SLOTS: BoardPinSlot[] = [
  { label: 'A0', gpio: 1, role: 'analog' },
  { label: 'A1', gpio: 2, role: 'analog' },
  { label: 'A2', gpio: 3, role: 'analog' },
  { label: 'A3', gpio: 4, role: 'analog' },
  { label: 'A4', gpio: 5, role: 'analog' },
  { label: 'A5', gpio: 6, role: 'analog' },
  { label: 'A6', gpio: 7, role: 'analog' },
  { label: 'A7', gpio: 8, role: 'analog' },
  { label: 'A8', gpio: 9, role: 'analog' },
  { label: 'A9', gpio: 10, role: 'analog' },
  { label: 'A10', gpio: 11, role: 'analog' },
  { label: 'A11', gpio: 12, role: 'analog' },
  { label: 'A12', gpio: 13, role: 'analog' },
  { label: 'A13', gpio: 14, role: 'analog' },
  { label: 'LED', gpio: 16 },
  { label: 'RX' },
  { label: 'TX' },
  { label: 'GND' },
  { label: '3V3' },
  { label: '5V' },
];

export const V15F_DIGITAL_PIN_SLOTS: BoardPinSlot[] = [
  { label: '5V' },
  { label: '3V3' },
  { label: 'GND' },
  { label: 'GND' },
  { label: 'SCL', gpio: 42 },
  { label: 'SDA', gpio: 40 },
  { label: 'D13', gpio: 45, role: 'select' },
  { label: 'D12', gpio: 39, role: 'select' },
  { label: 'D11', gpio: 38, role: 'select' },
  { label: 'D10', gpio: 37, role: 'select' },
  { label: 'D9', gpio: 36, role: 'select' },
  { label: 'D8', gpio: 35, role: 'select' },
  { label: 'D7', gpio: 48, role: 'select' },
  { label: 'D6', gpio: 34, role: 'select' },
  { label: 'D5', gpio: 33, role: 'select' },
  { label: 'D4', gpio: 47, role: 'select' },
  { label: 'D3', gpio: 26, role: 'select' },
  { label: 'D2', gpio: 21, role: 'select' },
  { label: 'D1', gpio: 18, role: 'select' },
  { label: 'D0', gpio: 17, role: 'select' },
];

export const GCU_DIGITAL_PIN_SLOTS: BoardPinSlot[] = [
  { label: '5V' },
  { label: '3V3' },
  { label: '3V3' },
  { label: 'D46', gpio: 46, role: 'select' },
  { label: 'D45', gpio: 45, role: 'select' },
  { label: 'D42', gpio: 42, role: 'select' },
  { label: 'D41', gpio: 41, role: 'select' },
  { label: 'D40', gpio: 40, role: 'select' },
  { label: 'D39', gpio: 39, role: 'select' },
  { label: 'D37', gpio: 37, role: 'select' },
  { label: 'D36', gpio: 36, role: 'select' },
  { label: 'D35', gpio: 35, role: 'select' },
  { label: 'D21', gpio: 21, role: 'select' },
  { label: 'D20', gpio: 20, role: 'select' },
  { label: 'D19', gpio: 19, role: 'select' },
  { label: 'D18', gpio: 18, role: 'select' },
  { label: 'D17', gpio: 17, role: 'select' },
  { label: 'D16', gpio: 16, role: 'select' },
  { label: 'GND' },
  { label: 'GND' },
];

export const V21_GCU_DIGITAL_PIN_SLOTS: BoardPinSlot[] = [
  { label: '5V' },
  { label: '3V3' },
  { label: '3V3' },
  { label: 'NC' },
  { label: 'D45', gpio: 45, role: 'select' },
  { label: 'D42', gpio: 42, role: 'select' },
  { label: 'D41', gpio: 41, role: 'select' },
  { label: 'D40', gpio: 40, role: 'select' },
  { label: 'D39', gpio: 39, role: 'select' },
  { label: 'D37', gpio: 37, role: 'select' },
  { label: 'D36', gpio: 36, role: 'select' },
  { label: 'D35', gpio: 35, role: 'select' },
  { label: 'D21', gpio: 21, role: 'select' },
  { label: 'D20', gpio: 20, role: 'select' },
  { label: 'D19', gpio: 19, role: 'select' },
  { label: 'D18', gpio: 18, role: 'select' },
  { label: 'NC' },
  { label: 'NC' },
  { label: 'GND' },
  { label: 'GND' },
];

export const GCU_ANALOG_PIN_SLOTS: BoardPinSlot[] = [
  { label: '5V' },
  { label: '3V3' },
  { label: '3V3' },
  { label: 'A1', gpio: 1, role: 'analog' },
  { label: 'A2', gpio: 2, role: 'analog' },
  { label: 'A3', gpio: 3, role: 'analog' },
  { label: 'A4', gpio: 4, role: 'analog' },
  { label: 'A5', gpio: 5, role: 'analog' },
  { label: 'A6', gpio: 6, role: 'analog' },
  { label: 'A7', gpio: 7, role: 'analog' },
  { label: 'A8', gpio: 8, role: 'analog' },
  { label: 'A9', gpio: 9, role: 'analog' },
  { label: 'A10', gpio: 10, role: 'analog' },
  { label: 'A11', gpio: 11, role: 'analog' },
  { label: 'A12', gpio: 12, role: 'analog' },
  { label: 'A13', gpio: 13, role: 'analog' },
  { label: 'A14', gpio: 14, role: 'analog' },
  { label: 'A15', gpio: 15, role: 'analog' },
  { label: 'GND' },
  { label: 'GND' },
];

export const V21_GCU_ANALOG_PIN_SLOTS: BoardPinSlot[] = [
  { label: '5V' },
  { label: '3V3' },
  { label: '3V3' },
  { label: 'A1', gpio: 1, role: 'analog' },
  { label: 'A2', gpio: 2, role: 'analog' },
  { label: 'A3', gpio: 3, role: 'analog' },
  { label: 'A4', gpio: 4, role: 'analog' },
  { label: 'A5', gpio: 5, role: 'analog' },
  { label: 'A6', gpio: 6, role: 'analog' },
  { label: 'A7', gpio: 7, role: 'analog' },
  { label: 'A8', gpio: 8, role: 'analog' },
  { label: 'A9', gpio: 9, role: 'analog' },
  { label: 'A10', gpio: 10, role: 'analog' },
  { label: 'NC' },
  { label: 'NC' },
  { label: 'NC' },
  { label: 'NC' },
  { label: 'NC' },
  { label: 'GND' },
  { label: 'GND' },
];

export const V22C_GCU_ANALOG_PIN_SLOTS: BoardPinSlot[] = [
  { label: '5V' },
  { label: '3V3' },
  { label: '3V3' },
  { label: 'A1', gpio: 1, role: 'analog' },
  { label: 'A2', gpio: 2, role: 'analog' },
  { label: 'A3', gpio: 3, role: 'analog' },
  { label: 'A4', gpio: 4, role: 'analog' },
  { label: 'A5', gpio: 5, role: 'analog' },
  { label: 'A6', gpio: 6, role: 'analog' },
  { label: 'A7', gpio: 7, role: 'analog' },
  { label: 'A8', gpio: 8, role: 'analog' },
  { label: 'A9', gpio: 9, role: 'analog' },
  { label: 'A10', gpio: 10, role: 'analog' },
  // IO11 reaches the connector but must not be used on this revision.
  { label: 'DNU' },
  { label: 'NC' },
  { label: 'NC' },
  { label: 'NC' },
  { label: 'NC' },
  { label: 'GND' },
  { label: 'GND' },
];

export const V22C_GCU_DIGITAL_PIN_SLOTS: BoardPinSlot[] = [
  { label: '5V' },
  { label: '3V3' },
  { label: '3V3' },
  { label: 'NC' },
  { label: 'D45', gpio: 45, role: 'select' },
  { label: 'D42', gpio: 42, role: 'select' },
  { label: 'D41', gpio: 41, role: 'select' },
  { label: 'D40', gpio: 40, role: 'select' },
  { label: 'D39', gpio: 39, role: 'select' },
  { label: 'D37', gpio: 37, role: 'select' },
  { label: 'D36', gpio: 36, role: 'select' },
  { label: 'D35', gpio: 35, role: 'select' },
  { label: 'D21', gpio: 21, role: 'select' },
  { label: 'D20', gpio: 20, role: 'select' },
  { label: 'D19', gpio: 19, role: 'select' },
  { label: 'D18', gpio: 18, role: 'select' },
  // IO17 reaches the connector but must not be used on this revision.
  { label: 'DNU' },
  { label: 'NC' },
  { label: 'GND' },
  { label: 'GND' },
];

/** Every known board; the first (v1.0.F) is the fallback for unknown models. */
export const BOARD_PINS: readonly BoardPins[] = [
  {
    hardwareModel: 'TIA-CTL v1.0.F 2026.4',
    artwork: 'v10f',
    defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    defaultSelectPins: [13, 14, 15, 16, 17, 18, 19, 20, 21, 26, 47, 33, 34, 48, 40, 41, 35, 36, 37, 38, 39],
    analogPinSlots: V1_ANALOG_PIN_SLOTS,
    digitalPinSlots: V1_DIGITAL_PIN_SLOTS,
    analogPinHeading: 'ANA FPC',
    digitalPinHeading: 'DIG FPC',
  },
  {
    hardwareModel: 'TIA-CTL v2.1 GCU LTS',
    artwork: 'gcu_v21',
    defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    defaultSelectPins: [18, 19, 20, 21, 35, 36, 37, 39, 40, 41, 42, 45],
    analogPinSlots: V21_GCU_ANALOG_PIN_SLOTS,
    digitalPinSlots: V21_GCU_DIGITAL_PIN_SLOTS,
    analogPinHeading: 'ANALOG PINS',
    digitalPinHeading: 'DIGITAL PINS',
  },
  {
    hardwareModel: 'TIA-CTL v2.2.C GCU LTS',
    artwork: 'gcu_v22c',
    defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    defaultSelectPins: [18, 19, 20, 21, 35, 36, 37, 39, 40, 41, 42, 45],
    analogPinSlots: V22C_GCU_ANALOG_PIN_SLOTS,
    digitalPinSlots: V22C_GCU_DIGITAL_PIN_SLOTS,
    analogPinHeading: 'ANALOG PINS',
    digitalPinHeading: 'DIGITAL PINS',
  },
  {
    hardwareModel: 'TIA-CTL v1.5.F 2026.7',
    artwork: 'v15f',
    defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    defaultSelectPins: [17, 18, 21, 26, 47, 33, 34, 48, 35, 36, 37, 38, 39, 45],
    analogPinSlots: V15F_ANALOG_PIN_SLOTS,
    digitalPinSlots: V15F_DIGITAL_PIN_SLOTS,
    analogPinHeading: 'Analog Pins',
    digitalPinHeading: 'Digital Pins',
  },
  {
    hardwareModel: 'TIA-CTL v2.0.F 2026.10',
    artwork: 'v20f',
    defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    defaultSelectPins: [17, 18, 21, 26, 47, 33, 34, 48, 35, 36, 37, 38, 39, 45],
    analogPinSlots: V15F_ANALOG_PIN_SLOTS,
    digitalPinSlots: V15F_DIGITAL_PIN_SLOTS,
    analogPinHeading: 'Analog Pins',
    digitalPinHeading: 'Digital Pins',
  },
  {
    hardwareModel: 'TIA-CTL v2.3.D GCU LTS',
    artwork: 'gcu_v23d',
    defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultSelectPins: [16, 17, 18, 19, 20, 21, 35, 36, 37, 39, 40, 41, 42, 45, 46],
    analogPinSlots: GCU_ANALOG_PIN_SLOTS,
    digitalPinSlots: GCU_DIGITAL_PIN_SLOTS,
    analogPinHeading: 'ANALOG PINS',
    digitalPinHeading: 'DIGITAL PINS',
  },
];

/** Folds the older "VD-CTL/R ..." / "TIA-CTL/R ..." spellings into "tia-ctl ...". */
function normalizeModel(value: string): string {
  return value.trim().toLowerCase().replace(/^(vd|tia)-ctl\/r\b/, 'tia-ctl');
}

export function boardPinsFor(hardwareModel: string | null | undefined): BoardPins {
  const normalized = normalizeModel(String(hardwareModel ?? ''));
  return BOARD_PINS.find((board) => normalizeModel(board.hardwareModel) === normalized) ?? BOARD_PINS[0]!;
}

/** Adds or removes a pin; the order picked is the matrix order. */
export function togglePin(values: readonly number[], value: number): number[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/** The same layout as a terminal command line. */
export function pinLayoutCommandLine(analogPins: readonly number[], selectPins: readonly number[]): string {
  return `set-matrix-layout --analog-pins ${analogPins.join(',')} --select-pins ${selectPins.join(',')}`;
}

/**
 * The silkscreen name of each scanned pin, in scan order: rows are the
 * analog pins (A..), columns the select pins (D..); null when the layout
 * doesn't match the matrix. A GPIO the header doesn't show is named by number.
 */
export function matrixPinLabels(
  hardwareModel: string | null | undefined,
  pins: { analog: readonly number[]; select: readonly number[] } | null | undefined,
  rows: number,
  cols: number,
): { rows: string[]; cols: string[] } | null {
  if (!pins || pins.analog.length !== rows || pins.select.length !== cols) return null;
  const board = boardPinsFor(hardwareModel);
  const slots = [...board.analogPinSlots, ...board.digitalPinSlots];
  const nameOf = (gpio: number, role: 'analog' | 'select') =>
    (slots.find((slot) => slot.gpio === gpio && slot.role === role) ?? slots.find((slot) => slot.gpio === gpio))?.label
    ?? `GPIO${gpio}`;
  return { rows: pins.analog.map((gpio) => nameOf(gpio, 'analog')), cols: pins.select.map((gpio) => nameOf(gpio, 'select')) };
}
