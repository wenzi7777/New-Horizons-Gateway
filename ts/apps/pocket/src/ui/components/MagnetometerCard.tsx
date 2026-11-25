// The magnetometer on NH Pocket's device screen: on/off + reminder interval
// with one Apply (as the Desktop and Studio), the calibration state, and the
// reminder banner. Switching it on opens the calibration screen straight
// away; leaving that screen without applying switches it off again.

import { useRouter } from 'expo-router';
import { Compass } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { calibrationDue, MAG_CAL_INTERVAL_CHOICES, magnetometerHint, type DeviceView, type MagnetometerView } from '@nhgw/host';

import { Body, Button, Caption, Card, Notice, SectionHeader, type Tone } from './primitives';
import { ChoiceSegment } from './ChoiceSegment';
import { useI18n } from '../i18n';

type T = ReturnType<typeof useI18n>['t'];

/** The reminder for a device list / header, or null when there is nothing to say. */
export function magHint(t: T, magnetometer: MagnetometerView | undefined, nowMs: number): { label: string; tone: Tone } | null {
  const hint = magnetometerHint(magnetometer, nowMs);
  if (!hint) return null;
  if (hint.state === 'none') return { label: t('magHintNone'), tone: 'warning' };
  if (hint.state === 'suspect') return { label: t('magHintSuspect'), tone: 'warning' };
  if (hint.state === 'due') return { label: t('magHintDue'), tone: 'warning' };
  if (hint.state === 'soon') return { label: t('magHintSoon', { n: Math.max(0, hint.daysLeft ?? 0) }), tone: 'accent' };
  return null;
}

export function magModeText(t: T, mode: unknown): string {
  return mode === 'full' ? t('magCalModeFull') : mode === 'hard_iron' ? t('magCalModeHardIron') : t('magCalModeNone');
}

export function MagnetometerCard({
  device,
  busy,
  run,
  confirmClear,
}: {
  device: Pick<DeviceView, 'uid' | 'online' | 'magnetometer'>;
  busy: boolean;
  /** Sends one command (toasts, busy state); resolves ok. */
  run: (command: { kind: 'mag'; enabled?: boolean; calIntervalDays?: number } | { kind: 'mag_calibration_clear' }) => Promise<boolean | undefined>;
  confirmClear: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const mag = device.magnetometer;
  const enabled = mag?.enabled === true;
  const intervalDays = Number(mag?.calibration.interval_days ?? 30);
  const [enabledDraft, setEnabledDraft] = useState<'on' | 'off'>(enabled ? 'on' : 'off');
  const [intervalDraft, setIntervalDraft] = useState<number>(intervalDays);
  useEffect(() => setEnabledDraft(enabled ? 'on' : 'off'), [enabled]);
  useEffect(() => setIntervalDraft(intervalDays), [intervalDays]);
  if (!mag) return null;

  const offline = !device.online;
  const calibration = mag.calibration;
  const calibrated = calibration.mode === 'full' || calibration.mode === 'hard_iron';
  const due = calibrationDue(calibration, Date.now());
  const hint = enabled ? magHint(t, mag, Date.now()) : null;
  const differs = enabledDraft !== (enabled ? 'on' : 'off') || intervalDraft !== intervalDays;
  const openWizard = (fromEnable: boolean) => router.push({ pathname: '/magcal/[uid]', params: { uid: device.uid, fromEnable: fromEnable ? '1' : '0' } });

  const apply = async () => {
    const turningOn = enabledDraft === 'on' && !enabled;
    const ok = await run({
      kind: 'mag',
      enabled: enabledDraft !== (enabled ? 'on' : 'off') ? enabledDraft === 'on' : undefined,
      calIntervalDays: intervalDraft !== intervalDays ? intervalDraft : undefined,
    });
    if (ok && turningOn) openWizard(true);
  };

  const intervalOptions = MAG_CAL_INTERVAL_CHOICES.map((days) => ({ value: days as number, label: days === 0 ? t('magCalIntervalNever') : `${days}` }));

  return (
    <>
      <SectionHeader title={`${t('magnetometer')} · ${mag.model}`} />
      {hint ? (
        <Notice tone={hint.tone} icon={Compass} title={hint.label}>
          <Button label={t('magCalibrateNow')} variant="primary" compact disabled={offline || busy} onPress={() => openWizard(false)} />
        </Notice>
      ) : null}
      <Card>
        <Caption>{t(`magState_${mag.state === 'blocked' || mag.state === 'ready' || mag.state === 'error' ? mag.state : 'disabled'}` as never)}</Caption>
        <ChoiceSegment<'on' | 'off'>
          options={[
            { value: 'on', label: t('magOn') },
            { value: 'off', label: t('magOff') },
          ]}
          value={enabledDraft}
          onChange={setEnabledDraft}
          disabled={offline || busy}
          accessibilityLabel={t('magnetometer')}
        />
        {enabledDraft === 'on' && !enabled ? <Caption>{t('magEnableNeedsCalibration')}</Caption> : null}
        <Body style={{ fontWeight: '600', marginTop: 8 }}>{t('magCalInterval')}</Body>
        <ChoiceSegment<number> options={intervalOptions} value={intervalDraft} onChange={setIntervalDraft} disabled={offline || busy} accessibilityLabel={t('magCalInterval')} />
        <Caption>{intervalDraft === 0 ? t('magCalIntervalNever') : t('magCalIntervalDays', { n: intervalDraft })}</Caption>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
          <Button label={t('magApply')} variant="primary" busy={busy} disabled={offline || !differs} onPress={() => void apply()} />
        </View>
        {mag.state === 'blocked' ? <Caption>{t('magBlockedByImu')}</Caption> : null}
      </Card>
      <Card>
        <Body style={{ fontWeight: '600' }}>{t('magCalStatus')}</Body>
        <Caption>
          {calibrated
            ? [
                magModeText(t, calibration.mode),
                Number(calibration.calibrated_at_ms) > 0 ? new Date(Number(calibration.calibrated_at_ms)).toLocaleDateString() : '',
                calibration.residual_pct !== undefined ? `${t('magCalResidual')} ${Number(calibration.residual_pct).toFixed(1)}%` : '',
                due.daysLeft !== null ? (due.daysLeft >= 0 ? t('magCalDaysLeft', { n: due.daysLeft }) : t('magHintDue')) : t('magCalIntervalNever'),
              ]
                .filter(Boolean)
                .join(' · ')
            : t('magCalNever')}
        </Caption>
        {enabled ? <Caption>{t('magMaintenanceCopy')}</Caption> : null}
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          {calibrated ? (
            <Button
              label={t('magCalClear')}
              variant="plain"
              disabled={offline || busy}
              onPress={() => void confirmClear().then((ok) => (ok ? run({ kind: 'mag_calibration_clear' }) : undefined))}
            />
          ) : null}
          <Button label={t('magCalibrate')} disabled={offline || busy || !enabled} onPress={() => openWizard(false)} />
        </View>
      </Card>
    </>
  );
}
