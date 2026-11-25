import { describe, expect, it } from 'vitest';

import { gyroScale, headingFromMag, ImuHistory, liveFrame, niceScale, tiltFromAcc, trendPolyline, vectorNorm } from '../src';

// Rotate v about the x axis by `deg` (a roll of the board).
function rollX(v: number[], deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  return [v[0]!, v[1]! * Math.cos(r) + v[2]! * Math.sin(r), -v[1]! * Math.sin(r) + v[2]! * Math.cos(r)];
}

describe('IMU views', () => {
  it('reads tilt like a spirit level', () => {
    expect(tiltFromAcc([0, 0, 1])).toMatchObject({ rollDeg: 0, bubbleX: 0 });
    expect(tiltFromAcc([0, 0, 1])!.pitchDeg).toBeCloseTo(0);
    // Right edge lowered: the accelerometer reads -x, the bubble goes left (to the high side).
    const right = tiltFromAcc([-Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)])!;
    expect(right.pitchDeg).toBeCloseTo(30);
    expect(right.bubbleX).toBeCloseTo(-0.5);
    // Top edge lowered: -y, the bubble goes down the screen.
    expect(tiltFromAcc([0, -0.5, Math.sqrt(0.75)])!.bubbleY).toBeCloseTo(0.5);
    expect(tiltFromAcc([1, 0, 0])!.pitchDeg).toBeCloseTo(-90);
    expect(tiltFromAcc([0, 0, 0])).toBeNull();
    expect(vectorNorm([3, 4, 0])).toBe(5);
  });

  it('gives the heading of +x, steady when the board tilts', () => {
    // Earth's field dips downward; +x north, +y west, +z up.
    expect(headingFromMag([20, 0, -40])).toBeCloseTo(0);
    expect(headingFromMag([0, 20, -40])).toBeCloseTo(90); // north along +y: +x points east
    expect(headingFromMag([-20, 0, -40])).toBeCloseTo(180);
    expect(headingFromMag([0, -20, -40])).toBeCloseTo(270);
    const mag = rollX([0, 20, -40], 25);
    const acc = rollX([0, 0, 1], 25);
    expect(headingFromMag(mag, acc)).toBeCloseTo(90);
    expect(headingFromMag([0, 0, 0])).toBeNull();
  });

  it('picks the gyro scale and a 1-2-5 trend scale', () => {
    expect(gyroScale(0)).toBe(30);
    expect(gyroScale(30)).toBe(30);
    expect(gyroScale(31)).toBe(125);
    expect(gyroScale(-600)).toBe(1000);
    expect(gyroScale(9999)).toBe(2000);
    expect(niceScale(0.8)).toBe(1);
    expect(niceScale(1.3)).toBe(2);
    expect(niceScale(46)).toBe(50);
    expect(niceScale(0, 10)).toBe(10);
  });

  it('keeps the last window of each sensor', () => {
    const h = new ImuHistory(1000);
    h.push(0, { acc: [0, 0, 1], gyro: [1, 2, 3] }, 1);
    h.push(0, { acc: [9, 9, 9] }, 1); // same frame again: ignored
    h.push(500, { acc: [0, 0, 1], gyro: [-5, 0, 0] }, 2);
    h.push(1600, { acc: [0, 1, 0], gyro: [0, 0, 0] }, 3);
    expect(h.series('acc', 1600).map((p) => p.t)).toEqual([1600]);
    // Pushing t=1600 dropped everything before 600.
    expect(h.series('gyro', 1600).map((p) => p.t)).toEqual([1600]);
    expect(h.has('mag')).toBe(false);
    expect(h.series('mag', 1600)).toEqual([]);
    expect(h.latest('acc')).toEqual([0, 1, 0]);
    const many = new ImuHistory(10_000);
    for (let t = 0; t < 1000; t++) many.push(t, { gyro: [t, 0, 0] });
    const thin = many.series('gyro', 999, 100);
    expect(thin).toHaveLength(100);
    expect(thin[99]!.t).toBe(999);
    expect(many.symmetricMax('gyro', 999)).toBe(999);
    expect(trendPolyline([{ t: 0, v: [1, 0, -1] }], 0, 0, 1000, 1, 100, 20)).toBe('100.0,2.0');
  });

  it('live frames carry the magnetometer', () => {
    const top = liveFrame('X', { p: [1], mag: [1, 2, 3] }, null);
    expect(top?.mag).toEqual([1, 2, 3]);
    const nested = liveFrame('X', { p: [1], imu: { mag: [4, 5, 6], acc: [0, 0, 1] } }, null);
    expect(nested).toMatchObject({ mag: [4, 5, 6], acc: [0, 0, 1] });
    expect(liveFrame('X', { p: [1] }, null)).not.toHaveProperty('mag');
  });
});
