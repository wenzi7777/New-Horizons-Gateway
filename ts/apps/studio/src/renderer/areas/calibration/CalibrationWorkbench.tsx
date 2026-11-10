// The calibration workbench (device page, Calibration tab): a port of the
// Desktop's CalibrationWorkbench. All rules and command sequences live in
// ./workbench.ts and ./calibrationFlow.ts; this file only renders and wires.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Check, CircleCheck, Download, Plus } from 'lucide-react';

import type { DeviceView } from '../../../shared/contract';
import { Card, Disclosure, Notice, useConfirm, NumberInput } from '../../components/ui';
import { useStudio } from '../../state/studio';
import { calibrationApi } from './api';
import {
  calibrationErrorKey,
  calibrationSnapshotKey,
  canSaveCalibration,
  chooseCalibrationState,
  getCalibrationStep,
  isFullCalibrationStatus,
  parseCalibrationState,
  saturatingSensorReports,
  sensorPointStatuses,
  unfittedSensorReports,
  zeroBlockedReason,
  type CalibrationFitSettings,
  type CalibrationFitSummary,
  type CalibrationOverride,
  type CalibrationState,
  type SensorFitReport,
} from './calibrationFlow';
import { BASELINE_DURATION_MS, MAX_CAPTURE_MS, ZERO_DURATION_MS, calibrationStatusCommand, captureDurationMs, clearProfileCommand, deleteLevelCommand, disableCommand, dumpLevelCommand, dumpTareCommand, enableCommand, enterMaintenanceCommand, exitMaintenanceCommand, setFitCommand, type Payload } from './commands';
import { calibrationSensorLabel } from './sensorLabel';
import { calibrationStrings, type CalKey } from './strings';
import { useAreaT } from '../i18n';
import {
  advancedFlow,
  baselineFlow,
  buildLevelRows,
  byDisplayOrder,
  cancelFlow,
  captureCsv,
  captureFlow,
  cellsFromReply,
  cellsKnown,
  clearZeroFlow,
  confirmSpec,
  deleteDraftLevelFlow,
  exportDumpsFlow,
  exportFileStem,
  exportJson,
  formatNumber,
  initialWorkbenchState,
  loadLevelFlow,
  matrixLayout,
  outcomeFromCommand,
  parseLevelInput,
  parseReferenceInput,
  referenceDiffers,
  resolveSelectedLevel,
  saveConfirmation,
  saveFlow,
  setReferenceFlow,
  shouldLoadLevel,
  startFlow,
  stepIndex,
  workbenchReducer,
  zeroFlow,
  type ConfirmRequest,
  type FlowIO,
  type FlowLabel,
  type FlowResult,
  type Outcome,
  type PendingAction,
  type PreviewCell,
} from './workbenchLogic';
import './calibration.css';

type T = (key: CalKey, vars?: Readonly<Record<string, unknown>>) => string;
const MAX_LISTED_REPORTS = 12;

