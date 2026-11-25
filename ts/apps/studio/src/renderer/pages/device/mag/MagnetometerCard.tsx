// The magnetometer in NH Studio's device settings (the Desktop's
// components/magCalibration/MagnetometerPanel.tsx):
//
// "runtime" (Streaming, beside the IMU): on/off menu + apply, the reminder
// interval, rates, calibration state. Switching it on goes straight into the
// calibration wizard; cancelling the wizard switches it off again.
// "maintenance": the calibration and its reminder only.

import { useEffect, useState } from 'react';
import { Compass } from 'lucide-react';
import { calibrationDue, MAG_CAL_INTERVAL_CHOICES, magnetometerHint, type MagCalibrationStatus } from '@nhgw/host';

import { Card, Field, Notice, Select, useConfirm } from '../../../components/ui';
import { magClearCalibrationCommand, magCommand } from '../../../lib/commands';
import { useStudio } from '../../../state/studio';
import { MagCalibrationWizard, magModeLabel, type MagSend } from './MagCalibrationWizard';
import { useMagT, type MagKey } from './magStrings';
import './mag.css';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The badge text for a hint, or null when there is nothing to say. */
export function magHintLabel(m: ReturnType<typeof useMagT>, hint: ReturnType<typeof magnetometerHint>): string | null {
  if (!hint) return null;
  if (hint.state === 'none') return m('magHintNone');
  if (hint.state === 'suspect') return m('magHintSuspect');
  if (hint.state === 'due') return m('magHintDue');
  if (hint.state === 'soon') return m('magHintSoon', { n: Math.max(0, hint.daysLeft ?? 0) });
  return null;
}

/** The reminder as a small badge (device list, device header). */
export function MagHintBadge({ magnetometer }: { magnetometer: unknown }) {
  const m = useMagT();
  const hint = magnetometerHint(magnetometer, Date.now());
  const label = magHintLabel(m, hint);
  if (!label || !hint) return null;
  return (
    <span className={`mag-hint-badge ${hint.state}`} title={label}>
      <Compass size={12} aria-hidden="true" />
      {label}
    </span>
  );
}

