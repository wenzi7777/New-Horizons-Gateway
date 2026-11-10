// Pure helpers of the Desktop's Visualization page (New-Horizons-Desktop
// pages/VisualizationPage.tsx): row/column mirroring, the centre of pressure,
// and the bilinear interpolation its 3D surface uses.

export const COP_OFFSET = 250;
export const SURFACE_INTERPOLATION_STEPS = 3;
export const VISUAL_SURFACE_MAX_INTERPOLATED_POINTS = 1800;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
function finite(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Row-major values with rows and/or columns reversed (the Desktop's Row/Col Mirror). */
export function mirrorValues(values: readonly number[], rows: number, cols: number, rowMirror: boolean, colMirror: boolean): number[] {
  if (!rowMirror && !colMirror) return [...values];
  const out = new Array<number>(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sr = rowMirror ? rows - 1 - r : r;
      const sc = colMirror ? cols - 1 - c : c;
      out[r * cols + c] = finite(values[sr * cols + sc]);
    }
  }
  return out;
}

export type Cop = { x: number; y: number; xRatio: number; yRatio: number; hasData: boolean };

/** Centre of pressure over a rows×cols grid, weights = value − COP_OFFSET (as the Desktop). */
export function computeCop(values: readonly number[], rows: number, cols: number): Cop {
  let wx = 0;
  let wy = 0;
  let total = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const adjusted = finite(values[r * cols + c], NaN) - COP_OFFSET;
      if (!Number.isFinite(adjusted) || adjusted <= 0) continue;
      wx += (cols > 1 ? c / (cols - 1) : 0.5) * adjusted;
      wy += (rows > 1 ? r / (rows - 1) : 0.5) * adjusted;
      total += adjusted;
    }
  }
  if (total <= 0) return { x: 0, y: 0, xRatio: 0.5, yRatio: 0.5, hasData: false };
  const xRatio = wx / total;
  const yRatio = wy / total;
  return { x: xRatio * Math.max(cols - 1, 1), y: yRatio * Math.max(rows - 1, 1), xRatio: clamp(xRatio, 0, 1), yRatio: clamp(yRatio, 0, 1), hasData: true };
}

export function surfaceInterpolationSteps(rows: number, cols: number): number {
  for (let steps = SURFACE_INTERPOLATION_STEPS; steps > 1; steps -= 1) {
    if (((rows - 1) * steps + 1) * ((cols - 1) * steps + 1) <= VISUAL_SURFACE_MAX_INTERPOLATED_POINTS) return steps;
  }
  return 1;
}

/** Bilinear upsampling for the 3D surface: (rows−1)·steps+1 × (cols−1)·steps+1. */
export function interpolateGrid(values: readonly number[], rows: number, cols: number, steps = surfaceInterpolationSteps(rows, cols)): { values: number[]; rows: number; cols: number } {
  if (steps <= 1 || rows < 2 || cols < 2) return { values: [...values], rows, cols };
  const outRows = (rows - 1) * steps + 1;
  const outCols = (cols - 1) * steps + 1;
  const at = (r: number, c: number) => finite(values[r * cols + c]);
  const out = new Array<number>(outRows * outCols);
  for (let r = 0; r < outRows; r++) {
    const sr = r / steps;
    const r0 = Math.min(Math.floor(sr), rows - 1);
    const r1 = Math.min(r0 + 1, rows - 1);
    const fr = sr - r0;
    for (let c = 0; c < outCols; c++) {
      const sc = c / steps;
      const c0 = Math.min(Math.floor(sc), cols - 1);
      const c1 = Math.min(c0 + 1, cols - 1);
      const fc = sc - c0;
      const top = at(r0, c0) + (at(r0, c1) - at(r0, c0)) * fc;
      const bottom = at(r1, c0) + (at(r1, c1) - at(r1, c0)) * fc;
      out[r * outCols + c] = top + (bottom - top) * fr;
    }
  }
  return { values: out, rows: outRows, cols: outCols };
}
