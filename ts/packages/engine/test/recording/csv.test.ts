import { describe, expect, it } from 'vitest';
import { csvCell, csvParse, csvRow } from '../../src/recording/csv';
import { PyFloat } from '../../src/parse/pyJson';
import { bits, hasPython, rng, runPython } from './pyHarness';

type Typed = { i: number } | { f: string } | { s: string } | { b: boolean } | null;

describe('csv writer', () => {
  it('quotes like csv.writer', () => {
    expect(csvRow(['a,b', 'q"x', 'l\nn', 'cr\rx', ' sp', '', null, new PyFloat(1), -0.5, true, 'tab\tx', 'é'])).toBe(
      '"a,b","q""x","l\nn","cr\rx", sp,,,1.0,-0.5,True,tab\tx,é\r\n',
    );
    expect(csvRow([''])).toBe('""\r\n');
    expect(csvRow([])).toBe('\r\n');
    expect(csvCell(new PyFloat(NaN))).toBe('nan');
  });
  it('reads back what it writes', () => {
    const rows = [['a,b', 'q"x', 'l\nn', ''], ['1', '2']];
    expect(csvParse(rows.map((r) => csvRow(r)).join(''))).toEqual(rows);
    expect(csvParse('a,b\n\nc\r\n')).toEqual([['a', 'b'], [], ['c']]);
  });
});

describe.skipIf(!hasPython)('csv writer, differential', () => {
  const random = rng(99);
  const pieces = ['a', ',', '"', '\n', '\r', ' ', 'é', '日本', '\t', '', 'x"y', "'", '\\'];
  const rows: Typed[][] = [];
  for (let r = 0; r < 300; r++) {
    const row: Typed[] = [];
    const n = Math.floor(random() * 8);
    for (let c = 0; c < n; c++) {
      const kind = random();
      if (kind < 0.25) row.push({ i: Math.floor((random() - 0.5) * 1e12) });
      else if (kind < 0.55) row.push({ f: bits((random() - 0.5) * 10 ** (Math.floor(random() * 30) - 15)) });
      else if (kind < 0.6) row.push(null);
      else if (kind < 0.65) row.push({ b: random() < 0.5 });
      else row.push({ s: Array.from({ length: Math.floor(random() * 4) }, () => pieces[Math.floor(random() * pieces.length)]).join('') });
    }
    rows.push(row);
  }
  rows.push([{ s: '' }], [], [{ f: bits(-0) }, { f: bits(NaN) }, { f: bits(1e16) }, { f: bits(100) }]);
  const fromBits = (hex: string) => new DataView(Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16))).buffer).getFloat64(0);
  const toValue = (t: Typed): unknown =>
    t === null ? null : 'i' in t ? t.i : 'f' in t ? new PyFloat(fromBits(t.f)) : 'b' in t ? t.b : t.s;

  it('writes the same bytes as csv.writer', () => {
    const py = runPython<string>('csv', { rows });
    expect(rows.map((row) => csvRow(row.map(toValue))).join('')).toBe(py);
  });
});
