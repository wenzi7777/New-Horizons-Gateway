// The NHOS Native boards (TIA-CTL v1.0.F, v1.5.F, v2.0.F) as drawings: the
// outline and the parts worth pointing at, in mm from the board's top-left
// corner as seen from the FRONT, plus where each FPC contact sits. The
// "Illustrated" interface draws them and points live values at the parts
// (calloutLayout below). GCU LTS boards have no drawing: the apps keep their
// plain cards for those.
//
// Every number comes from the boards' EasyEDA files (pcb/<board>/*.epro,
// component boxes from the footprints' component-shape layer, FPC contacts
// from their pads). The Desktop keeps the same file as
// frontend/src/lib/boardArt.ts; change both together.

import { boardPinsFor, type BoardPinSlot } from './boardPins';

export type BoardArtId = 'v10f' | 'v15f' | 'v20f';

export type BoardArtKind =
  | 'module' // the ESP32-S3 module (shielded)
  | 'antenna' // its PCB antenna, past the board edge
  | 'usb'
  | 'connector' // JST battery connector
  | 'fpc'
  | 'ic'
  | 'led'
  | 'switch' // the slide power switch
  | 'button';

/** What a callout can point at. Several parts may share one (the four TIA chips are 'tia'). */
export type BoardArtTarget =
  | 'mcu'
  | 'antenna'
  | 'usb'
  | 'battery'
  | 'analogFpc'
  | 'digitalFpc'
  | 'led'
  | 'statusLed'
  | 'power'
  | 'imu'
  | 'vref'
  | 'tia'
  | 'charger'
  | 'fuelGauge';

export type BoardArtPart = {
  kind: BoardArtKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which callout target this part belongs to. */
  target?: BoardArtTarget;
  /** Printed on the part (short: it is a few mm wide). */
  label?: string;
};

/** One FPC's contacts: contact n (1-based) is at pin1 + (n - 1) * step. */
export type FpcContacts = {
  pin1: { x: number; y: number };
  step: { x: number; y: number };
  count: number;
  /**
   * true when boardPins lists this connector's slots from the last contact
   * down (slot i is contact count - i), as the v1.5.F / v2.0.F digital FPC.
   */
  slotsReversed: boolean;
};

export type BoardArt = {
  id: BoardArtId;
  width: number;
  height: number;
  holes: readonly { x: number; y: number; d: number }[];
  parts: readonly BoardArtPart[];
  analogFpc: FpcContacts;
  digitalFpc: FpcContacts;
  /** Where a target's callout lands when it is not simply the middle of its parts. */
  anchors?: Partial<Record<BoardArtTarget, { x: number; y: number }>>;
};

const ESP32 = (x: number): BoardArtPart[] => [
  // The module is 15.4 x 20.5 mm; its antenna end hangs 5 mm past the top edge.
  { kind: 'antenna', x, y: -5.03, w: 15.4, h: 5.0, target: 'antenna' },
  { kind: 'module', x, y: -0.03, w: 15.4, h: 15.5, target: 'mcu', label: 'ESP32-S3' },
];

