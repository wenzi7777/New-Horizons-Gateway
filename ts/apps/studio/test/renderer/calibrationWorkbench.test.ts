import { describe, expect, it } from 'vitest';

import * as cmd from '../../src/renderer/areas/calibration/commands';
import { valueToCsv } from '../../src/renderer/areas/calibration/valueFormat';
import {
  advancedFlow,
  automatedLevelFlow,
  baselineFlow,
  buildLevelRows,
  cancelFlow,
  captureCsv,
  captureFlow,
  cellsKnown,
  confirmSpec,
  deleteDraftLevelFlow,
  exportDumpsFlow,
  exportJson,
  firstUncaptured,
  initialWorkbenchState,
  matrixLayout,
  outcomeFromCommand,
  parseLevelInput,
  parseReferenceInput,
  previewCells,
  saveConfirmation,
  saveFlow,
  shouldLoadLevel,
  startFlow,
  stepIndex,
  workbenchReducer,
  zeroFlow,
  type FlowIO,
  type Outcome,
} from '../../src/renderer/areas/calibration/workbenchLogic';
import { calibrationStrings } from '../../src/renderer/areas/calibration/strings';

describe('payload builders (exact Desktop payloads)', () => {
  it('builds every calibration command', () => {
    expect(cmd.calibrationStatusCommand()).toEqual({ command: 'calibration_status' });
    expect(cmd.enterMaintenanceCommand()).toEqual({ command: 'enter_maintenance', reason: 'calibration' });
    expect(cmd.exitMaintenanceCommand()).toEqual({ command: 'exit_maintenance' });
    expect(cmd.zeroCommand()).toEqual({ command: 'calibration_tare_capture', duration_ms: 1000 });
    expect(cmd.zeroClearCommand()).toEqual({ command: 'calibration_tare_clear' });
    expect(cmd.sessionBeginCommand()).toEqual({ command: 'calibration_session_begin' });
    expect(cmd.sessionAbortCommand()).toEqual({ command: 'calibration_session_abort' });
    expect(cmd.sessionCommitCommand()).toEqual({ command: 'calibration_session_commit', auto_enable: true });
    expect(cmd.captureBaselineCommand()).toEqual({ command: 'calibration_capture_tare', duration_ms: 3000 });
    expect(cmd.captureAllCommand(10, 3000)).toEqual({ command: 'calibration_capture_all', level: 10, duration_ms: 3000 });
    expect(cmd.captureCellCommand(7, 2.5, 500)).toEqual({ command: 'calibration_capture_cell', sensor_index: 7, level: 2.5, duration_ms: 500 });
    expect(cmd.setReferenceCommand(10, 10.12345)).toEqual({ command: 'calibration_set_reference', level: 10, reference: 10.123 });
    expect(cmd.deleteLevelCommand(6)).toEqual({ command: 'calibration_delete_level', level: 6 });
    expect(cmd.enableCommand()).toEqual({ command: 'calibration_enable' });
    expect(cmd.disableCommand()).toEqual({ command: 'calibration_disable' });
    expect(cmd.clearProfileCommand()).toEqual({ command: 'calibration_clear_profile' });
    expect(cmd.setFitCommand(3)).toEqual({ command: 'calibration_set_fit', min_level: 3 });
    expect(cmd.dumpTareCommand()).toEqual({ command: 'calibration_dump_tare' });
    expect(cmd.dumpLevelCommand(12)).toEqual({ command: 'calibration_dump_level', level: 12 });
    expect(cmd.dumpFitCommand()).toEqual({ command: 'calibration_dump_fit' });
  });

  it('clamps capture durations to what the host can wait for', () => {
    expect(cmd.captureDurationMs(3)).toBe(3000);
    expect(cmd.captureDurationMs(0.1)).toBe(500);
    expect(cmd.captureDurationMs(60)).toBe(cmd.MAX_CAPTURE_MS);
    expect(cmd.captureDurationMs(Number.NaN)).toBe(3000);
  });
});

/** A fake device: answers by command name, records every payload. */
function fakeIO(answers: Record<string, Outcome | ((n: number) => Outcome)> = {}, maintenanceMode = false) {
  const sent: Record<string, unknown>[] = [];
  const counts: Record<string, number> = {};
  const io: FlowIO = {
    maintenanceMode,
    async command(_label, payload) {
      sent.push(payload);
      const name = String(payload.command);
      counts[name] = (counts[name] ?? 0) + 1;
      const answer = answers[name];
      if (typeof answer === 'function') return answer(counts[name]!);
      return answer ?? { ok: true, code: '', result: {} };
    },
  };
  return { io, sent, names: () => sent.map((p) => p.command) };
}
const err = (code: string): Outcome => ({ ok: false, code, result: null });
const okResult = (result: Record<string, unknown>): Outcome => ({ ok: true, code: '', result });

