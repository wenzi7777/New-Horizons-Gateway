// The calibration workbench's logic, free of React: reply parsing, the
// level/sensor bookkeeping, the UI state machine (a reducer) and every
// command sequence (flow) the Desktop's CalibrationWorkbench runs -- the
// maintenance hand-off, the pre-v1.5.1 zero fallback, refresh-after-failed-
// capture -- so each can be tested with a fake device.

import type { CommandOutcome } from '../../../shared/contract';
import {
  captureAllCommand,
  captureBaselineCommand,
  captureCellCommand,
  calibrationStatusCommand,
  deleteLevelCommand,
  dumpFitCommand,
  dumpLevelCommand,
  dumpTareCommand,
  enterMaintenanceCommand,
  exitMaintenanceCommand,
  sessionAbortCommand,
  sessionBeginCommand,
  sessionCommitCommand,
  setReferenceCommand,
  zeroClearCommand,
  zeroCommand,
  type Payload,
} from './commands';
import { parseCalibrationState, type CalibrationSummary } from './calibrationFlow';
import { calibrationSensorLabel, calibrationToStreamIndex } from './sensorLabel';

// ---- Replies ---------------------------------------------------------------

export type Outcome = { ok: boolean; code: string; result: Record<string, unknown> | null };

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Studio's CommandOutcome (the host already unwrapped `data`) as the Desktop's Outcome. */
export function outcomeFromCommand(outcome: CommandOutcome | null | undefined): Outcome {
  if (!outcome) return { ok: false, code: 'no_response', result: null };
  const data = recordValue(outcome.data);
  if (!outcome.ok) return { ok: false, code: outcome.message === 'error' ? '' : outcome.message, result: Object.keys(data).length > 0 ? data : null };
  return { ok: true, code: '', result: data };
}

/** A reply's payload: under `data` when relayed, at the top level otherwise. */
export function replyData(result: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const source = recordValue(result);
  const data = recordValue(source.data);
  return Object.keys(data).length > 0 ? data : source;
}

/** Draft layer while a session is open, otherwise the saved one. */
export function preferredLayer(source: Record<string, unknown>): Record<string, unknown> {
  const draft = recordValue(source.draft);
  return Object.keys(draft).length > 0 ? draft : recordValue(source.saved);
}

export type PreviewCell = { sensorIndex: number; value: number | null };

/** cells of a calibration_dump_tare / calibration_dump_level layer */
export function previewCells(layer: unknown): Map<number, PreviewCell> {
  const cells = new Map<number, PreviewCell>();
  const list = recordValue(layer).cells;
  if (!Array.isArray(list)) return cells;
  for (const item of list) {
    const cell = recordValue(item);
    const sensorIndex = numberValue(cell.sensor_index, -1);
    if (sensorIndex < 0) continue;
    const value = cell.value === null || cell.value === undefined || cell.calibrated === false ? null : numberValue(cell.value, 0);
    cells.set(sensorIndex, { sensorIndex, value });
  }
  return cells;
}

export function cellsFromReply(result: Record<string, unknown> | null): Map<number, PreviewCell> {
  return previewCells(preferredLayer(replyData(result)));
}

// ---- Levels and sensors ----------------------------------------------------

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** The firmware names a level by round(kPa * 1000); so does the workbench. */
export function levelKey(level: number): number {
  return Math.round(level * 1000);
}

export function capturedCount(cells: Map<number, PreviewCell>): number {
  let count = 0;
  cells.forEach((cell) => {
    if (cell.value != null) count += 1;
  });
  return count;
}

/** The next sensor without a value, starting at `from` and wrapping; `from` when all have one. */
export function firstUncaptured(cells: Map<number, PreviewCell>, totalSensors: number, from = 0): number {
  for (let offset = 0; offset < totalSensors; offset += 1) {
    const index = (from + offset) % totalSensors;
    if (cells.get(index)?.value == null) return index;
  }
  return from;
}