export function MagnetometerCard({
  variant,
  uid,
  hardwareModel,
  status,
  disabled,
  busy,
  send,
}: {
  variant: 'runtime' | 'maintenance';
  uid: string;
  hardwareModel: string;
  status: Record<string, unknown>;
  disabled: boolean;
  busy: string;
  send: MagSend;
}) {
  const { t } = useStudio();
  const m = useMagT();
  const [dialog, ask] = useConfirm();
  const magnetometer = record(status.magnetometer);
  const supported = typeof magnetometer.enabled === 'boolean';
  const model = String(magnetometer.model ?? '');
  const enabled = magnetometer.enabled === true;
  const calibration = record(magnetometer.calibration) as MagCalibrationStatus & Record<string, unknown>;
  const intervalDays = Number(calibration.interval_days ?? 30);
  const [enabledDraft, setEnabledDraft] = useState(enabled ? 'on' : 'off');
  const [intervalDraft, setIntervalDraft] = useState(String(intervalDays));
  const [wizard, setWizard] = useState<null | { fromEnable: boolean }>(null);

  useEffect(() => setEnabledDraft(enabled ? 'on' : 'off'), [enabled]);
  useEffect(() => setIntervalDraft(String(intervalDays)), [intervalDays]);

  if (!model || model === 'none') {
    return variant === 'runtime' ? <Card title={m('magnetometer')} copy={m('magNotSupported')} /> : null;
  }
  if (!supported) {
    return variant === 'runtime' ? <Card title={`${m('magnetometer')} · ${model}`} copy={m('magNeedsFirmware')} /> : null;
  }

  const due = calibrationDue(calibration, Date.now());
  const calibrated = calibration.mode === 'full' || calibration.mode === 'hard_iron';
  const state = String(magnetometer.state ?? (enabled ? 'ready' : 'disabled'));
  const draftDiffers = enabledDraft !== (enabled ? 'on' : 'off') || Number(intervalDraft) !== intervalDays;
  const running = busy === 'set_mag' || busy === 'set_mag_calibration';
  const hint = enabled ? magnetometerHint(magnetometer, Date.now()) : null;
  const hintLabel = magHintLabel(m, hint);

  async function apply() {
    const turningOn = enabledDraft === 'on' && !enabled;
    const outcome = await send(
      m('magApply'),
      magCommand({
        enabled: enabledDraft !== (enabled ? 'on' : 'off') ? enabledDraft === 'on' : undefined,
        calIntervalDays: Number(intervalDraft) !== intervalDays ? Number(intervalDraft) : undefined,
      }),
    );
    if (outcome.ok && turningOn) setWizard({ fromEnable: true });
  }

  async function closeWizard(applied: boolean) {
    const fromEnable = wizard?.fromEnable === true;
    setWizard(null);
    if (fromEnable && !applied) await send(m('magApply'), magCommand({ enabled: false }), { success: false });
  }

  async function clearCalibration() {
    const ok = await ask({ title: m('magCalClear'), message: m('magCalClearConfirm'), confirmLabel: m('magCalClear'), danger: true });
    if (ok) await send(m('magCalClear'), magClearCalibrationCommand());
  }

  const calibrationLine = calibrated ? (
    <>
      {magModeLabel(m, calibration.mode)}
      {Number(calibration.calibrated_at_ms) > 0 ? ` · ${new Date(Number(calibration.calibrated_at_ms)).toLocaleDateString()}` : ''}
      {calibration.residual_pct !== undefined ? ` · ${m('magCalResidual')} ${Number(calibration.residual_pct).toFixed(1)}%` : ''}
      {due.daysLeft !== null ? ` · ${due.daysLeft >= 0 ? m('magCalDaysLeft', { n: due.daysLeft }) : m('magHintDue')}` : ` · ${m('magCalIntervalNever')}`}
    </>
  ) : (
    m('magCalNever')
  );

  const calibrateButtons = (
    <div className="form-footer">
      {calibrated ? (
        <button className="button ghost" type="button" disabled={disabled || running} onClick={() => void clearCalibration()}>
          {m('magCalClear')}
        </button>
      ) : null}
      <button className="button" type="button" disabled={disabled || running || !enabled} onClick={() => setWizard({ fromEnable: false })}>
        {m('magCalibrate')}
      </button>
    </div>
  );

  const banner =
    hintLabel && hint ? (
      <div className={`mag-hint-banner ${hint.state}`} role="status">
        <Compass size={18} strokeWidth={1.75} aria-hidden="true" />
        <span>{hintLabel}</span>
        <button className="button primary" type="button" disabled={disabled || running} onClick={() => setWizard({ fromEnable: false })}>
          {m('magCalibrateNow')}
        </button>
      </div>
    ) : null;

  const rates = [
    m(`magState_${state}` as MagKey),
    enabled && Number(magnetometer.odr_hz) > 0 ? `${m('magOdr')} ${String(magnetometer.odr_hz)} Hz` : '',
    enabled && Number(magnetometer.averaging) > 0 ? `${m('magAveraging')} ×${String(magnetometer.averaging)}` : '',
    enabled && Number(magnetometer.measured_rate_hz) > 0 ? `${m('magMeasured')} ${Number(magnetometer.measured_rate_hz).toFixed(1)} Hz` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card
      title={variant === 'runtime' ? `${m('magnetometer')} · ${model}` : `${m('magMaintenanceTitle')} · ${model}`}
      copy={variant === 'runtime' ? rates : enabled ? m('magMaintenanceCopy') : m('magMaintenanceOff')}
      className="mag-card"
    >
      {banner}
      {variant === 'runtime' ? (
        <>
          <div className="field-grid">
            <Field label={m('magnetometer')} hint={enabledDraft === 'on' && !enabled ? m('magEnableNeedsCalibration') : undefined}>
              {(id) => (
                <Select id={id} value={enabledDraft} disabled={disabled || running} onChange={(event) => setEnabledDraft(event.target.value)}>
                  <option value="on">{m('magOn')}</option>
                  <option value="off">{m('magOff')}</option>
                </Select>
              )}
            </Field>
            <Field label={m('magCalInterval')}>
              {(id) => (
                <Select id={id} value={intervalDraft} disabled={disabled || running} onChange={(event) => setIntervalDraft(event.target.value)}>
                  {MAG_CAL_INTERVAL_CHOICES.map((days) => (
                    <option key={days} value={String(days)}>{days === 0 ? m('magCalIntervalNever') : m('magCalIntervalDays', { n: days })}</option>
                  ))}
                  {!MAG_CAL_INTERVAL_CHOICES.includes(intervalDays as (typeof MAG_CAL_INTERVAL_CHOICES)[number]) ? (
                    <option value={String(intervalDays)}>{m('magCalIntervalDays', { n: intervalDays })}</option>
                  ) : null}
                </Select>
              )}
            </Field>
          </div>
          <div className="form-footer">
            <button className="button primary" type="button" disabled={disabled || running || !draftDiffers} onClick={() => void apply()}>
              {busy === 'set_mag' ? t('running') : m('magApply')}
            </button>
          </div>
          {magnetometer.blocked_by === 'imu' ? <Notice kind="warning">{m('magBlockedByImu')}</Notice> : null}
          {enabled && state === 'error' && magnetometer.last_error ? <Notice kind="error">{String(magnetometer.last_error)}</Notice> : null}
          <p className="field-note">
            <strong>{m('magCalStatus')}</strong>: {calibrationLine}
          </p>
        </>
      ) : enabled ? (
        <p className="field-note">{calibrationLine}</p>
      ) : null}
      {calibrateButtons}
      {wizard ? (
        <MagCalibrationWizard uid={uid} hardwareModel={hardwareModel} magnetometer={magnetometer} fromEnable={wizard.fromEnable} send={send} onClose={(applied) => void closeWizard(applied)} />
      ) : null}
      {dialog}
    </Card>
  );
}