export function CalibrationWorkbench({ device }: { device: DeviceView }) {
  const { api, exec, snapshot } = useStudio();
  const ct = useAreaT(calibrationStrings) as T;
  const [dialog, ask] = useConfirm();
  const uid = device.uid;
  const rows = device.matrix?.rows ?? 0;
  const cols = device.matrix?.cols ?? 0;
  const totalSensors = rows * cols;
  const connected = device.online;
  const maintenanceMode = device.mode === 'maintenance';
  const labelOf = useCallback((index: number) => calibrationSensorLabel(index, rows, cols), [rows, cols]);

  const status = snapshot?.deviceDetails[uid]?.status ?? {};
  const [override, setOverride] = useState<CalibrationOverride | null>(null);
  const calibration = chooseCalibrationState(status, override);
  const snapshotKeyRef = useRef('');
  snapshotKeyRef.current = calibrationSnapshotKey(status);

  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbenchState);
  const [zeroError, setZeroError] = useState('');
  const [flowError, setFlowError] = useState('');
  const [advancedError, setAdvancedError] = useState('');
  const [lastZeroAt, setLastZeroAt] = useState('');
  const [zeroNeedsFirmware, setZeroNeedsFirmware] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(3);
  const [newLevelInput, setNewLevelInput] = useState('');
  const [addLevelError, setAddLevelError] = useState('');
  const [referenceInput, setReferenceInput] = useState('');
  const [referenceError, setReferenceError] = useState('');
  const [preview, setPreview] = useState<{ title: string; cells: Map<number, PreviewCell> } | null>(null);
  const [exportNote, setExportNote] = useState('');
  const enteredMaintenanceRef = useRef(false);
  const syncedRef = useRef('');
  const pendingRef = useRef<PendingAction>('');

  const step = getCalibrationStep({ sessionActive: calibration.session_active, draftTareComplete: calibration.draft_tare?.complete === true, baselineConfirmed: state.baselineConfirmed });
  const saveReady = canSaveCalibration(calibration);
  const zeroReason = zeroBlockedReason(connected, calibration);
  const busy = state.pending !== '';
  const maxLevel = Number(calibration.metadata.max_level) || 0;
  const minPoints = calibration.fit_settings?.min_points ?? 3;

  const levelRows = useMemo(() => buildLevelRows(calibration.draft_levels, state.addedLevels), [calibration.draft_levels, state.addedLevels]);
  const selectedRow = resolveSelectedLevel(levelRows, state.selectedLevelKey);
  const cached = selectedRow ? state.levelCells.get(selectedRow.key) : undefined;
  const known = cellsKnown(selectedRow, cached);
  const capturedAtSelected = selectedRow?.summary?.captured_points ?? 0;
  const selectedCells = known && capturedAtSelected > 0 ? cached ?? new Map<number, PreviewCell>() : new Map<number, PreviewCell>();
  const selectedStatuses = useMemo(() => sensorPointStatuses(calibration.draft_fit, state.selectedSensor), [calibration.draft_fit, state.selectedSensor]);
  const unfitted = useMemo(() => new Set(unfittedSensorReports(calibration.draft_fit, minPoints).map((item) => item.sensor_index)), [calibration.draft_fit, minPoints]);

  const errorText = useCallback((code: string) => {
    const key = calibrationErrorKey(code);
    return ct(key, { error: code });
  }, [ct]);

  const command = useCallback(async (label: FlowLabel, payload: Payload): Promise<Outcome> => {
    const result = await exec(ct(label), () => api.sendCommand(uid, payload), { uid, payload, success: false, error: false });
    const outcome = outcomeFromCommand(result);
    if (outcome.ok && isFullCalibrationStatus(outcome.result)) {
      setOverride({ state: parseCalibrationState(outcome.result), snapshotKey: snapshotKeyRef.current });
    }
    return outcome;
  }, [api, exec, ct, uid]);

  const io: FlowIO = { command, maintenanceMode };

  const withPending = async (action: Exclude<PendingAction, ''>, body: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = action;
    dispatch({ type: 'begin', action });
    try {
      await body();
    } finally {
      pendingRef.current = '';
      dispatch({ type: 'end' });
    }
  };

  useEffect(() => {
    if (!calibration.session_active) dispatch({ type: 'session_closed' });
  }, [calibration.session_active]);

  useEffect(() => {
    if (!selectedRow && levelRows[0]) dispatch({ type: 'select_level', key: levelRows[0].key, totalSensors });
    else if (levelRows.length === 0 && state.selectedLevelKey !== null) dispatch({ type: 'select_level', key: null, totalSensors });
  }, [levelRows, selectedRow, state.selectedLevelKey, totalSensors]);

  useEffect(() => {
    dispatch({ type: 'clamp_sensor', totalSensors });
  }, [totalSensors, state.selectedSensor]);

  // Read the selected level's cells whenever what is shown would not match the device.
  useEffect(() => {
    const attempt = shouldLoadLevel({ row: selectedRow, known, busy, loading: state.loadingLevelKey !== null, connected, failedLoads: state.failedLoads });
    if (!attempt || !selectedRow) return;
    const row = selectedRow;
    dispatch({ type: 'loading', key: row.key });
    void loadLevelFlow(io, row.level)
      .then((result) => {
        if (result.ok && result.cells) dispatch({ type: 'cells', key: row.key, cells: result.cells, next: 'keep_or_advance', totalSensors });
        else dispatch({ type: 'load_failed', attempt });
      })
      .finally(() => dispatch({ type: 'loading', key: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRow?.key, capturedAtSelected, known, busy, state.loadingLevelKey, connected]);

  // One status read per device when the tab opens.
  useEffect(() => {
    if (!connected) {
      syncedRef.current = '';
      return;
    }
    if (syncedRef.current === uid) return;
    syncedRef.current = uid;
    void command('refreshStatus', calibrationStatusCommand());
  }, [uid, connected, command]);

  useEffect(() => {
    setReferenceInput('');
    setReferenceError('');
  }, [selectedRow?.key]);

  const fail = (setError: (text: string) => void, result: FlowResult) => {
    if (!result.ok) setError(errorText(result.code));
    return result.ok;
  };

  // ---- actions ----
  const zero = () => withPending('zero', async () => {
    setZeroError('');
    setZeroNeedsFirmware(false);
    const result = await zeroFlow(io);
    if (!fail(setZeroError, result)) return;
    setLastZeroAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    if ('needsFirmware' in result && result.needsFirmware) setZeroNeedsFirmware(true);
  });

  const clearZero = () => withPending('clear_zero', async () => {
    setZeroError('');
    if (fail(setZeroError, await clearZeroFlow(io))) setLastZeroAt('');
  });

  const start = () => withPending('start', async () => {
    setFlowError('');
    const result = await startFlow(io);
    if (!fail(setFlowError, result)) return;
    enteredMaintenanceRef.current = result.enteredMaintenance;
    dispatch({ type: 'session_started' });
  });

  const captureBaseline = () => withPending('baseline', async () => {
    setFlowError('');
    if (fail(setFlowError, await baselineFlow(io))) dispatch({ type: 'baseline_confirmed' });
  });

  const addLevel = () => {
    setAddLevelError('');
    const parsed = parseLevelInput(newLevelInput, levelRows);
    if ('error' in parsed) {
      if (parsed.error === 'exists' && parsed.existing) {
        setAddLevelError(ct('calLevelExists', { level: formatNumber(parsed.existing.level) }));
        dispatch({ type: 'select_level', key: parsed.existing.key, totalSensors });
      } else setAddLevelError(ct('calLevelInvalid'));
      return;
    }
    dispatch({ type: 'add_level', level: parsed.level });
    setNewLevelInput('');
  };

  const capture = (kind: 'all' | 'cell') => {
    if (!selectedRow) return;
    const row = selectedRow;
    const durationMs = captureDurationMs(durationSeconds);
    const sensor = state.selectedSensor;
    void withPending(kind === 'all' ? 'capture_all' : 'capture_one', async () => {
      setFlowError('');
      const result = await captureFlow(io, kind === 'all' ? { kind, level: row.level, durationMs } : { kind, level: row.level, durationMs, sensorIndex: sensor });
      if ('cells' in result && result.cells) {
        dispatch({ type: 'cells', key: row.key, cells: result.cells, next: kind === 'cell' ? { after: sensor } : undefined, totalSensors });
      }
      fail(setFlowError, result);
    });
  };

  const applyReference = () => {
    if (!selectedRow?.summary) return;
    const value = parseReferenceInput(referenceInput);
    if (value === null) {
      setReferenceError(ct('calReferenceInvalid'));
      return;
    }
    const level = selectedRow.level;
    void withPending('reference', async () => {
      setReferenceError('');
      if (fail(setReferenceError, await setReferenceFlow(io, level, value))) setReferenceInput('');
    });
  };

  const deleteDraftLevel = (row: (typeof levelRows)[number]) => withPending('delete_level', async () => {
    setFlowError('');
    const result = await deleteDraftLevelFlow(io, row);
    if (fail(setFlowError, result)) dispatch({ type: 'forget_level', key: row.key });
  });

  const confirmFirst = async (request: ConfirmRequest) => {
    const spec = confirmSpec(request);
    return ask({ title: ct(spec.title, spec.vars), message: ct(spec.message, spec.vars), confirmLabel: ct(spec.confirm), danger: spec.danger });
  };

  const save = async () => {
    const request = saveConfirmation(calibration.draft_fit);
    if (request && !(await confirmFirst(request))) return;
    await withPending('save', async () => {
      setFlowError('');
      if (fail(setFlowError, await saveFlow(io, enteredMaintenanceRef.current))) enteredMaintenanceRef.current = false;
    });
  };

  const cancel = async () => {
    if (!(await confirmFirst({ kind: 'cancel' }))) return;
    await withPending('cancel', async () => {
      setFlowError('');
      if (fail(setFlowError, await cancelFlow(io, enteredMaintenanceRef.current))) enteredMaintenanceRef.current = false;
    });
  };

  const advanced = (label: FlowLabel, payload: Payload, needsMaintenance = false) => withPending('advanced', async () => {
    setAdvancedError('');
    fail(setAdvancedError, await advancedFlow(io, label, payload, { needsMaintenance, sessionActive: calibration.session_active }));
  });

  const loadPreview = (title: string, payload: Payload) => withPending('advanced', async () => {
    setAdvancedError('');
    const result = await advancedFlow(io, 'preview', payload, { sessionActive: calibration.session_active });
    if (fail(setAdvancedError, result) && 'result' in result) setPreview({ title, cells: cellsFromReply(result.result ?? null) });
  });

  const exportData = (format: 'csv' | 'json') => withPending('advanced', async () => {
    setAdvancedError('');
    setExportNote('');
    const result = await exportDumpsFlow(io, calibration.levels.map((item) => item.level));
    if (!fail(setAdvancedError, result) || !('dumps' in result) || !result.dumps) return;
    const now = new Date();
    const content = format === 'csv' ? captureCsv(result.dumps, rows, cols) : exportJson({ dumps: result.dumps, uid, rows, cols, now });
    try {
      const path = await calibrationApi(api).saveExport({ fileStem: exportFileStem(uid, now), format, content });
      if (path) setExportNote(ct('calExportSaved', { path }));
    } catch (error) {
      setAdvancedError(ct('calExportFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  });

  const clearProfile = async () => {
    if (!(await confirmFirst({ kind: 'clear' }))) return;
    setPreview(null);
    await advanced('clearCalibrationProfile', clearProfileCommand(), true);
  };

  const deleteSaved = async (level: number) => {
    if (!(await confirmFirst({ kind: 'delete_saved', level }))) return;
    await advanced('deleteCalibrationLevel', deleteLevelCommand(level), true);
  };

  const levelText = (level: number, reference: number) =>
    referenceDiffers(level, reference) ? `${formatNumber(level)} kPa (${ct('calReferenceMeasured', { value: formatNumber(reference) })})` : `${formatNumber(level)} kPa`;

  // ---- render ----
  return (
    <div className="stack cal-workbench">
      <div className="cal-head">
        <div>
          <h2>{ct('calTitle')}</h2>
          <p className="card-copy">{ct('calCopy')}</p>
        </div>
        <span className={`cal-chip ${calibration.output_mode}`} aria-live="polite">
          <span className="cal-chip-dot" aria-hidden="true" />
          {outputModeLabel(ct, calibration)}
        </span>
      </div>

      {!connected ? <Notice kind="warning">{ct('calOffline')}</Notice> : null}

      <Card title={ct('calZeroTitle')} copy={calibration.output_mode === 'calibrated' ? ct('calZeroCopyCalibrated') : ct('calZeroCopy')}>
        <div className="actions">
          <button className="button primary" type="button" disabled={busy || zeroReason !== null} onClick={() => void zero()}>
            {state.pending === 'zero' ? ct('calZeroRunning') : ct('calZeroAction')}
          </button>
          {calibration.tare_enabled && calibration.output_mode === 'tared' ? (
            <button className="button ghost" type="button" disabled={busy || zeroReason !== null} onClick={() => void clearZero()}>
              {ct('calZeroClear')}
            </button>
          ) : null}
        </div>
        {state.pending === 'zero' ? <Progress ms={ZERO_DURATION_MS} /> : null}
        {zeroReason === 'session_active' ? <p className="cal-hint">{ct('calZeroSessionBlocked')}</p> : null}
        {lastZeroAt && state.pending !== 'zero' && !zeroError ? (
          <p className="cal-done"><CircleCheck size={15} aria-hidden="true" />{ct('calZeroDone', { time: lastZeroAt })}</p>
        ) : null}
        {zeroNeedsFirmware ? <Notice kind="warning">{ct('calZeroNeedsFirmware')}</Notice> : null}
        {zeroError ? <Notice kind="error">{zeroError}</Notice> : null}
      </Card>

      <Card title={ct('calPointTitle')} copy={ct('calPressureCopy')}>
        <Steps ct={ct} current={stepIndex(step, saveReady)} />

        {step === 'not_started' ? (
          <div className="cal-panel">
            <p className="cal-summary">
              {calibration.levels.length > 0 ? ct('calCurrentProfile', { count: calibration.levels.length, max: formatNumber(maxLevel) }) : ct('calNoProfile')}
              {calibration.levels.length > 0 ? <span className={`tag ${calibration.enabled ? 'accent' : 'waiting'}`}>{calibration.enabled ? ct('enabledState') : ct('disabledState')}</span> : null}
            </p>
            <div className="actions">
              <button className="button primary" type="button" disabled={busy || !connected} onClick={() => void start()}>
                {state.pending === 'start' ? ct('running') : ct('calStart')}
              </button>
            </div>
            {!maintenanceMode ? <p className="cal-hint">{ct('calStartHint')}</p> : null}
          </div>
        ) : null}

        {step === 'baseline' ? (
          <div className="cal-panel">
            <p>{ct('calBaselineCopy', { seconds: BASELINE_DURATION_MS / 1000 })}</p>
            <div className="actions">
              <button className="button primary" type="button" disabled={busy || !connected} onClick={() => void captureBaseline()}>
                {state.pending === 'baseline' ? ct('calCapturing') : ct('calBaselineCapture')}
              </button>
              {calibration.draft_tare?.complete ? (
                <button className="button ghost" type="button" disabled={busy} onClick={() => dispatch({ type: 'baseline_confirmed' })}>{ct('calBaselineReuse')}</button>
              ) : null}
            </div>
            {state.pending === 'baseline' ? <Progress ms={BASELINE_DURATION_MS} /> : null}
          </div>
        ) : null}

        {step === 'levels' ? (
          <div className="cal-panel">
            <p>{ct('calLevelsCopy')}</p>
            <div className="cal-group">
              <div className="cal-group-head">
                <h4>{ct('calLevelsTitle')}</h4>
                <span>{ct('calSensorCount', { count: totalSensors })}</span>
              </div>
              {levelRows.length > 0 ? (
                <ul className="cal-levels">
                  {levelRows.map((row) => {
                    const captured = row.summary?.captured_points ?? 0;
                    const total = row.summary?.total_points || totalSensors;
                    const pct = total > 0 ? Math.round((captured / total) * 100) : 0;
                    const active = row.key === selectedRow?.key;
                    const pointStatus = selectedStatuses.get(row.level);
                    const excluded = pointStatus === 'saturated' || pointStatus === 'no_response';
                    return (
                      <li key={row.key} className={`cal-level${active ? ' active' : ''}${excluded ? ' excluded' : ''}`}>
                        <button className="cal-level-select" type="button" aria-pressed={active} disabled={busy} onClick={() => dispatch({ type: 'select_level', key: row.key, totalSensors })}>
                          <strong>{row.summary ? levelText(row.level, row.summary.reference) : `${formatNumber(row.level)} kPa`}</strong>
                          {excluded ? <small className="cal-flag">{ct(pointStatus === 'saturated' ? 'calPointSaturated' : 'calPointNoResponse', { sensor: labelOf(state.selectedSensor) })}</small> : null}
                        </button>
                        <div className="progress-track" aria-hidden="true">
                          <div className={`progress-fill${row.summary?.complete ? '' : ' cal-partial'}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="cal-count">
                          {captured === 0 ? ct('calLevelNotCaptured') : row.summary?.complete ? <Check size={14} aria-label={ct('profileComplete')} /> : `${captured}/${total}`}
                        </span>
                        <button className="button ghost cal-destructive" type="button" disabled={busy} onClick={() => void deleteDraftLevel(row)}>{ct('delete')}</button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="cal-hint">{ct('calNoLevelsYet')}</p>
              )}
              <div className="cal-row">
                <label className="field cal-field">
                  <span className="field-label">{ct('calNewLevelKpa')}</span>
                  <NumberInput
                   
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={newLevelInput}
                    placeholder="10"
                    aria-invalid={addLevelError !== ''}
                    onChange={(event) => {
                      setNewLevelInput(event.target.value);
                      setAddLevelError('');
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') addLevel();
                    }}
                  />
                </label>
                <button className="button" type="button" disabled={busy} onClick={addLevel}>
                  <Plus size={14} aria-hidden="true" />
                  {ct('calAddLevel')}
                </button>
              </div>
              {addLevelError ? <p className="field-error" role="alert">{addLevelError}</p> : null}
              <FitProgress ct={ct} fit={calibration.draft_fit} settings={calibration.fit_settings} labelOf={labelOf} rows={rows} cols={cols} />
              {selectedRow && selectedStatuses.size > 0 ? <p className="cal-hint">{ct('calLevelsForSensor', { sensor: labelOf(state.selectedSensor) })}</p> : null}
            </div>

            {selectedRow ? (
              <div className="cal-group" key={selectedRow.key}>
                <div className="cal-group-head">
                  <h4>{ct('calLevelDetailTitle', { level: formatNumber(selectedRow.level) })}</h4>
                  <span>{known ? ct('calLevelCapturedCount', { captured: capturedAtSelected, total: totalSensors }) : ct('calLoadingLevel')}</span>
                </div>
                <p className="cal-hint">{ct('calSingleSensorCopy')}</p>
                <div className={`cal-matrix-wrap${known ? '' : ' loading'}`} aria-busy={!known}>
                  <SensorMatrix ct={ct} rows={rows} cols={cols} cells={selectedCells} selected={state.selectedSensor} onSelect={(sensor) => dispatch({ type: 'select_sensor', sensor })} unfitted={unfitted} />
                  {!known ? <div className="cal-matrix-loading">{ct('calLoadingLevel')}</div> : null}
                </div>
                <div className="cal-legend" aria-hidden="true">
                  <span><i className="cal-swatch captured" />{ct('calLegendCaptured')}</span>
                  <span><i className="cal-swatch" />{ct('calLegendMissing')}</span>
                  {unfitted.size > 0 ? <span><i className="cal-swatch unfitted" />{ct('calLegendUnfitted')}</span> : null}
                </div>
                <div className="cal-row">
                  <label className="field cal-field narrow">
                    <span className="field-label">{ct('calDurationSeconds')}</span>
                    <NumberInput
                     
                      inputMode="decimal"
                      min={0.5}
                      max={MAX_CAPTURE_MS / 1000}
                      step={0.5}
                      value={durationSeconds}
                      onChange={(event) => setDurationSeconds(Math.min(MAX_CAPTURE_MS / 1000, Math.max(0.5, Number(event.target.value) || 3)))}
                    />
                  </label>
                  <button className="button primary" type="button" disabled={busy || !connected || !known} onClick={() => capture('cell')}>
                    {state.pending === 'capture_one' ? ct('calCapturing') : ct('calCaptureOne', { sensor: labelOf(state.selectedSensor) })}
                  </button>
                  <button className="button" type="button" disabled={busy || !connected || !known} onClick={() => capture('all')}>
                    {state.pending === 'capture_all' ? ct('calCapturing') : ct('calCaptureAll')}
                  </button>
                </div>
                <p className="field-note">{ct('calDurationMax', { seconds: MAX_CAPTURE_MS / 1000 })}</p>
                {state.pending === 'capture_all' || state.pending === 'capture_one' ? <Progress ms={captureDurationMs(durationSeconds)} /> : null}

                <div className="cal-row">
                  <label className="field cal-field">
                    <span className="field-label">{ct('calReferenceLabel')}</span>
                    <NumberInput
                     
                      inputMode="decimal"
                      min={0}
                      step="any"
                      value={referenceInput}
                      disabled={!selectedRow.summary}
                      placeholder={formatNumber(selectedRow.summary?.reference ?? selectedRow.level)}
                      aria-invalid={referenceError !== ''}
                      onChange={(event) => {
                        setReferenceInput(event.target.value);
                        setReferenceError('');
                      }}
                    />
                  </label>
                  <button className="button" type="button" disabled={busy || !connected || !selectedRow.summary || !referenceInput.trim()} onClick={applyReference}>
                    {state.pending === 'reference' ? ct('running') : ct('calSetReference')}
                  </button>
                </div>
                <p className="field-note">{selectedRow.summary ? ct('calReferenceHint', { level: formatNumber(selectedRow.level) }) : ct('calReferenceNeedsCapture')}</p>
                {referenceError ? <p className="field-error" role="alert">{referenceError}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {step !== 'not_started' ? (
          <div className="cal-footer">
            <button className="button ghost cal-destructive" type="button" disabled={busy} onClick={() => void cancel()}>
              {state.pending === 'cancel' ? ct('running') : ct('calCancel')}
            </button>
            <div className="cal-footer-save">
              {!saveReady && step === 'levels' ? <span className="cal-hint">{ct(calibration.draft_fit?.partial_save ? 'calSaveHintPartial' : 'calSaveHint')}</span> : null}
              <button className="button primary" type="button" disabled={busy || !saveReady} onClick={() => void save()}>
                {state.pending === 'save' ? ct('running') : ct('calSave')}
              </button>
            </div>
          </div>
        ) : null}
        {flowError ? <Notice kind="error">{flowError}</Notice> : null}
      </Card>

      {/* HOOK: the automated pressure chamber (tools area) plugs in here via
          workbench.ts PressureTargetSource / automatedLevelFlow. */}
      <Card className="later-card" title={ct('calAirTitle')} copy={ct('calAirCopy')}>
        <p className="cal-hint">{ct('calAutoLater')}</p>
      </Card>

      <Card>
        <Disclosure summary={<span className="cal-disclosure"><strong>{ct('calAdvanced')}</strong><small>{ct('calAdvancedCopy')}</small></span>}>
          <div className="stack">
            <ul className="cal-settings">
              <li>
                <div><strong>{ct('calUseCalibration')}</strong><p>{ct('calUseCalibrationHint')}</p></div>
                <button
                  className="button"
                  type="button"
                  disabled={busy || !connected || (!calibration.enabled && !calibration.complete)}
                  onClick={() => void advanced(calibration.enabled ? 'disableCalibrationProfile' : 'enableCalibrationProfile', calibration.enabled ? disableCommand() : enableCommand())}
                >
                  {calibration.enabled ? ct('calTurnOff') : ct('calTurnOn')}
                </button>
              </li>
              <li>
                <div><strong>{ct('maintenanceModeLabel')}</strong><p>{maintenanceMode ? ct('calMaintenanceOn') : ct('calMaintenanceOff')}</p></div>
                <button
                  className="button"
                  type="button"
                  disabled={busy || !connected || calibration.session_active}
                  onClick={() => void advanced(maintenanceMode ? 'exitMaintenance' : 'enterMaintenance', maintenanceMode ? exitMaintenanceCommand() : enterMaintenanceCommand())}
                >
                  {maintenanceMode ? ct('exitMaintenance') : ct('enterMaintenance')}
                </button>
              </li>
              <li>
                <div><strong>{ct('refreshStatus')}</strong><p>{ct('refreshCalibrationStatusHint')}</p></div>
                <button className="button" type="button" disabled={busy || !connected} onClick={() => void advanced('refreshStatus', calibrationStatusCommand())}>{ct('refreshStatus')}</button>
              </li>
            </ul>

            <div className="cal-group">
              <div className="cal-group-head">
                <h4>{ct('calSavedPressures')}</h4>
                <button className="button ghost" type="button" disabled={busy || !connected || !calibration.tare_complete} onClick={() => void loadPreview(ct('calBaselineData'), dumpTareCommand())}>
                  {ct('calBaselineData')}
                </button>
              </div>
              {calibration.levels.length > 0 ? (
                <ul className="cal-levels">
                  {calibration.levels.map((item) => (
                    <li key={item.level} className="cal-level">
                      <strong>{levelText(item.level, item.reference)}</strong>
                      <span className="cal-count">{item.captured_points}/{item.total_points}</span>
                      <button className="button ghost" type="button" disabled={busy || !connected} onClick={() => void loadPreview(`${formatNumber(item.level)} kPa`, dumpLevelCommand(item.level))}>{ct('preview')}</button>
                      <button className="button ghost cal-destructive" type="button" disabled={busy || !connected || calibration.session_active} onClick={() => void deleteSaved(item.level)}>{ct('delete')}</button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cal-hint">{ct('noCalibrationLevels')}</p>
              )}
            </div>

            <FitProgress ct={ct} fit={calibration.fit} settings={calibration.fit_settings} labelOf={labelOf} rows={rows} cols={cols} saved />

            <FitSettingsEditor ct={ct} settings={calibration.fit_settings} disabled={busy || !connected || calibration.session_active} onApply={(minLevel) => void advanced('calFitSettingsTitle', setFitCommand(minLevel), true)} />

            <div className="cal-settings-row">
              <div><strong>{ct('calExportData')}</strong><p>{ct('calExportDataHint')}</p></div>
              <div className="actions">
                <button className="button" type="button" disabled={busy || !connected || !calibration.tare_complete} onClick={() => void exportData('csv')}>
                  <Download size={14} aria-hidden="true" />
                  {ct('calExportCsv')}
                </button>
                <button className="button ghost" type="button" disabled={busy || !connected || !calibration.tare_complete} onClick={() => void exportData('json')}>
                  {ct('calExportJson')}
                </button>
              </div>
            </div>
            {exportNote ? <Notice kind="success">{exportNote}</Notice> : null}

            {preview ? (
              <div className="cal-group">
                <div className="cal-group-head">
                  <h4>{preview.title}</h4>
                  <button className="button ghost" type="button" onClick={() => setPreview(null)}>{ct('calClosePreview')}</button>
                </div>
                <p className="cal-hint">{ct('calPreviewUnits')}</p>
                <SensorMatrix ct={ct} rows={rows} cols={cols} cells={preview.cells} showValues />
              </div>
            ) : null}

            <div className="cal-settings-row cal-danger">
              <div><strong>{ct('clearCalibrationProfile')}</strong><p>{ct('clearCalibrationProfileHint')}</p></div>
              <button className="button danger" type="button" disabled={busy || !connected || calibration.session_active} onClick={() => void clearProfile()}>
                {ct('clearCalibrationProfile')}
              </button>
            </div>
            {advancedError ? <Notice kind="error">{advancedError}</Notice> : null}
          </div>
        </Disclosure>
      </Card>
      {dialog}
    </div>
  );
}

function outputModeLabel(ct: T, calibration: CalibrationState): string {
  if (calibration.output_mode === 'calibrated') return ct('calOutputCalibrated', { count: calibration.levels.length });
  return calibration.output_mode === 'tared' ? ct('calOutputTared') : ct('calOutputRaw');
}

function Progress({ ms }: { ms: number }) {
  return (
    <div className="progress-track indeterminate" style={{ ['--tare-ms' as string]: `${Math.max(1, ms)}ms` }} aria-hidden="true">
      <div className="progress-fill" />
    </div>
  );
}

function Steps({ ct, current }: { ct: T; current: number }) {
  const labels = [ct('calStepBaseline'), ct('calStepLevels'), ct('calStepSave')];
  return (
    <ol className={`cal-steps${current < 0 ? ' idle' : ''}`} aria-label={ct('calPressureTitle')}>
      {labels.map((label, index) => {
        const state = current < 0 ? 'upcoming' : index < current ? 'done' : index === current ? 'current' : 'upcoming';
        return (
          <li key={label} className={`cal-step ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="cal-step-mark" aria-hidden="true">{state === 'done' ? <Check size={12} strokeWidth={3} /> : index + 1}</span>
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function SensorMatrix({ ct, rows, cols, cells, selected, onSelect, showValues = false, unfitted }: {
  ct: T;
  rows: number;
  cols: number;
  cells: Map<number, PreviewCell>;
  selected?: number;
  onSelect?: (sensorIndex: number) => void;
  showValues?: boolean;
  unfitted?: Set<number>;
}) {
  const layout = matrixLayout(rows, cols);
  if (layout.length === 0) return null;
  return (
    <div className={`cal-matrix${showValues ? ' values' : ''}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {layout.map(({ sensorIndex, label }) => {
        const cell = cells.get(sensorIndex);
        const captured = cell?.value != null;
        const className = `cal-cell${captured ? ' captured' : ''}${unfitted?.has(sensorIndex) ? ' unfitted' : ''}${selected === sensorIndex ? ' selected' : ''}`;
        const content = (
          <>
            <strong>{label}</strong>
            {showValues ? <small>{captured ? formatNumber(cell!.value as number) : '–'}</small> : null}
          </>
        );
        return onSelect ? (
          <button key={sensorIndex} type="button" className={className} aria-pressed={selected === sensorIndex} aria-label={ct('calSelectSensor', { sensor: label })} onClick={() => onSelect(sensorIndex)}>
            {content}
          </button>
        ) : (
          <div key={sensorIndex} className={className}>{content}</div>
        );
      })}
    </div>
  );
}

function levelsText(levels: number[]): string {
  return levels.map((level) => `${formatNumber(level)} kPa`).join(', ');
}

function sensorReportLine(ct: T, report: SensorFitReport, minPoints: number, labelOf: (index: number) => string): string {
  const reasons: string[] = [];
  if (report.saturated.length > 0) reasons.push(ct('calReasonSaturated', { levels: levelsText(report.saturated) }));
  if (report.no_response.length > 0) reasons.push(ct('calReasonNoResponse', { levels: levelsText(report.no_response) }));
  const advice =
    report.saturates_from !== null
      ? ct('calAdviceBelowSaturation', { level: formatNumber(report.saturates_from) })
      : report.no_response.length > 0
        ? ct('calAdviceNoResponse')
        : ct('calAdviceMoreLevels');
  return ct('calSensorReport', {
    sensor: labelOf(report.sensor_index),
    usable: report.usable,
    min: minPoints,
    reasons: reasons.length > 0 ? reasons.join(ct('calReasonSeparator')) : ct('calReasonTooFewLevels'),
    advice,
  });
}

function FitProgress({ ct, fit, settings, labelOf, rows, cols, saved = false }: {
  ct: T;
  fit: CalibrationFitSummary | null;
  settings: CalibrationFitSettings | null;
  labelOf: (index: number) => string;
  rows: number;
  cols: number;
  saved?: boolean;
}) {
  if (!fit || fit.cells_total === 0) return null;
  const minPoints = settings?.min_points ?? 3;
  const order = byDisplayOrder(rows, cols);
  const reports = unfittedSensorReports(fit, minPoints).sort(order);
  const saturating = saturatingSensorReports(fit, minPoints).sort(order);
  const detailed = fit.points.length > 0;
  const needPoints = fit.failures.too_few_points + fit.failures.no_tare;
  const failedList = [...fit.failed].sort(order).map((item) => labelOf(item.sensor_index)).join(', ');
  const more = fit.cells_total - fit.cells_fitted - fit.failed.length;
  return (
    <div className="cal-fit" aria-live="polite">
      <p className={fit.complete ? 'cal-done' : 'cal-hint'}>
        {fit.complete ? <CircleCheck size={15} aria-hidden="true" /> : null}
        {ct(saved ? 'calFitSaved' : 'calFitProgress', { fitted: fit.cells_fitted, total: fit.cells_total })}
      </p>
      {detailed && reports.length > 0 ? (
        <>
          <p className="cal-hint">{ct('calFitExcludedTitle', { count: reports.length })}</p>
          <ul className="cal-reports">
            {reports.slice(0, MAX_LISTED_REPORTS).map((report) => <li key={report.sensor_index}>{sensorReportLine(ct, report, minPoints, labelOf)}</li>)}
          </ul>
          {reports.length > MAX_LISTED_REPORTS ? <p className="cal-hint">{ct('calFitMoreReports', { count: reports.length - MAX_LISTED_REPORTS })}</p> : null}
        </>
      ) : null}
      {!detailed && !fit.complete && needPoints > 0 ? (
        <p className="cal-hint">{ct('calFitNeedPoints', { count: needPoints, points: minPoints, level: formatNumber(settings?.min_level ?? 3) })}</p>
      ) : null}
      {fit.failures.singular > 0 ? <p className="cal-hint">{ct('calFitSingular', { count: fit.failures.singular })}</p> : null}
      {!detailed && failedList ? <p className="cal-hint">{ct('calFitFailedList', { sensors: more > 0 ? `${failedList} +${more}` : failedList })}</p> : null}
      {detailed && saturating.length > 0 ? (
        <p className="cal-hint">
          {ct('calFitSaturatingNote', { sensors: saturating.map((item) => `${labelOf(item.sensor_index)} (${formatNumber(item.saturates_from ?? 0)} kPa)`).join(', ') })}
        </p>
      ) : null}
      {!saved && !fit.complete && fit.partial_save && fit.cells_fitted > 0 ? <p className="cal-hint">{ct('calFitPartialSaveNote', { count: fit.cells_total - fit.cells_fitted })}</p> : null}
    </div>
  );
}

// The readout curve (c1/c2/clip) is deliberately not editable, as in the
// Desktop: this only ever sends min_level.
function FitSettingsEditor({ ct, settings, disabled, onApply }: { ct: T; settings: CalibrationFitSettings | null; disabled: boolean; onApply: (minLevel: number) => void }) {
  const [value, setValue] = useState(String(settings?.min_level ?? 3));
  const deviceKey = JSON.stringify(settings);
  useEffect(() => {
    setValue(String(settings?.min_level ?? 3));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceKey]);
  if (!settings) return null;
  const parsed = Number(value);
  return (
    <div className="cal-group">
      <div className="cal-group-head"><h4>{ct('calFitSettingsTitle')}</h4></div>
      <p className="cal-hint">{ct('calFitSettingsCopy')}</p>
      <div className="cal-row">
        <label className="field cal-field narrow">
          <span className="field-label">{ct('paramFitMinLevel')}</span>
          <NumberInput step="any" value={value} disabled={disabled} onChange={(event) => setValue(event.target.value)} />
        </label>
        <button className="button" type="button" disabled={disabled || !value.trim() || !Number.isFinite(parsed)} onClick={() => onApply(parsed)}>{ct('calFitApply')}</button>
      </div>
    </div>
  );
}
