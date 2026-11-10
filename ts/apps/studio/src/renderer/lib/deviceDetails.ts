// Reads the settings pages' current values out of the engine's device record
// and last status (StudioSnapshot.deviceDetails[uid]), from the same fields
// and with the same defaults the Desktop's DeviceSettingsPage reads them.

import { normalizeBatteryStatus, type BatteryStatusViewModel } from './batteryProfile';
import { normalizeUpdateChannel, type ScanTiming, type UpdateChannel } from './commands';
import { scanHealthView, type ScanHealthView } from './scanHealth';

type Raw = Record<string, unknown>;

export function record(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

function numArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : [];
}

export type DeviceSettingsView = {
  hasStatus: boolean;
  mode: string;
  scanTiming: ScanTiming;
  scanHealth: ScanHealthView;
  filter: { enabled: boolean; median: number; alpha: number };
  imu: { enabled: boolean; state: string; sampleRateHz: number | null; lastError: string };
  rawAdc: boolean;
  streamBuffer: { enabled: boolean; mode: string; depthFrames: number | null };
  battery: BatteryStatusViewModel;
  chargeProfile: string;
  chargeControlSupported: boolean;
  power: { state: string; chargeState: string; wakeSource: string };
  ota: {
    channelSupported: boolean;
    channel: UpdateChannel;
    autoApplyOnBoot: boolean;
    manifestUrl: string;
    resolvedManifestUrl: string;
  };
  update: Raw;
  logging: { enabled: boolean; level: string; mode: string; bytes: number | null; totalBytes: number | null };
  calibration: { tareActive: boolean; calibrated: boolean };
  wifi: { ssid: string; rssi: number | null; ip: string };
};

/** The settings view of one device: status first, then the record's last_result/runtime, like the Desktop. */
export function deviceSettingsView(detail: { record: unknown; status: unknown } | undefined): DeviceSettingsView {
  const rec = record(detail?.record);
  const status = record(detail?.status ?? rec.last_status);
  const runtime = record(status.runtime);
  const scanTiming = record(runtime.scan_timing);
  const scanHealthRaw = record(status.scan_health);
  const filter = record(status.filter ?? runtime.filter);
  const imu = record(status.imu ?? runtime.imu);
  const streamBuffer = record(status.stream_buffer ?? runtime.stream_buffer);
  const batteryRaw = record(status.battery);
  const power = record(status.power);
  const ota = record(status.ota ?? status.update_config);
  const logging = record(status.logging ?? runtime.logging);
  const calibration = record(status.calibration);
  const wifi = record(status.wifi);
  const matrixLayout = record(status.matrix_layout);
  const channelSupported = typeof ota.channel === 'string';

  return {
    hasStatus: Object.keys(status).length > 0,
    mode: str(status.mode ?? rec.mode, ''),
    scanTiming: {
      target_fps: num(scanTiming.target_fps ?? scanHealthRaw.requested_target_fps, 60),
      settle_us: num(scanTiming.settle_us ?? scanHealthRaw.settle_us, 20),
      send_every_n_frames: num(scanTiming.send_every_n_frames ?? scanHealthRaw.send_every_n_frames, 1),
    },
    scanHealth: scanHealthView(scanHealthRaw, numArray(matrixLayout.analog_pins ?? matrixLayout.active_rows)),
    filter:
      filter.enabled === undefined && filter.median === undefined && filter.alpha === undefined
        ? { enabled: false, median: 3, alpha: 0.25 }
        : { enabled: filter.enabled === true, median: num(filter.median, 3), alpha: num(filter.alpha, 0.25) },
    imu: {
      enabled: imu.enabled !== false,
      state: str(imu.state, imu.enabled === false ? 'disabled' : '-'),
      sampleRateHz: typeof imu.sample_rate_hz === 'number' ? imu.sample_rate_hz : null,
      lastError: str(imu.last_error, ''),
    },
    rawAdc: (status.stream_raw_adc ?? runtime.stream_raw_adc) === true,
    streamBuffer: {
      enabled: streamBuffer.enabled !== false,
      mode: str(streamBuffer.mode, 'standard'),
      depthFrames: typeof streamBuffer.depth_frames === 'number' ? streamBuffer.depth_frames : null,
    },
    battery: normalizeBatteryStatus(batteryRaw),
    chargeProfile: str(batteryRaw.profile, 'balanced'),
    chargeControlSupported: Object.keys(batteryRaw).length > 0,
    power: {
      state: str(power.state, '-'),
      chargeState: str(power.charge_state ?? batteryRaw.charge_state, '-'),
      wakeSource: str(power.wake_source, '-'),
    },
    ota: {
      channelSupported,
      channel: normalizeUpdateChannel(ota.channel),
      autoApplyOnBoot: ota.auto_apply_on_boot === true,
      manifestUrl: str(ota.manifest_url, ''),
      resolvedManifestUrl: str(ota.resolved_manifest_url, ''),
    },
    update: record(status.update_state ?? rec.update_state),
    logging: {
      enabled: logging.enabled !== false,
      level: str(logging.level, 'error'),
      mode: str(logging.mode, 'standard'),
      bytes: typeof logging.bytes === 'number' ? logging.bytes : null,
      totalBytes: typeof logging.effective_total_bytes === 'number' ? logging.effective_total_bytes : null,
    },
    calibration: {
      // CalibrationWorkbench shows "clear zero" when tare_enabled && output_mode === "tared".
      tareActive: calibration.tare_enabled === true && calibration.output_mode === 'tared',
      calibrated: calibration.enabled === true || calibration.output_mode === 'calibrated',
    },
    wifi: {
      ssid: str(wifi.ssid, ''),
      rssi: typeof wifi.rssi === 'number' ? wifi.rssi : null,
      ip: str(wifi.ip, ''),
    },
  };
}

