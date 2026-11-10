// Device Settings: scanning, signal and stream, power and battery, clock,
// maintenance mode, firmware update and the device log. Current values come
// from StudioSnapshot.deviceDetails[uid].status (lib/deviceDetails.ts); every
// change is sent with the Desktop's exact payload (lib/commands.ts).

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

import type { DeviceView } from '../../../shared/contract';
import { Card, Disclosure, Facts, Field, Notice, Segmented, SwitchRow, useConfirm, NumberInput, Select, TextInput } from '../../components/ui';
import {
  BATTERY_PRESETS,
  batteryCapacityChoiceFor,
  batteryProfileValidationError,
  durationLabel,
  estimateBatteryTime,
  type BatteryCapacityChoice,
} from '../../lib/batteryProfile';
import {
  buildBatteryGaugeResyncCommand,
  buildBatteryProfileCommand,
  CHARGE_PROFILES,
  chargeProfileCommand,
  clockConfigCommand,
  clockStatusCommand,
  clockSyncCommand,
  effectiveSendFps,
  FILTER_MEDIANS,
  filterAlphaValid,
  filterCommand,
  imuCommand,
  LOG_LEVELS,
  logClearCommand,
  logSettingsCommand,
  maintenanceCommand,
  otaConfigCommand,
  powerStateCommand,
  rawAdcCommand,
  scanHealthCommand,
  scanPresetTiming,
  scanTimingCommand,
  scanTimingValidationError,
  setTimeCommand,
  statusCommand,
  streamBufferCommand,
  updateChannelCommand,
  updateCommand,
  type Payload,
  type ScanTiming,
  type UpdateChannel,
} from '../../lib/commands';
import { clockView, deviceSettingsView, record, updatePhaseKey, type ClockView } from '../../lib/deviceDetails';
import { formatMicros, scanRateLow } from '../../lib/scanHealth';
import { formatBytes } from '../../lib/format';
import { progressOf, updateTransferProgress } from '../../lib/updateProgress';
import { useStudio } from '../../state/studio';
import { ActionButtonCard, BatteryLedCard, ConnectionCard, LightsCard, PinsCard, RamCard, RestartCard, useDeviceSettingsT } from './DeviceHardware';

/** A draft that follows the device's value until the user edits it. */
function useDraft<V>(value: V): [V, (next: V) => void, boolean, () => void] {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  const key = JSON.stringify(value);
  useEffect(() => {
    if (!dirty) setDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dirty]);
  return [
    draft,
    (next: V) => {
      setDraft(next);
      setDirty(JSON.stringify(next) !== key);
    },
    dirty,
    () => {
      setDirty(false);
      setDraft(value);
    },
  ];
}

// The Desktop's device settings sections (pages/DeviceSettingsPage.tsx), in
// its order. Streaming carries the clock; Hardware carries the Action Button.
export const DEVICE_SETTINGS_SECTIONS = ['overview', 'hardware', 'runtime', 'update', 'diagnostics'] as const;
export type DeviceSettingsSectionId = (typeof DEVICE_SETTINGS_SECTIONS)[number];

