import { describe, expect, it } from 'vitest';

import {
  applyCalibration, calibrationDue, calibrationFromStatus, calibrationProblem, composeCalibration, coverageOf,
  fitEllipsoid, fitSphere, IDENTITY3, MagCalibrationSession, magCalibrationPayload, magnetometerHint, quickCommandPayload, type MagCalibration, type MagVec,
} from '../src';

// The same cases as the Desktop's frontend/tests/magCalibration.test.mjs.

// Points on a sphere (Fibonacci lattice), distorted by `soft` and moved by `hard`.
function cloud(n: number, field: number, soft: number[], hard: MagVec, noise = 0, seed = 1): MagVec[] {
  let s = seed;
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const out: MagVec[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = golden * i;
    const u = [Math.cos(t) * r * field, y * field, Math.sin(t) * r * field];
    const d = [
      soft[0]! * u[0]! + soft[1]! * u[1]! + soft[2]! * u[2]!,
      soft[3]! * u[0]! + soft[4]! * u[1]! + soft[5]! * u[2]!,
      soft[6]! * u[0]! + soft[7]! * u[1]! + soft[8]! * u[2]!,
    ];
    out.push([d[0]! + hard[0] + rand() * noise, d[1]! + hard[1] + rand() * noise, d[2]! + hard[2] + rand() * noise]);
  }
  return out;
}

const SOFT = [1.2, 0.1, 0.0, 0.1, 0.85, 0.05, 0.0, 0.05, 1.0];
const HARD: MagVec = [25, -40, 12];

describe('magnetometer calibration fitting', () => {
  it('recovers a hard-iron offset with a sphere fit', () => {
    const fit = fitSphere(cloud(400, 47, [...IDENTITY3], HARD, 0.5))!;
    expect(fit.mode).toBe('hard_iron');
    fit.offset.forEach((o, i) => expect(o).toBeCloseTo(HARD[i]!, 0));
    expect(fit.fieldUt).toBeCloseTo(47, 0);
    expect(fit.residualPct).toBeLessThan(1.5);
  });

  it('turns an ellipsoid back into a sphere with a full fit', () => {
    const points = cloud(600, 47, SOFT, HARD, 0.3);
    const fit = fitEllipsoid(points)!;
    expect(fit.mode).toBe('full');
    fit.offset.forEach((o, i) => expect(o).toBeCloseTo(HARD[i]!, 0));
    expect(fit.residualPct).toBeLessThan(1);
    // Symmetric, volume-preserving.
    expect(fit.matrix[1]).toBeCloseTo(fit.matrix[3]!, 6);
    expect(calibrationProblem(fit)).toBeNull();
    // A sphere fit on the same cloud is visibly worse.
    expect(fitSphere(points)!.residualPct).toBeGreaterThan(5);
  });

  it('composes a new fit on calibrated samples with the calibration in use', () => {
    const raw = cloud(600, 47, SOFT, HARD, 0);
    const first = fitSphere(raw)!;                       // a hard-iron-only first pass
    const streamed = raw.map((p) => applyCalibration(first, p));
    const second = fitEllipsoid(streamed)!;              // fitted on what the device streams
    const total = composeCalibration(first, second);
    expect(total.mode).toBe('full');
    // Applying the composed calibration to raw == applying both in turn.
    for (const p of raw.slice(0, 20)) {
      const once = applyCalibration(total, p);
      const twice = applyCalibration(second, applyCalibration(first, p));
      once.forEach((v, i) => expect(v).toBeCloseTo(twice[i]!, 6));
    }
    // And it is as good as a full fit on raw.
    const direct = fitEllipsoid(raw)!;
    const norms = raw.map((p) => Math.hypot(...applyCalibration(total, p)));
    const mean = norms.reduce((a, b) => a + b, 0) / norms.length;
    expect(mean).toBeCloseTo(direct.fieldUt, 0);
  });

  it('refuses what the firmware would refuse', () => {
    const ok: MagCalibration = { mode: 'full', offset: [1, 2, 3], matrix: [...IDENTITY3], fieldUt: 47, residualPct: 1 };
    expect(calibrationProblem(ok)).toBeNull();
    expect(calibrationProblem({ ...ok, offset: [600, 0, 0] })).toBe('mag_calibration_offset_too_large');
    expect(calibrationProblem({ ...ok, matrix: [5, 0, 0, 0, 5, 0, 0, 0, 0.1] })).toBe('mag_calibration_matrix_ill_conditioned');
    expect(calibrationProblem({ ...ok, matrix: [-1, 0, 0, 0, 1, 0, 0, 0, 1] })).toBe('mag_calibration_matrix_singular');
    expect(calibrationProblem({ ...ok, fieldUt: 0 })).toBe('mag_calibration_field_out_of_range');
    expect(calibrationProblem({ ...ok, offset: [NaN, 0, 0] })).toBe('mag_calibration_not_finite');
  });
});

describe('coverage', () => {
  it('is complete for a full sphere and partial for a flat turn', () => {
    expect(coverageOf(cloud(600, 47, [...IDENTITY3], HARD)).fraction).toBe(1);
    const flat: MagVec[] = [];
    for (let i = 0; i < 360; i++) {
      const a = (i * Math.PI) / 180;
      flat.push([30 * Math.cos(a) + HARD[0], 30 * Math.sin(a) + HARD[1], -36 + HARD[2]]);
    }
    const c = coverageOf(flat);
    expect(c.fraction).toBeLessThan(0.5);
    expect(c.fraction).toBeGreaterThan(0.2);
    expect(c.nextFace).not.toBeNull();
    expect(coverageOf([]).fraction).toBe(0);
  });
});

