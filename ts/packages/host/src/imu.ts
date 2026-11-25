// What the live views draw from a device's IMU and magnetometer (spec
// PROTOCOL.md: acc in g, gyro in deg/s, mag in µT): the tilt a spirit level
// shows, a tilt-compensated heading, the gyro bars' scale, and the last few
// seconds of each sensor for the trend lines. The Desktop keeps a copy in
// frontend/src/lib/imuView.ts; both are tested with the same cases.

export type Vec3 = [number, number, number];
export type ImuKey = 'acc' | 'gyro' | 'mag';
export type ImuSample = Partial<Record<ImuKey, readonly number[] | null | undefined>>;

/** The axis colours of the trend lines and bars (data colours, like the pressure scale). */
export const IMU_AXIS_COLORS = ['#e5484d', '#30a46c', '#3e63dd'] as const;
export const IMU_WINDOW_MS = 10_000;
export const IMU_MAX_POINTS = 300;
export const GYRO_SCALES = [30, 125, 250, 500, 1000, 2000] as const;

const RAD = 180 / Math.PI;

/** A finite x, y, z, or null. */
export function vec3(value: readonly number[] | null | undefined): Vec3 | null {
  if (!value || value.length < 3) return null;
  const v: Vec3 = [Number(value[0]), Number(value[1]), Number(value[2])];
  return v.every(Number.isFinite) ? v : null;
}

export function vectorNorm(v: readonly number[]): number {
  return Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/**
 * Roll / pitch (degrees) from the accelerometer at rest, and where a spirit
 * level's bubble sits (−1..1 each, screen x right / y down): the bubble goes
 * to the high side, so lowering the right edge moves it left.
 */
export function tiltFromAcc(acc: readonly number[]): { rollDeg: number; pitchDeg: number; bubbleX: number; bubbleY: number } | null {
  const v = vec3(acc);
  if (!v) return null;
  const n = vectorNorm(v);
  if (n < 1e-6) return null;
  const [ax, ay, az] = v;
  return {
    rollDeg: Math.atan2(ay, az) * RAD,
    pitchDeg: Math.atan2(-ax, Math.hypot(ay, az)) * RAD,
    bubbleX: clampUnit(ax / n),
    bubbleY: clampUnit(-ay / n),
  };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Heading (0..360°, clockwise from magnetic north) of the board's +x axis.
 * "Up" comes from the accelerometer, so tilting the board does not swing it;
 * without one the board is taken as flat. Raw: no hard/soft-iron correction
 * beyond the firmware's own calibration.
 */
export function headingFromMag(mag: readonly number[], acc?: readonly number[] | null): number | null {
  const m = vec3(mag);
  if (!m || vectorNorm(m) < 1e-6) return null;
  const a = vec3(acc ?? null);
  const up: Vec3 = a && vectorNorm(a) > 1e-6 ? a : [0, 0, 1];
  const east = cross(m, up);
  const north = cross(up, east);
  if (vectorNorm(east) < 1e-9 || vectorNorm(north) < 1e-9) return null;
  const deg = Math.atan2(east[0] / vectorNorm(east), north[0] / vectorNorm(north)) * RAD;
  return (deg + 360) % 360;
}

/** The gyro bars' full scale: the first common range that holds `maxAbs`. */
export function gyroScale(maxAbs: number): number {
  for (const scale of GYRO_SCALES) if (Math.abs(maxAbs) <= scale) return scale;
  return 2000;
}

export type ImuPoint = { t: number; v: Vec3 };

/** The last `windowMs` of each sensor, for the trend lines. */
export class ImuHistory {
  private readonly samples: Record<ImuKey, ImuPoint[]> = { acc: [], gyro: [], mag: [] };
  private readonly seen: Record<ImuKey, boolean> = { acc: false, gyro: false, mag: false };
  private lastKey: string | number | null = null;

  readonly windowMs: number;

  constructor(windowMs = IMU_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * Adds a frame's readings at `tMs`. `key` (a frame timestamp or sequence)
   * makes a repeated push of the same frame a no-op.
   */
  push(tMs: number, sample: ImuSample, key?: string | number): void {
    if (key !== undefined && key === this.lastKey) return;
    if (key !== undefined) this.lastKey = key;
    for (const name of ['acc', 'gyro', 'mag'] as const) {
      const v = vec3(sample[name]);
      if (!v) continue;
      this.seen[name] = true;
      const list = this.samples[name];
      list.push({ t: tMs, v });
      const cutoff = tMs - this.windowMs;
      let drop = 0;
      while (drop < list.length && list[drop]!.t < cutoff) drop += 1;
      if (drop > 0) list.splice(0, drop);
      if (list.length > 4000) list.splice(0, list.length - 4000);
    }
  }

  /** Whether this sensor has ever reported (no magnetometer: false for mag). */
  has(key: ImuKey): boolean {
    return this.seen[key];
  }

  latest(key: ImuKey): Vec3 | null {
    const list = this.samples[key];
    return list.length ? list[list.length - 1]!.v : null;
  }

  /** Points inside the window ending at `nowMs`, thinned to at most `maxPoints`. */
  series(key: ImuKey, nowMs: number, maxPoints = IMU_MAX_POINTS): ImuPoint[] {
    const cutoff = nowMs - this.windowMs;
    const inside = this.samples[key].filter((p) => p.t >= cutoff);
    if (inside.length <= maxPoints) return inside;
    const stride = inside.length / maxPoints;
    const out: ImuPoint[] = [];
    for (let i = 0; i < maxPoints; i++) out.push(inside[Math.floor(i * stride)]!);
    out[out.length - 1] = inside[inside.length - 1]!;
    return out;
  }

  /** The largest |axis value| in the window (the trend line's symmetric scale); 0 when empty. */
  symmetricMax(key: ImuKey, nowMs: number): number {
    let max = 0;
    const cutoff = nowMs - this.windowMs;
    for (const p of this.samples[key]) {
      if (p.t < cutoff) continue;
      for (const x of p.v) max = Math.max(max, Math.abs(x));
    }
    return max;
  }

  clear(): void {
    for (const name of ['acc', 'gyro', 'mag'] as const) {
      this.samples[name] = [];
      this.seen[name] = false;
    }
    this.lastKey = null;
  }
}

/** SVG polyline points for one axis of a trend line in a width×height box (y=0 in the middle). */
export function trendPolyline(points: readonly ImuPoint[], axis: 0 | 1 | 2, nowMs: number, windowMs: number, scale: number, width: number, height: number): string {
  const half = height / 2;
  const s = scale > 0 ? scale : 1;
  return points
    .map((p) => {
      const x = ((p.t - (nowMs - windowMs)) / windowMs) * width;
      const y = half - Math.max(-1, Math.min(1, p.v[axis] / s)) * (half - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** A trend line's scale: the window's largest |value| rounded up to a 1-2-5 step (never 0). */
export function niceScale(maxAbs: number, floor = 1e-3): number {
  const m = Math.max(Math.abs(maxAbs), floor);
  const p = 10 ** Math.floor(Math.log10(m));
  for (const step of [1, 2, 5, 10]) if (m <= step * p) return step * p;
  return 10 * p;
}