export function DeviceSettings({ device }: { device: DeviceView }) {
  const { t, exec, api, snapshot } = useStudio();
  const ds = useDeviceSettingsT();
  const detail = snapshot?.deviceDetails[device.uid];
  const view = useMemo(() => deviceSettingsView(detail), [detail]);
  const rec = record(detail?.record);
  const status = record(detail?.status ?? rec.last_status);
  const [busy, setBusy] = useState('');
  const [dialog, ask] = useConfirm();
  const [active, setActive] = useState<DeviceSettingsSectionId>('hardware');
  const disabled = !device.online || busy !== '';

  /** Send one payload through the engine; logged, toasted, returns ok. */
  const send = async (label: string, payload: Payload, options: { success?: string | false } = {}) => {
    setBusy(String(payload.command));
    try {
      const outcome = await exec(label, () => api.sendCommand(device.uid, payload), { uid: device.uid, payload, ...options });
      return outcome;
    } finally {
      setBusy('');
    }
  };
  const cardProps = { device, status, disabled, busy, send };

  const body: Record<DeviceSettingsSectionId, ReactNode> = {
    overview: (
      <>
        <ConnectionCard {...cardProps} record={rec} />
        <RestartCard disabled={!device.online || busy !== ''} busy={busy} send={send} ask={ask} />
      </>
    ),
    hardware: (
      <>
        <PinsCard {...cardProps} />
        <PowerSection device={device} view={view} disabled={disabled} busy={busy} send={send} ask={ask} />
        <BatteryLedCard {...cardProps} />
        <ActionButtonCard {...cardProps} />
        <LightsCard {...cardProps} />
      </>
    ),
    runtime: (
      <>
        <ScanSection view={view} disabled={disabled} busy={busy} send={send} />
        <ClockSection device={device} disabled={disabled} busy={busy} send={send} />
      </>
    ),
    update: (
      <>
        <UpdateSection device={device} view={view} disabled={disabled} busy={busy} send={send} ask={ask} />
        <MaintenanceSection device={device} view={view} disabled={disabled} busy={busy} send={send} ask={ask} />
      </>
    ),
    diagnostics: (
      <>
        <SignalSection view={view} disabled={disabled} busy={busy} send={send} />
        <RamCard status={status} disabled={disabled} busy={busy} send={send} />
        <LogsSection device={device} view={view} disabled={disabled} busy={busy} send={send} ask={ask} />
        <Disclosure summary={t('techDetails')}>
          <p className="field-note">{t('rawStatus')}</p>
          <pre className="json-view">{JSON.stringify(detail?.status ?? null, null, 2)}</pre>
        </Disclosure>
      </>
    ),
  };

  return (
    <div className="device-settings-layout">
      <nav className="device-settings-nav" aria-label={t('tabSettings')}>
        {DEVICE_SETTINGS_SECTIONS.map((id) => (
          <button key={id} type="button" className={active === id ? 'active' : ''} aria-current={active === id ? 'page' : undefined} onClick={() => setActive(id)}>
            {ds(`settingsSection_${id}`)}
          </button>
        ))}
        <button className="button tiny ghost chip-refresh" type="button" disabled={disabled} onClick={() => void send(t('actionStatus'), statusCommand(), { success: t('statusRefreshed') })}>
          <RefreshCw size={13} aria-hidden="true" />
          {busy === 'status' ? t('running') : t('actionStatus')}
        </button>
      </nav>
      <section className="stack settings-section" aria-label={ds(`settingsSection_${active}`)}>
        <h3 className="section-title">{ds(`settingsSection_${active}`)}</h3>
        {!device.online ? <Notice kind="warning">{t('deviceOfflineNotice')}</Notice> : null}
        {!view.hasStatus ? <Notice>{t('noStatusYet')}</Notice> : null}
        {body[active]}
      </section>
      {dialog}
    </div>
  );
}

type View = ReturnType<typeof deviceSettingsView>;
type Send = (label: string, payload: Payload, options?: { success?: string | false }) => Promise<{ ok: boolean; data: unknown }>;
type Ask = ReturnType<typeof useConfirm>[1];
type SectionProps = { view: View; disabled: boolean; busy: string; send: Send };

function onOff(t: ReturnType<typeof useStudio>['t'], value: boolean) {
  return value ? t('valueOn') : t('valueOff');
}

// ---- Scanning -----------------------------------------------------------------

