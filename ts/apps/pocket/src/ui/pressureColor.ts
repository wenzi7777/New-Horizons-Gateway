// The pressure colour scale, ported from the Desktop
// (New-Horizons-Desktop/frontend/src/lib/pressureColor.ts) so a cell looks
// the same on the phone as on the Visualization page. The Desktop writes
// `hsl(Hdeg 58% L%)`; react-native-svg wants a plain colour, so the same
// HSL is converted to #rrggbb here. These are the only hard-coded colours in
// the app: the scale is data, not theme.

export type PressureRange = { min: number; max: number };

/** The Desktop Visualization's default range and its presets (VisualizationPage.tsx). */
export const DEFAULT_RANGE: PressureRange = { min: 300, max: 3150 };
export const RANGE_PRESETS: readonly PressureRange[] = [DEFAULT_RANGE, { min: 300, max: 4990 }];

export function valueRatio(value: number, range: PressureRange): number {
  const span = Math.max(range.max - range.min, 1);
  return Math.max(0, Math.min(1, (value - range.min) / span));
}

/** Hue (deg), saturation and lightness (%) for a value, exactly as the Desktop. */
export function hslForValue(value: number, range: PressureRange): { h: number; s: number; l: number } {
  const ratio = valueRatio(value, range);
  return { h: 154 - ratio * 108, s: 58, l: 78 - ratio * 30 };
}

/** The Desktop's CSS string, kept for comparison in tests. */
export function cssColorForValue(value: number, range: PressureRange): string {
  const { h, s, l } = hslForValue(value, range);
  return `hsl(${h}deg ${s}% ${l}%)`;
}

/** HSL to sRGB 0..1 channels (three.js vertex colours), as NH Studio. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [channel(0), channel(8), channel(4)];
}

export function hslToHex(h: number, s: number, l: number): string {
  const hex = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  const [r, g, b] = hslToRgb(h, s, l);
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function rgbForValue(value: number, range: PressureRange): [number, number, number] {
  const { h, s, l } = hslForValue(value, range);
  return hslToRgb(h, s, l);
}

export function colorForValue(value: number, range: PressureRange): string {
  const { h, s, l } = hslForValue(value, range);
  return hslToHex(h, s, l);
}

/** Cell label ink on the scale (the Desktop draws labels in a dark ink on every cell). */
export const CELL_INK = 'rgba(16, 19, 23, 0.62)';

/** Colour steps a live map draws (the scale is smooth to the eye well before this). */
export const COLOR_STEPS = 64;
const stepCache = new Map<string, string[]>();

/**
 * colorForValue rounded to one of COLOR_STEPS steps, from a per-range table:
 * a cell whose value moved within its step keeps the same string, so it is
 * not redrawn.
 */
export function quantizedColor(value: number, range: PressureRange): string {
  const key = `${range.min}:${range.max}`;
  let table = stepCache.get(key);
  if (!table) {
    const span = Math.max(range.max - range.min, 1);
    table = Array.from({ length: COLOR_STEPS }, (_, i) => colorForValue(range.min + (span * i) / (COLOR_STEPS - 1), range));
    stepCache.set(key, table);
  }
  const step = Math.round(valueRatio(value, range) * (COLOR_STEPS - 1));
  return table[step] ?? table[0]!;
}
