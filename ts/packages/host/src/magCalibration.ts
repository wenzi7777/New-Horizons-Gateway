// Magnetometer hard/soft-iron calibration: the fitting, the coverage the
// wizard shows while the device is turned, and when to redo it.
//
//   m_cal = M · (m_raw − b)
//
// b (µT) is the field the device itself carries -- parts, battery, enclosure,
// screws -- and M (3×3, row-major, symmetric) undoes the stretching that
// turns the sphere of the earth's field into an ellipsoid. Both move with
// the device, so they hold until the mounting changes; fields from the room
// (a steel desk, a motor) do not move with it and no calibration removes
// them. The firmware applies M and b (MagCalibration.h) to every sample, so
// the stream already carries calibrated values: a new fit is made on those
// and composed with the one in use (composeCalibration), never on raw data.
//
// Pure, no dependencies. The Desktop keeps a byte-identical copy in
// frontend/src/lib/magCalibration.ts; both are tested with the same cases.

export type MagVec = [number, number, number];
export type MagCalibrationMode = 'none' | 'hard_iron' | 'full';

export interface MagCalibration {
  mode: MagCalibrationMode;
  /** Hard-iron offset, µT. */
  offset: MagVec;
  /** Soft-iron matrix, row-major. */
  matrix: number[];
  /** Fitted field strength, µT. */
  fieldUt: number;
  /** std(|m_cal|) / mean(|m_cal|) × 100 over the fitted points. */
  residualPct: number;
}

export const IDENTITY3: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const MAG_CAL_MIN_POINTS = 100;
export const MAG_CAL_FULL_MIN_POINTS = 300;
export const MAG_CAL_FULL_MIN_COVERAGE = 0.7;
export const MAG_CAL_HARD_MIN_COVERAGE = 0.25;
export const MAG_CAL_MAX_POINTS = 2000;
/** Above this the wizard warns and suggests redoing it. */
export const MAG_CAL_RESIDUAL_WARN_PCT = 5;
/** Days before expiry when the reminder starts. */
export const MAG_CAL_SOON_DAYS = 3;
export const MAG_CAL_INTERVAL_CHOICES = [7, 14, 30, 90, 0] as const;
/** Roughly the earth's field at Aizu (IGRF), for the result screen. */
export const MAG_REFERENCE_FIELD_UT = 47;

// The firmware's own limits (MagCalibration.h); a fit outside them would be
// refused by set_mag_calibration, so it is never offered.
const MAX_OFFSET_UT = 500;
const MAX_MATRIX_ENTRY = 10;
const MAX_CONDITION_ESTIMATE = 30;
const MAX_FIELD_UT = 200;

// ---------------------------------------------------------------- linear algebra

function det3(m: readonly number[]): number {
  return (
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
    m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)
  );
}

export function invert3(m: readonly number[]): number[] | null {
  const d = det3(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  const i = 1 / d;
  return [
    (m[4]! * m[8]! - m[5]! * m[7]!) * i,
    (m[2]! * m[7]! - m[1]! * m[8]!) * i,
    (m[1]! * m[5]! - m[2]! * m[4]!) * i,
    (m[5]! * m[6]! - m[3]! * m[8]!) * i,
    (m[0]! * m[8]! - m[2]! * m[6]!) * i,
    (m[2]! * m[3]! - m[0]! * m[5]!) * i,
    (m[3]! * m[7]! - m[4]! * m[6]!) * i,
    (m[1]! * m[6]! - m[0]! * m[7]!) * i,
    (m[0]! * m[4]! - m[1]! * m[3]!) * i,
  ];
}

export function multiply3(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out;
}

function mulVec(m: readonly number[], v: readonly number[]): MagVec {
  return [
    m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!,
    m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!,
    m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!,
  ];
}

function frobenius(m: readonly number[]): number {
  return Math.sqrt(m.reduce((sum, v) => sum + v * v, 0));
}

/** Eigen-decomposition of a symmetric 3×3 (Jacobi). Columns of `vectors` are the eigenvectors. */
export function symmetricEigen3(m: readonly number[]): { values: MagVec; vectors: number[] } {
  const a = [...m];
  const v = [...IDENTITY3];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[1]!) + Math.abs(a[2]!) + Math.abs(a[5]!);
    if (off < 1e-14) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p * 3 + q]!;
      if (Math.abs(apq) < 1e-300) continue;
      const app = a[p * 3 + p]!;
      const aqq = a[q * 3 + q]!;
      const theta = (aqq - app) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p]!;
        const akq = a[k * 3 + q]!;
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k]!;
        const aqk = a[q * 3 + k]!;
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p]!;
        const vkq = v[k * 3 + q]!;
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0]!, a[4]!, a[8]!], vectors: v };
}

