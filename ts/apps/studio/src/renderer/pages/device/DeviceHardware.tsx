// Device settings cards ported from New-Horizons-Desktop
// pages/DeviceSettingsPage.tsx that Studio did not have yet: pin layout,
// battery LED warning, Action Button, lights and display (board LED, external
// LED, SSD1306), RAM, and the connection / restart cards of the Overview
// section. Same payloads as the Desktop; sent through DeviceSettings' send().

import { useEffect, useState } from 'react';
import { CircleOff, Lightbulb, Power, RefreshCw } from 'lucide-react';

import type { DeviceView } from '../../../shared/contract';
import { Card, Disclosure, Facts, Field, Notice, NumberInput, Radio, Select, TextInput, useConfirm } from '../../components/ui';
import { useAreaT } from '../../areas/i18n';
import { actionButtonActionsForGesture, buildActionButtonCommand, normalizeActionButtonStatus, type ActionButtonAction, type ActionButtonGesture } from '../../lib/actionButton';
import { batteryLedThresholdValidationError, buildBatteryLedThresholdCommand } from '../../lib/batteryProfile';
import { boardProfileForHardwareModel, type BoardProfile } from '../../lib/boardProfile';
import type { Payload } from '../../lib/commands';
import { record } from '../../lib/deviceDetails';
import { formatBytes } from '../../lib/format';
import { useStudio } from '../../state/studio';
import { DEVICE_SETTINGS_STRINGS } from './settingsStrings';
import './device-settings.css';

export type Send = (label: string, payload: Payload, options?: { success?: string | false }) => Promise<{ ok: boolean; data: unknown }>;
type Ask = ReturnType<typeof useConfirm>[1];
type CardProps = { device: DeviceView; status: Record<string, unknown>; disabled: boolean; busy: string; send: Send };

const DEFAULT_EXTERNAL_LED_BRIGHTNESS = 0.35;
const DEFAULT_BOARD_LED_BRIGHTNESS = 0.3;
const BOARD_LED_BRIGHTNESS_OPTIONS = [0.1, 0.2, 0.3, 0.5, 1] as const;
const EXTERNAL_LED_BRIGHTNESS_OPTIONS = [
  { value: 0.1, labelKey: 'brightnessOption_10' },
  { value: 0.2, labelKey: 'brightnessOption_20' },
  { value: 0.35, labelKey: 'brightnessOption_35' },
  { value: 0.5, labelKey: 'brightnessOption_50' },
  { value: 1, labelKey: 'brightnessOption_100_danger' },
] as const;
const EXTERNAL_PRESETS = ['system_status', 'connectivity', 'pressure_meter', 'stream_heartbeat', 'calibration_auto', 'solid_marker', 'identify', 'off'] as const;
const EXTERNAL_COLORS = ['teal', 'green', 'blue', 'purple', 'amber', 'red', 'white'] as const;
const OLED_PAGES = ['live_status', 'sensor_snapshot', 'recording_status', 'app'] as const;