export type LevelRow = {
  key: number;
  level: number;
  /** null for a level added here with no capture yet: the device only learns a level from its first capture. */
  summary: CalibrationSummary | null;
};

/** The draft's levels plus the ones added here and not captured yet, lowest first. */
export function buildLevelRows(draftLevels: readonly CalibrationSummary[], addedLevels: readonly number[]): LevelRow[] {
  const rows = new Map<number, LevelRow>();
  for (const item of draftLevels) rows.set(levelKey(item.level), { key: levelKey(item.level), level: item.level, summary: item });
  for (const level of addedLevels) {
    if (!rows.has(levelKey(level))) rows.set(levelKey(level), { key: levelKey(level), level, summary: null });
  }
  return [...rows.values()].sort((a, b) => a.level - b.level);
}

/**
 * Known when the device has nothing at this level, or when the cells read
 * back agree with the device's own count; otherwise the matrix waits for a
 * fresh read rather than showing another level's (or stale) state.
 */
export function cellsKnown(row: LevelRow | null, cached: Map<number, PreviewCell> | undefined): boolean {
  if (!row) return false;
  const deviceCaptured = row.summary?.captured_points ?? 0;
  return deviceCaptured === 0 || (cached !== undefined && capturedCount(cached) === deviceCaptured);
}

export type LevelInputError = 'invalid' | 'exists';

/** "Add level": a positive kPa not already listed. */
export function parseLevelInput(input: string, rows: readonly LevelRow[]): { level: number } | { error: LevelInputError; existing?: LevelRow } {
  const level = Number(input);
  if (!input.trim() || !Number.isFinite(level) || level <= 0) return { error: 'invalid' };
  const existing = rows.find((row) => row.key === levelKey(level));
  if (existing) return { error: 'exists', existing };
  return { level };
}

/** A measured reference (manual entry): a finite kPa >= 0. */
export function parseReferenceInput(input: string): number | null {
  const value = Number(input);
  return input.trim() && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The reference differs from the level's name enough to show it (Desktop: >= 0.0005 kPa). */
export function referenceDiffers(level: number, reference: number): boolean {
  return Math.abs(reference - level) >= 0.0005;
}

/** Sort key for listing sensors in the displayed (CSV) order. */
export function byDisplayOrder(rows: number, cols: number) {
  return (a: { sensor_index: number }, b: { sensor_index: number }) =>
    calibrationToStreamIndex(a.sensor_index, rows, cols) - calibrationToStreamIndex(b.sensor_index, rows, cols);
}

/** Matrix cells laid out as the physical matrix, row by row; sensor = col * rows + row. */
export function matrixLayout(rows: number, cols: number): { sensorIndex: number; label: string }[] {
  const out: { sensorIndex: number; label: string }[] = [];
  if (rows <= 0 || cols <= 0) return out;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const sensorIndex = col * rows + row;
      out.push({ sensorIndex, label: calibrationSensorLabel(sensorIndex, rows, cols) });
    }
  }
  return out;
}

// ---- UI state machine ------------------------------------------------------

export type PendingAction = '' | 'zero' | 'clear_zero' | 'start' | 'baseline' | 'capture_all' | 'capture_one' | 'save' | 'cancel' | 'delete_level' | 'reference' | 'advanced';

export type ConfirmRequest = { kind: 'cancel' } | { kind: 'clear' } | { kind: 'save_partial'; unfitted: number } | { kind: 'delete_saved'; level: number };

