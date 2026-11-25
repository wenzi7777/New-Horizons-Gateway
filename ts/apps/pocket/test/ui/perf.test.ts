import { describe, expect, it } from 'vitest';

import { createLiveFeed, noteRender, pushLiveFrame, renderFps, throttleDelay } from '../../src/ui/liveFeedCore';
import { COLOR_STEPS, colorForValue, quantizedColor } from '../../src/ui/pressureColor';
import { sameData, shareData } from '../../src/ui/shareData';
import { gridLines, lookAt, multiply, orbitEye, orbitMatrix, parseCssColor, perspective, SURFACE_START, SURFACE_TARGET, toUint16Indices } from '../../src/ui/components/surfaceGl';

const device = (over: Record<string, unknown> = {}) => ({
  uid: 'AA',
  displayName: 'Dev',
  online: true,
  fps: 20,
  lastSeenMs: 1000,
  matrix: { rows: 4, cols: 4 },
  pins: { analog: [1, 2], select: [3, 4] },
  battery: { percent: 80, charging: false },
  recording: { enabled: false, finishing: false, error: '' },
  ...over,
});

describe('shareData', () => {
  it('ignores lastSeenMs and keeps the previous object', () => {
    const a = device();
    const b = device({ lastSeenMs: 5000 });
    expect(sameData(a, b)).toBe(true);
    expect(shareData(a, b)).toBe(a);
  });

  it('sees a changed pin list', () => {
    const a = device();
    const b = device({ pins: { analog: [1, 2, 5], select: [3, 4] } });
    expect(sameData(a, b)).toBe(false);
    const shared = shareData(a, b);
    expect(shared).not.toBe(a);
    expect(shared.pins).toEqual(b.pins);
    expect(shared.pins).not.toBe(a.pins);
    expect(shared.pins.select).toBe(a.pins.select);
    // Unchanged nested parts keep their identity.
    expect(shared.matrix).toBe(a.matrix);
    expect(shared.recording).toBe(a.recording);
  });

  it('reuses unchanged devices in a list, matched by uid', () => {
    const one = device({ uid: 'A1' });
    const two = device({ uid: 'B2' });
    const next = [device({ uid: 'B2' }), device({ uid: 'A1', fps: 12 })];
    const shared = shareData([one, two], next);
    expect(shared[0]).toBe(two);
    expect(shared[1]).not.toBe(one);
    expect(shared[1]!.fps).toBe(12);
    const same = [device({ uid: 'A1' }), device({ uid: 'B2', lastSeenMs: 9 })];
    expect(shareData([one, two], same)).toEqual([one, two]);
    expect(shareData([one, two], same)[0]).toBe(one);
  });

  it('treats missing and undefined fields alike, and null as a value', () => {
    expect(sameData({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameData({ a: null }, { a: undefined })).toBe(false);
    expect(sameData([1, 2], [1, 2, 3])).toBe(false);
  });
});

describe('live feed', () => {
  const frame = (n: number) => ({ uid: 'AA', rows: 2, cols: 2, values: [n, n, n, n], fps: 20, gyro: [n, 0, 0], acc: [0, 0, 1] }) as never;

  it('counts samples, keeps the latest and fills the IMU history', () => {
    const feed = createLiveFeed();
    let told = 0;
    feed.listeners.add(() => (told += 1));
    pushLiveFrame(feed, frame(1), 100);
    pushLiveFrame(feed, frame(2), 150);
    expect(feed.samples).toBe(2);
    expect((feed.latest as unknown as { values: number[] }).values[0]).toBe(2);
    expect(feed.imu.latest('gyro')?.[0]).toBe(2);
    expect(told).toBe(2);
  });

  it('render FPS counts the last second only', () => {
    const feed = createLiveFeed();
    for (let t = 0; t < 2000; t += 100) noteRender(feed, t);
    expect(renderFps(feed, 1900)).toBe(10);
    expect(feed.renders.length).toBeLessThanOrEqual(11);
    expect(renderFps(feed, 5000)).toBe(0);
  });

  it('throttle delay caps the rate', () => {
    expect(throttleDelay(0, 1000, 15)).toBe(0);
    expect(throttleDelay(1000, 1020, 10)).toBe(80);
  });
});

describe('quantizedColor', () => {
  const range = { min: 0, max: 100 };
  it('is one of COLOR_STEPS colours and matches the scale at the ends', () => {
    expect(quantizedColor(0, range)).toBe(colorForValue(0, range));
    expect(quantizedColor(100, range)).toBe(colorForValue(100, range));
    expect(quantizedColor(-5, range)).toBe(colorForValue(0, range));
    const seen = new Set<string>();
    for (let v = 0; v <= 100; v += 0.25) seen.add(quantizedColor(v, range));
    expect(seen.size).toBe(COLOR_STEPS);
  });
  it('keeps the same string for a small change', () => {
    expect(quantizedColor(50, range)).toBe(quantizedColor(50.3, range));
  });
});

describe('surfaceGl math', () => {
  const apply = (m: Float32Array, v: [number, number, number]) => {
    const out = [0, 0, 0, 0];
    for (let row = 0; row < 4; row++) out[row] = m[row]! * v[0] + m[4 + row]! * v[1] + m[8 + row]! * v[2] + m[12 + row]!;
    return out;
  };

  it('lookAt puts the target straight ahead on -z', () => {
    const view = lookAt([0, 0, 5], [0, 0, 0]);
    const p = apply(view, [0, 0, 0]);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(0);
    expect(p[2]).toBeCloseTo(-5);
  });

  it('perspective maps near / far to -1 / 1 in NDC', () => {
    const proj = perspective(90, 1, 1, 10);
    const near = apply(proj, [0, 0, -1]);
    const far = apply(proj, [0, 0, -10]);
    expect(near[2]! / near[3]!).toBeCloseTo(-1);
    expect(far[2]! / far[3]!).toBeCloseTo(1);
    // 90° fov: a point at x = -z sits on the right edge.
    const edge = apply(proj, [2, 0, -2]);
    expect(edge[0]! / edge[3]!).toBeCloseTo(1);
  });

  it('multiply with identity is a no-op', () => {
    const id = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const m = perspective(42, 1.5, 0.01, 100);
    expect(Array.from(multiply(id, m))).toEqual(Array.from(m));
  });

  it('the start orbit sees the target in the middle of the screen', () => {
    const eye = orbitEye(SURFACE_START);
    expect(Math.hypot(eye[0] - SURFACE_TARGET[0], eye[1] - SURFACE_TARGET[1], eye[2] - SURFACE_TARGET[2])).toBeCloseTo(SURFACE_START.distance);
    const clip = apply(orbitMatrix(SURFACE_START, 1.5), SURFACE_TARGET);
    expect(clip[0]! / clip[3]!).toBeCloseTo(0);
    expect(clip[1]! / clip[3]!).toBeCloseTo(0);
  });

  it('grid has 13 lines each way and Uint16 indices stop past 65536 vertices', () => {
    expect(gridLines().length).toBe(13 * 4 * 3);
    expect(toUint16Indices([0, 1, 2], 3)).toEqual(new Uint16Array([0, 1, 2]));
    expect(toUint16Indices([0], 70000)).toBeNull();
  });

  it('parses theme colours', () => {
    expect(parseCssColor('#ff0000', [0, 0, 0])).toEqual([1, 0, 0]);
    expect(parseCssColor('#0f0', [0, 0, 0])).toEqual([0, 1, 0]);
    expect(parseCssColor('rgba(0, 0, 255, 0.5)', [0, 0, 0])).toEqual([0, 0, 1]);
    expect(parseCssColor('transparent', [0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
  });
});
