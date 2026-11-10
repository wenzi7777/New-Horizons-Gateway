// TIA-CTL v2.0.F: the Vref DAC, the calibration switch, the measured Rfb per
// row, the range mode and the Vref sweep (ported from New-Horizons-Desktop
// components/VrefPanel.tsx, v1.7.0). The firmware owns every rule (ceiling,
// safe value, what needs a measured Rfb); this only asks and shows the answer.
import { useEffect, useState } from 'react';

import { Card, Checkbox, Facts, Field, Notice, NumberInput, Select } from '../../components/ui';
import { record } from '../../lib/deviceDetails';
import { rsSpreadFraction, summarizeSweep, sweepCsv, type SweepCalibration, type SweepStep, type SweepSummary } from '../../lib/vrefSweep';
import { useStudio } from '../../state/studio';
import type { Send } from './DeviceHardware';
import { useDeviceSettingsT } from './DeviceHardware';

type RfbRow = { row: number; off_mv: number; on_mv: number; rfb_ohm: number; offset_mv?: number; method?: string; status: string };
type SweepResult = { rows: number; cols: number; steps: SweepStep[]; calibration: SweepCalibration; fallbackRfbOhm: number };

const SAFE_VREF_MV = 330;

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
  URL.revokeObjectURL(url);
}

