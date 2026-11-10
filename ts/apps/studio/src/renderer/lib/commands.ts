// Device command payloads for every setting NH Studio offers. Each one is
// exactly what the Desktop sends for the same control (New-Horizons-Desktop/
// frontend/src/pages/DeviceSettingsPage.tsx, components/DeviceClockCard.tsx,
// components/calibration/CalibrationWorkbench.tsx, lib/batteryProfile.ts;
// commands in NewHorizonsOS-OTA/spec/commands.md). test/renderer/commands.test.ts
// pins every payload.

export type Payload = Record<string, unknown>;

// ---- Status -----------------------------------------------------------------

export function statusCommand(): Payload {
  return { command: 'status' };
}

/** quiet: the device skips its LED ack (the Desktop's quietCommand(), for polls). */
export function quiet(payload: Payload): Payload {
  return { ...payload, quiet: true };
}

export function rebootCommand(): Payload {
  return { command: 'reboot' };
}

export function scanHealthCommand(): Payload {
  return { command: 'scan_health' };
}

// ---- Scan timing ------------------------------------------------------------

export type ScanTiming = { target_fps: number; settle_us: number; send_every_n_frames: number };

/** The presets the settings page offers (applyScanPreset()). */
export const SCAN_PRESETS = [60, 90] as const;

/** applyScanPreset(): 60 fps settles 20 µs, above 60 fps 15 µs; every frame sent. */
export function scanPresetTiming(fps: number): ScanTiming {
  return { target_fps: fps, settle_us: fps > 60 ? 15 : 20, send_every_n_frames: 1 };
}

export function scanTimingValidationError(timing: ScanTiming): 'invalid_scan_timing' | null {
  const { target_fps, settle_us, send_every_n_frames } = timing;
  const ok =
    Number.isInteger(target_fps) && target_fps >= 1 && target_fps <= 200 &&
    Number.isInteger(settle_us) && settle_us >= 0 && settle_us <= 1000 &&
    Number.isInteger(send_every_n_frames) && send_every_n_frames >= 1 && send_every_n_frames <= 60;
  return ok ? null : 'invalid_scan_timing';
}

/** applyScanTiming(): { command: "set_scan_timing", ...nextTiming }. */
export function scanTimingCommand(timing: ScanTiming): Payload {
  return {
    command: 'set_scan_timing',
    target_fps: timing.target_fps,
    settle_us: timing.settle_us,
    send_every_n_frames: timing.send_every_n_frames,
  };
}

/** What the device ends up sending: target / every-n, rounded (the page's "effective send fps"). */
export function effectiveSendFps(timing: Pick<ScanTiming, 'target_fps' | 'send_every_n_frames'>): number {
  return Math.round(timing.target_fps / Math.max(1, timing.send_every_n_frames));
}

// ---- Filter, IMU, raw ADC, stream buffer --------------------------------------

export const FILTER_MEDIANS = [1, 3, 5] as const;

export function filterCommand(enabled: boolean, median: number, alpha: number): Payload {
  return { command: 'set_filter', enabled, median, alpha };
}

/** The alpha input's range on the Desktop (min 0.05, max 0.6). */
export function filterAlphaValid(alpha: number): boolean {
  return Number.isFinite(alpha) && alpha >= 0.05 && alpha <= 0.6;
}

export function imuCommand(enabled: boolean): Payload {
  return { command: 'set_imu', enabled };
}

export function rawAdcCommand(enabled: boolean): Payload {
  return { command: 'set_raw_adc', enabled };
}

export type StreamBufferMode = 'standard' | 'extended';

export function streamBufferCommand(enabled: boolean, mode: StreamBufferMode | string): Payload {
  return { command: 'set_stream_buffer', enabled, mode };
}

// ---- Power and charging -------------------------------------------------------

/** Profiles in the order the Desktop lists them (commands.md: 100..350 mA). */
export const CHARGE_PROFILES = ['ultra_slow', 'slow', 'balanced', 'fast', 'extreme'] as const;
export type ChargeProfile = (typeof CHARGE_PROFILES)[number];