/** Solve the n×n system A x = b (Gaussian elimination, partial pivoting); null when singular. */
function solve(aIn: number[][], bIn: number[]): number[] | null {
  const n = bIn.length;
  const a = aIn.map((row) => [...row]);
  const b = [...bIn];
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    if (Math.abs(a[pivot]![col]!) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    for (let r = col + 1; r < n; r++) {
      const f = a[r]![col]! / a[col]![col]!;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r]![c] = a[r]![c]! - f * a[col]![c]!;
      b[r] = b[r]! - f * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r]!;
    for (let c = r + 1; c < n; c++) sum -= a[r]![c]! * x[c]!;
    x[r] = sum / a[r]![r]!;
  }
  return x.every(Number.isFinite) ? x : null;
}

/** Least squares: rows of `design` · x ≈ `target`, via the normal equations (inputs centred and scaled by the caller). */
function leastSquares(design: number[][], target: number[]): number[] | null {
  const n = design[0]?.length ?? 0;
  const ata = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const atb = new Array<number>(n).fill(0);
  for (let i = 0; i < design.length; i++) {
    const row = design[i]!;
    for (let r = 0; r < n; r++) {
      atb[r] = atb[r]! + row[r]! * target[i]!;
      for (let c = r; c < n; c++) ata[r]![c] = ata[r]![c]! + row[r]! * row[c]!;
    }
  }
  for (let r = 0; r < n; r++) for (let c = 0; c < r; c++) ata[r]![c] = ata[c]![r]!;
  return solve(ata, atb);
}

// ---------------------------------------------------------------- applying

export function applyCalibration(cal: Pick<MagCalibration, 'mode' | 'offset' | 'matrix'>, raw: readonly number[]): MagVec {
  if (cal.mode === 'none') return [raw[0]!, raw[1]!, raw[2]!];
  return mulVec(cal.matrix, [raw[0]! - cal.offset[0], raw[1]! - cal.offset[1], raw[2]! - cal.offset[2]]);
}

function magnitudeStats(points: readonly MagVec[]): { mean: number; residualPct: number } {
  if (!points.length) return { mean: 0, residualPct: 0 };
  const norms = points.map((p) => Math.hypot(p[0], p[1], p[2]));
  const mean = norms.reduce((s, v) => s + v, 0) / norms.length;
  const variance = norms.reduce((s, v) => s + (v - mean) ** 2, 0) / norms.length;
  return { mean, residualPct: mean > 0 ? (Math.sqrt(variance) / mean) * 100 : 0 };
}

/** How round the cloud is after `cal`: mean |m| and its spread in percent. */
export function residualOf(cal: Pick<MagCalibration, 'mode' | 'offset' | 'matrix'>, points: readonly MagVec[]): { meanUt: number; residualPct: number } {
  const { mean, residualPct } = magnitudeStats(points.map((p) => applyCalibration(cal, p)));
  return { meanUt: mean, residualPct };
}

// ---------------------------------------------------------------- fitting

function centroidAndScale(points: readonly MagVec[]): { c: MagVec; s: number } {
  const c: MagVec = [0, 0, 0];
  for (const p of points) for (let k = 0; k < 3; k++) c[k] = c[k]! + p[k]! / points.length;
  let s = 0;
  for (const p of points) s = Math.max(s, Math.abs(p[0] - c[0]), Math.abs(p[1] - c[1]), Math.abs(p[2] - c[2]));
  return { c, s: s > 0 ? s : 1 };
}

