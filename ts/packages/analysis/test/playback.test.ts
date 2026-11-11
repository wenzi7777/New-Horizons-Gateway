import { describe, expect, it } from 'vitest';

import { nextSpeed, playbackTime, PLAYBACK_SPEEDS } from '../src/playback';

describe('playback', () => {
  it('advances by elapsed wall time times the speed and stops at the end', () => {
    expect(playbackTime(1000, 5000, 500, 1)).toEqual({ ms: 1500, finished: false });
    expect(playbackTime(1000, 5000, 500, 4)).toEqual({ ms: 3000, finished: false });
    expect(playbackTime(1000, 5000, 500, 0.5)).toEqual({ ms: 1250, finished: false });
    expect(playbackTime(1000, 5000, 2000, 4)).toEqual({ ms: 5000, finished: true });
    expect(playbackTime(1000, 5000, -5, 1).ms).toBe(1000);
  });
  it('cycles the speeds', () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.5, 1, 2, 4]);
    expect(nextSpeed(1)).toBe(2);
    expect(nextSpeed(4)).toBe(0.5);
    expect(nextSpeed(3)).toBe(1); // unknown: back to a sane start
  });
});