function ScanSection({ view, disabled, busy, send }: SectionProps) {
  const { t } = useStudio();
  const [timing, setTiming, dirty, reset] = useDraft<ScanTiming>(view.scanTiming);
  const preset = timing.send_every_n_frames === 1 && (timing.target_fps === 60 || timing.target_fps === 90) && scanPresetTiming(timing.target_fps).settle_us === timing.settle_us ? timing.target_fps : null;
  const [custom, setCustom] = useState(preset === null);
  const invalid = scanTimingValidationError(timing);
  const health = view.scanHealth;
  const choice: number | 'custom' = custom ? 'custom' : (preset ?? 'custom');
  return (
    <>
      <Card title={t('secScan')} copy={t('scanCopy')}>
        <Segmented<number | 'custom'>
          label={t('secScan')}
          value={choice}
          options={[
            { value: 60, label: t('scanStandard') },
            { value: 90, label: t('scanExtended') },
            { value: 'custom', label: t('scanCustom') },
          ]}
          onChange={(value) => {
            if (value === 'custom') {
              setCustom(true);
              return;
            }
            setCustom(false);
            setTiming(scanPresetTiming(value));
          }}
        />
        {choice === 'custom' ? (
          <div className="field-grid three">
            <Field label={t('targetFps')}>
              {(id) => <NumberInput id={id} min={1} max={200} value={timing.target_fps} onChange={(e) => setTiming({ ...timing, target_fps: Number(e.target.value) })} />}
            </Field>
            <Field label={t('settleUs')}>
              {(id) => <NumberInput id={id} min={0} max={1000} value={timing.settle_us} onChange={(e) => setTiming({ ...timing, settle_us: Number(e.target.value) })} />}
            </Field>
            <Field label={t('sendEvery')}>
              {(id) => <NumberInput id={id} min={1} max={60} value={timing.send_every_n_frames} onChange={(e) => setTiming({ ...timing, send_every_n_frames: Number(e.target.value) })} />}
            </Field>
          </div>
        ) : null}
        {invalid ? <span className="field-error" role="alert">{t('invalidScanTiming')}</span> : null}
        <p className="field-note">
          {t('effectiveSend', { fps: effectiveSendFps(timing) })} ·{' '}
          {t('onDevice', { value: `${view.scanTiming.target_fps} fps / ${view.scanTiming.settle_us} µs / ${view.scanTiming.send_every_n_frames}` })}
        </p>
        <div className="form-footer">
          {dirty ? <span className="dirty-indicator">{t('unsavedChanges')}</span> : null}
          {dirty ? (
            <button className="button ghost" type="button" onClick={reset}>
              {t('revert')}
            </button>
          ) : null}
          <button
            className="button primary"
            type="button"
            disabled={disabled || !dirty || invalid !== null}
            onClick={() => void send(t('applyScanTiming'), scanTimingCommand(timing)).then((o) => o.ok && reset())}
          >
            {busy === 'set_scan_timing' ? t('running') : t('applyScanTiming')}
          </button>
        </div>
      </Card>
      <Card
        title={t('scanHealthTitle')}
        actions={
          <button className="button tiny" type="button" disabled={disabled} onClick={() => void send(t('scanHealthTitle'), scanHealthCommand(), { success: false })}>
            <RefreshCw size={13} aria-hidden="true" />
            {busy === 'scan_health' ? t('running') : t('actionStatus')}
          </button>
        }
      >
        {scanRateLow(health) ? <Notice kind="warning">{t('scanRateLowWarn')}</Notice> : null}
        <Facts
          items={[
            [t('scanActual'), health.actualFps !== null ? `${health.actualFps} / ${health.targetFps ?? '-'} fps` : t('notReported')],
            [t('scanBudget'), formatMicros(health.budgetUs)],
            [t('scanLast'), formatMicros(health.lastScanUs)],
            [t('scanOverruns'), health.overrunFrames ?? t('notReported')],
            [t('scanQueueDropped'), health.queueDropped ?? t('notReported')],
          ]}
        />
      </Card>
    </>
  );
}

// ---- Signal and stream -----------------------------------------------------------

