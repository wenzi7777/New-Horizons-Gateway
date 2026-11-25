import { describe, expect, it } from 'vitest';

import { computeCop, interpolateGrid, mirrorValues, surfaceInterpolationSteps } from '../../src/renderer/lib/visualization';
import { LIVE_STRINGS } from '../../src/renderer/pages/liveStrings';

describe('visualization helpers (ported from the Desktop)', () => {
  it('mirrors rows and columns', () => {
    const v = [1, 2, 3, 4, 5, 6]; // 2×3
    expect(mirrorValues(v, 2, 3, false, false)).toEqual(v);
    expect(mirrorValues(v, 2, 3, true, false)).toEqual([4, 5, 6, 1, 2, 3]);
    expect(mirrorValues(v, 2, 3, false, true)).toEqual([3, 2, 1, 6, 5, 4]);
  });

  it('centre of pressure ignores values at or below the offset', () => {
    expect(computeCop([0, 0, 0, 0], 2, 2).hasData).toBe(false);
    const cop = computeCop([250, 250, 250, 1250], 2, 2);
    expect(cop).toMatchObject({ hasData: true, xRatio: 1, yRatio: 1, x: 1, y: 1 });
  });

  it('interpolates bilinearly within the point budget', () => {
    expect(surfaceInterpolationSteps(2, 2)).toBe(3);
    expect(surfaceInterpolationSteps(40, 40)).toBe(1);
    const grid = interpolateGrid([0, 3, 3, 6], 2, 2, 3);
    expect(grid.rows).toBe(4);
    expect(grid.cols).toBe(4);
    expect(grid.values[0]).toBe(0);
    expect(grid.values[15]).toBe(6);
    expect(grid.values[1]).toBeCloseTo(1);
  });

  it('live strings exist in every language', () => {
    const keys = Object.keys(LIVE_STRINGS.en).sort();
    expect(Object.keys(LIVE_STRINGS.ja).sort()).toEqual(keys);
    expect(Object.keys(LIVE_STRINGS['zh-CN']).sort()).toEqual(keys);
    expect(LIVE_STRINGS['zh-CN'].profiles).toBe('描述文件');
  });
});

describe('grid transform (Transpose + Row/Col Mirror)', () => {
  it('transposes first, then mirrors what is drawn', async () => {
    const { transformGrid, transformPinLabels } = await import('../../src/renderer/lib/visualization');
    const v = [0, 1, 2, 3, 4, 5]; // 2×3
    const none = { rowMirror: false, colMirror: false, transpose: false };
    expect(transformGrid(v, 2, 3, none)).toEqual({ values: v, rows: 2, cols: 3, indices: v });
    const t = transformGrid(v, 2, 3, { ...none, transpose: true });
    expect(t).toMatchObject({ rows: 3, cols: 2, values: [0, 3, 1, 4, 2, 5] });
    // Transpose + Col Mirror = a quarter turn clockwise.
    expect(transformGrid(v, 2, 3, { ...none, transpose: true, colMirror: true }).values).toEqual([3, 0, 4, 1, 5, 2]);
    const seen = new Set<string>();
    for (const transpose of [false, true]) for (const rowMirror of [false, true]) for (const colMirror of [false, true]) {
      seen.add(transformGrid([0, 1, 2, 3, 4, 5, 6, 7, 8], 3, 3, { transpose, rowMirror, colMirror }).values.join());
    }
    expect(seen.size).toBe(8);
    expect(transformPinLabels({ rows: ['A1', 'A2'], cols: ['D1', 'D2', 'D3'] }, { ...none, transpose: true, rowMirror: true })).toEqual({
      rows: ['D3', 'D2', 'D1'],
      cols: ['A1', 'A2'],
    });
  });

  it('mirrors a profile by moving its sensors, not their values', async () => {
    const { mirrorProfileSensors, computePointsCop } = await import('../../src/renderer/lib/visualization');
    const profile = { sensors: [{ index: 0, x: 0.2, y: 0.1, label: 'P1', enabled: true }] };
    expect(mirrorProfileSensors(profile, true, true).sensors[0]).toMatchObject({ index: 0, x: 0.8, y: 0.9 });
    expect(mirrorProfileSensors(profile, false, false)).toBe(profile);
    expect(computePointsCop([{ value: 1250, xRatio: 1, yRatio: 0 }], 3, 3)).toMatchObject({ hasData: true, xRatio: 1, yRatio: 0, x: 2 });
  });
});