describe('the wizard session', () => {
  it('collects, drops repeats, and fits fully once the sphere is covered', () => {
    const session = new MagCalibrationSession(null);
    expect(session.add([1, 2, 3])).toBe(false);          // not collecting yet
    session.start();
    expect(session.add([10, 0, 40])).toBe(true);
    expect(session.add([10, 0, 40])).toBe(false);        // the same sample again
    expect(session.add([10.01, 0, 40.01])).toBe(false);  // held still
    for (const p of cloud(500, 47, SOFT, HARD, 0.2)) session.add(p);
    expect(session.ready()).toBe(true);
    const result = session.compute()!;
    expect(result.fallbackReason).toBeNull();
    expect(result.calibration.mode).toBe('full');
    expect(result.problem).toBeNull();
    expect(result.residualWarn).toBe(false);
    expect(session.phase).toBe('result');
    const payload = magCalibrationPayload(result.calibration, 1_764_000_000_000);
    expect(payload).toMatchObject({ command: 'set_mag_calibration', mode: 'full', calibrated_at_ms: 1_764_000_000_000 });
    expect((payload.matrix as number[]).length).toBe(9);
  });

  it('falls back to hard iron on a partial turn and refuses too little', () => {
    const session = new MagCalibrationSession(null);
    session.start();
    expect(session.canCompute()).toBe(false);
    for (let i = 0; i < 360; i += 1) {
      const a = (i * Math.PI) / 180;
      const tilt = Math.sin(a * 3) * 8;
      session.add([30 * Math.cos(a) + 5, 30 * Math.sin(a) - 7, -36 + tilt]);
    }
    expect(session.ready()).toBe(false);
    expect(session.canCompute()).toBe(true);
    const result = session.compute()!;
    expect(result.calibration.mode).toBe('hard_iron');
    expect(result.fallbackReason).not.toBeNull();
  });
});

describe('reminders', () => {
  const day = 86_400_000;
  const at = 1_764_000_000_000;
  it('counts down and flags', () => {
    expect(calibrationDue({ mode: 'none' }, at).state).toBe('none');
    expect(calibrationDue(null, at).state).toBe('none');
    expect(calibrationDue({ mode: 'full', calibrated_at_ms: at, interval_days: 30 }, at + day)).toEqual({ state: 'ok', daysLeft: 29 });
    expect(calibrationDue({ mode: 'full', calibrated_at_ms: at, interval_days: 30 }, at + 28 * day).state).toBe('soon');
    expect(calibrationDue({ mode: 'full', calibrated_at_ms: at, interval_days: 30 }, at + 30 * day).state).toBe('due');
    expect(calibrationDue({ mode: 'full', calibrated_at_ms: at, interval_days: 0 }, at + 999 * day)).toEqual({ state: 'ok', daysLeft: null });
    expect(calibrationDue({ mode: 'hard_iron', calibrated_at_ms: at, interval_days: 30, suspect: true }, at).state).toBe('suspect');
    expect(calibrationDue({ mode: 'full', calibrated_at_ms: 0, interval_days: 30 }, at).state).toBe('due');
  });

  it('reads the calibration a device reports', () => {
    expect(calibrationFromStatus({ mode: 'none' })).toBeNull();
    const cal = calibrationFromStatus({ mode: 'full', offset: [1, 2, 3], matrix: [...IDENTITY3], field_ut: 47, residual_pct: 1.2 })!;
    expect(cal.offset).toEqual([1, 2, 3]);
    expect(cal.fieldUt).toBe(47);
    expect(calibrationFromStatus({ mode: 'full', offset: [1, 2], matrix: [...IDENTITY3] })).toBeNull();
  });
});

describe('magnetometerHint', () => {
  it('says nothing for an absent or disabled magnetometer', () => {
    expect(magnetometerHint(undefined, 0)).toBeNull();
    expect(magnetometerHint({ enabled: false, calibration: { mode: 'none' } }, 0)).toBeNull();
  });
  it('reports none for an enabled, uncalibrated one and due past the interval', () => {
    expect(magnetometerHint({ enabled: true, calibration: { mode: 'none' } }, 0)?.state).toBe('none');
    const day = 86_400_000;
    const hint = magnetometerHint({ enabled: true, calibration: { mode: 'full', calibrated_at_ms: day, interval_days: 7 } }, 9 * day);
    expect(hint?.state).toBe('due');
  });
});

describe('magnetometer quick commands', () => {
  it('builds set_mag and set_mag_calibration payloads', () => {
    expect(quickCommandPayload({ kind: 'mag', enabled: false })).toEqual({ command: 'set_mag', enabled: false });
    expect(quickCommandPayload({ kind: 'mag', calIntervalDays: 7 })).toEqual({ command: 'set_mag', cal_interval_days: 7 });
    expect(quickCommandPayload({ kind: 'mag_calibration_clear' })).toEqual({ command: 'set_mag_calibration', clear: true });
    const cal: MagCalibration = { mode: 'hard_iron', offset: [1, 2, 3], matrix: [...IDENTITY3], fieldUt: 47, residualPct: 1 };
    expect(quickCommandPayload({ kind: 'mag_calibration', calibration: cal, nowMs: 1000 })).toEqual(magCalibrationPayload(cal, 1000));
  });
});