/** The Desktop's update status line, as a key of our dictionary. */
export function updatePhaseKey(phase: string):
  | 'updateAvailableShort'
  | 'updateUpToDate'
  | 'updateCheckingDevice'
  | 'updateInstalling'
  | 'updateApplied'
  | 'updateFailed'
  | 'updateNotCheckedDevice' {
  switch (phase) {
    case 'ready':
      return 'updateAvailableShort';
    case 'current':
      return 'updateUpToDate';
    case 'manifest':
      return 'updateCheckingDevice';
    case 'downloading':
      return 'updateInstalling';
    case 'applied':
      return 'updateApplied';
    case 'error':
      return 'updateFailed';
    default:
      return 'updateNotCheckedDevice';
  }
}

/** A clock_status reply reduced to what the clock card shows (DeviceClockCard snapshotFrom()). */
export type ClockView = {
  synced: boolean;
  source: string;
  mode: string;
  epochMs: number | null;
  uncertaintyMs: number | null;
  serverRttUs: number | null;
  serverUnsupported: boolean;
  config: { ntpServer: string; ntpIntervalS: number | null; syncIntervalS: number | null };
};

export function clockView(result: unknown): ClockView | null {
  const source = record(result);
  if (source.ok === false) return null;
  const data = 'clock' in source ? source : record(source.data);
  const clock = record(data.clock);
  if (!('synced' in clock)) return null;
  const config = record(data.clock_config);
  const espNow = clock.mode === 'espnow';
  const server = record(espNow ? clock.hub : clock.gateway);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    synced: clock.synced === true,
    source: str(clock.source, 'none'),
    mode: str(clock.mode, ''),
    epochMs: n(clock.epoch_ms),
    uncertaintyMs: n(clock.uncertainty_ms),
    serverRttUs: n(server.last_rtt_us),
    serverUnsupported: server.supported === false,
    config: { ntpServer: str(config.ntp_server, ''), ntpIntervalS: n(config.ntp_interval_s), syncIntervalS: n(config.sync_interval_s) },
  };
}