const TIA_CTL_V20F: BoardArt = {
  id: 'v20f',
  width: 30,
  height: 40,
  holes: [
    { x: 1.65, y: 38.35, d: 2 },
    { x: 17.91, y: 1.65, d: 2 },
    { x: 28.45, y: 38.35, d: 2 },
  ],
  parts: [
    ...ESP32(0.05),
    { kind: 'usb', x: 20.31, y: -0.17, w: 8.9, h: 7.35, target: 'usb', label: 'USB-C' },
    { kind: 'connector', x: 21.62, y: 10.62, w: 7.8, h: 10.0, target: 'battery', label: 'BAT' },
    { kind: 'fpc', x: 0, y: 21.5, w: 5.03, h: 14.4, target: 'analogFpc', label: 'ANALOG' },
    { kind: 'fpc', x: 24.95, y: 21.5, w: 5.05, h: 14.4, target: 'digitalFpc', label: 'DIGITAL' },
    { kind: 'led', x: 6.42, y: 36.62, w: 2.4, h: 2.7, target: 'led' },
    { kind: 'led', x: 8.83, y: 36.62, w: 2.4, h: 2.7, target: 'led' },
    { kind: 'led', x: 11.54, y: 37.68, w: 0.8, h: 1.6, target: 'statusLed' },
    { kind: 'led', x: 13.06, y: 37.68, w: 0.8, h: 1.6, target: 'statusLed' },
    { kind: 'switch', x: 15.12, y: 36.69, w: 6.6, h: 4.25, target: 'power' },
    { kind: 'button', x: 23.39, y: 37.23, w: 3.0, h: 2.5 },
    { kind: 'button', x: 0.91, y: 15.77, w: 3.0, h: 2.5 },
    { kind: 'button', x: 0.91, y: 18.56, w: 3.0, h: 2.5 },
    { kind: 'ic', x: 13.36, y: 15.87, w: 3.0, h: 2.5, target: 'imu' }, // BMI270
    { kind: 'ic', x: 15.19, y: 19.08, w: 1.24, h: 1.24, target: 'imu' }, // BMM350
    { kind: 'ic', x: 16.15, y: 11.83, w: 2.0, h: 2.0, target: 'fuelGauge' }, // MAX17048
    { kind: 'ic', x: 16.2, y: 8.87, w: 0.87, h: 1.56, target: 'charger' }, // BQ25180
    { kind: 'ic', x: 21.23, y: 8.27, w: 2.0, h: 2.0 }, // TLV757 LDO
    { kind: 'ic', x: 9.09, y: 17.84, w: 1.63, h: 2.93, target: 'vref' }, // MCP4725 Vref DAC
    { kind: 'ic', x: 18.82, y: 24.79, w: 3.0, h: 3.0 }, // PCA9536
    { kind: 'ic', x: 20.17, y: 20.41, w: 1.63, h: 2.93 }, // TPS22950
    { kind: 'ic', x: 11.6, y: 21.2, w: 2.0, h: 2.0, target: 'tia' }, // TLV9064 x4
    { kind: 'ic', x: 11.6, y: 24.8, w: 2.0, h: 2.0, target: 'tia' },
    { kind: 'ic', x: 11.6, y: 28.4, w: 2.0, h: 2.0, target: 'tia' },
    { kind: 'ic', x: 11.6, y: 32.0, w: 2.0, h: 2.0, target: 'tia' },
  ],
  analogFpc: { pin1: { x: 5.35, y: 23.95 }, step: { x: 0, y: 0.5 }, count: 20, slotsReversed: false },
  digitalFpc: { pin1: { x: 24.62, y: 33.45 }, step: { x: 0, y: -0.5 }, count: 20, slotsReversed: true },
};

const TIA_CTL_V15F: BoardArt = {
  id: 'v15f',
  width: 30,
  height: 40,
  holes: [
    { x: 28.45, y: 9.53, d: 2 },
    { x: 28.45, y: 38.35, d: 2 },
  ],
  parts: [
    ...ESP32(0.05),
    { kind: 'usb', x: 20.31, y: -0.05, w: 8.9, h: 7.35, target: 'usb', label: 'USB-C' },
    { kind: 'connector', x: 21.62, y: 11.38, w: 7.8, h: 10.0, target: 'battery', label: 'BAT' },
    { kind: 'fpc', x: 0.03, y: 22.26, w: 5.12, h: 14.4, target: 'analogFpc', label: 'ANALOG' },
    { kind: 'fpc', x: 24.82, y: 22.26, w: 5.12, h: 14.4, target: 'digitalFpc', label: 'DIGITAL' },
    { kind: 'led', x: 5.79, y: 36.62, w: 2.4, h: 2.7, target: 'led' },
    { kind: 'led', x: 8.2, y: 36.62, w: 2.4, h: 2.7, target: 'led' },
    { kind: 'led', x: 11.03, y: 37.43, w: 0.8, h: 1.6, target: 'statusLed' },
    { kind: 'led', x: 12.55, y: 37.48, w: 0.8, h: 1.6, target: 'statusLed' },
    { kind: 'switch', x: 14.73, y: 36.69, w: 6.6, h: 4.25, target: 'power' },
    { kind: 'button', x: 23.27, y: 37.1, w: 3.0, h: 2.5 },
    { kind: 'button', x: 0.91, y: 16.28, w: 3.0, h: 2.5 },
    { kind: 'button', x: 0.91, y: 19.07, w: 3.0, h: 2.5 },
    { kind: 'ic', x: 15.56, y: 18.19, w: 3.0, h: 2.5, target: 'imu' }, // BMI270
    { kind: 'ic', x: 12.1, y: 19.6, w: 1.24, h: 1.24, target: 'imu' }, // BMM350
    { kind: 'ic', x: 13.88, y: 15.81, w: 1.7, h: 0.9, target: 'fuelGauge' }, // MAX17048
    { kind: 'ic', x: 17.95, y: 11.03, w: 1.56, h: 0.87, target: 'charger' }, // BQ25180
    { kind: 'ic', x: 19.44, y: 20.52, w: 2.0, h: 2.0 }, // TLV757 LDO
    { kind: 'ic', x: 15.81, y: 23.82, w: 2.93, h: 1.63 }, // TPS22950
    { kind: 'ic', x: 9.86, y: 23.79, w: 2.0, h: 2.0, target: 'tia' }, // TLV9064 x4
    { kind: 'ic', x: 13.22, y: 26.56, w: 2.0, h: 2.0, target: 'tia' },
    { kind: 'ic', x: 10.05, y: 29.1, w: 2.0, h: 2.0, target: 'tia' },
    { kind: 'ic', x: 13.35, y: 31.89, w: 2.0, h: 2.0, target: 'tia' },
  ],
  analogFpc: { pin1: { x: 5.48, y: 24.71 }, step: { x: 0, y: 0.5 }, count: 20, slotsReversed: false },
  digitalFpc: { pin1: { x: 24.49, y: 34.21 }, step: { x: 0, y: -0.5 }, count: 20, slotsReversed: true },
  // No Vref DAC on this board: a Vref callout points at the amplifiers.
  anchors: { vref: { x: 12.6, y: 28.8 } },
};

