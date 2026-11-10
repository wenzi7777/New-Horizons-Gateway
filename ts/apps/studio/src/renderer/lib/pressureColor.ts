// The pressure colour scale, ported from the Desktop
// (New-Horizons-Desktop/frontend/src/lib/pressureColor.ts) so a cell looks
// the same in NH Studio as on the Desktop's Visualization page. With the
// brand mark, these are the only hard-coded colours in the renderer: the
// scale is data, not theme.

export type PressureRange = { min: number; max: number };

/** The Desktop Visualization's default range and its presets (VisualizationPage.tsx). */
export const DEFAULT_RANGE: PressureRange = { min: 300, max: 3150 };
export const RANGE_PRESETS: readonly PressureRange[] = [DEFAULT_RANGE, { min: 300, max: 4990 }];

/** Index of a preset equal to `range`, or -1 (the Desktop's presetIndexForRange). */
export function presetIndexForRange(range: PressureRange): number {
  return RANGE_PRESETS.findIndex((preset) => preset.min === range.min && preset.max === range.max);
}

export function valueRatio(value: number, range: PressureRange): number {
  const span = Math.max(range.max - range.min, 1);
  return Math.max(0, Math.min(1, (value - range.min) / span));
}

/** Hue (deg), saturation and lightness (%) for a value, exactly as the Desktop. */
export function hslForValue(value: number, range: PressureRange): { h: number; s: number; l: number } {
  const ratio = valueRatio(value, range);
  return { h: 154 - ratio * 108, s: 58, l: 78 - ratio * 30 };
}

/** The Desktop's CSS colour string. */
export function cssColorForValue(value: number, range: PressureRange): string {
  const { h, s, l } = hslForValue(value, range);
  return `hsl(${h}deg ${s}% ${l}%)`;
}

/** HSL to linear-free sRGB 0..1 channels (for three.js vertex colours). */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [channel(0), channel(8), channel(4)];
}

export function rgbForValue(value: number, range: PressureRange): [number, number, number] {
  const { h, s, l } = hslForValue(value, range);
  return hslToRgb(h, s, l);
}

/** A sanitised custom range: finite, min < max, within the sensor's 0..4990. */
export function clampRange(min: number, max: number): PressureRange | null {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const lo = Math.max(0, Math.min(4990, Math.round(min)));
  const hi = Math.max(0, Math.min(4990, Math.round(max)));
  return hi > lo ? { min: lo, max: hi } : null;
}