/** Hard iron only: the best sphere. Null when the points cannot define one. */
export function fitSphere(points: readonly MagVec[]): MagCalibration | null {
  if (points.length < 4) return null;
  const { c, s } = centroidAndScale(points);
  // |q|² = 2 a·q + d, q = (p − c)/s.
  const design: number[][] = [];
  const target: number[] = [];
  for (const p of points) {
    const q = [(p[0] - c[0]) / s, (p[1] - c[1]) / s, (p[2] - c[2]) / s];
    design.push([2 * q[0]!, 2 * q[1]!, 2 * q[2]!, 1]);
    target.push(q[0]! ** 2 + q[1]! ** 2 + q[2]! ** 2);
  }
  const x = leastSquares(design, target);
  if (!x) return null;
  const r2 = x[3]! + x[0]! ** 2 + x[1]! ** 2 + x[2]! ** 2;
  if (!(r2 > 0)) return null;
  const offset: MagVec = [c[0] + x[0]! * s, c[1] + x[1]! * s, c[2] + x[2]! * s];
  const cal: MagCalibration = { mode: 'hard_iron', offset, matrix: [...IDENTITY3], fieldUt: Math.sqrt(r2) * s, residualPct: 0 };
  const stats = residualOf(cal, points);
  cal.residualPct = stats.residualPct;
  return cal;
}

/**
 * Hard and soft iron: the best ellipsoid, then the symmetric matrix that maps
 * it onto a sphere of the same volume (so the output stays in µT and keeps
 * the fitted field strength). Null when the points do not define a closed
 * ellipsoid -- too few directions covered.
 */
export function fitEllipsoid(points: readonly MagVec[]): MagCalibration | null {
  if (points.length < 9) return null;
  const { c, s } = centroidAndScale(points);
  // a x² + b y² + c z² + 2d xy + 2e xz + 2f yz + 2g x + 2h y + 2i z = 1
  const design: number[][] = [];
  const target: number[] = [];
  for (const p of points) {
    const x = (p[0] - c[0]) / s;
    const y = (p[1] - c[1]) / s;
    const z = (p[2] - c[2]) / s;
    design.push([x * x, y * y, z * z, 2 * x * y, 2 * x * z, 2 * y * z, 2 * x, 2 * y, 2 * z]);
    target.push(1);
  }
  const v = leastSquares(design, target);
  if (!v) return null;
  const A = [v[0]!, v[3]!, v[4]!, v[3]!, v[1]!, v[5]!, v[4]!, v[5]!, v[2]!];
  const Ainv = invert3(A);
  if (!Ainv) return null;
  const centre = mulVec(Ainv, [-v[6]!, -v[7]!, -v[8]!]);
  const k = 1 + (centre[0] * (A[0]! * centre[0] + A[1]! * centre[1] + A[2]! * centre[2]) +
    centre[1] * (A[3]! * centre[0] + A[4]! * centre[1] + A[5]! * centre[2]) +
    centre[2] * (A[6]! * centre[0] + A[7]! * centre[1] + A[8]! * centre[2]));
  if (!(k > 0)) return null;
  const shape = A.map((a) => a / k);  // (q − centre)ᵀ shape (q − centre) = 1
  const { values, vectors } = symmetricEigen3(shape);
  if (!values.every((l) => l > 0 && Number.isFinite(l))) return null;
  // sqrt(shape) maps the ellipsoid onto the unit sphere; scale by the
  // geometric-mean radius so the volume (and the field strength) is kept.
  const radius = 1 / Math.cbrt(Math.sqrt(values[0]) * Math.sqrt(values[1]) * Math.sqrt(values[2]));
  const sqrtL = values.map((l) => Math.sqrt(l) * radius);
  const matrix = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0;
      for (let e = 0; e < 3; e++) sum += vectors[r * 3 + e]! * sqrtL[e]! * vectors[col * 3 + e]!;
      matrix[r * 3 + col] = sum;
    }
  }
  const offset: MagVec = [c[0] + centre[0] * s, c[1] + centre[1] * s, c[2] + centre[2] * s];
  const cal: MagCalibration = { mode: 'full', offset, matrix, fieldUt: radius * s, residualPct: 0 };
  const stats = residualOf(cal, points);
  cal.residualPct = stats.residualPct;
  return cal;
}

/** Null when the firmware would accept it; otherwise why not (the firmware's error names). */
export function calibrationProblem(cal: MagCalibration): string | null {
  if (cal.mode === 'none') return null;
  const nums = [...cal.offset, ...cal.matrix, cal.fieldUt, cal.residualPct];
  if (!nums.every(Number.isFinite)) return 'mag_calibration_not_finite';
  if (cal.offset.some((o) => Math.abs(o) > MAX_OFFSET_UT)) return 'mag_calibration_offset_too_large';
  if (cal.matrix.some((m) => Math.abs(m) > MAX_MATRIX_ENTRY)) return 'mag_calibration_matrix_too_large';
  if (!(cal.fieldUt > 0) || cal.fieldUt > MAX_FIELD_UT) return 'mag_calibration_field_out_of_range';
  if (!(det3(cal.matrix) > 1e-6)) return 'mag_calibration_matrix_singular';
  const inv = invert3(cal.matrix);
  if (!inv) return 'mag_calibration_matrix_singular';
  if (frobenius(cal.matrix) * frobenius(inv) > MAX_CONDITION_ESTIMATE) return 'mag_calibration_matrix_ill_conditioned';
  return null;
}