const TIA_CTL_V10F: BoardArt = {
  id: 'v10f',
  width: 35.56,
  height: 32.64,
  holes: [],
  parts: [
    ...ESP32(20.11),
    { kind: 'usb', x: 0.88, y: 0.21, w: 8.9, h: 7.35, target: 'usb', label: 'USB-C' },
    { kind: 'ic', x: 10.83, y: 1.53, w: 5.0, h: 5.0, label: 'UART' }, // CP2102N
    { kind: 'connector', x: 27.21, y: 15.96, w: 7.8, h: 10.0, target: 'battery', label: 'BAT' },
    { kind: 'fpc', x: 5.63, y: 27.49, w: 14.4, h: 5.12, target: 'analogFpc', label: 'ANALOG' },
    { kind: 'fpc', x: 20.61, y: 27.49, w: 14.4, h: 5.12, target: 'digitalFpc', label: 'DIGITAL' },
    { kind: 'led', x: 0.78, y: 17.92, w: 2.0, h: 2.0, target: 'led' }, // SK6812
    { kind: 'led', x: 0.95, y: 14.79, w: 1.6, h: 0.8, target: 'statusLed' },
    { kind: 'led', x: 0.93, y: 16.36, w: 1.6, h: 0.8, target: 'statusLed' },
    { kind: 'switch', x: 0, y: 21.34, w: 4.25, h: 6.6, target: 'power' },
    { kind: 'button', x: 0.91, y: 29.1, w: 3.0, h: 2.0 },
    { kind: 'ic', x: 16.91, y: 13.11, w: 2.5, h: 3.0, target: 'imu' }, // BMI270
    { kind: 'ic', x: 22.59, y: 16.71, w: 1.56, h: 0.87, target: 'charger' }, // BQ25180
    { kind: 'ic', x: 7.55, y: 14.11, w: 1.6, h: 2.9 }, // TLV757 LDO
    { kind: 'ic', x: 10.62, y: 14.61, w: 5.0, h: 4.4, target: 'tia' }, // OPA4314 x3
    { kind: 'ic', x: 7.96, y: 21.0, w: 4.4, h: 5.0, target: 'tia' },
    { kind: 'ic', x: 18.33, y: 19.9, w: 5.0, h: 4.4, target: 'tia' },
  ],
  analogFpc: { pin1: { x: 8.08, y: 27.16 }, step: { x: 0.5, y: 0 }, count: 20, slotsReversed: false },
  digitalFpc: { pin1: { x: 23.06, y: 27.16 }, step: { x: 0.5, y: 0 }, count: 20, slotsReversed: false },
  anchors: { vref: { x: 13.1, y: 19.2 } },
};

export const BOARD_ARTS: readonly BoardArt[] = [TIA_CTL_V10F, TIA_CTL_V15F, TIA_CTL_V20F];

/** The drawing for a hardware model, or null (GCU LTS, unknown): use the plain cards then. */
export function boardArtFor(hardwareModel: string | null | undefined): BoardArt | null {
  if (!hardwareModel) return null;
  const id = boardPinsFor(hardwareModel).artwork;
  const normalized = String(hardwareModel).trim().toLowerCase();
  // boardPinsFor falls back to v1.0.F for unknown models: only take a real match.
  if (id === 'v10f' && !/v1\.0\.f/.test(normalized)) return null;
  return BOARD_ARTS.find((art) => art.id === id) ?? null;
}

