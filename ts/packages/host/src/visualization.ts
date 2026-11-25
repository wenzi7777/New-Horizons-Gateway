// Pure helpers of the Desktop's Visualization card (New-Horizons-Desktop
// pages/VisualizationPage.tsx), shared by NH Studio's Live page and NH
// Pocket's live screen: the grid transform (Transpose + Row/Col Mirror), the
// centre of pressure, the bilinear interpolation of the 3D surface and the
// surface's geometry.

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

export type GridTransform = { rowMirror: boolean; colMirror: boolean; transpose: boolean };

export const NO_TRANSFORM: GridTransform = { rowMirror: false, colMirror: false, transpose: false };

export type TransformedGrid = {
  /** Row-major values as drawn. */
  values: number[];
  /** Rows and columns as drawn (swapped by Transpose). */
  rows: number;
  cols: number;
  /** indices[i]: the stream (row-major) index drawn at display cell i -- its P number. */
  indices: number[];
};

/**
 * Lays a rows×cols stream out on screen. Transpose swaps the axes first, then
 * Row / Col Mirror flip what is drawn (top-bottom / left-right), so the
 * mirrors always act on the picture. Together they give the square's 8
 * symmetries (Transpose + Col Mirror = a quarter turn clockwise). The
 * Desktop's lib/matrixTransform.ts follows the same rule.
 */
export function transformGrid(values: readonly number[], rows: number, cols: number, transform: GridTransform): TransformedGrid {
  const { rowMirror, colMirror, transpose } = transform;
  const dispRows = transpose ? cols : rows;
  const dispCols = transpose ? rows : cols;
  const out = new Array<number>(dispRows * dispCols);
  const indices = new Array<number>(dispRows * dispCols);
  for (let r = 0; r < dispRows; r++) {
    for (let c = 0; c < dispCols; c++) {
      const rr = rowMirror ? dispRows - 1 - r : r;
      const cc = colMirror ? dispCols - 1 - c : c;
      const source = (transpose ? cc : rr) * cols + (transpose ? rr : cc);
      indices[r * dispCols + c] = source;
      out[r * dispCols + c] = finite(values[source]);
    }
  }
  return { values: out, rows: dispRows, cols: dispCols, indices };
}

/** Row-major values with rows and/or columns reversed (the Desktop's Row/Col Mirror). */
export function mirrorValues(values: readonly number[], rows: number, cols: number, rowMirror: boolean, colMirror: boolean): number[] {
  return transformGrid(values, rows, cols, { rowMirror, colMirror, transpose: false }).values;
}

/** The row (A..) and column (D..) pin labels of the drawn grid. */
export function transformPinLabels(
  labels: { rows: readonly string[]; cols: readonly string[] },
  transform: GridTransform,
): { rows: string[]; cols: string[] } {
  const rows = transform.transpose ? [...labels.cols] : [...labels.rows];
  const cols = transform.transpose ? [...labels.rows] : [...labels.cols];
  return { rows: transform.rowMirror ? rows.reverse() : rows, cols: transform.colMirror ? cols.reverse() : cols };
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

/**
 * Centre of pressure over placed points (the Desktop's computeCop over its
 * display points): a profile's sensors at their own positions. x / y are in
 * grid units of rows×cols like computeCop's.
 */
export function computePointsCop(points: readonly { value: number; xRatio: number; yRatio: number }[], rows: number, cols: number): Cop {
  let wx = 0;
  let wy = 0;
  let total = 0;
  for (const point of points) {
    const adjusted = point.value - COP_OFFSET;
    if (!Number.isFinite(adjusted) || adjusted <= 0) continue;
    wx += point.xRatio * adjusted;
    wy += point.yRatio * adjusted;
    total += adjusted;
  }
  if (total <= 0) return { x: 0, y: 0, xRatio: 0.5, yRatio: 0.5, hasData: false };
  const xRatio = wx / total;
  const yRatio = wy / total;
  return { x: xRatio * Math.max(cols - 1, 1), y: yRatio * Math.max(rows - 1, 1), xRatio: clamp(xRatio, 0, 1), yRatio: clamp(yRatio, 0, 1), hasData: true };
}

/**
 * A profile with its sensors' positions mirrored (the Desktop flips a
 * profile's points, x → 1−x / y → 1−y, and keeps each sensor's value).
 * Transpose does not apply to a profile: it places its sensors itself.
 */
export function mirrorProfileSensors<P extends { sensors: readonly { x: number; y: number }[] }>(profile: P, rowMirror: boolean, colMirror: boolean): P {
  if (!rowMirror && !colMirror) return profile;
  return {
    ...profile,
    sensors: profile.sensors.map((s) => (s ? { ...s, x: colMirror ? 1 - Number(s.x) : s.x, y: rowMirror ? 1 - Number(s.y) : s.y } : s)),
  };
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

/**
 * Positions (x, height, z) and colours for a rows×cols surface, plus its
 * triangle indices. `ratio` maps a value to 0..1 height, `rgb` to 0..1 colour
 * channels (each app's pressure scale).
 */
export function surfaceGeometry(
  values: readonly number[],
  rows: number,
  cols: number,
  ratio: (value: number) => number,
  rgb: (value: number) => readonly [number, number, number],
  fallbackValue = 0,
): { positions: Float32Array; colors: Float32Array; indices: number[] } {
  const scale = Math.max(rows, cols, 1);
  const width = cols / scale;
  const depth = rows / scale;
  const positions = new Float32Array(rows * cols * 3);
  const colors = new Float32Array(rows * cols * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const value = values[i] ?? fallbackValue;
      positions[i * 3] = (cols === 1 ? 0 : c / (cols - 1) - 0.5) * width * 2;
      positions[i * 3 + 1] = ratio(value) * 0.6;
      positions[i * 3 + 2] = (rows === 1 ? 0 : r / (rows - 1) - 0.5) * depth * 2;
      const [red, green, blue] = rgb(value);
      colors[i * 3] = red;
      colors[i * 3 + 1] = green;
      colors[i * 3 + 2] = blue;
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }
  return { positions, colors, indices };
}

/** "x, y, z" with two decimals, or "-" (the Desktop's Gyro / Acc readout). */
export function formatVector(value: readonly number[] | null | undefined): string {
  if (!value || value.length < 3) return '-';
  return value
    .slice(0, 3)
    .map((v) => Number(v).toFixed(2))
    .join(', ');
}