/** The Desktop's confirm dialogs: string keys, the variables, and whether it is destructive. */
export function confirmSpec(request: ConfirmRequest): {
  title: 'calCancelConfirmTitle' | 'calClearConfirmTitle' | 'calSavePartialTitle' | 'calDeleteLevelConfirmTitle';
  message: 'calCancelConfirmMessage' | 'calClearConfirmMessage' | 'calSavePartialMessage' | 'calDeleteLevelConfirmMessage';
  confirm: 'calCancel' | 'clearCalibrationProfile' | 'calSave' | 'delete';
  vars: Record<string, string>;
  danger: boolean;
} {
  switch (request.kind) {
    case 'cancel':
      return { title: 'calCancelConfirmTitle', message: 'calCancelConfirmMessage', confirm: 'calCancel', vars: {}, danger: true };
    case 'clear':
      return { title: 'calClearConfirmTitle', message: 'calClearConfirmMessage', confirm: 'clearCalibrationProfile', vars: {}, danger: true };
    case 'save_partial':
      return { title: 'calSavePartialTitle', message: 'calSavePartialMessage', confirm: 'calSave', vars: { count: String(request.unfitted) }, danger: false };
    default:
      return { title: 'calDeleteLevelConfirmTitle', message: 'calDeleteLevelConfirmMessage', confirm: 'delete', vars: { level: formatNumber(request.level) }, danger: true };
  }
}

/** Save asks first when the draft leaves sensors unfitted (partial save). */
export function saveConfirmation(fit: { complete: boolean; cells_total: number; cells_fitted: number } | null): ConfirmRequest | null {
  return fit && !fit.complete ? { kind: 'save_partial', unfitted: fit.cells_total - fit.cells_fitted } : null;
}

/** The three-step indicator: -1 idle, 0 baseline, 1 levels, 2 save (ready). */
export function stepIndex(step: 'not_started' | 'baseline' | 'levels', saveReady: boolean): number {
  return step === 'not_started' ? -1 : step === 'baseline' ? 0 : saveReady ? 2 : 1;
}

export type WorkbenchState = {
  pending: PendingAction;
  baselineConfirmed: boolean;
  addedLevels: number[];
  selectedLevelKey: number | null;
  selectedSensor: number;
  /** Each level's cells as the device last reported them, by levelKey(). */
  levelCells: Map<number, Map<number, PreviewCell>>;
  loadingLevelKey: number | null;
  /** "key:captured" reads that failed, so a failing read is not retried in a loop. */
  failedLoads: Set<string>;
};

export const initialWorkbenchState: WorkbenchState = {
  pending: '',
  baselineConfirmed: false,
  addedLevels: [],
  selectedLevelKey: null,
  selectedSensor: 0,
  levelCells: new Map(),
  loadingLevelKey: null,
  failedLoads: new Set(),
};