/** The drawing's extent (the antenna and plugs stick out past the outline). */
export function boardArtBounds(art: BoardArt): { x: number; y: number; width: number; height: number } {
  let x0 = 0;
  let y0 = 0;
  let x1 = art.width;
  let y1 = art.height;
  for (const part of art.parts) {
    x0 = Math.min(x0, part.x);
    y0 = Math.min(y0, part.y);
    x1 = Math.max(x1, part.x + part.w);
    y1 = Math.max(y1, part.y + part.h);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Where a callout to `target` lands (mm), or null when the board has no such part. */
export function boardArtAnchor(art: BoardArt, target: BoardArtTarget): { x: number; y: number } | null {
  const fixed = art.anchors?.[target];
  if (fixed) return fixed;
  const parts = art.parts.filter((part) => part.target === target);
  if (!parts.length) return null;
  const x0 = Math.min(...parts.map((p) => p.x));
  const y0 = Math.min(...parts.map((p) => p.y));
  const x1 = Math.max(...parts.map((p) => p.x + p.w));
  const y1 = Math.max(...parts.map((p) => p.y + p.h));
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}

/** The contact (mm) of slot `index` of an FPC, in boardPins' slot order. */
export function fpcContact(fpc: FpcContacts, index: number): { x: number; y: number } {
  const contact = fpc.slotsReversed ? fpc.count - index : index + 1;
  return { x: fpc.pin1.x + (contact - 1) * fpc.step.x, y: fpc.pin1.y + (contact - 1) * fpc.step.y };
}

export type FpcPinArt = { side: 'analog' | 'digital'; index: number; slot: BoardPinSlot; x: number; y: number };

/** Every slot of both FPCs with its contact position. */
export function boardArtPins(art: BoardArt, hardwareModel: string | null | undefined): FpcPinArt[] {
  const pins = boardPinsFor(hardwareModel);
  const out: FpcPinArt[] = [];
  pins.analogPinSlots.forEach((slot, index) => out.push({ side: 'analog', index, slot, ...fpcContact(art.analogFpc, index) }));
  pins.digitalPinSlots.forEach((slot, index) => out.push({ side: 'digital', index, slot, ...fpcContact(art.digitalFpc, index) }));
  return out;
}

// -- callout layout -----------------------------------------------------------

export type CalloutSpec = {
  id: string;
  /** A part to point at, or `anchor` (mm) for any other point, such as one FPC contact. */
  target?: BoardArtTarget;
  anchor?: { x: number; y: number };
  side?: 'left' | 'right';
  /** More parts the same label points at (one callout for something that spans parts, like a matrix on both FPCs). */
  branches?: readonly BoardArtTarget[];
};

export type CalloutLayoutOptions = {
  /** Width (px) of the whole diagram. */
  width: number;
  /** Width (px) of each label column; the board gets the rest. */
  labelWidth: number;
  /** Height (px) one label takes. */
  labelHeight: number;
  /** Gap (px) between the label columns and the board. */
  gap?: number;
  /** The board's tallest size (px). */
  maxBoardHeight: number;
  /** Space (px) kept free above and below. */
  padding?: number;
};

export type CalloutLabelBox = { id: string; side: 'left' | 'right'; x: number; y: number; w: number; h: number };
export type CalloutBranch = { points: readonly [number, number][]; anchor: [number, number] };
export type CalloutLeader = {
  id: string;
  points: readonly [number, number][];
  anchor: [number, number];
  /** Extra lines (spec.branches) leaving from the leader's bend at the board edge. */
  branches: CalloutBranch[];
};

export type CalloutLayout = {
  width: number;
  height: number;
  /** The drawing goes at (x, y) scaled by `scale` px/mm, with the bounds' corner at (x, y). */
  board: { x: number; y: number; scale: number; bounds: { x: number; y: number; width: number; height: number } };
  labels: CalloutLabelBox[];
  leaders: CalloutLeader[];
};

/** Spreads boxes of height h near their wanted y without overlap, inside [top, bottom]. */
export function spreadLabels(wanted: readonly number[], h: number, top: number, bottom: number): number[] {
  const order = wanted.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const ys = order.map((item) => Math.max(top, item.y - h / 2));
  for (let k = 1; k < ys.length; k++) ys[k] = Math.max(ys[k]!, ys[k - 1]! + h);
  // Too low at the end: push back up from the bottom.
  if (ys.length && ys[ys.length - 1]! + h > bottom) {
    ys[ys.length - 1] = bottom - h;
    for (let k = ys.length - 2; k >= 0; k--) ys[k] = Math.min(ys[k]!, ys[k + 1]! - h);
  }
  const out = new Array<number>(wanted.length);
  order.forEach((item, k) => (out[item.i] = ys[k]!));
  return out;
}

/**
 * Where the board, the labels and their leader lines go for a diagram
 * `width` px wide: labels in a column each side, each placed level with the
 * part it points at as far as they fit, joined by a line that runs level from
 * the label to the board's edge and then straight to the part. Callouts whose
 * target the board lacks are left out.
 */
export function calloutLayout(art: BoardArt, specs: readonly CalloutSpec[], options: CalloutLayoutOptions): CalloutLayout {
  const gap = options.gap ?? 16;
  const padding = options.padding ?? 8;
  const bounds = boardArtBounds(art);
  const room = Math.max(40, options.width - 2 * (options.labelWidth + gap));
  const scale = Math.min(room / bounds.width, options.maxBoardHeight / bounds.height);
  const boardW = bounds.width * scale;
  const boardH = bounds.height * scale;
  const centre = bounds.x + bounds.width / 2;

  const placed = specs
    .map((spec) => ({ spec, anchor: spec.anchor ?? (spec.target ? boardArtAnchor(art, spec.target) : null) }))
    .filter((item): item is { spec: CalloutSpec; anchor: { x: number; y: number } } => item.anchor !== null)
    .map((item) => ({ ...item, side: item.spec.side ?? (item.anchor.x < centre ? 'left' : 'right') }) as { spec: CalloutSpec; anchor: { x: number; y: number }; side: 'left' | 'right' });
  // Balance the columns: move the free callouts nearest the middle across.
  for (;;) {
    const left = placed.filter((p) => p.side === 'left').length;
    const right = placed.length - left;
    if (Math.abs(left - right) <= 1) break;
    const heavy = left > right ? 'left' : 'right';
    const movable = placed.filter((p) => p.side === heavy && !p.spec.side).sort((a, b) => Math.abs(a.anchor.x - centre) - Math.abs(b.anchor.x - centre));
    if (!movable.length) break;
    movable[0]!.side = heavy === 'left' ? 'right' : 'left';
  }
  const perSide = Math.max(placed.filter((p) => p.side === 'left').length, placed.filter((p) => p.side === 'right').length);
  const height = Math.max(boardH, perSide * options.labelHeight) + 2 * padding;
  const board = { x: (options.width - boardW) / 2, y: (height - boardH) / 2, scale, bounds };
  const toPx = (p: { x: number; y: number }): [number, number] => [board.x + (p.x - bounds.x) * scale, board.y + (p.y - bounds.y) * scale];

  const labels: CalloutLabelBox[] = [];
  const leaders: CalloutLeader[] = [];
  for (const side of ['left', 'right'] as const) {
    const items = placed.filter((p) => p.side === side);
    const ys = spreadLabels(items.map((item) => toPx(item.anchor)[1]), options.labelHeight, padding, height - padding);
    items.forEach((item, k) => {
      const x = side === 'left' ? 0 : options.width - options.labelWidth;
      const y = ys[k]!;
      labels.push({ id: item.spec.id, side, x, y, w: options.labelWidth, h: options.labelHeight });
      const anchor = toPx(item.anchor);
      const startX = side === 'left' ? x + options.labelWidth : x;
      // The line leaves the label at its title's height (the upper third).
      const startY = y + options.labelHeight * 0.32;
      const edgeX = side === 'left' ? board.x - gap / 2 : board.x + boardW + gap / 2;
      // A branch splits off at the bend: along the board edge to its part's
      // height, then level across to it.
      const branches = (item.spec.branches ?? [])
        .map((target) => boardArtAnchor(art, target))
        .filter((point): point is { x: number; y: number } => point !== null)
        .map((point) => {
          const to = toPx(point);
          return { points: [[edgeX, startY], [edgeX, to[1]], to] as [number, number][], anchor: to };
        });
      // With branches the main line bends the same way, so the lines run
      // level from the edge, one after the other.
      const points: [number, number][] = branches.length ? [[startX, startY], [edgeX, startY], [edgeX, anchor[1]], anchor] : [[startX, startY], [edgeX, startY], anchor];
      leaders.push({ id: item.spec.id, points, anchor, branches });
    });
  }
  return { width: options.width, height, board, labels, leaders };
}
