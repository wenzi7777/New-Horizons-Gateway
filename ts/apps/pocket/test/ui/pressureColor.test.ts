import { describe, expect, it } from 'vitest';

import { colorForValue, cssColorForValue, DEFAULT_RANGE, hslForValue, hslToHex, RANGE_PRESETS, valueRatio } from '../../src/ui/pressureColor';

describe('pressure colour scale (ported from the Desktop)', () => {
  it('matches the Desktop formula and CSS string', () => {
    const range = { min: 300, max: 3150 };
    expect(cssColorForValue(300, range)).toBe('hsl(154deg 58% 78%)');
    expect(cssColorForValue(3150, range)).toBe('hsl(46deg 58% 48%)');
    expect(hslForValue(1725, range)).toEqual({ h: 100, s: 58, l: 63 });
  });

  it('clamps the ratio and guards a zero span like the Desktop', () => {
    expect(valueRatio(-10, { min: 0, max: 100 })).toBe(0);
    expect(valueRatio(1e6, { min: 0, max: 100 })).toBe(1);
    expect(valueRatio(5, { min: 5, max: 5 })).toBe(0);
    expect(valueRatio(6, { min: 5, max: 5 })).toBe(1);
  });

  it('converts HSL to hex correctly', () => {
    expect(hslToHex(0, 100, 50)).toBe('#ff0000');
    expect(hslToHex(120, 100, 50)).toBe('#00ff00');
    expect(hslToHex(240, 100, 50)).toBe('#0000ff');
    expect(hslToHex(0, 0, 100)).toBe('#ffffff');
    expect(hslToHex(154, 58, 78)).toBe('#a6e7cb');
  });

  it('uses the Desktop Visualization range presets', () => {
    expect(DEFAULT_RANGE).toEqual({ min: 300, max: 3150 });
    expect(RANGE_PRESETS).toEqual([{ min: 300, max: 3150 }, { min: 300, max: 4990 }]);
    expect(colorForValue(0, DEFAULT_RANGE)).toBe(colorForValue(300, DEFAULT_RANGE));
    expect(colorForValue(9999, DEFAULT_RANGE)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