/**
 * The calibration to store when `fit` was made on samples already calibrated
 * by `current`:  M' = M_fit · M_cur,  b' = b_cur + M_cur⁻¹ · b_fit.
 */
export function composeCalibration(current: MagCalibration | null, fit: MagCalibration): MagCalibration {
  if (!current || current.mode === 'none') return { ...fit, offset: [...fit.offset] as MagVec, matrix: [...fit.matrix] };
  const curInv = invert3(current.matrix) ?? [...IDENTITY3];
  const shift = mulVec(curInv, fit.offset);
  const mode: MagCalibrationMode = fit.mode === 'full' || current.mode === 'full' ? 'full' : 'hard_iron';
  return {
    mode,
    offset: [current.offset[0] + shift[0], current.offset[1] + shift[1], current.offset[2] + shift[2]],
    matrix: mode === 'hard_iron' ? [...IDENTITY3] : multiply3(fit.matrix, current.matrix),
    fieldUt: fit.fieldUt,
    residualPct: fit.residualPct,
  };
}

// ---------------------------------------------------------------- coverage

/** The 26 directions the coverage sphere is split into (cube faces, edges and corners). */
export const COVERAGE_DIRECTIONS: readonly MagVec[] = (() => {
  const out: MagVec[] = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
    if (!x && !y && !z) continue;
    const n = Math.hypot(x, y, z);
    out.push([x / n, y / n, z / n]);
  }
  return out;
})();

export type MagFace = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export const MAG_FACES: readonly MagFace[] = ['+z', '-z', '+x', '-x', '+y', '-y'];
const FACE_AXIS: Record<MagFace, MagVec> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };

export interface MagCoverage {
  /** Points per direction, in COVERAGE_DIRECTIONS order. */
  counts: number[];
  covered: boolean[];
  /** Covered directions / 26. */
  fraction: number;
  /** The face whose directions are least covered: where to turn next. Null when all are covered. */
  nextFace: MagFace | null;
  centre: MagVec;
}

const POINTS_PER_DIRECTION = 2;

/** Which directions the field has been seen from, around the cloud's bounding-box centre. */
export function coverageOf(points: readonly MagVec[]): MagCoverage {
  const counts = new Array<number>(COVERAGE_DIRECTIONS.length).fill(0);
  let centre: MagVec = [0, 0, 0];
  if (points.length) {
    const lo: MagVec = [Infinity, Infinity, Infinity];
    const hi: MagVec = [-Infinity, -Infinity, -Infinity];
    for (const p of points) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, p[k]!); hi[k] = Math.max(hi[k]!, p[k]!); }
    centre = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    for (const p of points) {
      const d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
      const n = Math.hypot(d[0]!, d[1]!, d[2]!);
      if (!(n > 0)) continue;
      let best = 0;
      let bestDot = -Infinity;
      COVERAGE_DIRECTIONS.forEach((dir, i) => {
        const dot = (dir[0] * d[0]! + dir[1] * d[1]! + dir[2] * d[2]!) / n;
        if (dot > bestDot) { bestDot = dot; best = i; }
      });
      counts[best] = counts[best]! + 1;
    }
  }
  const covered = counts.map((c) => c >= POINTS_PER_DIRECTION);
  const fraction = covered.filter(Boolean).length / COVERAGE_DIRECTIONS.length;
  let nextFace: MagFace | null = null;
  let worst = Infinity;
  for (const face of MAG_FACES) {
    const axis = FACE_AXIS[face];
    let total = 0;
    let have = 0;
    COVERAGE_DIRECTIONS.forEach((dir, i) => {
      if (dir[0] * axis[0] + dir[1] * axis[1] + dir[2] * axis[2] > 0.5) { total++; if (covered[i]) have++; }
    });
    const share = total ? have / total : 1;
    if (share < 1 && share < worst) { worst = share; nextFace = face; }
  }
  return { counts, covered, fraction, nextFace, centre };
}

