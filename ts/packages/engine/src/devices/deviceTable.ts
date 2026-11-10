// The device records of the Desktop service (service.py's `_devices`,
// `_latest_status`, `_latest_result`, `_latest_visualization`), with the same
// field names, so anything that read a Desktop device entry reads these.
//
// Several writers update one entry -- the device's own status and results,
// its stream and heartbeats, and the relay's presence snapshot (here: this
// host's own FindMe/session state) -- each with a different subset of
// fields, so entries are merged, never replaced (mergeDeviceEntry).
//
// Timestamps are the Python ISO strings (utcIsoFormat); staleness compares
// them against the wall clock as Python did. Pending-command and boot
// timers are monotonic.
import { type Clock, utcIsoFormat } from '@nhgw/core';

import type { CommandGating } from './commandGating';
import { maintenanceModeFromResult, modeFromPayload } from './commandGating';
import type { DeviceEventEmitter } from './events';
import { canonicalDeviceName, deviceIdCandidates, deviceUidFromPayload, isFullHexUid, normalizeDeviceId, normalizeUid } from './identity';
import type { DeviceLabels } from './labels';
import { type Dict, dictOr, get, has, isDict, isNone, num, or, parseIsoMs, setDefault, strOr, toInt, truthy } from './py';
import { finalizeApplyUpdateForFirmwareVersion, markRelayedUpdateStarted, mergeUpdateState, updateStateFromResult } from './updateState';

/** A device not genuinely heard from for this long is shown offline (service.STALE_DEVICE_TIMEOUT_SEC). */
export const STALE_DEVICE_TIMEOUT_MS = 12_000;
export const STALE_DEVICE_CHECK_INTERVAL_MS = 5_000;
/** One disconnected presence snapshot right after the device was live is ridden out (FINDME_DISCONNECT_GRACE_SEC). */
export const FINDME_DISCONNECT_GRACE_MS = 5_000;
/** A relayed mode never overrides a direct one younger than this (DIRECT_MODE_FRESH_SEC). */
export const DIRECT_MODE_FRESH_MS = 15_000;

/** Failures a relay reports for a device that never answered: not evidence it is alive. */
export const RELAY_FAILURE_CODES: ReadonlySet<string> = new Set([
  'command_delivery_timeout',
  'result_page_timeout',
  'device_not_connected_to_hub',
  'device_command_already_in_flight',
  'hub_command_roster_full',
  'command_too_large',
  'gateway_send_failed',
]);

/** Blocks written by more than one source, merged key by key. */
export const MERGED_DEVICE_BLOCKS: readonly string[] = ['findme', 'gateway_state'];

export const CALIBRATION_STATUS_KEYS: readonly string[] = [
  'enabled', 'mode_active', 'session_active', 'complete', 'tare_complete', 'tare_enabled', 'output_mode',
  'tare', 'draft_tare', 'levels', 'draft_levels', 'fit', 'draft_fit', 'fit_settings', 'metadata',
];

const SNAPSHOT_IDENTITY_KEYS = [
  'device_name', 'mode', 'firmware_version', 'hardware_model', 'matrix_shape', 'findme', 'runtime', 'logging', 'system',
];
const SNAPSHOT_ENVELOPE_KEYS = [
  'device_uid', 'device_id', 'received_at', 'received_at_ms', 'command', 'request_id', 'status', 'message',
  'transport_path', 'gateway_id', 'gateway_connected', 'mode', 'protocol', 'firmware_version',
];

export type DeviceKind = 'status' | 'result' | 'parsed' | 'gateway';

export interface RecordingState {
  enabled: boolean;
  error: string;
}

export interface DeviceTableHooks {
  /** Before a result is merged (catalog bookkeeping, app events). */
  beforeResult?(deviceUid: string, payload: Dict): void;
  /** After a result was merged and its events emitted (catalog fetch). */
  afterResult?(deviceUid: string, payload: Dict, isStatusSnapshot: boolean): void;
  /** After a status was merged and its events emitted (before any inferred result is recorded). */
  afterStatus?(deviceUid: string, payload: Dict): void;
  /**
   * A parsed frame, before it is merged (the recording module writes it here;
   * may add fields such as recording_lag_ms to `frame`).
   */
  beforeParsed?(deviceUid: string, frame: Dict): void;
}

export interface DeviceTableOptions {
  clock: Clock;
  events: DeviceEventEmitter;
  gating: CommandGating;
  labels: DeviceLabels;
  hooks?: DeviceTableHooks;
  /** Whether each device is recording (the recording module's state); default: never. */
  recordingState?: (deviceUid: string) => RecordingState;
}