export type WorkbenchAction =
  | { type: 'begin'; action: Exclude<PendingAction, ''> }
  | { type: 'end' }
  | { type: 'session_closed' }
  | { type: 'session_started' }
  | { type: 'baseline_confirmed' }
  | { type: 'add_level'; level: number }
  | { type: 'forget_level'; key: number }
  | { type: 'select_level'; key: number | null; totalSensors: number }
  | { type: 'select_sensor'; sensor: number }
  | { type: 'cells'; key: number; cells: Map<number, PreviewCell>; next?: 'keep_or_advance' | { after: number }; totalSensors: number }
  | { type: 'loading'; key: number | null }
  | { type: 'load_failed'; attempt: string }
  | { type: 'clamp_sensor'; totalSensors: number };

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case 'begin':
      // One command at a time, as the Desktop's withPending().
      return state.pending ? state : { ...state, pending: action.action };
    case 'end':
      return { ...state, pending: '' };
    case 'session_closed':
      return { ...state, baselineConfirmed: false, levelCells: new Map(), addedLevels: [], selectedLevelKey: null, failedLoads: new Set() };
    case 'session_started':
      return { ...state, baselineConfirmed: false };
    case 'baseline_confirmed':
      return { ...state, baselineConfirmed: true };
    case 'add_level':
      return { ...state, addedLevels: [...state.addedLevels, action.level], selectedLevelKey: levelKey(action.level), selectedSensor: 0 };
    case 'forget_level': {
      const levelCells = new Map(state.levelCells);
      levelCells.delete(action.key);
      return {
        ...state,
        addedLevels: state.addedLevels.filter((level) => levelKey(level) !== action.key),
        levelCells,
        selectedLevelKey: state.selectedLevelKey === action.key ? null : state.selectedLevelKey,
      };
    }
    case 'select_level': {
      const cells = action.key === null ? undefined : state.levelCells.get(action.key);
      return { ...state, selectedLevelKey: action.key, selectedSensor: cells ? firstUncaptured(cells, action.totalSensors) : 0 };
    }
    case 'select_sensor':
      return { ...state, selectedSensor: action.sensor };
    case 'cells': {
      const levelCells = new Map(state.levelCells).set(action.key, action.cells);
      let selectedSensor = state.selectedSensor;
      if (action.next === 'keep_or_advance') {
        // After a read: stay on an empty sensor, move on from a captured one.
        selectedSensor = action.cells.get(selectedSensor)?.value == null ? selectedSensor : firstUncaptured(action.cells, action.totalSensors, selectedSensor);
      } else if (action.next) {
        selectedSensor = firstUncaptured(action.cells, action.totalSensors, action.next.after + 1);
      }
      return { ...state, levelCells, selectedSensor };
    }
    case 'loading':
      return { ...state, loadingLevelKey: action.key };
    case 'load_failed':
      return { ...state, failedLoads: new Set(state.failedLoads).add(action.attempt) };
    case 'clamp_sensor':
      return state.selectedSensor >= action.totalSensors ? { ...state, selectedSensor: 0 } : state;
    default:
      return state;
  }
}

/** The selected level row; the first one when none (or a deleted one) is selected. */
export function resolveSelectedLevel(rows: readonly LevelRow[], selectedKey: number | null): LevelRow | null {
  return rows.find((row) => row.key === selectedKey) ?? null;
}

/** Whether the selected level's cells should be read from the device now. */
export function shouldLoadLevel(input: {
  row: LevelRow | null;
  known: boolean;
  busy: boolean;
  loading: boolean;
  connected: boolean;
  failedLoads: Set<string>;
}): string | null {
  const { row } = input;
  if (!row || input.known || input.busy || input.loading || !input.connected) return null;
  const attempt = `${row.key}:${row.summary?.captured_points ?? 0}`;
  return input.failedLoads.has(attempt) ? null : attempt;
}

// ---- Flows -----------------------------------------------------------------

/** Label keys the flows log their commands under (translated by the page). */
export type FlowLabel =
  | 'refreshStatus'
  | 'enterMaintenance'
  | 'exitMaintenance'
  | 'calZeroAction'
  | 'calZeroClear'
  | 'calStart'
  | 'calBaselineCapture'
  | 'calCaptureAll'
  | 'calSingleSensor'
  | 'calSetReference'
  | 'deleteCalibrationLevel'
  | 'calSave'
  | 'calCancel'
  | 'calLoadingLevel'
  | 'calExportData'
  | 'enableCalibrationProfile'
  | 'disableCalibrationProfile'
  | 'clearCalibrationProfile'
  | 'calFitSettingsTitle'
  | 'preview';

export interface FlowIO {
  command(label: FlowLabel, payload: Payload): Promise<Outcome>;
  /** Whether the device is in maintenance mode now (from the snapshot). */
  maintenanceMode: boolean;
}

export type FlowResult = { ok: true } | { ok: false; code: string };
const OK: FlowResult = { ok: true };
const failed = (code: string): FlowResult => ({ ok: false, code });

export async function refreshStatus(io: FlowIO): Promise<Outcome> {
  return io.command('refreshStatus', calibrationStatusCommand());
}

/** A capture whose reply was lost may still have been stored, so re-read -- not when nothing answered at all. */
export async function refreshAfterFailedCapture(io: FlowIO, outcome: Outcome): Promise<void> {
  if (outcome.code !== 'no_response') await refreshStatus(io);
}