describe('flows', () => {
  it('start enters maintenance first and remembers it', async () => {
    const { io, names } = fakeIO();
    expect(await startFlow(io)).toEqual({ ok: true, enteredMaintenance: true });
    expect(names()).toEqual(['enter_maintenance', 'calibration_session_begin']);
  });

  it('start in maintenance does not touch it; a failed begin releases what it entered', async () => {
    const already = fakeIO({}, true);
    expect(await startFlow(already.io)).toEqual({ ok: true, enteredMaintenance: false });
    expect(already.names()).toEqual(['calibration_session_begin']);
    const failing = fakeIO({ calibration_session_begin: err('calibration_session_active') });
    expect(await startFlow(failing.io)).toEqual({ ok: false, code: 'calibration_session_active', enteredMaintenance: false });
    expect(failing.names()).toEqual(['enter_maintenance', 'calibration_session_begin', 'exit_maintenance']);
  });

  it('zero falls back to maintenance on old firmware and flags it', async () => {
    const { io, names } = fakeIO({ calibration_tare_capture: (n) => (n === 1 ? err('maintenance_required') : okResult({})) });
    const result = await zeroFlow(io);
    expect(result).toEqual({ ok: true, needsFirmware: true });
    expect(names()).toEqual(['calibration_tare_capture', 'enter_maintenance', 'calibration_tare_capture', 'exit_maintenance']);
    const modern = fakeIO({ calibration_tare_capture: okResult({ output_mode: 'tared' }) });
    expect(await zeroFlow(modern.io)).toEqual({ ok: true, needsFirmware: false });
  });

  it('baseline refreshes after success, and after a lost reply but not after silence', async () => {
    const good = fakeIO();
    expect(await baselineFlow(good.io)).toEqual({ ok: true });
    expect(good.names()).toEqual(['calibration_capture_tare', 'calibration_status']);
    const lost = fakeIO({ calibration_capture_tare: err('command_timeout') });
    await baselineFlow(lost.io);
    expect(lost.names()).toEqual(['calibration_capture_tare', 'calibration_status']);
    const silent = fakeIO({ calibration_capture_tare: err('no_response') });
    await baselineFlow(silent.io);
    expect(silent.names()).toEqual(['calibration_capture_tare']);
  });

  it('captures return the draft cells, and set a measured reference when given', async () => {
    const dump = { draft: { cells: [{ sensor_index: 0, value: 12.5 }, { sensor_index: 1, value: null }] }, saved: { cells: [] } };
    const { io, sent } = fakeIO({ calibration_capture_all: okResult(dump), calibration_capture_cell: okResult(dump) });
    const all = await captureFlow(io, { kind: 'all', level: 10, durationMs: 3000, reference: 10.2 });
    expect(all.ok).toBe(true);
    expect(sent).toEqual([cmd.captureAllCommand(10, 3000), cmd.setReferenceCommand(10, 10.2), cmd.calibrationStatusCommand()]);
    if (all.ok && 'cells' in all) expect(all.cells?.get(0)?.value).toBe(12.5);
    sent.length = 0;
    await captureFlow(io, { kind: 'cell', level: 10, durationMs: 500, sensorIndex: 4 });
    expect(sent).toEqual([cmd.captureCellCommand(4, 10, 500), cmd.calibrationStatusCommand()]);
  });

  it('deleting a level never captured stays local', async () => {
    const { io, names } = fakeIO();
    expect(await deleteDraftLevelFlow(io, { key: 5000, level: 5, summary: null })).toEqual({ ok: true, sent: false });
    expect(names()).toEqual([]);
  });

  it('save and cancel hand maintenance back only when the flow took it', async () => {
    const a = fakeIO();
    await saveFlow(a.io, true);
    expect(a.sent).toEqual([cmd.sessionCommitCommand(), cmd.exitMaintenanceCommand()]);
    const b = fakeIO();
    await cancelFlow(b.io, false);
    expect(b.names()).toEqual(['calibration_session_abort']);
    const c = fakeIO({ calibration_session_commit: err('calibration_incomplete') });
    expect(await saveFlow(c.io, true)).toEqual({ ok: false, code: 'calibration_incomplete' });
    expect(c.names()).toEqual(['calibration_session_commit']);
  });

  it('maintenance-only advanced commands leave maintenance again unless a session holds it', async () => {
    const a = fakeIO();
    await advancedFlow(a.io, 'clearCalibrationProfile', cmd.clearProfileCommand(), { needsMaintenance: true, sessionActive: false });
    expect(a.names()).toEqual(['enter_maintenance', 'calibration_clear_profile', 'exit_maintenance']);
    const b = fakeIO();
    await advancedFlow(b.io, 'calFitSettingsTitle', cmd.setFitCommand(3), { needsMaintenance: true, sessionActive: true });
    expect(b.names()).toEqual(['enter_maintenance', 'calibration_set_fit']);
  });

  it('export reads status, tare, fit and every saved level', async () => {
    const { io, sent } = fakeIO();
    const result = await exportDumpsFlow(io, [6, 10]);
    expect(result.ok).toBe(true);
    expect(sent).toEqual([cmd.calibrationStatusCommand(), cmd.dumpTareCommand(), cmd.dumpFitCommand(), cmd.dumpLevelCommand(6), cmd.dumpLevelCommand(10)]);
  });

  it('the automated-target hook settles, captures, and records the measured mean', async () => {
    const { io, sent } = fakeIO();
    const targets: number[] = [];
    const result = await automatedLevelFlow(
      io,
      { settle: async (kpa) => (targets.push(kpa), { settledKpa: kpa }), measureDuring: async (run) => ({ result: await run(), meanKpa: 9.87 }) },
      10,
      10000,
    );
    expect(result).toEqual({ ok: true, reference: 9.87 });
    expect(targets).toEqual([10]);
    expect(sent.map((p) => p.command)).toEqual(['calibration_capture_all', 'calibration_status', 'calibration_set_reference']);
  });
});

