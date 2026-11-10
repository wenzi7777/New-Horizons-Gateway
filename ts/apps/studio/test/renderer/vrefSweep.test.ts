// Ported from New-Horizons-Desktop frontend/tests/vrefSweep.test.mjs and batteryProfile.test.mjs (v2.0.F).
import { describe, expect, it } from 'vitest';

import { batteryRecognisedFromId, normalizeBatteryStatus } from '../../src/renderer/lib/batteryProfile';
import { rsSpreadFraction, summarizeSweep, sweepCsv } from '../../src/renderer/lib/vrefSweep';

// 2 rows x 2 cols; Rfb 20k, a cell of Rs = 10k reads Vref * (1 + 20k/10k) = 3 * Vref.
function step(vref: number, rs: number, rfb = 20000) {
  const v = (r: number | null) => (r === null ? vref : vref * (1 + rfb / r));
  return { vref_mv: vref, matrix_mv: [v(rs), v(null), v(null), v(rs)] };
}
const measured = { rfb_ohm: [20000, 20000], offset_mv: [0, 0] };

describe('vref sweep', () => {
  it('a pure resistance keeps its Rs across Vref', () => {
    const summary = summarizeSweep([step(200, 10000), step(300, 10000), step(500, 10000)], 2, 2, measured);
    expect(summary.map((s) => Math.round(s.rsMedianOhm!))).toEqual([10000, 10000, 10000]);
    expect(summary[0]!.usedCells).toBe(2);
    expect(rsSpreadFraction(summary)! < 1e-9).toBe(true);
  });
  it('a material whose Rs falls with Vref shows a spread', () => {
    expect(rsSpreadFraction(summarizeSweep([step(200, 12000), step(500, 8000)], 2, 2, measured))!).toBeGreaterThan(0.3);
  });
  it('cells at the rail are counted, not turned into a resistance', () => {
    const [only] = summarizeSweep([{ vref_mv: 330, matrix_mv: [3100, 330, 330, 3173] }], 2, 2, measured);
    expect(only!.saturatedCells).toBe(2);
    expect(only!.rsMedianOhm).toBeNull();
  });
  it('without a measured Rfb the soldered value is used, and without either Rs is unknown', () => {
    const bare = { vref_mv: 330, matrix_mv: [990, 330, 330, 990] };
    expect(Math.round(summarizeSweep([bare], 2, 2, {}, 20000)[0]!.rsMedianOhm!)).toBe(10000);
    expect(summarizeSweep([bare], 2, 2)[0]!.rsMedianOhm).toBeNull();
    expect(summarizeSweep([bare], 2, 2)[0]!.rfbMeanOhm).toBeNull();
  });
  it("a row's ADC offset moves where no signal is", () => {
    const [only] = summarizeSweep([{ vref_mv: 330, matrix_mv: [339 + 660, 339, 339, 339 + 660] }], 2, 2, { rfb_ohm: [20000, 20000], offset_mv: [9, 9] });
    expect(Math.round(only!.rsMedianOhm!)).toBe(10000);
    expect(only!.usedCells).toBe(2);
  });
  it('the csv is one line per vref and cell, row-major', () => {
    const lines = sweepCsv([step(300, 10000)], 2, 2, measured).trim().split('\n');
    expect(lines[0]).toBe('vref_mv,row,col,rfb_ohm,offset_mv,raw_mv');
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe('300,0,1,20000,0,300');
  });
});

describe('battery recognised from its ID resistor (v2.0.F)', () => {
  it('is reported as auto', () => {
    const battery = normalizeBatteryStatus({ battery_present: true, profile_source: 'auto', profile_resolved: true, capacity_mah: 500, max_charge_current_ma: 350, battery_id: { read_ok: true, kind: 'known', mv: 1100, ohm: 100000 } });
    expect(battery.batteryId).toEqual({ readOk: true, kind: 'known', mv: 1100, ohm: 100000 });
    expect(batteryRecognisedFromId(battery)).toBe(true);
    expect(batteryRecognisedFromId(normalizeBatteryStatus({ profile_source: 'manual' }))).toBe(false);
    expect(normalizeBatteryStatus({ profile_source: 'manual' }).batteryId).toBeNull();
  });
});
