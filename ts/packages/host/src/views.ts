// Engine records -> the contract's plain views (pure functions, tested in
// test/views.test.ts), and the settings <-> GatewayConfig mapping.
import type { GatewayConfig, RawConfig, TargetMode } from '@nhgw/core';
import type { Timeline } from '@nhgw/engine';

import type {
  BatteryView,
  DeviceView,
  LiveFrame,
  NearbyDeviceView,
  HostClientType,
  RangeMode,
  VrefView,
  VrefZone,
  HostSettings,
  RecordingSummary,
  RecordingTimeline,
} from './contract';
import { dict, num, str } from './plainJson';

export type NetworkInterfaceInfoLike = { name: string; address: string };

/** No frame for this long: the device's fps shows 0. */
export const LIVE_STALE_MS = 2000;
/** isolationSuspected: running this long with Wi-Fi up and not one FindMe. */
export const ISOLATION_AFTER_MS = 60_000;

function int(value: unknown): number | null {
  const n = num(value);
  if (n !== null) return Math.trunc(n);
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function parseIsoMs(value: unknown): number | null {
  const text = str(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function matrixOf(value: unknown): { rows: number; cols: number } | null {
  const shape = dict(value);
  const rows = int(shape.rows);
  const cols = int(shape.cols);
  return rows !== null && cols !== null && rows > 0 && cols > 0 ? { rows, cols } : null;
}

export function batteryOf(entry: Record<string, unknown>): BatteryView | null {
  const status = dict(entry.last_status);
  const battery = dict(status.battery);
  const latest = dict(dict(entry.latest_sample).battery);
  const centi = num(battery.soc_centi_percent) ?? num(latest.soc_centi_percent);
  const soc = centi !== null ? centi / 100 : (num(battery.soc_percent) ?? num(latest.soc_percent));
  const chargeState = str(dict(status.power).charge_state) || str(battery.charge_state);
  if (soc === null && !chargeState && Object.keys(battery).length === 0 && Object.keys(latest).length === 0) return null;
  const syncing = str(battery.gauge_sync_state) === 'syncing';
  return {
    percent: soc === null || syncing ? null : Math.max(0, Math.min(100, Math.round(soc))),
    charging: chargeState === 'charging' && !syncing,
  };
}

/** A decorated device entry (DeviceService.listDevices()) as the UI shows it. `nowMono`: the monotonic clock in ms. */
export function deviceView(entry: Record<string, unknown>, nowMono: number): DeviceView {
  const uid = str(entry.device_uid);
  const summary = dict(entry.system_summary);
  const status = dict(entry.last_status);
  const system = dict(status.system);
  const sample = dict(entry.latest_sample);
  const sampleAt = num(sample.received_at_ms);
  const live = sampleAt !== null && nowMono - sampleAt <= LIVE_STALE_MS;
  const fps = live ? (int(sample.device_udp_fps) ?? 0) : 0;
  const nickname = str(entry.nickname);
  const deviceName = str(entry.device_name);
  const known = (...values: unknown[]) => values.map(str).find((v) => v && v !== 'unknown') ?? '';
  return {
    uid,
    displayName: nickname || deviceName || `NHOS-${uid}`,
    nickname,
    group: str(entry.device_group),
    online: entry.gateway_connected === true,
    mode: str(entry.mode) || 'unknown',
    hardwareModel: known(entry.hardware_model, system.hardware_model, summary.hardware_model),
    firmwareVersion: known(entry.firmware_version, system.firmware_version, summary.firmware_version),
    battery: batteryOf(entry),
    fps,
    matrix: matrixOf(entry.matrix_shape) ?? matrixOf(status.matrix_shape) ?? matrixOf(summary.matrix_shape),
    recording: {
      enabled: entry.recording_enabled === true,
      finishing: entry.recording_finishing === true,
      error: str(entry.recording_error),
    },
    lastSeenMs: parseIsoMs(entry.last_seen_at),
    vref: vrefOf(status),
  };
}

/** The v2.0.F firmware's safe Vref and GPIO45 strap thresholds (VrefPolicy.h). */
export const VREF_SAFE_MV = 330;
export const VREF_STRAP_MARGIN_MV = 700;
export const VREF_STRAP_RISK_MV = 800;

/**
 * Where a Vref sits: the safe value, raised, close to the strap risk (700–800 mV) or past
 * it (a reset that skips the shutdown handler may then fail to boot until power is cut).
 */
export function vrefZone(mv: number | null, mode: string): VrefZone {
  if (mode === 'auto') return 'auto';
  if (mv === null) return 'unknown';
  if (Math.abs(mv - VREF_SAFE_MV) <= 5) return 'safe';
  if (mv < VREF_STRAP_MARGIN_MV) return 'raised';
  if (mv < VREF_STRAP_RISK_MV) return 'near';
  return 'risk';
}

/** status.vref + status.range -> VrefView; null when the board has no Vref DAC. */
export function vrefOf(status: Record<string, unknown>): VrefView | null {
  const vref = dict(status.vref);
  if (vref.supported !== true) return null;
  const range = dict(status.range);
  const rawMode = str(range.mode);
  const mode: RangeMode = rawMode === 'virtual' || rawMode === 'auto' ? rawMode : 'raw';
  const table = Array.isArray(range.rfb_ohm) ? range.rfb_ohm.map((v) => num(v) ?? 0) : [];
  const measured = table.filter((v) => v > 0).sort((a, b) => a - b);
  const mv = vref.ok === false ? null : num(vref.mv);
  return {
    mv,
    zone: vrefZone(mv, mode),
    limitMv: num(vref.limit_mv),
    mode,
    refRfbOhm: num(range.ref_rfb_ohm) ?? 20000,
    leakCompensation: range.leak_compensation !== false,
    rfbMeasuredRows: Math.max(measured.length, int(range.rfb_known_rows) ?? 0),
    rfbRows: table.length,
    rfbMedianOhm: measured[Math.floor(measured.length / 2)] ?? null,
    saturatedRows: int(range.saturated_rows),
    calibrationOn: vref.calibration_on === true,
  };
}

/** Marks a listed device another relay took over (see DeviceView.takenOver). */
export function withOwnership(view: DeviceView, owner: { isYielded(uid: string): boolean; attachedTo(uid: string): string }): DeviceView {
  if (!owner.isYielded(view.uid)) return view;
  const by = owner.attachedTo(view.uid);
  // Online here: the new owner is gone and this relay serves it as the fallback.
  if (view.online && !by) return view;
  return { ...view, takenOver: true, takenOverBy: by };
}

/** A DeviceService.nearby() item. `attachedTo`: the relay the device last said it is attached to (not us). */
export function nearbyView(item: Record<string, unknown>, attachedTo: string): NearbyDeviceView {
  return {
    uid: str(item.device_uid),
    name: str(item.device_name) || `NHOS-${str(item.device_uid)}`,
    ip: str(item.addr),
    attachedTo,
    lastSeenMs: parseIsoMs(item.last_findme_at) ?? 0,
  };
}

/** A visualization_update's data; null when it carries no pressures. */
export function liveFrame(uid: string, data: Record<string, unknown>, shape: { rows: number; cols: number } | null): LiveFrame | null {
  if (!Array.isArray(data.p)) return null;
  const values = (data.p as unknown[]).map((v) => num(v) ?? 0);
  const fits = shape !== null && shape.rows * shape.cols === values.length;
  return {
    uid,
    values,
    rows: fits ? shape.rows : 1,
    cols: fits ? shape.cols : values.length,
    timestampMs: num(data.timestamp_ms) ?? num(data.device_epoch_ms) ?? 0,
    fps: int(data.device_udp_fps) ?? 0,
  };
}

/**
 * A recording folder's meta.json (format 1) as a summary. `id` is the folder
 * relative to the data root; `inProgress` when this host is still writing it.
 */
export function recordingSummary(
  id: string,
  meta: Record<string, unknown> | null,
  bytes: number,
  inProgress: boolean,
  nowMs: number,
): RecordingSummary {
  const device = dict(meta?.device);
  const recording = dict(meta?.recording);
  const uid = str(device.uid) || id.split('/')[0] || '';
  const started = parseIsoMs(recording.started_at) ?? 0;
  const end = parseIsoMs(recording.stopped_at) ?? (inProgress ? nowMs : (parseIsoMs(recording.updated_at) ?? started));
  return {
    id,
    uid,
    deviceName: str(device.display_name) || `NHOS-${uid}`,
    startedAtMs: started,
    durationMs: Math.max(0, end - started),
    frames: int(recording.rows) ?? 0,
    bytes,
    inProgress,
    syncState: 'local',
  };
}

export function timelineView(timeline: Timeline): RecordingTimeline {
  return {
    buckets: timeline.buckets.map((bucket) => (bucket === null ? { min: 0, max: 0 } : { min: bucket[0], max: bucket[1] })),
    durationMs: timeline.duration_ms,
    lostFrames: timeline.lost_frames,
    gaps: timeline.gaps,
    events: timeline.events.map((event) => ({ atMs: event.at_ms, label: event.label })),
  };
}

/** Wi-Fi interface names (the hotspot is ap0 / swlan0 / wlan1 depending on the vendor). */
const WIFI_INTERFACE = /^(wlan|swlan|ap|wifi|softap)\d*/i;

export function wifiUp(addresses: readonly NetworkInterfaceInfoLike[]): boolean {
  return addresses.some((item) => WIFI_INTERFACE.test(item.name) && item.address !== '' && !item.address.startsWith('169.254.'));
}

/** Running ≥ 60 s with Wi-Fi up and not a single FindMe: the network probably isolates clients. */
export function isolationSuspected(runningForMs: number | null, addresses: readonly NetworkInterfaceInfoLike[], findmeRequests: number): boolean {
  return runningForMs !== null && runningForMs >= ISOLATION_AFTER_MS && findmeRequests === 0 && wifiUp(addresses);
}

// -- settings ----------------------------------------------------------------

/**
 * App keys kept in the same config file (GatewayConfigStore keeps unknown
 * keys). Their `pocket_` prefix is NH Pocket's on-disk format, kept so
 * existing Pocket configs read the same; Studio uses the same keys.
 */
export const APP_KEYS = {
  relayEnabled: 'pocket_relay_enabled',
  syncPolicy: 'pocket_sync_policy',
  theme: 'pocket_theme',
  locale: 'pocket_locale',
} as const;

/** The app's short name, the default display name on the server. */
export function productName(clientType: HostClientType): string {
  return clientType === 'studio' ? 'NH Studio' : 'NH Pocket';
}

/** The first-run config: managed offers, relay on, production server. */
export function hostDefaultConfig(relayId: string, displayName = 'NH Pocket'): RawConfig {
  return {
    enabled: true,
    gateway_id: relayId,
    gateway_name: displayName,
    target_mode: 'production',
    manual_url: '',
    offer_policy: 'managed',
    managed_devices: [],
    released_devices: [],
    [APP_KEYS.relayEnabled]: true,
    [APP_KEYS.syncPolicy]: 'manual',
    [APP_KEYS.theme]: 'auto',
    [APP_KEYS.locale]: 'system',
  };
}

/** A new relay id, `<clientType>-<8 hex>`. */
export function newRelayId(clientType: HostClientType = 'pocket', random: () => number = Math.random): string {
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += Math.floor(random() * 16).toString(16);
  return `${clientType}-${suffix}`;
}


function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function settingsFromConfig(config: GatewayConfig): HostSettings {
  const relay = config[APP_KEYS.relayEnabled];
  return {
    pocketId: config.gateway_id,
    displayName: config.gateway_name,
    serverTarget: config.target_mode,
    manualUrl: config.manual_url,
    relayEnabled: relay === undefined ? true : relay === true,
    offerPolicy: config.offer_policy === 'all' ? 'all' : 'managed',
    syncPolicy: oneOf(config[APP_KEYS.syncPolicy], ['manual', 'auto', 'wifi_only'] as const, 'manual'),
    theme: oneOf(config[APP_KEYS.theme], ['auto', 'light', 'dark'] as const, 'auto'),
    locale: oneOf(config[APP_KEYS.locale], ['system', 'en', 'ja', 'zh-CN'] as const, 'system'),
  };
}

/** A settings patch as a config patch (only the keys the patch names). */
export function configPatchFromSettings(patch: Partial<HostSettings>, defaultName = 'NH Pocket'): RawConfig {
  const out: RawConfig = {};
  if (patch.pocketId !== undefined) out.gateway_id = patch.pocketId.trim();
  if (patch.displayName !== undefined) out.gateway_name = patch.displayName.trim() || defaultName;
  if (patch.serverTarget !== undefined) out.target_mode = patch.serverTarget satisfies TargetMode;
  if (patch.manualUrl !== undefined) out.manual_url = patch.manualUrl.trim();
  if (patch.offerPolicy !== undefined) out.offer_policy = patch.offerPolicy;
  if (patch.relayEnabled !== undefined) out[APP_KEYS.relayEnabled] = patch.relayEnabled;
  if (patch.syncPolicy !== undefined) out[APP_KEYS.syncPolicy] = patch.syncPolicy;
  if (patch.theme !== undefined) out[APP_KEYS.theme] = patch.theme;
  if (patch.locale !== undefined) out[APP_KEYS.locale] = patch.locale;
  return out;
}