describe('workbench state machine', () => {
  it('runs one action at a time', () => {
    const busy = workbenchReducer(initialWorkbenchState, { type: 'begin', action: 'save' });
    expect(workbenchReducer(busy, { type: 'begin', action: 'cancel' }).pending).toBe('save');
    expect(workbenchReducer(busy, { type: 'end' }).pending).toBe('');
  });

  it('adds, selects, advances and forgets levels', () => {
    let s = workbenchReducer(initialWorkbenchState, { type: 'add_level', level: 10 });
    expect(s.selectedLevelKey).toBe(10000);
    const cells = previewCells({ cells: [{ sensor_index: 0, value: 1 }, { sensor_index: 1, value: 2 }] });
    s = workbenchReducer(s, { type: 'cells', key: 10000, cells, next: { after: 0 }, totalSensors: 4 });
    expect(s.selectedSensor).toBe(2);
    s = workbenchReducer(s, { type: 'select_level', key: 10000, totalSensors: 4 });
    expect(s.selectedSensor).toBe(2);
    s = workbenchReducer(s, { type: 'forget_level', key: 10000 });
    expect(s.addedLevels).toEqual([]);
    expect(s.selectedLevelKey).toBeNull();
    expect(s.levelCells.size).toBe(0);
  });

  it('closing the session resets the draft bookkeeping', () => {
    let s = workbenchReducer(initialWorkbenchState, { type: 'baseline_confirmed' });
    s = workbenchReducer(s, { type: 'add_level', level: 6 });
    s = workbenchReducer(s, { type: 'session_closed' });
    expect(s.baselineConfirmed).toBe(false);
    expect(s.addedLevels).toEqual([]);
  });

  it('level rows merge draft levels and added ones; cells are trusted only when counts agree', () => {
    const summary = { level: 10, reference: 10, captured_points: 2, total_points: 4, missing_points: 2, complete: false, source: 'draft' };
    const rows = buildLevelRows([summary], [5, 10]);
    expect(rows.map((row) => [row.level, row.summary !== null])).toEqual([[5, false], [10, true]]);
    expect(cellsKnown(rows[0]!, undefined)).toBe(true);
    expect(cellsKnown(rows[1]!, undefined)).toBe(false);
    expect(cellsKnown(rows[1]!, previewCells({ cells: [{ sensor_index: 0, value: 1 }, { sensor_index: 3, value: 1 }] }))).toBe(true);
    const failed = new Set(['10000:2']);
    expect(shouldLoadLevel({ row: rows[1]!, known: false, busy: false, loading: false, connected: true, failedLoads: new Set() })).toBe('10000:2');
    expect(shouldLoadLevel({ row: rows[1]!, known: false, busy: false, loading: false, connected: true, failedLoads: failed })).toBeNull();
  });

  it('validates level and reference input', () => {
    const rows = buildLevelRows([], [10]);
    expect(parseLevelInput('abc', rows)).toEqual({ error: 'invalid' });
    expect(parseLevelInput('-1', rows)).toEqual({ error: 'invalid' });
    expect(parseLevelInput('10.0', rows)).toMatchObject({ error: 'exists' });
    expect(parseLevelInput('12.5', rows)).toEqual({ level: 12.5 });
    expect(parseReferenceInput('')).toBeNull();
    expect(parseReferenceInput('-0.1')).toBeNull();
    expect(parseReferenceInput('9.95')).toBe(9.95);
  });

  it('confirms partial saves and destructive steps', () => {
    expect(saveConfirmation({ complete: true, cells_total: 4, cells_fitted: 4 })).toBeNull();
    expect(saveConfirmation({ complete: false, cells_total: 4, cells_fitted: 3 })).toEqual({ kind: 'save_partial', unfitted: 1 });
    expect(confirmSpec({ kind: 'save_partial', unfitted: 1 }).danger).toBe(false);
    expect(confirmSpec({ kind: 'delete_saved', level: 2.5 }).vars).toEqual({ level: '2.5' });
    expect([stepIndex('not_started', false), stepIndex('baseline', false), stepIndex('levels', false), stepIndex('levels', true)]).toEqual([-1, 0, 1, 2]);
  });

  it('lays the matrix out physically with P1.. row-major labels', () => {
    expect(matrixLayout(2, 3).map((c) => `${c.sensorIndex}:${c.label}`)).toEqual(['0:P1', '2:P2', '4:P3', '1:P4', '3:P5', '5:P6']);
    expect(firstUncaptured(new Map(), 4, 2)).toBe(2);
  });
});