export async function ensureMaintenance(io: FlowIO): Promise<FlowResult> {
  if (io.maintenanceMode) return OK;
  const entered = await io.command('enterMaintenance', enterMaintenanceCommand());
  return entered.ok ? OK : failed(entered.code);
}

/** Zero (normal mode); firmware before v1.5.1 refuses it outside maintenance, so enter, zero, leave. */
export async function zeroFlow(io: FlowIO): Promise<FlowResult & { needsFirmware?: boolean }> {
  let outcome = await io.command('calZeroAction', zeroCommand());
  if (!outcome.ok && outcome.code === 'maintenance_required') {
    const wasMaintenance = io.maintenanceMode;
    if (!wasMaintenance) {
      const entered = await ensureMaintenance(io);
      if (!entered.ok) return entered;
    }
    outcome = await io.command('calZeroAction', zeroCommand());
    if (!wasMaintenance) await io.command('exitMaintenance', exitMaintenanceCommand());
  }
  if (!outcome.ok) return failed(outcome.code);
  return { ok: true, needsFirmware: !parseCalibrationState(outcome.result).output_mode_reported };
}

export async function clearZeroFlow(io: FlowIO): Promise<FlowResult> {
  const outcome = await io.command('calZeroClear', zeroClearCommand());
  return outcome.ok ? OK : failed(outcome.code);
}

/** Start: maintenance (remembering that this flow entered it), then a draft session. */
export async function startFlow(io: FlowIO): Promise<FlowResult & { enteredMaintenance: boolean }> {
  let enteredMaintenance = false;
  if (!io.maintenanceMode) {
    const entered = await ensureMaintenance(io);
    if (!entered.ok) return { ...entered, enteredMaintenance: false };
    enteredMaintenance = true;
  }
  const outcome = await io.command('calStart', sessionBeginCommand());
  if (!outcome.ok) {
    if (enteredMaintenance) await io.command('exitMaintenance', exitMaintenanceCommand());
    return { ok: false, code: outcome.code, enteredMaintenance: false };
  }
  return { ok: true, enteredMaintenance };
}

export async function baselineFlow(io: FlowIO): Promise<FlowResult> {
  const outcome = await io.command('calBaselineCapture', captureBaselineCommand());
  if (!outcome.ok) {
    await refreshAfterFailedCapture(io, outcome);
    return failed(outcome.code);
  }
  await refreshStatus(io);
  return OK;
}

export type CaptureRequest =
  | { kind: 'all'; level: number; durationMs: number; reference?: number }
  | { kind: 'cell'; level: number; durationMs: number; sensorIndex: number };

/**
 * Capture all sensors or one at a level. With `reference` (a measured
 * pressure -- typed in, or from an automated chamber), the level's reference
 * is set right after, as the Desktop's chamber flow does.
 */
export async function captureFlow(io: FlowIO, request: CaptureRequest): Promise<(FlowResult & { cells?: Map<number, PreviewCell> })> {
  const payload =
    request.kind === 'all'
      ? captureAllCommand(request.level, request.durationMs)
      : captureCellCommand(request.sensorIndex, request.level, request.durationMs);
  const outcome = await io.command(request.kind === 'all' ? 'calCaptureAll' : 'calSingleSensor', payload);
  if (!outcome.ok) {
    await refreshAfterFailedCapture(io, outcome);
    return failed(outcome.code);
  }
  const cells = cellsFromReply(outcome.result);
  if (request.kind === 'all' && request.reference !== undefined && Number.isFinite(request.reference)) {
    const set = await io.command('calSetReference', setReferenceCommand(request.level, request.reference));
    if (!set.ok) {
      await refreshStatus(io);
      return { ok: false, code: set.code, cells };
    }
  }
  await refreshStatus(io);
  return { ok: true, cells };
}