function str(value: unknown, fallback = '-'): string {
  return value === undefined || value === null || value === '' ? fallback : String(value);
}
function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function yesNo(value: unknown): string {
  return value === true ? 'true' : value === false ? 'false' : '-';
}
function csv(value: unknown): string {
  return Array.isArray(value) ? value.join(',') : '';
}
function numberCsv(value: string): number[] {
  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
}
function externalLedBrightnessValue(value: unknown): number {
  const n = Number(value);
  return EXTERNAL_LED_BRIGHTNESS_OPTIONS.some((o) => o.value === n) ? n : DEFAULT_EXTERNAL_LED_BRIGHTNESS;
}
function boardLedBrightnessValue(value: unknown): number {
  const n = Number(value);
  return (BOARD_LED_BRIGHTNESS_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_BOARD_LED_BRIGHTNESS;
}

/** Follows `value` until the user edits; resets when the device's value changes. */
function useSynced<V>(value: V): [V, (next: V) => void] {
  const [draft, setDraft] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => {
    setDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [draft, setDraft];
}

/** Device settings wording; keys are the Desktop's (some built from a value, e.g. indicatorPreset_<preset>). */
export function useDeviceSettingsT(): (key: string, vars?: Readonly<Record<string, unknown>>) => string {
  return useAreaT(DEVICE_SETTINGS_STRINGS) as (key: string, vars?: Readonly<Record<string, unknown>>) => string;
}

export function boardProfileOf(device: DeviceView): BoardProfile {
  return boardProfileForHardwareModel(device.hardwareModel);
}

export function indicatorsOf(status: Record<string, unknown>): Record<string, unknown> {
  return record(status.indicators ?? record(status.runtime).indicators);
}

// ---- Hardware: pins -----------------------------------------------------------------

export function PinsCard({ device, status, disabled, busy, send }: CardProps) {
  const ds = useDeviceSettingsT();
  const { t } = useStudio();
  const layout = record(status.matrix_layout);
  const profile = boardProfileOf(device);
  const [analog, setAnalog] = useSynced(csv(layout.analog_pins ?? layout.active_rows));
  const [select, setSelect] = useSynced(csv(layout.select_pins ?? layout.active_cols));
  return (
    <Card title={ds('settingsSection_pins')} copy={profile.powerUx === 'remote_only' ? ds('pinLayoutCopyGcu') : ds('pinLayoutCopyV1')}>
      <div className="field-grid">
        <Field label={ds('analogPins')}>{(id) => <TextInput id={id} className="mono" value={analog} onChange={(e) => setAnalog(e.target.value)} />}</Field>
        <Field label={ds('selectPins')}>{(id) => <TextInput id={id} className="mono" value={select} onChange={(e) => setSelect(e.target.value)} />}</Field>
      </div>
      <div className="form-footer">
        <button
          className="button primary"
          type="button"
          disabled={disabled}
          onClick={() => void send(ds('applyPinLayout'), { command: 'set_matrix_layout', analog_pins: numberCsv(analog), select_pins: numberCsv(select) })}
        >
          {busy === 'set_matrix_layout' ? t('running') : ds('applyPinLayout')}
        </button>
      </div>
    </Card>
  );
}

// ---- Hardware: battery LED warning ---------------------------------------------------

export function BatteryLedCard({ device, status, disabled, busy, send }: CardProps) {
  const ds = useDeviceSettingsT();
  const { t } = useStudio();
  const batteryLed = record(indicatorsOf(status).battery_led);
  const [threshold, setThreshold] = useSynced(str(batteryLed.low_battery_threshold_percent, '10'));
  if (!boardProfileOf(device).supportsBatteryStatusLed || batteryLed.supported !== true) return null;
  const invalid = batteryLedThresholdValidationError(Number(threshold)) !== null;
  return (
    <Card title={ds('batteryLedWarning')} copy={ds('batteryLedWarningCopy')}>
      <div className="field-grid">
        <Field label={ds('batteryLedThreshold')} error={invalid ? ds('batteryLedThresholdInvalid') : undefined}>
          {(id) => <NumberInput id={id} min={0} max={25} step={1} value={threshold} onChange={(e) => setThreshold(e.target.value)} />}
        </Field>
      </div>
      <div className="form-footer">
        <button className="button primary" type="button" disabled={disabled || invalid} onClick={() => void send(ds('saveBatteryLedWarning'), buildBatteryLedThresholdCommand(Number(threshold)))}>
          {busy === 'set_indicators' ? t('running') : ds('saveBatteryLedWarning')}
        </button>
      </div>
    </Card>
  );
}

// ---- Hardware: Action Button ---------------------------------------------------------

export function ActionButtonCard({ device, status, disabled, busy, send }: CardProps) {
  const ds = useDeviceSettingsT();
  const { t } = useStudio();
  const actionButton = normalizeActionButtonStatus(status.action_button);
  const [shortPress, setShortPress] = useSynced<ActionButtonAction>(actionButton.shortPress ?? 'none');
  const [longPress, setLongPress] = useSynced<ActionButtonAction>(actionButton.longPress ?? 'soft_off');
  if (!boardProfileOf(device).supportsActionButtonSettings) return null;
  const dirty = shortPress !== (actionButton.shortPress ?? 'none') || longPress !== (actionButton.longPress ?? 'soft_off');
  const label = (action: ActionButtonAction) => ds(`actionButtonAction_${action}`);
  const icon = (action: ActionButtonAction) => {
    if (action === 'soft_off') return <Power aria-hidden="true" size={20} />;
    if (action === 'identify') return <Lightbulb aria-hidden="true" size={20} />;
    if (action === 'toggle_external_led') return <CircleOff aria-hidden="true" size={20} />;
    return <span className="action-button-none-icon" aria-hidden="true">—</span>;
  };
  const choices = (gesture: ActionButtonGesture, value: ActionButtonAction, setValue: (next: ActionButtonAction) => void) => (
    <fieldset className="action-button-choice-group" disabled={!actionButton.supported || disabled}>
      <legend>{gesture === 'short' ? ds('actionButtonShortPress') : ds('actionButtonLongPress')}</legend>
      <div className="action-button-choice-grid">
        {actionButtonActionsForGesture(gesture).map((action) => (
          <label key={action} className={`action-button-choice ${value === action ? 'selected' : ''}`}>
            <Radio name={`action-button-${gesture}-${device.uid}`} value={action} checked={value === action} onChange={() => setValue(action)} />
            <span className="action-button-choice-icon">{icon(action)}</span>
            <span className="action-button-choice-copy">
              <strong>{label(action)}</strong>
              <small>{ds(`actionButtonActionCopy_${action}`)}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
  return (
    <Card className="action-button-settings" title={ds('settingsSection_actionButton')} copy={ds('actionButtonPageCopy')}>
      <section className="action-button-hero" aria-label={ds('settingsSection_actionButton')}>
        <div className="action-button-glyph" aria-hidden="true" />
        <div>
          <p className="action-button-eyebrow">{ds('actionButtonConfiguredFor')}</p>
          <h4>{`${ds('actionButtonShortPress')}: ${label(shortPress)} · ${ds('actionButtonLongPress')}: ${label(longPress)}`}</h4>
          <p>{ds('actionButtonBootWifiFixed')}</p>
        </div>
      </section>
      {!actionButton.supported ? (
        <Notice kind="warning">
          <strong>{ds('actionButtonFirmwareUpdateRequired')}</strong> {ds('actionButtonFirmwareUpdateRequiredCopy')}
        </Notice>
      ) : (
        <>
          <div className="action-button-panel">
            {choices('short', shortPress, setShortPress)}
            {choices('long', longPress, setLongPress)}
          </div>
          {dirty ? (
            <div className="form-footer">
              <button className="button primary" type="button" disabled={disabled} onClick={() => void send(ds('saveActionButton'), buildActionButtonCommand(shortPress, longPress))}>
                {busy === 'set_action_button' ? t('running') : ds('saveActionButton')}
              </button>
            </div>
          ) : null}
          <Facts
            items={[
              [ds('actionButtonLastAction'), actionButton.lastAction ?? '-'],
              [ds('actionButtonLastResult'), actionButton.lastResult ?? '-'],
            ]}
          />
        </>
      )}
    </Card>
  );
}

// ---- Hardware: lights and display ------------------------------------------------------

export function LightsCard({ device, status, disabled, busy, send }: CardProps) {
  const ds = useDeviceSettingsT();
  const { t } = useStudio();
  const profile = boardProfileOf(device);
  const indicators = indicatorsOf(status);
  const boardLed = record(indicators.board_led);
  const externalLed = record(indicators.external_led);
  const oled = record(indicators.oled);
  const [boardBrightness, setBoardBrightness] = useSynced(boardLedBrightnessValue(boardLed.brightness));
  const [ext, setExt] = useSynced({
    mode: str(externalLed.mode, 'off'),
    preset: str(externalLed.preset, 'system_status'),
    brightness: externalLedBrightnessValue(externalLed.brightness),
    color: str(externalLed.color, 'teal'),
  });
  const [screen, setScreen] = useSynced({
    mode: str(oled.mode, 'off'),
    page: str(oled.page, 'live_status'),
    update_hz: num(oled.update_hz, 1),
    contrast: num(oled.contrast, 128),
    rotation: num(oled.rotation, 0),
  });
  const running = busy === 'set_indicators';
  return (
    <Card title={ds('lightsAndDisplay')}>
      <div className="settings-subsection">
        <div>
          <h5>{ds('boardLedBrightnessLabel')}</h5>
          <p className="field-note">{ds('boardLedBrightnessCopy')}</p>
        </div>
        <div className="inline-form">
          <Select value={String(boardBrightness)} onChange={(e) => setBoardBrightness(boardLedBrightnessValue(e.target.value))} aria-label={ds('paramBrightness')}>
            {BOARD_LED_BRIGHTNESS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === DEFAULT_BOARD_LED_BRIGHTNESS ? ds('boardLedBrightnessDefault') : `${Math.round(option * 100)}%`}
              </option>
            ))}
          </Select>
          <button className="button primary" type="button" disabled={disabled} onClick={() => void send(ds('saveBoardLedBrightness'), { command: 'set_indicators', board_led: { brightness: boardBrightness } })}>
            {running ? t('running') : ds('saveBoardLedBrightness')}
          </button>
        </div>
      </div>
      {profile.supportsExternalLed ? (
        <div className="settings-subsection">
          <div>
            <h5>{ds('externalLedIndicators')}</h5>
            <p className="field-note">{ds('externalLedIndicatorsCopy')}</p>
          </div>
          <div className="field-grid">
            <Field label={ds('externalLedMode')}>
              {(id) => (
                <Select id={id} value={ext.mode} onChange={(e) => setExt({ ...ext, mode: e.target.value })}>
                  <option value="off">{ds('indicatorMode_off')}</option>
                  <option value="enabled">{ds('indicatorMode_enabled')}</option>
                </Select>
              )}
            </Field>
            <Field label={ds('externalLedPreset')} hint={ds('externalLedAppPriority')}>
              {(id) => (
                <Select id={id} value={ext.preset} onChange={(e) => setExt({ ...ext, preset: e.target.value })}>
                  {EXTERNAL_PRESETS.map((preset) => (
                    <option key={preset} value={preset}>
                      {ds(`indicatorPreset_${preset}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={ds('paramBrightness')}>
              {(id) => (
                <Select id={id} value={String(ext.brightness)} onChange={(e) => setExt({ ...ext, brightness: Number(e.target.value) || DEFAULT_EXTERNAL_LED_BRIGHTNESS })}>
                  {EXTERNAL_LED_BRIGHTNESS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {ds(option.labelKey)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {ext.preset === 'solid_marker' ? (
              <Field label={ds('externalLedColor')}>
                {(id) => (
                  <Select id={id} value={ext.color} onChange={(e) => setExt({ ...ext, color: e.target.value })}>
                    {EXTERNAL_COLORS.map((color) => (
                      <option key={color} value={color}>
                        {ds(`indicatorColor_${color}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
          </div>
          {externalLed.active_preset === 'app' ? <Notice>{ds('externalLedAppActive')}</Notice> : null}
          {externalLed.last_error ? <Notice kind="error">{str(externalLed.last_error)}</Notice> : null}
          <div className="actions">
            <button className="button primary" type="button" disabled={disabled} onClick={() => void send(ds('saveExternalLed'), { command: 'set_indicators', external_led: { ...ext } })}>
              {running ? t('running') : ds('saveExternalLed')}
            </button>
            <button
              className="button"
              type="button"
              disabled={disabled}
              onClick={() => void send(ds('testExternalLed'), { command: 'set_indicators', external_led: { mode: 'enabled', preset: 'identify', brightness: ext.brightness } })}
            >
              {running ? t('running') : ds('testExternalLed')}
            </button>
          </div>
          <Disclosure summary={ds('settingsDetails')}>
            <Facts
              items={[
                [ds('externalLedPin'), str(externalLed.pin)],
                [ds('externalLedCount'), str(externalLed.count)],
                [ds('externalLedInitialized'), yesNo(externalLed.initialized)],
                [ds('activePreset'), externalLed.active_preset === 'app' ? ds('indicatorPreset_app') : str(externalLed.active_preset)],
                [ds('externalLedLastShow'), str(externalLed.last_show_ms)],
              ]}
            />
          </Disclosure>
        </div>
      ) : null}
      {profile.supportsOled ? (
        <div className="settings-subsection">
          <div>
            <h5>{ds('ssd1306Display')}</h5>
            <p className="field-note">{oled.detected ? `${ds('screenDetected')}${oled.addr ? ` · ${str(oled.addr)}` : ''}` : ds('noSsd1306Detected')}</p>
          </div>
          {oled.last_error ? <Notice kind="error">{str(oled.last_error)}</Notice> : null}
          <div className="field-grid">
            <Field label={ds('paramOledMode')}>
              {(id) => (
                <Select id={id} value={screen.mode} onChange={(e) => setScreen({ ...screen, mode: e.target.value })}>
                  <option value="off">{ds('indicatorMode_off')}</option>
                  <option value="auto">{ds('indicatorMode_auto')}</option>
                  <option value="enabled">{ds('indicatorMode_enabled')}</option>
                </Select>
              )}
            </Field>
            <Field label={ds('oledPage')}>
              {(id) => (
                <Select id={id} value={screen.page} onChange={(e) => setScreen({ ...screen, page: e.target.value })}>
                  {OLED_PAGES.map((page) => (
                    <option key={page} value={page}>
                      {ds(`oledPage_${page}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={ds('oledUpdateHz')}>
              {(id) => <NumberInput id={id} min={1} value={screen.update_hz} onChange={(e) => setScreen({ ...screen, update_hz: Number(e.target.value) || 1 })} />}
            </Field>
            <Field label={ds('oledContrast')}>
              {(id) => <NumberInput id={id} min={0} max={255} value={screen.contrast} onChange={(e) => setScreen({ ...screen, contrast: Number(e.target.value) || 128 })} />}
            </Field>
            <Field label={ds('oledRotation')}>
              {(id) => (
                <Select id={id} value={screen.rotation} onChange={(e) => setScreen({ ...screen, rotation: Number(e.target.value) })}>
                  <option value={0}>{ds('oledRotation_0')}</option>
                  <option value={1}>{ds('oledRotation_90')}</option>
                  <option value={2}>{ds('oledRotation_180')}</option>
                  <option value={3}>{ds('oledRotation_270')}</option>
                </Select>
              )}
            </Field>
          </div>
          <div className="form-footer">
            <button className="button primary" type="button" disabled={disabled} onClick={() => void send(ds('saveScreen'), { command: 'set_indicators', oled: { ...screen } })}>
              {running ? t('running') : ds('saveScreen')}
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

// ---- Diagnostics: RAM ------------------------------------------------------------------

export function RamCard({ status, disabled, busy, send }: Omit<CardProps, 'device'>) {
  const ds = useDeviceSettingsT();
  const { t } = useStudio();
  const memory = record(status.memory ?? status);
  const total = num(memory.heap_total, 0);
  const free = num(memory.heap_free, 0);
  const used = num(memory.heap_used, total > free ? total - free : 0);
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0;
  return (
    <Card
      title={ds('ramDiagnostics')}
      copy={ds('ramDiagnosticsCopy')}
      actions={
        <button className="button tiny" type="button" disabled={disabled} onClick={() => void send(ds('ramDiagnostics'), { command: 'memory_status' }, { success: false })}>
          <RefreshCw size={13} aria-hidden="true" />
          {busy === 'memory_status' ? t('running') : ds('viewRam')}
        </button>
      }
    >
      <div className="ram-bar-track" role="img" aria-label={`${ds('ramDiagnostics')} ${pct}%`}>
        <span className="ram-bar-used" style={{ width: `${pct}%` }} />
      </div>
      <div className="storage-summary">
        <span>
          {ds('used')}: {total ? formatBytes(used) : '-'}
        </span>
        <span>
          {ds('free')}: {free ? formatBytes(free) : '-'}
        </span>
        <span>
          {ds('total')}: {total ? formatBytes(total) : '-'}
        </span>
      </div>
      <Facts
        items={[
          [ds('heapFree'), str(memory.heap_free)],
          [ds('heapLargestBlock'), str(memory.heap_largest_free_block)],
          [ds('heapMinFree'), str(memory.heap_min_free)],
        ]}
      />
    </Card>
  );
}

// ---- Overview: relay link and restart --------------------------------------------------

export function ConnectionCard({ device, status, record: rec, disabled, busy, send }: CardProps & { record: Record<string, unknown> }) {
  const ds = useDeviceSettingsT();
  const { t } = useStudio();
  const hubRelayed = rec.client_type === 'hub' || status.transport === 'espnow';
  const findme = record(rec.findme ?? status.findme ?? record(status.runtime).findme);
  if (hubRelayed) {
    return (
      <Card title={ds('hubLinkTitle')} copy={ds('hubLinkCopy')}>
        <Facts
          items={[
            [ds('hubLinkHub'), str(rec.gateway_id)],
            [ds('hubLinkState'), device.online ? ds('hubOnline') : ds('offline')],
            [ds('transport'), 'ESP-NOW'],
          ]}
        />
      </Card>
    );
  }
  return (
    <Card
      title={ds('gatewayTitle')}
      copy={ds('gatewayCopy')}
      actions={
        <button className="button tiny" type="button" disabled={disabled} onClick={() => void send('FindMe', { command: 'findme_discover' })}>
          {busy === 'findme_discover' ? t('running') : ds('rediscoverGateway')}
        </button>
      }
    >
      <Facts
        items={[
          [ds('gatewayId'), str(findme.gateway_id)],
          [ds('gatewayHost'), findme.host ? `${str(findme.host)}${findme.udp_port ? `:${str(findme.udp_port)}` : ''}` : '-'],
          [ds('gatewaySource'), str(findme.state)],
        ]}
      />
      {findme.last_error ? <Notice kind="error">{str(findme.last_error)}</Notice> : null}
      <Disclosure summary={ds('settingsDetails')}>
        <Facts
          items={[
            [ds('transport'), str(rec.transport_path ?? status.transport_path)],
            [ds('heartbeat'), str(findme.last_heartbeat_at ?? status.last_heartbeat_at)],
            [ds('heartbeatInterval'), str(findme.heartbeat_interval_ms)],
            [ds('gatewayLastSuccess'), str(findme.last_success_ms)],
          ]}
        />
      </Disclosure>
    </Card>
  );
}

export function RestartCard({ disabled, busy, send, ask }: { disabled: boolean; busy: string; send: Send; ask: Ask }) {
  const ds = useDeviceSettingsT();
  const { t } = useStudio();
  return (
    <Card className="danger-zone" title={ds('restartTitle')} copy={ds('restartCopy')}>
      <div className="actions">
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() =>
            void ask({ title: ds('rebootConfirmTitle'), message: ds('rebootConfirmMessage'), confirmLabel: ds('rebootDevice') }).then((ok) => {
              if (ok) void send(ds('rebootDevice'), { command: 'reboot' });
            })
          }
        >
          {busy === 'reboot' ? t('running') : ds('rebootDevice')}
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() =>
            void ask({ title: ds('rebootWifiSetupConfirmTitle'), message: ds('rebootWifiSetupConfirmMessage'), confirmLabel: ds('rebootWifiSetup'), danger: true }).then((ok) => {
              if (ok) void send(ds('rebootWifiSetup'), { command: 'reboot_wifi_setup' });
            })
          }
        >
          {busy === 'reboot_wifi_setup' ? t('running') : ds('rebootWifiSetup')}
        </button>
      </div>
    </Card>
  );
}