export function VrefCards({ status, disabled, busy, send }: { status: Record<string, unknown>; disabled: boolean; busy: string; send: Send }) {
  const ds = useDeviceSettingsT();
  const { t } = useStudio();
  const [vrefOverride, setVrefOverride] = useState<Record<string, unknown> | null>(null);
  const [rangeOverride, setRangeOverride] = useState<Record<string, unknown> | null>(null);
  const statusKey = JSON.stringify([status.vref, status.range]);
  useEffect(() => {
    setVrefOverride(null);
    setRangeOverride(null);
  }, [statusKey]);
  const vref = vrefOverride ?? record(status.vref);
  const range = rangeOverride ?? record(status.range);

  const currentMv = num(vref.mv);
  const limitMv = num(vref.limit_mv);
  const calibrationOn = vref.calibration_on === true;
  const modeNow = typeof range.mode === 'string' ? range.mode : 'raw';
  const refRfbNow = num(range.ref_rfb_ohm) ?? 20000;
  const leakNow = range.leak_compensation !== false;
  const rfbTable = numbers(range.rfb_ohm);
  const rfbOffsets = numbers(range.offset_mv);
  const knownRows = num(range.rfb_known_rows) ?? 0;
  const rfbValid = knownRows > 0;

  const [error, setError] = useState<string | null>(null);
  const [vrefDraft, setVrefDraft] = useState('330');
  const [limitDraft, setLimitDraft] = useState('800');
  const [measureVref, setMeasureVref] = useState('');
  const [rfbRows, setRfbRows] = useState<RfbRow[] | null>(null);
  const [modeDraft, setModeDraft] = useState(modeNow);
  const [refRfbDraft, setRefRfbDraft] = useState(String(refRfbNow));
  const [leakDraft, setLeakDraft] = useState(leakNow);
  const [sweepStart, setSweepStart] = useState('100');
  const [sweepStop, setSweepStop] = useState('800');
  const [sweepStep, setSweepStep] = useState('100');
  const [sweepSettle, setSweepSettle] = useState('150');
  const [sweepSolderedRfb, setSweepSolderedRfb] = useState('');
  const [sweep, setSweep] = useState<SweepResult | null>(null);

  useEffect(() => {
    setModeDraft(modeNow);
    setRefRfbDraft(String(refRfbNow));
    setLeakDraft(leakNow);
  }, [modeNow, refRfbNow, leakNow]);
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
    return body(outcome.data);
  }

  const working = disabled;

  async function setVref(label: string, payload: Record<string, unknown>) {
    const result = await ask(label, { command: 'set_vref', ...payload });
    if (result && result.vref !== undefined) setVrefOverride(record(result.vref));
  }

  async function measureRfb() {
    const mv = Number(measureVref);
    const result = await ask(ds('rfbMeasure'), { command: 'rfb_measure', ...(measureVref.trim() && Number.isFinite(mv) ? { vref_mv: mv } : {}) });
    if (!result) return;
    if (Array.isArray(result.rows)) setRfbRows(result.rows as RfbRow[]);
    if (result.range !== undefined) setRangeOverride(record(result.range));
  }

  async function applyRange(label: string, payload: Record<string, unknown>) {
    const result = await ask(label, { command: 'set_range', ...payload });
    if (result && result.range !== undefined) setRangeOverride(record(result.range));
  }

  async function runSweep() {
    const result = await ask(ds('sweepTitle'), { command: 'vref_sweep', start_mv: Number(sweepStart), stop_mv: Number(sweepStop), step_mv: Number(sweepStep), settle_ms: Number(sweepSettle) });
    if (result && Array.isArray(result.steps)) {
      setSweep({
        rows: num(result.rows) ?? 0,
        cols: num(result.cols) ?? 0,
        steps: result.steps as SweepStep[],
        calibration: { rfb_ohm: Array.isArray(result.rfb_ohm) ? numbers(result.rfb_ohm) : undefined, offset_mv: Array.isArray(result.offset_mv) ? numbers(result.offset_mv) : undefined },
        fallbackRfbOhm: Number(sweepSolderedRfb) > 0 ? Number(sweepSolderedRfb) : 0,
      });
    }
  }

  const summary: SweepSummary[] = sweep ? summarizeSweep(sweep.steps, sweep.rows, sweep.cols, sweep.calibration, sweep.fallbackRfbOhm || undefined) : [];
  const spread = rsSpreadFraction(summary);
  const running = (name: string) => busy === name;
  const rfbDisplay: RfbRow[] = rfbRows ?? rfbTable.map((value, row) => ({ row, off_mv: 0, on_mv: 0, rfb_ohm: value, offset_mv: rfbOffsets[row], status: value > 0 ? 'ok' : '' }));

  if (vref.supported !== true) return null;
  return (
    <>
      <Card title={ds('vrefTitle')} copy={ds('vrefCopy')}>
        <Facts
          items={[
            [ds('vrefMv'), vref.ok === false ? t('batteryUnknown') : `${vref.mv ?? '-'} mV`],
            [ds('vrefLimitMv'), `${vref.limit_mv ?? '-'} mV`],
            [ds('vrefEepromMv'), `${vref.eeprom_mv ?? '-'} mV${vref.eeprom_ok === false ? ' ⚠' : ''}`],
            [ds('vrefCalibrationSwitch'), vref.calibration_available === false ? t('batteryUnknown') : calibrationOn ? 'true' : 'false'],
          ]}
        />
        {error ? (
          <div role="alert">
            <Notice kind="error">{error}</Notice>
          </div>
        ) : null}
        <h4>{ds('vrefControlTitle')}</h4>
        <p className="field-note">{ds('vrefLimitWarn')}</p>
        <div className="field-grid">
          <Field label={ds('vrefInputLabel')}>{(id) => <NumberInput id={id} min={100} step={10} value={vrefDraft} onChange={(e) => setVrefDraft(e.target.value)} />}</Field>
          <Field label={ds('vrefLimitInputLabel')}>{(id) => <NumberInput id={id} min={SAFE_VREF_MV} max={2000} step={10} value={limitDraft} onChange={(e) => setLimitDraft(e.target.value)} />}</Field>
        </div>
        <div className="form-footer">
          <button className="button primary" type="button" disabled={working} onClick={() => void setVref(ds('vrefApply'), { mv: Number(vrefDraft) })}>
            {running('set_vref') ? t('running') : ds('vrefApply')}
          </button>
          <button className="button" type="button" disabled={working} onClick={() => void setVref(ds('vrefReset'), { mv: SAFE_VREF_MV })}>
            {ds('vrefReset')}
          </button>
          <button className="button" type="button" disabled={working} onClick={() => void setVref(ds('vrefLimitApply'), { limit_mv: Number(limitDraft) })}>
            {ds('vrefLimitApply')}
          </button>
          <button
            className="button"
            type="button"
            disabled={working || vref.calibration_available === false}
            onClick={() => void ask(ds('vrefCalibrationSwitch'), { command: 'calibration_switch', on: !calibrationOn }).then((r) => r && r.vref !== undefined && setVrefOverride(record(r.vref)))}
          >
            {calibrationOn ? ds('calSwitchTurnOff') : ds('calSwitchTurnOn')}
          </button>
        </div>
      </Card>

      <Card title={ds('rfbTitle')} copy={ds('rfbCopy')}>
        <div className="field-grid">
          <Field label={ds('rfbMeasureVref')}>
            {(id) => <NumberInput id={id} min={100} step={10} value={measureVref} placeholder={String(currentMv ?? SAFE_VREF_MV)} onChange={(e) => setMeasureVref(e.target.value)} />}
          </Field>
        </div>
        <div className="form-footer">
          <button className="button primary" type="button" disabled={working} onClick={() => void measureRfb()}>
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
        ) : (
          <p className="field-note">{ds('rfbNotMeasured')}</p>
        )}
      </Card>

      <Card title={ds('rangeTitle')} copy={ds('rangeCopy')}>
        {!rfbValid ? <Notice>{ds('rangeNeedsRfb')}</Notice> : null}
        <div className="field-grid three">
          <Field label={ds('rangeMode')}>
            {(id) => (
              <Select id={id} value={modeDraft} onChange={(e) => setModeDraft(e.target.value)}>
                <option value="raw">{ds('rangeModeRaw')}</option>
                <option value="virtual" disabled={!rfbValid}>
                  {ds('rangeModeVirtual')}
                </option>
                <option value="auto" disabled={!rfbValid}>
                  {ds('rangeModeAuto')}
                </option>
              </Select>
            )}
          </Field>
          <Field label={ds('rangeRefRfb')}>{(id) => <NumberInput id={id} min={1000} max={1000000} step={1000} value={refRfbDraft} onChange={(e) => setRefRfbDraft(e.target.value)} />}</Field>
          <Checkbox checked={leakDraft} onChange={(e) => setLeakDraft(e.target.checked)} label={ds('rangeLeak')} />
        </div>
        <p className="field-note">
          {ds('rangeSaturated')}: {num(range.saturated_rows) ?? '-'}
        </p>
        <div className="form-footer">
          <button className="button" type="button" disabled={working || !rfbValid} onClick={() => void applyRange(ds('rfbClear'), { clear_rfb: true })}>
            {ds('rfbClear')}
          </button>
          <button className="button primary" type="button" disabled={working} onClick={() => void applyRange(ds('rangeApply'), { mode: modeDraft, ref_rfb_ohm: Number(refRfbDraft), leak_comp: leakDraft })}>
            {running('set_range') ? t('running') : ds('rangeApply')}
          </button>
        </div>
      </Card>

      <Card title={ds('sweepTitle')} copy={ds('sweepCopy')}>
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
          <button className="button primary" type="button" disabled={working} onClick={() => void runSweep()}>
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
      </Card>
    </>
  );
}