/** Manual entry of the pressure actually applied at a captured level. */
export async function setReferenceFlow(io: FlowIO, level: number, reference: number): Promise<FlowResult> {
  const outcome = await io.command('calSetReference', setReferenceCommand(level, reference));
  return outcome.ok ? OK : failed(outcome.code);
}

export async function loadLevelFlow(io: FlowIO, level: number): Promise<FlowResult & { cells?: Map<number, PreviewCell> }> {
  const outcome = await io.command('calLoadingLevel', dumpLevelCommand(level));
  return outcome.ok ? { ok: true, cells: cellsFromReply(outcome.result) } : failed(outcome.code);
}

/** A level with no capture is only forgotten locally; a captured one is deleted on the device. */
export async function deleteDraftLevelFlow(io: FlowIO, row: LevelRow): Promise<FlowResult & { sent: boolean }> {
  if (!row.summary) return { ok: true, sent: false };
  const outcome = await io.command('deleteCalibrationLevel', deleteLevelCommand(row.level));
  return outcome.ok ? { ok: true, sent: true } : { ok: false, code: outcome.code, sent: true };
}

/** Hand the device back to normal scanning when this flow put it in maintenance. */
export async function releaseMaintenance(io: FlowIO, enteredMaintenance: boolean): Promise<void> {
  if (enteredMaintenance) await io.command('exitMaintenance', exitMaintenanceCommand());
}

export async function saveFlow(io: FlowIO, enteredMaintenance: boolean): Promise<FlowResult> {
  const outcome = await io.command('calSave', sessionCommitCommand(true));
  if (!outcome.ok) return failed(outcome.code);
  await releaseMaintenance(io, enteredMaintenance);
  return OK;
}

export async function cancelFlow(io: FlowIO, enteredMaintenance: boolean): Promise<FlowResult> {
  const outcome = await io.command('calCancel', sessionAbortCommand());
  if (!outcome.ok) return failed(outcome.code);
  await releaseMaintenance(io, enteredMaintenance);
  return OK;
}

/** An advanced command; maintenance-only ones enter it and leave again unless a session holds it. */
export async function advancedFlow(
  io: FlowIO,
  label: FlowLabel,
  payload: Payload,
  options: { needsMaintenance?: boolean; sessionActive: boolean },
): Promise<FlowResult & { result?: Record<string, unknown> | null }> {
  const wasMaintenance = io.maintenanceMode;
  if (options.needsMaintenance) {
    const entered = await ensureMaintenance(io);
    if (!entered.ok) return entered;
  }
  const outcome = await io.command(label, payload);
  if (options.needsMaintenance && !wasMaintenance && !options.sessionActive) {
    await io.command('exitMaintenance', exitMaintenanceCommand());
  }
  return outcome.ok ? { ok: true, result: outcome.result } : failed(outcome.code);
}

/** Everything the device's fit was made from, plus the fit: status, tare, fit and every saved level. */
export async function exportDumpsFlow(io: FlowIO, savedLevels: readonly number[]): Promise<(FlowResult & { dumps?: Record<string, Record<string, unknown>> })> {
  const steps: [string, Payload][] = [
    ['status', calibrationStatusCommand()],
    ['tare', dumpTareCommand()],
    ['fit', dumpFitCommand()],
    ...savedLevels.map((level): [string, Payload] => [`level_${level}`, dumpLevelCommand(level)]),
  ];
  const dumps: Record<string, Record<string, unknown>> = {};
  for (const [key, payload] of steps) {
    const outcome = await io.command('calExportData', payload);
    if (!outcome.ok) return failed(outcome.code);
    dumps[key] = replyData(outcome.result);
  }
  return { ok: true, dumps };
}

// ---- Export files ----------------------------------------------------------

export const CALIBRATION_MODEL = 'p = a + b*sqrt(x) + c*x, x = readout(raw - tare)';