export interface RelayPresenceOptions {
  /** Ride out one disconnected snapshot right after the device was live (gateway summaries do, registrations do not). */
  allowDisconnectGrace?: boolean;
  /** The relay's kind ("gateway", "hub", "studio", "pocket"); a Hub's snapshot never writes `findme`. */
  clientType?: string;
}

/** Minimal shape of a parsed sensor frame (the parse module's output): the fields this table reads. */
export interface ParsedFrame {
  device_uid?: string;
  dn?: string;
  /** Pressures, one per sensor. */
  p?: number[];
  battery?: Dict;
  mode?: string;
  [key: string]: unknown;
}

export class DeviceTable {
  readonly devices = new Map<string, Dict>();
  readonly latestStatus = new Map<string, Dict>();
  readonly latestResult = new Map<string, Dict>();
  readonly latestVisualization = new Map<string, Dict>();
  /** device_id / short alias -> full UID. */
  readonly deviceIdToUid = new Map<string, string>();

  private readonly clock: Clock;
  private readonly events: DeviceEventEmitter;
  private readonly gating: CommandGating;
  private readonly labels: DeviceLabels;
  private readonly hooks: DeviceTableHooks;
  private readonly recordingState: (deviceUid: string) => RecordingState;
  private readonly rxTimes: number[] = [];
  private readonly rxTimesByDevice = new Map<string, number[]>();
  rxFrames = 0;

  constructor(options: DeviceTableOptions) {
    this.clock = options.clock;
    this.events = options.events;
    this.gating = options.gating;
    this.labels = options.labels;
    this.hooks = options.hooks ?? {};
    this.recordingState = options.recordingState ?? (() => ({ enabled: false, error: '' }));
  }

  nowIso(): string {
    return utcIsoFormat(this.clock.nowMs());
  }

  // -- identity ---------------------------------------------------------------

  /** `_resolve_known_device_uid`: a mapped device_id, a known key, or the one full UID a short alias ends. */
  resolveKnownDeviceUid(value: unknown): string {
    const normalized = normalizeUid(value);
    if (!normalized) return '';
    const mapped = this.deviceIdToUid.get(normalized);
    if (mapped) return mapped;
    if (this.devices.has(normalized)) return normalized;
    if (!isFullHexUid(normalized)) {
      const matches = [...this.devices.keys()].filter((uid) => isFullHexUid(uid) && uid.endsWith(normalized));
      if (matches.length === 1) return matches[0]!;
    }
    return normalized;
  }

  private rememberDeviceIdMapping(deviceUid: string, payload: Dict): void {
    for (const value of deviceIdCandidates(payload)) {
      const normalized = normalizeDeviceId(value);
      if (normalized) this.deviceIdToUid.set(normalized, deviceUid);
    }
  }

  /** `_purge_short_aliases_locked`: a full UID absorbs entries kept under a short alias of it. */
  private purgeShortAliases(deviceUid: string): boolean {
    if (!isFullHexUid(deviceUid)) return false;
    const keys = new Set([...this.devices.keys(), ...this.latestStatus.keys(), ...this.latestResult.keys(), ...this.latestVisualization.keys()]);
    const aliases = [...keys].filter(
      (key) => key !== deviceUid && key && key.length < deviceUid.length && deviceUid.endsWith(key.toUpperCase()),
    );
    if (aliases.length === 0) return false;
    for (const alias of aliases) {
      this.devices.delete(alias);
      this.latestStatus.delete(alias);
      this.latestResult.delete(alias);
      this.latestVisualization.delete(alias);
      this.gating.forgetDevice(alias);
      this.deviceIdToUid.set(normalizeUid(alias), deviceUid);
    }
    return true;
  }

  // -- reads ------------------------------------------------------------------

  /** list_devices(): decorated entries, by UID. */
  list(): Dict[] {
    return [...this.devices.keys()].sort().map((uid) => this.decorate(this.devices.get(uid)!));
  }

  get(deviceUid: unknown): Dict | null {
    const entry = this.devices.get(this.resolveKnownDeviceUid(deviceUid));
    return entry === undefined ? null : this.decorate(entry);
  }

  latestSample(deviceUid?: string): Dict[] {
    if (deviceUid) {
      const item = this.latestVisualization.get(this.resolveKnownDeviceUid(deviceUid));
      return item === undefined ? [] : [item];
    }
    return [...this.latestVisualization.keys()].sort().map((uid) => this.latestVisualization.get(uid)!);
  }

  /** visualization_target_fps(): the device's scan target, default 60. */
  visualizationTargetFps(deviceUid: unknown): number {
    const uid = deviceUid ? this.resolveKnownDeviceUid(deviceUid) : '';
    for (const candidate of [this.latestStatus.get(uid) ?? {}, this.latestResult.get(uid) ?? {}, this.devices.get(uid) ?? {}]) {
      const value = DeviceTable.extractTargetFps(candidate);
      if (value !== null) return value;
    }
    return 60;
  }

