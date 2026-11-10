// Analysis of a vref_sweep reply (v2.0.F). A row reads Vout = Vref * (1 + Rfb / Rs),
// so each cell's Rs = Rfb * Vref / (Vout - Vref). If the material is a pure
// resistance, Rs does not move as Vref does; how much it moves is the result.

export type SweepStep = {
  vref_mv: number;
  /** Row-major raw millivolts, rows * cols. */
  matrix_mv: number[];
};

/** What the device measured once (rfb_measure) and the sweep reuses at every step. */
export type SweepCalibration = {
  /** Rfb per row (0 = unknown). */
  rfb_ohm?: number[];
  /** Each row's ADC offset: with nothing pressed it reads Vref + offset. */
  offset_mv?: number[];
};

export type SweepSummary = {
  vrefMv: number;
  rfbMeanOhm: number | null;
  /** Median Rs over the cells that carry a usable signal. */
  rsMedianOhm: number | null;
  usedCells: number;
  /** Cells at the rail: their Rs cannot be computed. */
  saturatedCells: number;
};

/** A reading this far above Vref carries signal; this near the rail does not. */
const MIN_SIGNAL_MV = 30;
const SATURATION_MV = 3000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Rs comes from the Rfb the device measured once (a per-step Rfb is good to a few
 * percent at low Vref, which would read as Rs moving with Vref -- the very thing
 * under test). `fallbackRfbOhm` is the Rfb the user soldered, for rows without a
 * measured one; without either, Rs stays null.
 */
export function summarizeSweep(
  steps: SweepStep[],
  rows: number,
  cols: number,
  calibration: SweepCalibration = {},
  fallbackRfbOhm?: number,
): SweepSummary[] {
  const measured = (calibration.rfb_ohm ?? []).filter((value) => value > 0);
  return steps.map((step) => {
    const rs: number[] = [];
    let saturatedCells = 0;
    for (let r = 0; r < rows; r += 1) {
      const known = (calibration.rfb_ohm?.[r] ?? 0) > 0;
      const rowRfb: number = known ? calibration.rfb_ohm![r]! : (fallbackRfbOhm ?? 0);
      const baseline = step.vref_mv + (known ? calibration.offset_mv?.[r] ?? 0 : 0);
      for (let c = 0; c < cols; c += 1) {
        const vout = step.matrix_mv[r * cols + c];
        if (vout === undefined || !Number.isFinite(vout)) continue;
        if (vout >= SATURATION_MV) {
          saturatedCells += 1;
          continue;
        }
        const signal = vout - baseline;
        if (rowRfb > 0 && signal > MIN_SIGNAL_MV) {
          rs.push((rowRfb * step.vref_mv) / signal);
        }
      }
    }
    return {
      vrefMv: step.vref_mv,
      rfbMeanOhm: measured.length ? measured.reduce((a, b) => a + b, 0) / measured.length : null,
      rsMedianOhm: median(rs),
      usedCells: rs.length,
      saturatedCells,
    };
  });
}

/** Spread of the median Rs across the sweep, as a fraction of its median; null with fewer than two steps. */
export function rsSpreadFraction(summaries: SweepSummary[]): number | null {
  const values = summaries.map((item) => item.rsMedianOhm).filter((value): value is number => value !== null);
  if (values.length < 2) return null;
  const mid = median(values) as number;
  return mid > 0 ? (Math.max(...values) - Math.min(...values)) / mid : null;
}

export function sweepCsv(steps: SweepStep[], rows: number, cols: number, calibration: SweepCalibration = {}): string {
  const header = ["vref_mv", "row", "col", "rfb_ohm", "offset_mv", "raw_mv"].join(",");
  const lines: string[] = [header];
  for (const step of steps) {
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const rfb = calibration.rfb_ohm?.[r] ?? "";
        const offset = calibration.offset_mv?.[r] ?? "";
        lines.push([step.vref_mv, r, c, rfb, offset, step.matrix_mv[r * cols + c]].join(","));
      }
    }
  }
  return lines.join("\n") + "\n";
}
