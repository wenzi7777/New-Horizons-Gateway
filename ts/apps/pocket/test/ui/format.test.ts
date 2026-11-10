import { describe, expect, it } from 'vitest';

import {
  dayKey,
  formatBytes,
  formatDuration,
  formatValue,
  frameStats,
  groupByDay,
  isValidPocketId,
  isValidServerUrl,
  relativeDay,
} from '../../src/ui/format';

describe('formatBytes', () => {
  it('uses SI units with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1 KB');
    expect(formatBytes(1234)).toBe('1.23 KB');
    expect(formatBytes(56_700_000)).toBe('56.7 MB');
    expect(formatBytes(200e6)).toBe('200 MB');
    expect(formatBytes(41.7e9)).toBe('41.7 GB');
    expect(formatBytes(-1)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
  });
});

describe('formatDuration', () => {
  it('formats as a clock', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7_900)).toBe('0:07');
    expect(formatDuration(12 * 60_000 + 5_000)).toBe('12:05');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-5)).toBe('-');
  });
});

describe('values and stats', () => {
  it('formats pressure values', () => {
    expect(formatValue(3150.4)).toBe('3150');
    expect(formatValue(12.34)).toBe('12.3');
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('-');
  });
  it('computes max and mean', () => {
    expect(frameStats([])).toEqual({ max: 0, mean: 0 });
    expect(frameStats([1, 2, 3, 10])).toEqual({ max: 10, mean: 4 });
  });
});

describe('days', () => {
  it('groups by local day, newest first', () => {
    const d = (day: number, h: number) => new Date(2026, 10, day, h).getTime();
    const items = [d(9, 10), d(10, 8), d(10, 15), d(4, 1)];
    const groups = groupByDay(items, (x) => x);
    expect(groups.map((g) => g.key)).toEqual(['2026-11-10', '2026-11-09', '2026-11-04']);
    expect(groups[0]!.items).toEqual([d(10, 15), d(10, 8)]);
    expect(dayKey(d(4, 1))).toBe('2026-11-04');
  });
  it('labels today and yesterday, across a month boundary too', () => {
    const now = new Date(2026, 11, 1, 9).getTime();
    expect(relativeDay(new Date(2026, 11, 1, 0, 5).getTime(), now)).toBe('today');
    expect(relativeDay(new Date(2026, 10, 30, 23).getTime(), now)).toBe('yesterday');
    expect(relativeDay(new Date(2026, 10, 29, 23).getTime(), now)).toBeNull();
  });
});

describe('validation', () => {
  it('checks Pocket IDs like the Gateway ID rule', () => {
    expect(isValidPocketId('nh-pocket_01.lab')).toBe(true);
    expect(isValidPocketId('')).toBe(false);
    expect(isValidPocketId('has space')).toBe(false);
    expect(isValidPocketId('x'.repeat(65))).toBe(false);
  });
  it('checks server URLs', () => {
    expect(isValidServerUrl('wss://example.org/newhorizons/gateway/ws')).toBe(true);
    expect(isValidServerUrl('ws://192.168.1.2:5051/x')).toBe(true);
    expect(isValidServerUrl('https://example.org')).toBe(false);
    expect(isValidServerUrl('wss://')).toBe(false);
  });
});