// ---------------------------------------------------------------- reminders

export type MagCalibrationState = 'none' | 'ok' | 'soon' | 'due' | 'suspect';

/** What the device's status says about its calibration (status.magnetometer.calibration). */
export interface MagCalibrationStatus {
  mode?: unknown;
  calibrated_at_ms?: unknown;
  interval_days?: unknown;
  suspect?: unknown;
}

/**
 * Where the calibration stands at `nowMs`: none (never calibrated), suspect
 * (the device saw the field drift away from the fit), due (past the
 * interval), soon (within MAG_CAL_SOON_DAYS of it), ok. daysLeft is null when
 * there is no deadline (interval 0, or no calibration).
 */
export function calibrationDue(status: MagCalibrationStatus | null | undefined, nowMs: number): { state: MagCalibrationState; daysLeft: number | null } {
  const mode = typeof status?.mode === 'string' ? status.mode : 'none';
  if (mode !== 'hard_iron' && mode !== 'full') return { state: 'none', daysLeft: null };
  const interval = Number(status?.interval_days ?? 30);
  const at = Number(status?.calibrated_at_ms ?? 0);
  let daysLeft: number | null = null;
  if (Number.isFinite(interval) && interval > 0) {
    daysLeft = at > 0 ? Math.floor((at + interval * 86_400_000 - nowMs) / 86_400_000) : 0;
  }
  if (status?.suspect === true) return { state: 'suspect', daysLeft };
  if (daysLeft === null) return { state: 'ok', daysLeft };
  if (at <= 0 || at + interval * 86_400_000 <= nowMs) return { state: 'due', daysLeft: Math.min(daysLeft, 0) };
  if (daysLeft < MAG_CAL_SOON_DAYS) return { state: 'soon', daysLeft };
  return { state: 'ok', daysLeft };
}

/** The calibration the device reports, or null when it has none / it is malformed. */
export function calibrationFromStatus(status: MagCalibrationStatus & { offset?: unknown; matrix?: unknown; field_ut?: unknown; residual_pct?: unknown } | null | undefined): MagCalibration | null {
  const mode = status?.mode;
  if (mode !== 'hard_iron' && mode !== 'full') return null;
  const offset = Array.isArray(status?.offset) ? status!.offset.map(Number) : [];
  const matrix = Array.isArray(status?.matrix) ? status!.matrix.map(Number) : [];
  if (offset.length !== 3 || matrix.length !== 9 || ![...offset, ...matrix].every(Number.isFinite)) return null;
  return {
    mode,
    offset: [offset[0]!, offset[1]!, offset[2]!],
    matrix,
    fieldUt: Number(status?.field_ut ?? 0),
    residualPct: Number(status?.residual_pct ?? 0),
  };
}

// ---------------------------------------------------------------- the wizard's session

export type MagCalibrationPhase = 'prepare' | 'collect' | 'result';

export interface MagCalibrationResult {
  /** What will be stored (composed with the calibration in use). */
  calibration: MagCalibration;
  /** The fit on the collected (already calibrated) samples. */
  fit: MagCalibration;
  /** Why the full fit was not used, when it was not. */
  fallbackReason: 'coverage' | 'points' | 'fit_failed' | null;
  /** The firmware would refuse it; never sent. */
  problem: string | null;
  /** Collected samples, before and after the new fit (for the before/after plot). */
  before: MagVec[];
  after: MagVec[];
  residualWarn: boolean;
}

const MIN_STEP_DEG = 2;

/**
 * The wizard's state, UI-free: prepare → collect (samples from the live
 * stream, near-duplicates dropped) → result. The three apps draw it.
 */
export class MagCalibrationSession {
  phase: MagCalibrationPhase = 'prepare';
  points: MagVec[] = [];
  result: MagCalibrationResult | null = null;
  private lastDir: MagVec | null = null;
  private lastNorm = 0;

  readonly current: MagCalibration | null;

  // No parameter properties: the Desktop's copy runs under Node's type stripping.
  constructor(current: MagCalibration | null) {
    this.current = current;
  }

  start(): void {
    this.phase = 'collect';
    this.points = [];
    this.result = null;
    this.lastDir = null;
    this.lastNorm = 0;
  }