function SignalSection({ view, disabled, busy, send }: SectionProps) {
  const { t } = useStudio();
  const [filter, setFilter, filterDirty, resetFilter] = useDraft(view.filter);
  const [rawAdc, setRawAdc, rawDirty, resetRaw] = useDraft(view.rawAdc);
  const [imu, setImu, imuDirty, resetImu] = useDraft(view.imu.enabled);
  const [buffer, setBuffer, bufferDirty, resetBuffer] = useDraft({ enabled: view.streamBuffer.enabled, mode: view.streamBuffer.mode });
  const alphaOk = filterAlphaValid(filter.alpha);
  return (
    <>
      <Card title={t('filterTitle')} copy={t('filterCopy')}>
        <SwitchRow checked={filter.enabled} onChange={(enabled) => setFilter({ ...filter, enabled })} title={t('enabledLabel')} />
        <div className="field-grid">
          <Field label={t('filterMedian')}>
            {(id) => (
              <Select id={id} value={filter.median} disabled={!filter.enabled} onChange={(e) => setFilter({ ...filter, median: Number(e.target.value) })}>
                {FILTER_MEDIANS.map((m) => (
                  <option key={m} value={m}>
                    {m === 1 ? `1 (${t('filterMedianOff')})` : m}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('filterAlpha')} hint={t('filterAlphaHint')}>
            {(id) => (
              <NumberInput
                id={id}
               
                min={0.05}
                max={0.6}
                step={0.05}
                value={filter.alpha}
                disabled={!filter.enabled}
                className={alphaOk ? '' : 'invalid'}
                aria-invalid={!alphaOk}
                onChange={(e) => setFilter({ ...filter, alpha: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
        <p className="field-note">
          {t('onDevice', { value: view.filter.enabled ? `${t('valueOn')} · ${t('filterMedian')} ${view.filter.median} · α ${view.filter.alpha}` : t('valueOff') })}
        </p>
        <SaveRow dirty={filterDirty} onRevert={resetFilter} disabled={disabled || !filterDirty || !alphaOk} running={busy === 'set_filter'} onSave={() => void send(t('filterTitle'), filterCommand(filter.enabled, filter.median, filter.alpha)).then((o) => o.ok && resetFilter())} />
      </Card>
      <div className="card-grid">
        <Card title={t('imuTitle')} copy={t('imuCopy')}>
          <SwitchRow checked={imu} onChange={setImu} title={t('enabledLabel')} copy={`${view.imu.state}${view.imu.sampleRateHz ? ` · ${view.imu.sampleRateHz} Hz` : ''}`} />
          {view.imu.lastError ? <Notice kind="error">{view.imu.lastError}</Notice> : null}
          <SaveRow dirty={imuDirty} onRevert={resetImu} disabled={disabled || !imuDirty} running={busy === 'set_imu'} onSave={() => void send(t('imuTitle'), imuCommand(imu)).then((o) => o.ok && resetImu())} />
        </Card>
        <Card title={t('rawAdcTitle')} copy={t('rawAdcCopy')}>
          <SwitchRow checked={rawAdc} onChange={setRawAdc} title={t('enabledLabel')} copy={t('onDevice', { value: onOff(t, view.rawAdc) })} />
          <SaveRow dirty={rawDirty} onRevert={resetRaw} disabled={disabled || !rawDirty} running={busy === 'set_raw_adc'} onSave={() => void send(t('rawAdcTitle'), rawAdcCommand(rawAdc)).then((o) => o.ok && resetRaw())} />
        </Card>
      </div>
      <Card title={t('streamBufferTitle')} copy={t('streamBufferCopy')}>
        <SwitchRow
          checked={buffer.enabled}
          onChange={(enabled) => setBuffer({ ...buffer, enabled })}
          title={t('enabledLabel')}
          copy={view.streamBuffer.depthFrames !== null ? `${view.streamBuffer.mode} · ${view.streamBuffer.depthFrames}` : view.streamBuffer.mode}
        />
        <Segmented
          label={t('streamBufferTitle')}
          value={buffer.mode}
          disabled={!buffer.enabled}
          options={[
            { value: 'standard', label: t('bufferStandard') },
            { value: 'extended', label: t('bufferExtended') },
          ]}
          onChange={(mode) => setBuffer({ ...buffer, mode })}
        />
        <SaveRow dirty={bufferDirty} onRevert={resetBuffer} disabled={disabled || !bufferDirty} running={busy === 'set_stream_buffer'} onSave={() => void send(t('streamBufferTitle'), streamBufferCommand(buffer.enabled, buffer.mode)).then((o) => o.ok && resetBuffer())} />
      </Card>
    </>
  );
}

function SaveRow({ dirty, disabled, running, onSave, onRevert, label }: { dirty: boolean; disabled: boolean; running: boolean; onSave: () => void; onRevert: () => void; label?: string }) {
  const { t } = useStudio();
  return (
    <div className="form-footer">
      {dirty ? <span className="dirty-indicator">{t('unsavedChanges')}</span> : null}
      {dirty ? (
        <button className="button ghost" type="button" onClick={onRevert}>
          {t('revert')}
        </button>
      ) : null}
      <button className="button primary" type="button" disabled={disabled} onClick={onSave}>
        {running ? t('running') : (label ?? t('saveSetting'))}
      </button>
    </div>
  );
}

// ---- Power and battery --------------------------------------------------------------

function PowerSection({ device, view, disabled, busy, send, ask }: SectionProps & { device: DeviceView; ask: Ask }) {
  const { t } = useStudio();
  const battery = view.battery;
  const [profile, setProfile, profileDirty, resetProfile] = useDraft(view.chargeProfile);
  const seeded = battery.capacityMah !== null && battery.maxChargeCurrentMa !== null ? batteryCapacityChoiceFor(battery.capacityMah, battery.maxChargeCurrentMa) : '400';
  const [pack, setPack, packDirty, resetPack] = useDraft<{ choice: BatteryCapacityChoice; capacity: string; current: string }>({
    choice: seeded,
    capacity: seeded === 'custom' && battery.capacityMah !== null ? String(battery.capacityMah) : '',
    current: String(battery.maxChargeCurrentMa ?? 100),
  });
  const packError = batteryProfileValidationError(pack.choice, pack.capacity, pack.current);
  const estimate = estimateBatteryTime(battery, view.power.chargeState);
  const estimateText =
    estimate.kind === 'remaining'
      ? t('batteryTimeRemaining', { time: durationLabel(estimate.minutes) })
      : estimate.kind === 'until_full'
        ? t('batteryTimeToFull', { time: durationLabel(estimate.minutes) })
        : estimate.kind === 'full'
          ? t('batteryFull')
          : '-';

  if (!view.chargeControlSupported) {
    return <Notice>{t('batteryNotReported')}</Notice>;
  }
  return (
    <>
      <Card title={t('infoBattery')}>
        <Facts
          items={[
            [t('batteryLevel'), battery.syncState === 'syncing' ? t('batterySyncing') : battery.socPercent === null ? t('batteryUnknown') : `${Math.round(battery.socPercent)}%`],
            [t('batteryVoltage'), battery.vbatMv === null ? t('batteryUnknown') : `${(battery.vbatMv / 1000).toFixed(2)} V`],
            [t('chargeState'), view.power.chargeState],
            [t('batteryEstimate'), estimateText],
          ]}
        />
      </Card>
      <Card title={t('chargeProfile')} copy={t('chargeProfileCopy')}>
        <div className="inline-form">
          <Select aria-label={t('chargeProfile')} value={profile} onChange={(e) => setProfile(e.target.value)}>
            {CHARGE_PROFILES.map((p) => (
              <option key={p} value={p}>
                {t(`charge_${p}`)}
              </option>
            ))}
          </Select>
          <SaveRow dirty={profileDirty} onRevert={resetProfile} disabled={disabled || !profileDirty} running={busy === 'set_charge_profile'} onSave={() => void send(t('chargeProfile'), chargeProfileCommand(profile)).then((o) => o.ok && resetProfile())} />
        </div>
      </Card>
      <Card title={t('batterySetup')} copy={t('batterySetupCopy')}>
        <div className="field-grid three">
          <Field label={t('batteryCapacity')}>
            {(id) => (
              <Select id={id} value={pack.choice} onChange={(e) => setPack({ ...pack, choice: e.target.value as BatteryCapacityChoice })}>
                {BATTERY_PRESETS.map((p) => (
                  <option key={p.capacityMah} value={String(p.capacityMah)}>
                    {p.capacityMah} mAh · {p.maxChargeCurrentMa} mA
                  </option>
                ))}
                <option value="custom">{t('batteryCustom')}</option>
              </Select>
            )}
          </Field>
          {pack.choice === 'custom' ? (
            <>
              <Field label={t('customCapacity')}>
                {(id) => <NumberInput id={id} min={1} value={pack.capacity} onChange={(e) => setPack({ ...pack, capacity: e.target.value })} />}
              </Field>
              <Field label={t('maxChargeCurrent')}>
                {(id) => <NumberInput id={id} min={100} max={350} step={10} value={pack.current} onChange={(e) => setPack({ ...pack, current: e.target.value })} />}
              </Field>
            </>
          ) : null}
        </div>
        {packError ? <span className="field-error" role="alert">{t('invalidBatteryProfile')}</span> : null}
        <div className="form-footer">
          <button className="button" type="button" disabled={disabled} onClick={() => void send(t('resyncGauge'), buildBatteryGaugeResyncCommand())}>
            {busy === 'resync_battery_gauge' ? t('running') : t('resyncGauge')}
          </button>
          <button
            className="button primary"
            type="button"
            disabled={disabled || !packDirty || packError !== null}
            onClick={() => void send(t('saveBatteryProfile'), buildBatteryProfileCommand(pack.choice, pack.capacity, pack.current)).then((o) => o.ok && resetPack())}
          >
            {busy === 'set_battery_profile' ? t('running') : t('saveBatteryProfile')}
          </button>
        </div>
      </Card>
      <Card
        title={t('powerState')}
        actions={
          <>
            {view.power.state !== 'normal' && view.power.state !== '-' ? (
              <button className="button" type="button" disabled={disabled} onClick={() => void send(t('resumeNormal'), powerStateCommand('normal'))}>
                {t('resumeNormal')}
              </button>
            ) : null}
            <button
              className="button"
              type="button"
              disabled={disabled}
              onClick={async () => {
                if (await ask({ title: t('confirmSoftOffTitle', { device: device.displayName }), message: t('confirmSoftOffMessage'), confirmLabel: t('softOff') })) {
                  await send(t('softOff'), powerStateCommand('soft_off_auto'));
                }
              }}
            >
              {busy === 'power_set_state' ? t('running') : t('softOff')}
            </button>
          </>
        }
      >
        <Facts
          items={[
            [t('powerState'), view.power.state],
            [t('wakeSource'), view.power.wakeSource],
          ]}
        />
      </Card>
    </>
  );
}

// ---- Clock --------------------------------------------------------------------------

function ClockSection({ device, disabled, busy, send }: { device: DeviceView; disabled: boolean; busy: string; send: Send }) {
  const { t, locale } = useStudio();
  const [clock, setClock] = useState<(ClockView & { receivedAtMs: number }) | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [form, setForm] = useState({ ntpServer: '', ntpIntervalS: '', syncIntervalS: '' });
  const [formDirty, setFormDirty] = useState(false);

  const take = (outcome: { ok: boolean; data: unknown; message?: string }) => {
    if (!outcome.ok) {
      if (outcome.message === 'unknown_command') setUnsupported(true);
      return;
    }
    const next = clockView(outcome.data);
    if (next) {
      setClock({ ...next, receivedAtMs: Date.now() });
      if (!formDirty)
        setForm({
          ntpServer: next.config.ntpServer,
          ntpIntervalS: next.config.ntpIntervalS === null ? '' : String(next.config.ntpIntervalS),
          syncIntervalS: next.config.syncIntervalS === null ? '' : String(next.config.syncIntervalS),
        });
    }
  };
  const read = async () => take(await send(t('readClock'), clockStatusCommand(), { success: false }));

  useEffect(() => {
    if (device.online) void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.uid, device.online]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const deviceNow = clock?.epochMs != null ? clock.epochMs + (now - clock.receivedAtMs) : null;
  const fmt = (ms: number) => {
    try {
      return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));
    } catch {
      return new Date(ms).toTimeString().slice(0, 8);
    }
  };
  const offset = clock?.epochMs != null ? Math.round(clock.epochMs - clock.receivedAtMs) : null;

  return (
    <Card title={t('secClock')} copy={t('clockCopy')}>
      {unsupported ? <Notice>{t('clockUnsupported')}</Notice> : null}
      <div className="clock-digital" aria-live="off">
        <div>
          <span className="metric-label">{t('clockDeviceTime')}</span>
          <strong className="clock-time mono">{deviceNow !== null ? fmt(deviceNow) : '--:--:--'}</strong>
          <span className={`tag ${clock?.synced ? 'accent' : 'waiting'}`}>{clock ? (clock.synced ? t('clockSynced') : t('clockNotSynced')) : t('clockNotRead')}</span>
        </div>
        <div>
          <span className="metric-label">{t('clockComputerTime')}</span>
          <span className="clock-ref mono">{fmt(now)}</span>
        </div>
      </div>
      {clock ? (
        <Facts
          items={[
            [t('clockSource'), `${clock.source}${clock.mode ? ` (${clock.mode})` : ''}`],
            [t('clockUncertainty'), clock.uncertaintyMs !== null ? `±${clock.uncertaintyMs} ms` : '-'],
            [t('clockRtt'), clock.serverRttUs !== null ? formatMicros(clock.serverRttUs) : '-'],
            [t('clockOffset'), offset !== null ? `${offset > 0 ? '+' : ''}${offset} ms` : '-'],
          ]}
        />
      ) : null}
      <div className="actions">
        <button className="button" type="button" disabled={disabled || unsupported} onClick={() => void read()}>
          {busy === 'clock_status' ? t('running') : t('readClock')}
        </button>
        <button className="button" type="button" disabled={disabled || unsupported} onClick={async () => take(await send(t('clockSyncNow'), clockSyncCommand()))}>
          {busy === 'clock_sync' ? t('running') : t('clockSyncNow')}
        </button>
        <button className="button" type="button" disabled={disabled || unsupported} onClick={async () => take(await send(t('clockUseComputerTime'), setTimeCommand(Date.now())))}>
          {busy === 'set_time' ? t('running') : t('clockUseComputerTime')}
        </button>
      </div>
      <Disclosure summary={t('clockSettings')}>
        <form
          className="field-grid three"
          onSubmit={async (event) => {
            event.preventDefault();
            const outcome = await send(t('clockSettings'), clockConfigCommand(form));
            if (outcome.ok) {
              setFormDirty(false);
              take(outcome);
            }
          }}
        >
          <Field label={t('ntpServer')}>
            {(id) => <TextInput id={id} type="text" value={form.ntpServer} onChange={(e) => (setForm({ ...form, ntpServer: e.target.value }), setFormDirty(true))} />}
          </Field>
          <Field label={t('ntpInterval')}>
            {(id) => <NumberInput id={id} min={1} value={form.ntpIntervalS} onChange={(e) => (setForm({ ...form, ntpIntervalS: e.target.value }), setFormDirty(true))} />}
          </Field>
          <Field label={t('syncInterval')}>
            {(id) => <NumberInput id={id} min={1} value={form.syncIntervalS} onChange={(e) => (setForm({ ...form, syncIntervalS: e.target.value }), setFormDirty(true))} />}
          </Field>
          <div className="form-footer span-all">
            <button className="button primary" type="submit" disabled={disabled || unsupported || !formDirty}>
              {busy === 'set_clock_config' ? t('running') : t('save')}
            </button>
          </div>
        </form>
      </Disclosure>
    </Card>
  );
}

// ---- Maintenance mode ---------------------------------------------------------------

function MaintenanceSection({ device, view, disabled, busy, send, ask }: SectionProps & { device: DeviceView; ask: Ask }) {
  const { t } = useStudio();
  const mode = view.mode || device.mode;
  const inMaintenance = mode === 'maintenance' || mode === 'safe_maintenance';
  return (
    <Card
      title={t('secMaintenance')}
      copy={t('maintenanceCopy')}
      actions={
        <button
          className={`button${inMaintenance ? ' primary' : ''}`}
          type="button"
          disabled={disabled || mode === 'safe_maintenance'}
          onClick={async () => {
            if (inMaintenance) {
              await send(t('exitMaintenance'), maintenanceCommand(false));
              return;
            }
            if (await ask({ title: t('confirmMaintenanceTitle'), message: t('confirmMaintenanceMessage', { device: device.displayName }), confirmLabel: t('enterMaintenance') })) {
              await send(t('enterMaintenance'), maintenanceCommand(true));
            }
          }}
        >
          {busy === 'enter_maintenance' || busy === 'exit_maintenance' ? t('running') : inMaintenance ? t('exitMaintenance') : t('enterMaintenance')}
        </button>
      }
    >
      <span className={`status-pill ${inMaintenance ? 'waiting' : 'live'}`}>{inMaintenance ? t('maintenanceOnState') : t('maintenanceOffState')}</span>
    </Card>
  );
}

// ---- Firmware update ----------------------------------------------------------------

function UpdateSection({ device, view, disabled, busy, send, ask }: SectionProps & { device: DeviceView; ask: Ask }) {
  const { t } = useStudio();
  const update = view.update;
  const phase = typeof update.phase === 'string' ? update.phase : '';
  const version = typeof update.version === 'string' ? update.version : '';
  const transfer = updateTransferProgress(update);
  const progress = progressOf(update);
  const [settings, setSettings, settingsDirty, resetSettings] = useDraft({ auto: view.ota.autoApplyOnBoot, url: view.ota.manifestUrl });
  const updating = phase === 'downloading' || busy === 'check_update' || busy === 'apply_update';
  const lastError = String(update.last_error ?? update.error ?? '');

  const changeChannel = async (channel: UpdateChannel) => {
    if (channel === view.ota.channel) return;
    if (channel === 'beta') {
      const ok = await ask({ title: t('betaConfirmTitle', { device: device.displayName }), message: t('betaConfirmMessage'), confirmLabel: t('switchToBeta') });
      if (!ok) return;
    }
    await send(t('updateChannel'), updateChannelCommand(channel));
  };

  return (
    <Card title={t('secUpdate')}>
      <div className="update-hero" data-phase={phase || 'idle'}>
        <div className="version-jump">
          <span className="muted">{t('updateInstalledVersion')}</span>
          <strong>{device.firmwareVersion || '-'}</strong>
          {phase === 'ready' && version ? (
            <>
              <span className="arrow" aria-hidden="true">→</span>
              <strong className="to">{version}</strong>
            </>
          ) : null}
        </div>
        <p className={`update-status-line ${phase === 'ready' ? 'available' : phase === 'current' ? 'ok' : phase === 'error' ? 'error' : ''}`}>
          {t(updatePhaseKey(phase))}
          {transfer ? ` · ${transfer}` : ''}
        </p>
        {phase === 'downloading' || phase === 'applied' ? (
          <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={t('secUpdate')}>
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        ) : null}
        {phase === 'error' && lastError ? <Notice kind="error">{lastError}</Notice> : null}
        <div className="actions">
          <button
            className={`button${phase === 'ready' ? '' : ' primary'}`}
            type="button"
            disabled={disabled || updating}
            onClick={() => void send(t('checkUpdate'), updateCommand('check_update', view.ota.channelSupported ? settings.url : view.ota.manifestUrl), { success: false })}
          >
            {busy === 'check_update' ? t('running') : t('checkUpdate')}
          </button>
          {phase === 'ready' ? (
            <button
              className="button primary"
              type="button"
              disabled={disabled || updating}
              onClick={async () => {
                if (await ask({ title: t('confirmInstallTitle', { version, device: device.displayName }), message: t('confirmInstallMessage'), confirmLabel: t('updateInstall') })) {
                  await send(t('updateInstall'), updateCommand('apply_update', view.ota.channelSupported ? settings.url : view.ota.manifestUrl));
                }
              }}
            >
              {busy === 'apply_update' ? t('running') : t('updateInstall')}
            </button>
          ) : null}
        </div>
      </div>
      {view.ota.channelSupported ? (
        <div className="field">
          <span className="field-label" id="channel-label">
            {t('updateChannel')}
          </span>
          <Segmented<UpdateChannel>
            label={t('updateChannel')}
            value={view.ota.channel}
            disabled={disabled}
            options={[
              { value: 'stable', label: t('channelStable') },
              { value: 'beta', label: t('channelBeta') },
            ]}
            onChange={(channel) => void changeChannel(channel)}
          />
        </div>
      ) : (
        <Notice>{t('channelNeedsFirmware')}</Notice>
      )}
      <Disclosure summary={t('techDetails')}>
        <SwitchRow checked={settings.auto} onChange={(auto) => setSettings({ ...settings, auto })} title={t('autoUpdateOnBoot')} />
        <Field label={t('customManifest')} hint={t('customManifestHint')}>
          {(id) => <TextInput id={id} type="text" value={settings.url} placeholder={view.ota.resolvedManifestUrl} onChange={(e) => setSettings({ ...settings, url: e.target.value })} />}
        </Field>
        <SaveRow
          dirty={settingsDirty}
          onRevert={resetSettings}
          label={t('saveUpdateSettings')}
          disabled={disabled || !settingsDirty}
          running={busy === 'set_ota_config'}
          onSave={() => void send(t('saveUpdateSettings'), otaConfigCommand(settings.auto, settings.url, view.ota.channelSupported)).then((o) => o.ok && resetSettings())}
        />
        <Facts items={[['phase', phase || '-'], ['URL', String(record(update).url ?? view.ota.resolvedManifestUrl ?? '-')]]} />
      </Disclosure>
    </Card>
  );
}

// ---- Device log -------------------------------------------------------------------

function LogsSection({ device, view, disabled, busy, send, ask }: SectionProps & { device: DeviceView; ask: Ask }) {
  const { t } = useStudio();
  const [log, setLog, dirty, reset] = useDraft({ enabled: view.logging.enabled, level: view.logging.level, mode: view.logging.mode });
  return (
    <Card title={t('secLogs')} copy={t('logsCopy')}>
      <SwitchRow
        checked={log.enabled}
        onChange={(enabled) => setLog({ ...log, enabled })}
        title={t('enabledLabel')}
        copy={view.logging.bytes !== null ? `${t('logUsage')}: ${formatBytes(view.logging.bytes)}${view.logging.totalBytes ? ` / ${formatBytes(view.logging.totalBytes)}` : ''}` : undefined}
      />
      <div className="field-grid">
        <Field label={t('logLevel')}>
          {(id) => (
            <Select id={id} value={log.level} onChange={(e) => setLog({ ...log, level: e.target.value })}>
              {LOG_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="field">
          <span className="field-label">{t('logSize')}</span>
          <Segmented
            label={t('logSize')}
            value={log.mode}
            options={[
              { value: 'standard', label: t('logStandard') },
              { value: 'extended', label: t('logExtended') },
            ]}
            onChange={(mode) => setLog({ ...log, mode })}
          />
        </div>
      </div>
      <div className="form-footer">
        <button
          className="button danger"
          type="button"
          disabled={disabled}
          onClick={async () => {
            if (await ask({ title: t('confirmClearLogsTitle'), message: t('confirmClearLogsMessage', { device: device.displayName }), confirmLabel: t('clearLogs'), danger: true })) {
              await send(t('clearLogs'), logClearCommand());
            }
          }}
        >
          {busy === 'log_clear' ? t('running') : t('clearLogs')}
        </button>
        <span className="spacer" />
        {dirty ? (
          <button className="button ghost" type="button" onClick={reset}>
            {t('revert')}
          </button>
        ) : null}
        <button className="button primary" type="button" disabled={disabled || !dirty} onClick={() => void send(t('saveLogSettings'), logSettingsCommand(log.enabled, log.level, log.mode)).then((o) => o.ok && reset())}>
          {busy === 'set_log' ? t('running') : t('saveLogSettings')}
        </button>
      </div>
    </Card>
  );
}
