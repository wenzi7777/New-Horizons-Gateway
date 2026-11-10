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