  static extractTargetFps(payload: Dict): number | null {
    const paths = [
      ['runtime', 'scan_timing', 'target_fps'],
      ['scan_timing', 'target_fps'],
      ['last_status', 'runtime', 'scan_timing', 'target_fps'],
      ['last_result', 'runtime', 'scan_timing', 'target_fps'],
    ];
    for (const path of paths) {
      let value: unknown = payload;
      for (const key of path) {
        if (!isDict(value)) {
          value = null;
          break;
        }
        value = value[key];
      }
      let fps: number;
      const n = num(value);
      if (n !== null && Number.isFinite(n)) fps = Math.trunc(n);
      else if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) fps = parseInt(value, 10);
      else if (typeof value === 'boolean') fps = value ? 1 : 0;
      else continue;
      if (fps > 0) return fps;
    }
    return null;
  }

  // -- shaping ----------------------------------------------------------------

  /** `_payload_is_live`: whether this payload proves the device itself just answered. */
  static payloadIsLive(payload: Dict, kind: string): boolean {
    if (has(payload, 'live_seen')) return truthy(payload.live_seen);
    if (!['status', 'result', 'parsed'].includes(kind)) return false;
    if (kind === 'result') {
      for (const key of ['message', 'error']) if (RELAY_FAILURE_CODES.has(strOr(payload[key]))) return false;
    }
    return true;
  }

  static systemSummary(deviceUid: string, payload: Dict, receivedAt: string): Dict {
    const runtime = dictOr(payload.runtime);
    const system = dictOr(payload.system);
    const matrix = dictOr(payload.matrix_shape);
    const battery = dictOr(payload.battery);
    return {
      device_uid: deviceUid,
      mode: or(payload.mode, runtime.mode, system.mode, 'unknown'),
      firmware_version: or(system.firmware_version, runtime.firmware_version, payload.firmware_version, 'unknown'),
      protocol: or(payload.protocol, runtime.protocol, system.protocol, 'NHO/Arduino/1'),
      hardware_model: or(system.hardware_model, payload.hardware_model, 'unknown'),
      updated_at: receivedAt,
      matrix_shape: matrix,
      battery,
    };
  }

  /** `_normalize_device_entry`: what one payload says about a device (null = says nothing; merge skips it). */
  normalizeDeviceEntry(deviceUid: string, payload: Dict, kind: DeviceKind): Dict {
    const now = this.nowIso();
    const receivedAt = strOr(payload.received_at) || now;
    const system = dictOr(payload.system);
    const runtime = dictOr(payload.runtime);
    let updateState = payload.update_state;
    if (isNone(updateState) && kind === 'result') updateState = updateStateFromResult(payload);
    // A payload that does not name the device leaves the name alone: falling
    // back to the UID renamed it on every command result.
    const reportedName = strOr(or(payload.device_name, system.name, ''));
    const deviceName = reportedName ? canonicalDeviceName(reportedName, deviceUid) : null;
    const hasSystemVersions = ['hardware_model', 'firmware_version', 'protocol'].some((key) => has(payload, key));
    const systemSummary =
      kind === 'status' || truthy(system) || hasSystemVersions ? DeviceTable.systemSummary(deviceUid, payload, receivedAt) : null;
    const nickname = this.labels.nickname(deviceUid);
    const recording = this.recordingState(deviceUid);
    return {
      device_uid: deviceUid,
      device_name: deviceName,
      nickname,
      display_name: nickname || deviceName,
      channel: or(payload.channel, runtime.channel),
      mode: or(payload.mode, runtime.mode),
      transport_mode: dictOr(runtime.transport).mode,
      transport_path: payload.transport_path,
      gateway_connected: payload.gateway_connected,
      protocol: payload.protocol,
      firmware_version: payload.firmware_version,
      hardware_model: payload.hardware_model,
      matrix_shape: payload.matrix_shape,
      findme: payload.findme,
      last_heartbeat_at: payload.last_heartbeat_at,
      runtime: payload.runtime,
      logging: or(payload.logging, runtime.logging),
      services: payload.services,
      update_state: updateState,
      system_summary: systemSummary,
      scan_stopped: payload.scan_stopped,
      last_seen_at: receivedAt,
      last_live_seen_at: DeviceTable.payloadIsLive(payload, kind) ? receivedAt : null,
      last_kind: kind,
      last_status: this.latestStatus.get(deviceUid),
      last_result: this.latestResult.get(deviceUid),
      recording_enabled: recording.enabled,
      recording_error: recording.error,
    };
  }

  /** `_merge_device_entry`: None never overwrites; update_state, findme and gateway_state merge. */
  static mergeDeviceEntry(existing: Dict, incoming: Dict): Dict {
    const merged: Dict = { ...existing };
    const existingMode = strOr(merged.mode);
    const incomingMode = strOr(incoming.mode);
    for (const [key, raw] of Object.entries(incoming)) {
      if (isNone(raw)) continue;
      let value: unknown = raw;
      if (key === 'update_state') {
        value = mergeUpdateState(merged.update_state, value, existingMode, incomingMode);
      } else if (MERGED_DEVICE_BLOCKS.includes(key) && isDict(value) && isDict(merged[key])) {
        value = { ...(merged[key] as Dict), ...value };
      }
      merged[key] = value;
    }
    return finalizeApplyUpdateForFirmwareVersion(merged);
  }

  /** `_decorate_device_entry`: boot transition, labels and recording state, as every reader sees an entry. */
  decorate(entry: Dict): Dict {
    const result: Dict = { ...entry };
    const uid = strOr(result.device_uid);
    const transition = this.gating.activeBootTransition(uid);
    if (transition !== null) {
      result.booting = true;
      result.boot_target_mode = transition.target_mode;
      result.boot_command = transition.command;
      result.mode = 'booting';
    } else {
      delete result.booting;
      delete result.boot_target_mode;
      delete result.boot_command;
    }
    const nickname = this.labels.nickname(uid);
    const deviceName = strOr(or(result.device_name, result.device_uid, ''));
    const recording = this.recordingState(uid);
    result.nickname = nickname;
    result.display_name = nickname || deviceName;
    result.device_group = this.labels.group(uid);
    result.recording_enabled = recording.enabled;
    result.recording_error = recording.error;
    return result;
  }

  static mergeNestedStatusDict(existing: Dict, incoming: Dict): Dict {
    const merged: Dict = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = isDict(value) && isDict(merged[key]) ? DeviceTable.mergeNestedStatusDict(merged[key] as Dict, value) : value;
    }
    return merged;
  }

  /** `_merge_status_payload`: a status is merged into the last one (deeply); its envelope fields are not carried over. */
  static mergeStatusPayload(existingStatus: Dict, incoming: Dict): Dict {
    if (!truthy(existingStatus)) return finalizeApplyUpdateForFirmwareVersion(incoming);
    const skip = new Set(['request_id', 'command', 'status', 'message', 'received_at']);
    const merged: Dict = {};
    for (const [key, value] of Object.entries(existingStatus)) if (!skip.has(key)) merged[key] = value;
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = isDict(value) && isDict(merged[key]) ? DeviceTable.mergeNestedStatusDict(merged[key] as Dict, value) : value;
    }
    return finalizeApplyUpdateForFirmwareVersion(merged);
  }

  /** `_is_status_snapshot_result`: whether a result carries the device's status (transport errors never do). */
  static isStatusSnapshotResult(payload: Dict): boolean {
    const message = strOr(payload.message);
    if (['command_delivery_timeout', 'command_expired', 'device_not_connected_to_gateway', 'switch_command_delivery_timeout'].includes(message)) {
      return false;
    }
    if (strOr(payload.status).toLowerCase() === 'error' || payload.ok === false) return false;
    const command = strOr(payload.command);
    return (
      ['status', 'query', 'memory_status', 'scan_health', 'storage_status', 'set_log', 'set_ota_config', 'check_update', 'enter_maintenance', 'exit_maintenance'].includes(command) ||
      ['status', 'memory_status', 'scan_health', 'storage_status', 'log_config_updated', 'ota_config_updated', 'update_checked', 'stream_buffer_updated', 'maintenance_entered', 'maintenance_exited'].includes(message)
    );
  }

  /** The calibration status a calibration_* reply carries, if any. */
  static calibrationStatusFromResult(payload: Dict): Dict | null {
    if (!strOr(payload.command).startsWith('calibration_')) return null;
    if (strOr(payload.status).toLowerCase() === 'error' || payload.ok === false) return null;
    const source = isDict(payload.data) ? payload.data : payload;
    if (!['enabled', 'session_active', 'tare_complete', 'levels'].every((key) => has(source, key))) return null;
    const out: Dict = {};
    for (const key of CALIBRATION_STATUS_KEYS) if (has(source, key)) out[key] = source[key];
    return out;
  }

  static matrixShapeTuple(value: unknown): [number, number] | null {
    if (!isDict(value)) return null;
    const rows = toInt(value.rows, -1);
    const cols = toInt(value.cols, -1);
    if (rows <= 0 || cols <= 0) return null;
    return [rows, cols];
  }

  /** A new matrix shape makes the last frame (a different sensor count) meaningless. */
  private clearIncompatibleVisualization(deviceUid: string, merged: Dict): void {
    const shape = DeviceTable.matrixShapeTuple(merged.matrix_shape);
    if (shape === null) return;
    const latest = this.latestVisualization.get(deviceUid);
    if (!isDict(latest)) return;
    const points = latest.p;
    if (!Array.isArray(points)) return;
    if (points.length === shape[0] * shape[1]) return;
    this.latestVisualization.delete(deviceUid);
    delete merged.latest_sample;
  }

  private emitDeviceUpdate(entry: Dict): void {
    this.events.emit({ type: 'device_update', item: this.decorate(entry) });
  }

  private emitSnapshot(): void {
    this.events.emit({ type: 'device_snapshot', items: this.list() });
  }

  private prepare(deviceUidIn: unknown, payloadIn: unknown): [string, Dict] | null {
    if (!isDict(payloadIn)) return null;
    const payload: Dict = { ...payloadIn };
    const deviceUid = deviceUidFromPayload(deviceUidIn, payload);
    if (!deviceUid) return null;
    payload.device_uid = deviceUid;
    if (isFullHexUid(deviceUid)) payload.device_id = deviceUid;
    setDefault(payload, 'received_at', this.nowIso());
    this.rememberDeviceIdMapping(deviceUid, payload);
    return [deviceUid, payload];
  }

  // -- writers ----------------------------------------------------------------

  /** `_record_status`: hello / status / update_progress, heartbeats and stream presence. */
  recordStatus(deviceUidIn: unknown, payloadIn: unknown): void {
    const prepared = this.prepare(deviceUidIn, payloadIn);
    if (prepared === null) return;
    const [deviceUid] = prepared;
    let [, payload] = prepared;
    const existingForMerge = this.devices.get(deviceUid) ?? {};
    const existingStatus = isDict(existingForMerge.last_status) ? existingForMerge.last_status : {};
    payload = DeviceTable.mergeStatusPayload(existingStatus, payload);
    const entry = this.normalizeDeviceEntry(deviceUid, payload, 'status');
    const purged = this.purgeShortAliases(deviceUid);
    this.latestStatus.set(deviceUid, payload);
    const merged = DeviceTable.mergeDeviceEntry(this.devices.get(deviceUid) ?? {}, entry);
    merged.last_status = payload;
    this.clearIncompatibleVisualization(deviceUid, merged);
    if (truthy(merged.mode)) merged.last_direct_mode_at = payload.received_at;
    this.devices.set(deviceUid, merged);
    this.gating.modeObserved(deviceUid, modeFromPayload(payload));
    this.emitDeviceUpdate(merged);
    if (purged) this.emitSnapshot();
    this.hooks.afterStatus?.(deviceUid, payload);
    const synthetic = this.gating.pendingResultFromStatus(deviceUid, payload);
    if (synthetic !== null) this.recordResult(deviceUid, synthetic);
  }

  /** `_record_result`: a command reply (direct, relayed, or inferred from a status). */
  recordResult(deviceUidIn: unknown, payloadIn: unknown): void {
    const prepared = this.prepare(deviceUidIn, payloadIn);
    if (prepared === null) return;
    const [deviceUid, payload] = prepared;
    const requestId = strOr(payload.request_id);
    if (requestId) this.gating.forget(deviceUid, requestId);
    this.hooks.beforeResult?.(deviceUid, payload);
    markRelayedUpdateStarted(payload);
    const isStatusSnapshot = DeviceTable.isStatusSnapshotResult(payload);
    const calibrationStatus = DeviceTable.calibrationStatusFromResult(payload);
    const inner = dictOr(payload.data);
    const entryPayload: Dict = { ...payload };
    if (isStatusSnapshot && truthy(inner)) {
      // Relayed results keep the firmware's status under `data`: use its identity fields.
      for (const key of SNAPSHOT_IDENTITY_KEYS) {
        const value = entryPayload[key];
        if ((isNone(value) || value === '') && has(inner, key)) entryPayload[key] = inner[key];
      }
    }
    const entry = this.normalizeDeviceEntry(deviceUid, entryPayload, 'result');
    let updateResultState: Dict | null = null;
    const command = strOr(payload.command);
    if (command === 'check_update' || command === 'apply_update') {
      const nested = isDict(inner.update_state) ? inner.update_state : payload.update_state;
      if (isDict(nested)) updateResultState = nested;
    }
    const purged = this.purgeShortAliases(deviceUid);
    this.latestResult.set(deviceUid, payload);
    const merged = DeviceTable.mergeDeviceEntry(this.devices.get(deviceUid) ?? {}, entry);
    merged.last_result = payload;
    const knownStatus = this.latestStatus.get(deviceUid);
    if (isStatusSnapshot) {
      // Hoist the firmware's `data` to the top level, as the stream/heartbeat path has it.
      let statusPayload: Dict;
      if (truthy(inner)) {
        statusPayload = { ...inner };
        for (const key of SNAPSHOT_ENVELOPE_KEYS) if (has(payload, key)) statusPayload[key] = payload[key];
      } else {
        statusPayload = { ...payload };
      }
      const maintenanceMode = maintenanceModeFromResult(payload);
      if (maintenanceMode !== null) {
        statusPayload.mode = maintenanceMode;
        statusPayload.runtime = { ...dictOr(statusPayload.runtime), mode: maintenanceMode };
        statusPayload.scan_stopped = maintenanceMode !== 'normal';
      }
      statusPayload = DeviceTable.mergeStatusPayload(truthy(knownStatus) ? knownStatus! : {}, statusPayload);
      this.latestStatus.set(deviceUid, statusPayload);
      merged.last_status = statusPayload;
      if (maintenanceMode !== null) merged.mode = maintenanceMode;
    } else if (calibrationStatus !== null && truthy(knownStatus)) {
      // calibration_* replies carry the whole calibration status.
      const statusPayload: Dict = { ...knownStatus!, calibration: calibrationStatus };
      this.latestStatus.set(deviceUid, statusPayload);
      merged.last_status = statusPayload;
    } else if (updateResultState !== null && truthy(knownStatus)) {
      // The update card reads the last status first.
      const statusPayload: Dict = { ...knownStatus! };
      statusPayload.update_state = mergeUpdateState(statusPayload.update_state, updateResultState);
      this.latestStatus.set(deviceUid, statusPayload);
      merged.last_status = statusPayload;
    }
    this.clearIncompatibleVisualization(deviceUid, merged);
    if (truthy(merged.mode)) merged.last_direct_mode_at = payload.received_at;
    this.devices.set(deviceUid, merged);
    if (isStatusSnapshot) this.gating.modeObserved(deviceUid, modeFromPayload(payload));
    const item = this.decorate(merged);
    this.events.emit({ type: 'command_result', device_uid: deviceUid, request_id: requestId, result: payload });
    this.events.emit({ type: 'device_update', item });
    if (purged) this.emitSnapshot();
    this.hooks.afterResult?.(deviceUid, payload, isStatusSnapshot);
  }

  /** `_record_parsed`: a parsed sensor frame (without the CSV write: see DeviceTableHooks.beforeParsed). */
  recordParsed(deviceUidIn: unknown, frame: ParsedFrame | Dict, source = 'udp'): void {
    if (!isDict(frame)) return;
    const deviceUid = deviceUidFromPayload(deviceUidIn, frame);
    if (!deviceUid) return;
    const payload: Dict = { ...frame, dn: deviceUid, device_uid: deviceUid, device_id: deviceUid };
    this.hooks.beforeParsed?.(deviceUid, payload);
    payload.device_udp_fps = this.markVisualizationReceived(deviceUid);
    payload.received_at_ms = Math.floor(this.clock.monotonicMs());
    const purged = this.purgeShortAliases(deviceUid);
    this.latestVisualization.set(deviceUid, payload);
    const entry = this.normalizeDeviceEntry(deviceUid, payload, 'parsed');
    entry.latest_sample = payload;
    entry.visualization_source = source;
    const existing = this.devices.get(deviceUid) ?? {};
    const merged = DeviceTable.mergeDeviceEntry(existing, entry);
    if (isDict(payload.battery)) {
      // v5 carries battery telemetry on the stream: keep it in last_status too.
      const latest: Dict = isDict(merged.last_status) ? { ...merged.last_status } : {};
      const existingBattery = latest.battery;
      latest.battery = isDict(existingBattery) ? DeviceTable.mergeNestedStatusDict(existingBattery, payload.battery) : { ...payload.battery };
      latest.device_uid = deviceUid;
      setDefault(latest, 'device_id', deviceUid);
      latest.received_at = this.nowIso();
      merged.last_status = latest;
      this.latestStatus.set(deviceUid, latest);
    }
    const recording = this.recordingState(deviceUid);
    merged.recording_enabled = recording.enabled;
    if (recording.error) merged.recording_error = recording.error;
    if (truthy(merged.mode)) merged.last_direct_mode_at = this.nowIso();
    this.devices.set(deviceUid, merged);
    const isNew = !truthy(existing);
    const item = this.decorate(merged);
    this.events.emit({ type: 'visualization_update', device_uid: deviceUid, data: payload });
    if (isNew) this.events.emit({ type: 'device_update', item });
    if (purged) this.emitSnapshot();
  }

  private markVisualizationReceived(deviceUid: string): number {
    const now = this.clock.monotonicMs();
    this.rxFrames += 1;
    this.rxTimes.push(now);
    let window = this.rxTimesByDevice.get(deviceUid);
    if (window === undefined) {
      window = [];
      this.rxTimesByDevice.set(deviceUid, window);
    }
    window.push(now);
    this.purgeRxWindow(now);
    return this.rxTimesByDevice.get(deviceUid)?.length ?? 0;
  }

  private purgeRxWindow(now: number): void {
    const cutoff = now - 1000;
    while (this.rxTimes.length && this.rxTimes[0]! < cutoff) this.rxTimes.shift();
    for (const [uid, window] of [...this.rxTimesByDevice]) {
      while (window.length && window[0]! < cutoff) window.shift();
      if (window.length === 0) this.rxTimesByDevice.delete(uid);
    }
  }

  /** visualization_stats(). */
  visualizationStats(): { udp_received_fps: number; udp_received_frames: number } {
    this.purgeRxWindow(this.clock.monotonicMs());
    return { udp_received_fps: this.rxTimes.length, udp_received_frames: this.rxFrames };
  }

  /** `_has_fresh_direct_mode_locked`. */
  private hasFreshDirectMode(existing: Dict, nowIso: string): boolean {
    const directAt = existing.last_direct_mode_at;
    if (!truthy(directAt) || !truthy(existing.mode)) return false;
    const direct = parseIsoMs(directAt);
    if (direct === null) return false;
    const now = parseIsoMs(nowIso) ?? this.clock.nowMs();
    const age = now - direct;
    return age >= 0 && age <= DIRECT_MODE_FRESH_MS;
  }

  /** `_should_preserve_recent_findme_attachment`: attached and genuinely live within the grace. */
  static shouldPreserveRecentFindmeAttachment(existing: Dict, seenAt: string): boolean {
    const findme = dictOr(existing.findme);
    if (strOr(findme.state).trim().toLowerCase() !== 'attached') return false;
    const lastLive = strOr(existing.last_live_seen_at) || strOr(existing.last_seen_at);
    if (!lastLive) return false;
    const seen = parseIsoMs(seenAt);
    const live = parseIsoMs(lastLive);
    if (seen === null || live === null) return false;
    const age = seen - live;
    return age >= 0 && age <= FINDME_DISCONNECT_GRACE_MS;
  }

  /**
   * `_record_gateway_device_presence_locked`: a relay's view of a device (here,
   * this host's own GatewayState roster entry). Returns the decorated entry,
   * or null when a stale report from a non-owner was ignored. Emits nothing.
   */
  recordRelayPresence(
    deviceUid: string,
    gatewayId: string,
    deviceIn: Dict,
    connectedIn: boolean,
    seenAt: string = this.nowIso(),
    options: RelayPresenceOptions = {},
  ): Dict | null {
    const existing: Dict = { ...(this.devices.get(deviceUid) ?? {}) };
    const clientType = options.clientType ?? '';
    let device = deviceIn;
    let connected = connectedIn;
    const actuallyConnected = connectedIn;
    if (!connected && options.allowDisconnectGrace && DeviceTable.shouldPreserveRecentFindmeAttachment(existing, seenAt)) {
      connected = true;
      const existingFindme = dictOr(existing.findme);
      device = { ...device, connected: true, findme_state: 'attached' };
      setDefault(device, 'addr', get(existingFindme, 'host', ''));
      setDefault(device, 'gateway_name', get(existingFindme, 'gateway_name', ''));
      setDefault(device, 'udp_port', get(existingFindme, 'udp_port', ''));
    }
    const deviceName = canonicalDeviceName(strOr(or(device.device_name, device.name, existing.device_name, deviceUid)), deviceUid);
    const gatewayState: Dict = {
      gateway_id: gatewayId,
      connected,
      findme_state: strOr(device.findme_state),
      updated_at: seenAt,
    };
    const findmeState: Dict = {
      state: strOr(device.findme_state) || (connected ? 'attached' : 'disconnected'),
      gateway_id: gatewayId,
      gateway_name: get(device, 'gateway_name', ''),
      host: or(device.last_findme_addr, device.addr, ''),
      udp_port: get(device, 'udp_port', ''),
      claim_id: get(device, 'claim_id', ''),
      last_success_ms: get(device, 'last_findme_at', ''),
      last_heartbeat_at: get(device, 'last_heartbeat_at', ''),
      last_error: get(device, 'findme_reason', ''),
    };
    const bootTransition = connected ? null : this.gating.activeBootTransition(deviceUid);
    const nickname = this.labels.nickname(deviceUid);
    const recording = this.recordingState(deviceUid);
    const incoming: Dict = {
      device_uid: deviceUid,
      device_name: deviceName,
      nickname,
      display_name: nickname || deviceName,
      gateway_id: gatewayId,
      client_type: clientType,
      gateway_connected: connected,
      last_gateway_seen_at: seenAt,
      gateway_state: gatewayState,
      // A Hub is not a FindMe gateway: its view lives in gateway_state only.
      findme:
        clientType === 'hub'
          ? null
          : Object.fromEntries(Object.entries(findmeState).filter(([, v]) => !isNone(v) && v !== '')),
      protocol: device.protocol,
      firmware_version: device.firmware_version,
      hardware_model: device.hardware_model,
      transport_path: device.transport_path,
      last_heartbeat_at: device.last_heartbeat_at,
      recording_enabled: recording.enabled,
      recording_error: recording.error,
    };
    let mode = or(device.mode, dictOr(device.runtime).mode);
    // A relay's cached mode is never fresher than the device's own report.
    if (truthy(mode) && this.hasFreshDirectMode(existing, seenAt)) mode = existing.mode;
    if (bootTransition !== null) {
      Object.assign(incoming, {
        mode: 'booting',
        booting: true,
        boot_target_mode: bootTransition.target_mode,
        boot_command: bootTransition.command,
        boot_expires_at_monotonic: bootTransition.expires_at,
      });
      mode = 'booting';
    }
    if (truthy(mode)) incoming.mode = mode;
    incoming.last_seen_at = seenAt;
    // Only a genuinely connected report advances last_live_seen_at.
    if (actuallyConnected) {
      incoming.last_live_seen_at = seenAt;
      incoming.last_kind = 'gateway';
    } else if (truthy(existing) && (!truthy(existing.gateway_id) || !gatewayId || existing.gateway_id === gatewayId)) {
      incoming.last_kind = or(existing.last_kind, 'gateway');
    } else {
      return null;
    }
    const merged = DeviceTable.mergeDeviceEntry(existing, incoming);
    this.devices.set(deviceUid, merged);
    return this.decorate(merged);
  }

  /**
   * `_check_stale_devices`: a device shown connected but not genuinely heard
   * from for STALE_DEVICE_TIMEOUT_MS goes offline (gateway_state too, which
   * the UI also reads). Emits device_update for each; returns their UIDs.
   */
  checkStale(nowMs: number = this.clock.nowMs()): string[] {
    const changed: string[] = [];
    for (const [uid, entry] of [...this.devices]) {
      if (entry.gateway_connected !== true) continue;
      const liveAt = strOr(entry.last_live_seen_at) || strOr(entry.received_at);
      if (!liveAt) continue;
      const parsed = parseIsoMs(liveAt);
      if (parsed === null) continue;
      if (nowMs - parsed <= STALE_DEVICE_TIMEOUT_MS) continue;
      entry.gateway_connected = false;
      if (isDict(entry.gateway_state)) entry.gateway_state = { ...entry.gateway_state, connected: false };
      this.devices.set(uid, entry);
      changed.push(uid);
      this.emitDeviceUpdate(entry);
    }
    return changed;
  }

  // -- labels -----------------------------------------------------------------

  /** set_device_nickname(). Throws LabelError('nickname_too_long'). */
  async setNickname(deviceUid: unknown, nickname: unknown): Promise<Dict> {
    const uid = this.resolveKnownDeviceUid(deviceUid);
    const value = await this.labels.setNickname(uid, nickname);
    const entry = this.devices.get(uid);
    if (entry !== undefined) {
      this.devices.set(uid, this.decorate(entry));
      // New: Python emitted nothing for a nickname (only for a group); a UI subscribing to updates wants it.
      this.emitDeviceUpdate(this.devices.get(uid)!);
    }
    return { status: 'saved', device_uid: uid, nickname: value };
  }

  /** set_device_group(). Throws LabelError('device_group_too_long'). */
  async setGroup(deviceUid: unknown, group: unknown): Promise<Dict> {
    const uid = this.resolveKnownDeviceUid(deviceUid);
    const value = await this.labels.setGroup(uid, group);
    const entry = this.devices.get(uid);
    if (entry !== undefined) {
      this.devices.set(uid, this.decorate(entry));
      this.emitDeviceUpdate(this.devices.get(uid)!);
    }
    return { status: 'saved', device_uid: uid, group: value };
  }
}