/** The Desktop's JSON export, unchanged. */
export function exportJson(input: { dumps: Record<string, unknown>; uid: string; rows: number; cols: number; now: Date }): string {
  return JSON.stringify(
    { exported_at: input.now.toISOString(), device_uid: input.uid, matrix_shape: { rows: input.rows, cols: input.cols }, model: CALIBRATION_MODEL, ...input.dumps },
    null,
    2,
  );
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Capture data as one long CSV: the baseline and every level, saved and
 * draft layers, one row per sensor. sensor_label is the CSV/stream numbering
 * (P1.. row-major); sensor_index stays the firmware's calibration index.
 */
export function captureCsv(dumps: Record<string, unknown>, rows: number, cols: number): string {
  const header = ['kind', 'level_kpa', 'reference_kpa', 'layer', 'sensor_label', 'sensor_index', 'row', 'col', 'value_mv'];
  const lines = [header.join(',')];
  const status = parseCalibrationState(dumps.status);
  const references = new Map(status.levels.map((item) => [levelKey(item.level), item.reference]));
  const emit = (kind: string, level: number | null, source: unknown) => {
    const record = recordValue(source);
    for (const layer of ['saved', 'draft'] as const) {
      const cells = [...previewCells(record[layer]).values()]
        .map((cell) => ({ ...cell, sensor_index: cell.sensorIndex }))
        .sort(byDisplayOrder(rows, cols));
      for (const cell of cells) {
        const row = rows > 0 ? cell.sensorIndex % rows : '';
        const col = rows > 0 ? Math.floor(cell.sensorIndex / rows) : '';
        const reference = level === null ? '' : references.get(levelKey(level)) ?? level;
        lines.push(
          [kind, level ?? '', reference, layer, calibrationSensorLabel(cell.sensorIndex, rows, cols), cell.sensorIndex, row, col, cell.value ?? '']
            .map(csvCell)
            .join(','),
        );
      }
    }
  };
  emit('tare', null, dumps.tare);
  const levels = Object.keys(dumps)
    .filter((key) => key.startsWith('level_'))
    .map((key) => ({ key, level: Number(key.slice('level_'.length)) }))
    .filter((item) => Number.isFinite(item.level))
    .sort((a, b) => a.level - b.level);
  for (const item of levels) emit('level', item.level, dumps[item.key]);
  return lines.join('\n') + '\n';
}

export function exportFileStem(uid: string, now: Date): string {
  return `calibration-${uid}-${now.toISOString().replace(/[:.]/g, '-')}`;
}

// ---- Automated targets (hook) ------------------------------------------------

/**
 * HOOK for the lab's automated pressure chamber (the "tools" area's client,
 * built separately). Not wired to the page yet: when it lands, an adapter
 * implementing this drives automatedLevelFlow() per level, and the measured
 * mean becomes the level's reference, exactly like the Desktop's
 * PressureCalibrationPanel (capture_all, then calibration_set_reference).
 * Until then the operator applies pressure by hand and may type the measured
 * value (setReferenceFlow / captureFlow's `reference`).
 */
export interface PressureTargetSource {
  /** Command the chamber to `kpa` (gauge) and resolve once it is stable. */
  settle(kpa: number): Promise<{ settledKpa: number | null }>;
  /** Mean pressure measured while `capture` runs (relative to the chamber's zero). */
  measureDuring<T>(capture: () => Promise<T>): Promise<{ result: T; meanKpa: number | null }>;
}

export async function automatedLevelFlow(io: FlowIO, source: PressureTargetSource, level: number, durationMs: number): Promise<FlowResult & { reference?: number | null }> {
  await source.settle(level);
  const { result, meanKpa } = await source.measureDuring(() => captureFlow(io, { kind: 'all', level, durationMs }));
  if (!result.ok) return result;
  if (meanKpa !== null && Number.isFinite(meanKpa)) {
    const set = await setReferenceFlow(io, level, meanKpa);
    if (!set.ok) return set;
  }
  return { ok: true, reference: meanKpa };
}