describe('replies and exports', () => {
  it('maps studio outcomes to the Desktop outcome', () => {
    expect(outcomeFromCommand({ ok: false, message: 'maintenance_required', data: {} })).toEqual({ ok: false, code: 'maintenance_required', result: null });
    expect(outcomeFromCommand({ ok: true, message: 'ok', data: { enabled: true } })).toEqual({ ok: true, code: '', result: { enabled: true } });
    expect(outcomeFromCommand(null).code).toBe('no_response');
  });

  it('writes capture CSV in display order with references, and the JSON record', () => {
    const dumps = {
      status: { enabled: true, session_active: false, tare_complete: true, levels: [{ level: 10, reference: 10.12 }] },
      tare: { saved: { cells: [{ sensor_index: 1, value: 3 }, { sensor_index: 0, value: 2 }] } },
      fit: {},
      level_10: { saved: { cells: [{ sensor_index: 0, value: 50 }] } },
    };
    const csv = captureCsv(dumps, 2, 1).trim().split('\n');
    expect(csv[0]).toBe('kind,level_kpa,reference_kpa,layer,sensor_label,sensor_index,row,col,value_mv');
    expect(csv.slice(1)).toEqual(['tare,,,saved,P1,0,0,0,2', 'tare,,,saved,P2,1,1,0,3', 'level,10,10.12,saved,P1,0,0,0,50']);
    const json = JSON.parse(exportJson({ dumps, uid: 'ABC', rows: 2, cols: 1, now: new Date(0) }));
    expect(json).toMatchObject({ device_uid: 'ABC', matrix_shape: { rows: 2, cols: 1 }, exported_at: '1970-01-01T00:00:00.000Z' });
  });

  it('valueToCsv (ported) flattens paths and quotes cells', () => {
    expect(valueToCsv({ a: [1, { b: 'x"y' }], c: null })).toBe('"path","value"\n"a[0]","1"\n"a[1].b","x""y"\n"c",""');
    expect(valueToCsv(new Uint8Array([1, 255]))).toBe('"path","value"\n"$","01 ff"');
  });

  it('every locale has every string', () => {
    const keys = Object.keys(calibrationStrings.en).sort();
    expect(Object.keys(calibrationStrings.ja).sort()).toEqual(keys);
    expect(Object.keys(calibrationStrings['zh-CN']).sort()).toEqual(keys);
    for (const dict of Object.values(calibrationStrings)) for (const value of Object.values(dict)) expect(value).toBeTruthy();
  });
});