  /** One live sample (µT, as streamed). Returns whether it was kept. */
  add(sample: readonly number[] | null | undefined): boolean {
    if (this.phase !== 'collect' || !sample || sample.length < 3) return false;
    const p: MagVec = [Number(sample[0]), Number(sample[1]), Number(sample[2])];
    if (!p.every(Number.isFinite)) return false;
    const n = Math.hypot(p[0], p[1], p[2]);
    if (!(n > 0)) return false;
    const dir: MagVec = [p[0] / n, p[1] / n, p[2] / n];
    if (this.lastDir) {
      const dot = dir[0] * this.lastDir[0] + dir[1] * this.lastDir[1] + dir[2] * this.lastDir[2];
      const angle = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
      // A held-still device repeats itself (and the firmware repeats a
      // sample when the chip is slower than the scan): keep only movement.
      if (angle < MIN_STEP_DEG && Math.abs(n - this.lastNorm) < 0.02 * this.lastNorm) return false;
    }
    if (this.points.length >= MAG_CAL_MAX_POINTS) this.points.shift();
    this.points.push(p);
    this.lastDir = dir;
    this.lastNorm = n;
    return true;
  }

  coverage(): MagCoverage {
    return coverageOf(this.points);
  }

  /** Enough for a full fit (the progress ring completes). */
  ready(): boolean {
    return this.points.length >= MAG_CAL_FULL_MIN_POINTS && this.coverage().fraction >= MAG_CAL_FULL_MIN_COVERAGE;
  }

  /** Enough for at least a hard-iron fit (the button can be pressed early). */
  canCompute(): boolean {
    return this.points.length >= MAG_CAL_MIN_POINTS && this.coverage().fraction >= MAG_CAL_HARD_MIN_COVERAGE;
  }

  compute(): MagCalibrationResult | null {
    if (!this.canCompute()) return null;
    const coverage = this.coverage();
    let fit: MagCalibration | null = null;
    let fallbackReason: MagCalibrationResult['fallbackReason'] = null;
    if (this.points.length < MAG_CAL_FULL_MIN_POINTS) fallbackReason = 'points';
    else if (coverage.fraction < MAG_CAL_FULL_MIN_COVERAGE) fallbackReason = 'coverage';
    else {
      fit = fitEllipsoid(this.points);
      if (fit && calibrationProblem(fit)) fit = null;
      if (!fit) fallbackReason = 'fit_failed';
    }
    if (!fit) fit = fitSphere(this.points);
    if (!fit) return null;
    const calibration = composeCalibration(this.current, fit);
    const after = this.points.map((p) => applyCalibration(fit!, p));
    this.result = {
      calibration,
      fit,
      fallbackReason,
      problem: calibrationProblem(calibration),
      before: [...this.points],
      after,
      residualWarn: fit.residualPct > MAG_CAL_RESIDUAL_WARN_PCT,
    };
    this.phase = 'result';
    return this.result;
  }

  /** Back to collecting, keeping nothing. */
  redo(): void {
    this.start();
  }
}

/** The set_mag_calibration command for a result; `nowMs` is the host's wall clock. */
export function magCalibrationPayload(cal: MagCalibration, nowMs: number): Record<string, unknown> {
  const round = (v: number, digits: number) => Number(v.toFixed(digits));
  return {
    command: 'set_mag_calibration',
    mode: cal.mode,
    offset: cal.offset.map((v) => round(v, 4)),
    matrix: cal.matrix.map((v) => round(v, 6)),
    field_ut: round(cal.fieldUt, 3),
    residual_pct: round(cal.residualPct, 3),
    calibrated_at_ms: Math.round(nowMs),
  };
}

/**
 * The hint a device list / card shows for a device's magnetometer
 * (status.magnetometer): null when it is off or absent (nothing to say),
 * otherwise its calibration state -- 'none' then means "on but never
 * calibrated", and 'ok' needs no badge.
 */
export function magnetometerHint(magnetometer: unknown, nowMs: number): { state: MagCalibrationState; daysLeft: number | null } | null {
  if (!magnetometer || typeof magnetometer !== 'object') return null;
  const mag = magnetometer as { enabled?: unknown; calibration?: unknown };
  if (mag.enabled !== true) return null;
  const cal = mag.calibration && typeof mag.calibration === 'object' ? (mag.calibration as MagCalibrationStatus) : null;
  return calibrationDue(cal, nowMs);
}
