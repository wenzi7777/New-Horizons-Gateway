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

export function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return `#${hex(channel(0))}${hex(channel(8))}${hex(channel(4))}`;
}

export function colorForValue(value: number, range: PressureRange): string {
  const { h, s, l } = hslForValue(value, range);
  return hslToHex(h, s, l);
}

/** Cell label ink on the scale (the Desktop draws labels in a dark ink on every cell). */
export const CELL_INK = 'rgba(16, 19, 23, 0.62)';
