// TIA-CTL v2.0.F: the Vref DAC, the calibration switch, the measured Rfb per
// row, the range mode and the Vref sweep (ported from New-Horizons-Desktop
// components/VrefPanel.tsx, v1.7.0). The firmware owns every rule (ceiling,
// safe value, what needs a measured Rfb); this only asks and shows the answer.
import { useEffect, useState } from 'react';

import { Card, Checkbox, Disclosure, Field, Notice, NumberInput, Segmented, Slider } from '../../components/ui';
import { record } from '../../lib/deviceDetails';
import { rsSpreadFraction, summarizeSweep, sweepCsv, type SweepCalibration, type SweepStep, type SweepSummary } from '../../lib/vrefSweep';
import { useStudio } from '../../state/studio';
import type { Send } from './DeviceHardware';
import { useDeviceSettingsT } from './DeviceHardware';

type RfbRow = { row: number; off_mv: number; on_mv: number; rfb_ohm: number; offset_mv?: number; method?: string; status: string };
type SweepResult = { rows: number; cols: number; steps: SweepStep[]; calibration: SweepCalibration; fallbackRfbOhm: number };

const SAFE_VREF_MV = 330;
const MIN_VREF_MV = 100;
// The firmware's defaults (VrefPolicy.h): the ceiling, and where the GPIO45 strap starts to be
// at risk on a reset that skips the shutdown handler.
const DEFAULT_LIMIT_MV = 700;
const STRAP_MARGIN_MV = 700;
const STRAP_RISK_MV = 800;
/** How long a command's own answer outranks the status: a poll already on its way, not forever. */
const ANSWER_FRESH_MS = 10_000;

type RangeMode = 'raw' | 'virtual' | 'auto';
type VrefZone = 'auto' | 'safe' | 'raised' | 'near' | 'risk' | 'unknown';

function vrefZone(mv: number | null, mode: string): VrefZone {
  if (mode === 'auto') return 'auto';
  if (mv === null) return 'unknown';
  if (Math.abs(mv - SAFE_VREF_MV) <= 5) return 'safe';
  if (mv < STRAP_MARGIN_MV) return 'raised';
  if (mv < STRAP_RISK_MV) return 'near';
  return 'risk';
}

/** A number typed in a field, or null when empty or not a number (Number('') is 0). */
function fieldNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.map((v) => num(v) ?? 0) : [];
}

function kOhm(value: number | null): string {
  return value === null || value <= 0 ? '-' : `${(value / 1000).toFixed(2)} kΩ`;
}

