import { describe, expect, it } from 'vitest';
import { pyFloatRepr, pyRound, pyRoundInt, pyTrueDivInt, ratioToDouble } from '../../src/parse/pyNumber';
import { pySumFloats } from '../../src/recording/timeline';
import { bits, hasPython, rng, runPython } from '../recording/pyHarness';

const f32 = (x: number) => Math.fround(x);

describe('pyFloatRepr (fixed cases)', () => {
  it.each([
    [0.1, '0.1'],
    [1e-5, '1e-05'],
    [100, '100.0'],
    [-0, '-0.0'],
    [0, '0.0'],
    [1e16, '1e+16'],
    [1234567890123456, '1234567890123456.0'],
    [12345678901234567, '1.2345678901234568e+16'],
    [0.0001, '0.0001'],
    [0.00012, '0.00012'],
    [1.5e-7, '1.5e-07'],
    [1e22, '1e+22'],
    [1.7976931348623157e308, '1.7976931348623157e+308'],
    [5e-324, '5e-324'],
    [NaN, 'nan'],
    [Infinity, 'inf'],
    [-Infinity, '-inf'],
    [-2.5, '-2.5'],
  ])('%s -> %s', (x, text) => {
    expect(pyFloatRepr(x)).toBe(text);
  });
});

describe('pyRound (fixed cases)', () => {
  it('rounds ties on the exact binary value, half to even', () => {
    expect(pyRound(0.0078125, 6)).toBe(0.007812); // 2^-7: an exact tie, kept even
    expect(pyRound(2.675, 2)).toBe(2.67); // 2.675 is really 2.67499999...
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(0.375, 2)).toBe(0.38);
    expect(Object.is(pyRound(-1e-9, 6), -0)).toBe(true);
    expect(pyRoundInt(2.5)).toBe(2);
    expect(pyRoundInt(3.5)).toBe(4);
    expect(pyRoundInt(-2.5)).toBe(-2);
    expect(Object.is(pyRoundInt(-0.4), 0)).toBe(true);
  });
  it('ratioToDouble is the nearest double', () => {
    for (const [n, d] of [
      [1n, 3n],
      [2n, 3n],
      [10n ** 30n + 1n, 7n],
      [(1n << 53n) + 1n, 1n],
      [(1n << 54n) + 3n, 2n],
    ] as const) {
      expect(ratioToDouble(n, d)).toBe(Number(n) / Number(d));
    }
  });
});

describe.skipIf(!hasPython)('Python numerics, differential', () => {
  const random = rng(20261110);
  const values: number[] = [];
  // float32 values as the parser sees them, over many magnitudes, plus ties.
  for (let i = 0; i < 3000; i++) {
    const exp = Math.floor(random() * 40) - 20;
    values.push(f32((random() - 0.5) * 2 * 10 ** exp));
  }
  for (let i = 0; i < 500; i++) values.push(f32(Math.floor(random() * 2 ** 20) / 2 ** Math.floor(random() * 24)));
  for (let i = 0; i < 300; i++) values.push((Math.floor(random() * 1e9) + 0.5) / 1e6); // near-ties as doubles
  for (let i = 0; i < 300; i++) values.push(random() * 10 ** (Math.floor(random() * 40) - 10));
  values.push(0, -0, 1e-7, -1e-7, 0.5e-6, 1.5e-6, 2.5e-6, 4.5e9, 9.5e15, 2 ** 53 + 0.0, 3.4028234663852886e38, -3.4028234663852886e38, 1e-300, NaN, Infinity, -Infinity, 0.0005, 0.0015, 0.0025);
  const cases = values.flatMap((x) => [2, 3, 6].map((nd) => ({ x, nd })));
  const sums: number[][] = [];
  for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(random() * 120);
    sums.push(Array.from({ length: n }, () => (random() < 0.1 ? -1 : 1) * f32(random() * 10 ** (Math.floor(random() * 12) - 4))));
  }
  sums.push([1e100, 1, -1e100], [0.1, 0.2, 0.3], [-0], [-0, -0], [1e308, 1e308, -1e308], [Infinity, -Infinity], [NaN, 1]);
  const divs: [number, number][] = [];
  for (let i = 0; i < 300; i++) divs.push([Math.floor(random() * 1e9) - 5e8, 1 + Math.floor(random() * 1e5)]);

  const py = runPython<{ round: { repr: string; str: string; round: string; round0?: number }[]; sum: string[]; div: string[] }>('num', {
    round: cases.map(({ x, nd }) => ({ bits: bits(x), nd })),
    sum: sums.map((list) => list.map(bits)),
    div: divs,
  });

  it('repr/str of every value', () => {
    const mismatches = cases.filter((c, i) => pyFloatRepr(c.x) !== py.round[i]!.repr || pyFloatRepr(c.x) !== py.round[i]!.str);
    expect(mismatches).toEqual([]);
  });
  it('round(x, 2/3/6) of every value', () => {
    const mismatches = cases
      .map((c, i) => ({ ...c, ts: pyFloatRepr(pyRound(c.x, c.nd)), py: py.round[i]!.round }))
      .filter((m) => m.ts !== m.py);
    expect(mismatches).toEqual([]);
  });
  it('round(x) of every finite value', () => {
    const mismatches = cases.filter((c, i) => py.round[i]!.round0 !== undefined && pyRoundInt(c.x) !== py.round[i]!.round0);
    expect(mismatches).toEqual([]);
  });
  it('sum() of float lists (Neumaier, 3.12+)', () => {
    expect(sums.map((list) => pyFloatRepr(pySumFloats(list)))).toEqual(py.sum);
  });
  it('int / int', () => {
    expect(divs.map(([a, b]) => pyFloatRepr(pyTrueDivInt(a, b)))).toEqual(py.div);
  });
});