export function chargeProfileCommand(profile: ChargeProfile | string): Payload {
  return { command: 'set_charge_profile', profile };
}

export type PowerState = 'normal' | 'soft_off_auto';

export function powerStateCommand(state: PowerState): Payload {
  return { command: 'power_set_state', state };
}

export { buildBatteryProfileCommand, buildBatteryGaugeResyncCommand, buildBatteryLedThresholdCommand } from './batteryProfile';

// ---- Clock --------------------------------------------------------------------

export function clockStatusCommand(): Payload {
  // DeviceClockCard polls it with quietCommand().
  return quiet({ command: 'clock_status' });
}

export function clockSyncCommand(): Payload {
  return { command: 'clock_sync' };
}

/** "Use this computer's time": force replaces a stale source; epoch_ms as a string, as the Desktop sends it. */
export function setTimeCommand(nowMs: number): Payload {
  return { command: 'set_time', epoch_ms: String(nowMs), force: true };
}

/** Only the fields filled in are sent (DeviceClockCard handleSaveSettings()). */
export function clockConfigCommand(form: { ntpServer: string; ntpIntervalS: string; syncIntervalS: string }): Payload {
  const payload: Payload = { command: 'set_clock_config' };
  if (form.ntpServer.trim()) payload.ntp_server = form.ntpServer.trim();
  if (form.ntpIntervalS.trim()) payload.ntp_interval_s = Number(form.ntpIntervalS);
  if (form.syncIntervalS.trim()) payload.sync_interval_s = Number(form.syncIntervalS);
  return payload;
}

// ---- Maintenance mode -----------------------------------------------------------

/** The settings page's mode switch sends reason "manual" (calibration sends "calibration"). */
export function maintenanceCommand(enter: boolean): Payload {
  return enter ? { command: 'enter_maintenance', reason: 'manual' } : { command: 'exit_maintenance' };
}

// ---- Firmware update ------------------------------------------------------------

export type UpdateChannel = 'stable' | 'beta';

export function normalizeUpdateChannel(value: unknown): UpdateChannel {
  return value === 'beta' ? 'beta' : 'stable';
}

/** Switching channel saves at once (beta only after confirming). */
export function updateChannelCommand(channel: UpdateChannel): Payload {
  return { command: 'set_ota_config', channel };
}

/** saveOtaConfig(): with channels an empty manifest_url is sent on purpose (follow the channel again). */
export function otaConfigCommand(autoApplyOnBoot: boolean, manifestUrl: string, channelSupported = true): Payload {
  return {
    command: 'set_ota_config',
    auto_apply_on_boot: autoApplyOnBoot,
    manifest_url: channelSupported ? manifestUrl.trim() : manifestUrl,
  };
}

/** check_update / apply_update name a manifest only when there is one (updateCommand()). */
export function updateCommand(command: 'check_update' | 'apply_update', manifestUrl = ''): Payload {
  const url = manifestUrl.trim();
  return url ? { command, manifest_url: url } : { command };
}

/** Timeouts the Desktop allows these (check 30 s, apply 90 s). */
export const UPDATE_TIMEOUT_MS = { check_update: 30_000, apply_update: 90_000 } as const;

// ---- Logs -----------------------------------------------------------------------

export const STANDARD_LOG_BYTES = 12 * 1024;
export const EXTENDED_LOG_BYTES = 24 * 1024;
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

export function logSettingsCommand(enabled: boolean, level: string, mode: 'standard' | 'extended' | string): Payload {
  return {
    command: 'set_log',
    enabled,
    level,
    mode,
    max_bytes: mode === 'extended' ? EXTENDED_LOG_BYTES : STANDARD_LOG_BYTES,
  };
}

export function logClearCommand(): Payload {
  return { command: 'log_clear' };
}

// ---- Calibration basics ---------------------------------------------------------

/** CalibrationWorkbench's ZERO_DURATION_MS: how long a tare averages. */
export const TARE_DURATION_MS = 1000;

export function tareCommand(): Payload {
  return { command: 'calibration_tare_capture', duration_ms: TARE_DURATION_MS };
}

export function tareClearCommand(): Payload {
  return { command: 'calibration_tare_clear' };
}