/** A command's reply body: the engine hands over `data` when the device wrapped it, else the whole result. */
function body(data: unknown): Record<string, unknown> {
  const outer = record(data);
  return outer.steps !== undefined || outer.rows !== undefined || outer.vref !== undefined || outer.range !== undefined ? outer : record(outer.data ?? outer);
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // Revoked right after click(), some browsers cancel the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function VrefCards({ status, disabled, busy, send }: { status: Record<string, unknown>; disabled: boolean; busy: string; send: Send }) {
  const ds = useDeviceSettingsT();
  const { t } = useStudio();
  const [vrefOverride, setVrefOverride] = useState<{ at: number; value: Record<string, unknown> } | null>(null);
  const [rangeOverride, setRangeOverride] = useState<{ at: number; value: Record<string, unknown> } | null>(null);
  // What the device just answered to a command here outranks the status for a few seconds: a
  // status poll can land in between, and a Rfb just measured must unlock the range modes at once.
  const now = Date.now();
  const vref = vrefOverride && now - vrefOverride.at < ANSWER_FRESH_MS ? { ...record(status.vref), ...vrefOverride.value } : record(status.vref);
  const range = rangeOverride && now - rangeOverride.at < ANSWER_FRESH_MS ? { ...record(status.range), ...rangeOverride.value } : record(status.range);

  const currentMv = vref.ok === false ? null : num(vref.mv);
  const limitMv = num(vref.limit_mv);
  const eepromMv = num(vref.eeprom_mv);
  const calibrationOn = vref.calibration_on === true;
  const modeNow: RangeMode = range.mode === 'virtual' || range.mode === 'auto' ? range.mode : 'raw';
  const refRfbNow = num(range.ref_rfb_ohm) ?? 20000;
  const leakNow = range.leak_compensation !== false;
  const rfbTable = numbers(range.rfb_ohm);
  const rfbOffsets = numbers(range.offset_mv);
  const knownRows = num(range.rfb_known_rows) ?? 0;
  const saturatedRows = num(range.saturated_rows);

  const [error, setError] = useState<string | null>(null);
  const [vrefDraft, setVrefDraft] = useState('330');
  const [limitDraft, setLimitDraft] = useState(String(DEFAULT_LIMIT_MV));
  const [measureVref, setMeasureVref] = useState('');
  const [rfbRows, setRfbRows] = useState<RfbRow[] | null>(null);
  // A table that came back from this very measurement counts even if `range` did not.
  const rfbValid = knownRows > 0 || (rfbRows?.some((row) => row.rfb_ohm > 0) ?? false);
  const [refRfbDraft, setRefRfbDraft] = useState(String(refRfbNow));
  const [leakDraft, setLeakDraft] = useState(leakNow);
  const [sweepStart, setSweepStart] = useState('100');
  const [sweepStop, setSweepStop] = useState(String(DEFAULT_LIMIT_MV));
  const [sweepStep, setSweepStep] = useState('100');
  const [sweepSettle, setSweepSettle] = useState('150');
  const [sweepSolderedRfb, setSweepSolderedRfb] = useState('');
  const [sweep, setSweep] = useState<SweepResult | null>(null);

  useEffect(() => {
    setRefRfbDraft(String(refRfbNow));
    setLeakDraft(leakNow);
  }, [refRfbNow, leakNow]);
  useEffect(() => {
    if (currentMv !== null) setVrefDraft(String(currentMv));
  }, [currentMv]);
  useEffect(() => {
    if (limitMv !== null) setLimitDraft(String(limitMv));
  }, [limitMv]);

  async function ask(label: string, payload: Record<string, unknown>) {
    setError(null);
    const outcome = await send(label, payload as never, { success: false });
    if (!outcome.ok) {
      setError(String((outcome as { message?: string }).message || 'no_response'));
      return null;
    }
    const result = body(outcome.data);
    if (result.vref !== undefined) setVrefOverride({ at: Date.now(), value: record(result.vref) });
    if (result.range !== undefined) setRangeOverride({ at: Date.now(), value: record(result.range) });
    return result;
  }

  /** The typed numbers, or null (and an error shown) when a field is empty or not a number. */
  function typed(fields: Record<string, string>): Record<string, number> | null {
    const out: Record<string, number> = {};
    for (const [key, text] of Object.entries(fields)) {
      const value = fieldNumber(text);
      if (value === null) {
        setError(ds('fieldNumberRequired'));
        return null;
      }
      out[key] = value;
    }
    return out;
  }

  const working = disabled;

  async function setVref(label: string, fields: Record<string, string>) {
    const values = typed(fields);
    if (values) await ask(label, { command: 'set_vref', ...values });
  }

  async function measureRfb() {
    const mv = fieldNumber(measureVref);
    const result = await ask(ds('rfbMeasure'), { command: 'rfb_measure', ...(mv !== null ? { vref_mv: mv } : {}) });
    if (result && Array.isArray(result.rows)) setRfbRows(result.rows as RfbRow[]);
  }

  async function applyMode(mode: RangeMode) {
    if (mode !== 'raw' && !rfbValid) return;
    await ask(ds('rangeApply'), { command: 'set_range', mode, ref_rfb_ohm: fieldNumber(refRfbDraft) ?? refRfbNow, leak_comp: leakDraft });
  }

  async function applyRangeSettings() {
    const values = typed({ ref_rfb_ohm: refRfbDraft });
    if (values) await ask(ds('rangeApply'), { command: 'set_range', mode: modeNow, leak_comp: leakDraft, ...values });
  }

  async function clearRfb() {
    // The table measured here is gone on the device too.
    if (await ask(ds('rfbClear'), { command: 'set_range', clear_rfb: true })) setRfbRows(null);
  }

  async function runSweep() {
    const values = typed({ start_mv: sweepStart, stop_mv: sweepStop, step_mv: sweepStep, settle_ms: sweepSettle });
    if (!values) return;
    const result = await ask(ds('sweepTitle'), { command: 'vref_sweep', ...values });
    if (result && Array.isArray(result.steps)) {
      const soldered = fieldNumber(sweepSolderedRfb) ?? 0;
      setSweep({
        rows: num(result.rows) ?? 0,
        cols: num(result.cols) ?? 0,
        steps: result.steps as SweepStep[],
        calibration: { rfb_ohm: Array.isArray(result.rfb_ohm) ? numbers(result.rfb_ohm) : undefined, offset_mv: Array.isArray(result.offset_mv) ? numbers(result.offset_mv) : undefined },
        fallbackRfbOhm: soldered > 0 ? soldered : 0,
      });
    }
  }

  const summary: SweepSummary[] = sweep ? summarizeSweep(sweep.steps, sweep.rows, sweep.cols, sweep.calibration, sweep.fallbackRfbOhm || undefined) : [];
  const spread = rsSpreadFraction(summary);
  const running = (name: string) => busy === name;
  const rfbDisplay: RfbRow[] = rfbRows ?? rfbTable.map((value, row) => ({ row, off_mv: 0, on_mv: 0, rfb_ohm: value, offset_mv: rfbOffsets[row], status: value > 0 ? 'ok' : '' }));

  // The status tiles.
  const measuredRfb = rfbDisplay.map((row) => row.rfb_ohm).filter((value) => value > 0).sort((a, b) => a - b);
  const rfbMedian = measuredRfb[Math.floor(measuredRfb.length / 2)] ?? null;
  const zone = vrefZone(currentMv, modeNow);
  // The slider runs from 100 mV to the ceiling; the bar under it marks the GPIO45 strap risk.
  const sliderMax = Math.max(SAFE_VREF_MV + 10, limitMv ?? DEFAULT_LIMIT_MV);
  const draftMv = fieldNumber(vrefDraft) ?? SAFE_VREF_MV;
  const span = sliderMax - MIN_VREF_MV;
  const share = (from: number, to: number) => Math.max(0, Math.min(to, sliderMax) - Math.max(from, MIN_VREF_MV)) / span;

  if (vref.supported !== true) return null;
  return (
    <Card title={ds('vrefTitle')} copy={ds('vrefCopy')}>
      {error ? (
        <div role="alert">
          <Notice kind="error">{error}</Notice>
        </div>
      ) : null}

      <div className="metric-row vref-status">
        <div className={`metric vref-zone-${zone}`}>
          <span className="metric-label">{ds('vrefMv')}</span>
          <div className="metric-value">{currentMv !== null ? `${currentMv} mV` : '-'}</div>
          <span className="field-note">{ds(`vrefZone_${zone}`)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">{ds('rfbValue')}</span>
          <div className="metric-value">{kOhm(rfbMedian)}</div>
          <span className="field-note">{rfbValid ? `${measuredRfb.length}/${rfbDisplay.length} ${ds('rfbRowsMeasured')}` : ds('rfbNotMeasured')}</span>
        </div>
        <div className="metric">
          <span className="metric-label">{ds('rangeSaturatedShort')}</span>
          <div className="metric-value">{saturatedRows ?? '-'}</div>
          <span className="field-note">{calibrationOn ? ds('calSwitchStateOn') : ds('calSwitchStateOff')}</span>
        </div>
      </div>

      <div className="settings-subsection">
        <h4>{ds('rangeMode')}</h4>
        <Segmented<RangeMode>
          label={ds('rangeMode')}
          value={modeNow}
          disabled={working || running('set_range')}
          options={(['raw', 'virtual', 'auto'] as const).map((mode) => ({ value: mode, label: ds(`rangeModeShort_${mode}`), disabled: mode !== 'raw' && !rfbValid }))}
          onChange={(mode) => void applyMode(mode)}
        />
        <p className="field-note">{ds(`rangeModeHint_${modeNow}`)}</p>
        {!rfbValid ? (
          <div className="vref-needs-rfb">
            <Notice>{ds('rangeNeedsRfb')}</Notice>
            <button className="button" type="button" disabled={working} onClick={() => void measureRfb()}>
              {running('rfb_measure') ? t('running') : ds('rfbMeasure')}
            </button>
          </div>
        ) : null}
        {modeNow !== 'raw' ? (
          <div className="field-grid three">
            <Field label={ds('rangeRefRfb')}>{(id) => <NumberInput id={id} min={1000} max={1000000} step={1000} value={refRfbDraft} onChange={(e) => setRefRfbDraft(e.target.value)} />}</Field>
            <div className="vref-check">
              <Checkbox checked={leakDraft} onChange={(e) => setLeakDraft(e.target.checked)} label={ds('rangeLeak')} />
            </div>
            <div className="vref-check">
              <button className="button" type="button" disabled={working} onClick={() => void applyRangeSettings()}>
                {ds('rangeApply')}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="settings-subsection">
        <h4>{ds('vrefControlTitle')}</h4>
        {modeNow === 'auto' ? <p className="field-note">{ds('vrefAutoControlled')}</p> : null}
        <div className="vref-slider">
          <Slider
            min={MIN_VREF_MV}
            max={sliderMax}
            step={10}
            value={Math.min(Math.max(draftMv, MIN_VREF_MV), sliderMax)}
            disabled={working || modeNow === 'auto'}
            aria-label={ds('vrefInputLabel')}
            onChange={(e) => setVrefDraft(e.target.value)}
          />
          <NumberInput min={MIN_VREF_MV} max={sliderMax} step={10} value={vrefDraft} disabled={modeNow === 'auto'} aria-label={ds('vrefInputLabel')} onChange={(e) => setVrefDraft(e.target.value)} />
          <span>mV</span>
        </div>
        <div className="vref-zone-bar" aria-hidden="true">
          <span className="safe" style={{ flexGrow: share(MIN_VREF_MV, STRAP_MARGIN_MV) }} />
          <span className="near" style={{ flexGrow: share(STRAP_MARGIN_MV, STRAP_RISK_MV) }} />
          <span className="risk" style={{ flexGrow: share(STRAP_RISK_MV, sliderMax) }} />
        </div>
        <p className="field-note">{ds('vrefZoneLegend')}</p>
        <div className="form-footer">
          <button className="button" type="button" disabled={working || currentMv === SAFE_VREF_MV} onClick={() => void ask(ds('vrefReset'), { command: 'set_vref', mv: SAFE_VREF_MV })}>
            {ds('vrefReset')}
          </button>
          <button className="button primary" type="button" disabled={working || modeNow === 'auto'} onClick={() => void setVref(ds('vrefApply'), { mv: vrefDraft })}>
            {running('set_vref') ? t('running') : ds('vrefApply')}
          </button>
        </div>
      </div>

      <Disclosure summary={ds('vrefToolsTitle')}>
        <div className="settings-subsection">
          <h4>{ds('rfbTitle')}</h4>
          <p className="field-note">{ds('rfbCopy')}</p>
          <div className="field-grid">
            <Field label={ds('rfbMeasureVref')}>
              {(id) => <NumberInput id={id} min={100} step={10} value={measureVref} placeholder={String(currentMv ?? SAFE_VREF_MV)} onChange={(e) => setMeasureVref(e.target.value)} />}
            </Field>
          </div>
          <div className="form-footer">
            <button className="button" type="button" disabled={working || !rfbValid} onClick={() => void clearRfb()}>
              {ds('rfbClear')}
            </button>
            <button className="button" type="button" disabled={working} onClick={() => void measureRfb()}>
              {running('rfb_measure') ? t('running') : ds('rfbMeasure')}
            </button>
          </div>
          {rfbValid || rfbRows ? (
            <table className="vref-table">
              <thead>
                <tr>
                  <th>{ds('rfbRow')}</th>
                  <th>{ds('rfbValue')}</th>
                  <th>{ds('rfbOffset')}</th>
                  <th>{ds('rfbStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {rfbDisplay.map((item) => (
                  <tr key={item.row}>
                    <td>{item.row}</td>
                    <td>{kOhm(item.rfb_ohm)}</td>
                    <td>{item.offset_mv !== undefined && item.rfb_ohm > 0 ? `${item.offset_mv > 0 ? '+' : ''}${item.offset_mv.toFixed(1)} mV` : '-'}</td>
                    <td>{item.status ? ds(`rfbStatus_${item.status}`) : ds('rfbNotMeasured')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>

        <div className="settings-subsection">
          <h4>{ds('vrefCalibrationSwitch')}</h4>
          <div className="form-footer">
            <button className="button" type="button" disabled={working || vref.calibration_available === false} onClick={() => void ask(ds('vrefCalibrationSwitch'), { command: 'calibration_switch', on: !calibrationOn })}>
              {calibrationOn ? ds('calSwitchTurnOff') : ds('calSwitchTurnOn')}
            </button>
          </div>
        </div>

        <div className="settings-subsection">
          <h4>{ds('vrefLimitMv')}</h4>
          <p className="field-note">{ds('vrefLimitWarn')}</p>
          <div className="field-grid">
            <Field label={ds('vrefLimitInputLabel')}>{(id) => <NumberInput id={id} min={SAFE_VREF_MV} max={2000} step={10} value={limitDraft} onChange={(e) => setLimitDraft(e.target.value)} />}</Field>
          </div>
          <div className="form-footer">
            <button className="button" type="button" disabled={working} onClick={() => void setVref(ds('vrefLimitApply'), { limit_mv: limitDraft })}>
              {ds('vrefLimitApply')}
            </button>
          </div>
          <p className="field-note">
            {ds('vrefEepromMv')}: {eepromMv !== null ? `${eepromMv} mV` : '-'}
            {vref.eeprom_ok === false ? ' ⚠' : ''}
          </p>
        </div>

        <div className="settings-subsection">
          <h4>{ds('sweepTitle')}</h4>
          <p className="field-note">{ds('sweepCopy')}</p>
          {!rfbValid ? <Notice>{ds('sweepNeedsRfb')}</Notice> : null}
          <div className="field-grid three">
            <Field label={ds('sweepStart')}>{(id) => <NumberInput id={id} min={100} step={10} value={sweepStart} onChange={(e) => setSweepStart(e.target.value)} />}</Field>
            <Field label={ds('sweepStop')}>{(id) => <NumberInput id={id} min={100} step={10} value={sweepStop} onChange={(e) => setSweepStop(e.target.value)} />}</Field>
            <Field label={ds('sweepStep')}>{(id) => <NumberInput id={id} min={10} step={10} value={sweepStep} onChange={(e) => setSweepStep(e.target.value)} />}</Field>
            <Field label={ds('sweepSettle')}>{(id) => <NumberInput id={id} min={20} max={1000} step={10} value={sweepSettle} onChange={(e) => setSweepSettle(e.target.value)} />}</Field>
            <Field label={ds('sweepSolderedRfb')}>{(id) => <NumberInput id={id} min={0} step={100} value={sweepSolderedRfb} onChange={(e) => setSweepSolderedRfb(e.target.value)} />}</Field>
          </div>
          <div className="form-footer">
            {sweep ? (
              <button className="button" type="button" onClick={() => download(`vref-sweep-${Date.now()}.csv`, sweepCsv(sweep.steps, sweep.rows, sweep.cols, sweep.calibration))}>
                {ds('sweepDownload')}
              </button>
            ) : null}
            <button className="button" type="button" disabled={working} onClick={() => void runSweep()}>
              {running('vref_sweep') ? ds('sweepRunning') : ds('sweepRun')}
            </button>
          </div>
          {sweep ? (
            <>
              <table className="vref-table">
                <thead>
                  <tr>
                    <th>Vref</th>
                    <th>{ds('sweepRfbMean')}</th>
                    <th>{ds('sweepRsMedian')}</th>
                    <th>{ds('sweepUsedCells')}</th>
                    <th>{ds('sweepSaturatedCells')}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((item) => (
                    <tr key={item.vrefMv}>
                      <td>{item.vrefMv} mV</td>
                      <td>{kOhm(item.rfbMeanOhm)}</td>
                      <td>{kOhm(item.rsMedianOhm)}</td>
                      <td>{item.usedCells}</td>
                      <td>{item.saturatedCells}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="field-note">{spread !== null ? `${ds('sweepSpread')}: ${(spread * 100).toFixed(1)}%` : ds('sweepNoRs')}</p>
            </>
          ) : null}
        </div>
      </Disclosure>
    </Card>
  );
}
