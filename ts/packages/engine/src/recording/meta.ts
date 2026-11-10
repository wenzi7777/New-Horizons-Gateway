// recording_meta.py: the `.meta.json` (format 1) that describes a recording,
// and the device fields it is built from. json.dumps(indent=2,
// ensure_ascii=False) + "\n", rewritten atomically every WRITE_EVERY_SEC
// while frames arrive and on every change. See the Python module docstring
// for the document's fields.
import type { ParsedPacket } from '../parse/packetParser';
import { deepCopy, isDict, pyEquals, PyFloat, pyIntOf, pyJsonDumps, pyStrOr, pyTruthyOf } from '../parse/pyJson';
import { pyRoundInt } from '../parse/pyNumber';
import { basename, type RecordingFileSink } from './sink';
import { isoMs, localTimeZoneOffset, META_FORMAT, type RecordingPaths } from './paths';

type Dict = Record<string, unknown>;

/** Clocks a recording reads; core's Clock satisfies it. */
export interface RecordingClock {
  /** Wall clock, µs since the Unix epoch (Python datetime.now(timezone.utc)). */
  nowEpochUs(): number;
  /** Monotonic ms (Python time.monotonic() * 1000). */
  monotonicMs(): number;
}

/** time.monotonic() as Python had it: seconds, from the injected ms. */
export const monotonicSec = (clock: RecordingClock): number => clock.monotonicMs() / 1000;

/** Where the frames came in, for `transport.relay` (the new hosts add studio / pocket). */
export type RecordingRelay = 'gateway' | 'hub' | 'direct' | 'studio' | 'pocket' | (string & {});

const asDict = (value: unknown): Dict => (isDict(value) ? value : {});

/** _known: the first value that is not None, "" or "unknown". */
function known(...values: unknown[]): unknown {
  for (const value of values) {
    if (value === null || value === undefined || value === '' || value === 'unknown') continue;
    return value;
  }
  return null;
}

function matrixShape(...candidates: unknown[]): { rows: number; cols: number } | null {
  for (const candidate of candidates) {
    if (!isDict(candidate)) continue;
    let rows: number;
    let cols: number;
    try {
      rows = pyIntOf(candidate.rows);
      cols = pyIntOf(candidate.cols);
    } catch {
      continue;
    }
    if (rows > 0 && cols > 0) return { rows, cols };
  }
  return null;
}

/**
 * status_is_full: a real `status` reply, rather than the stand-in a heartbeat
 * or a bare stream packet leaves.
 */
export function statusIsFull(status: Dict): boolean {
  const system = asDict(status.system);
  return Boolean(
    pyTruthyOf(known(system.hardware_model, status.hardware_model)) ||
      pyTruthyOf(asDict(status.matrix_shape)) ||
      pyTruthyOf(asDict(status.calibration)),
  );
}

export type BuildDeviceMetaOptions = {
  nickname?: string;
  group?: string;
  /** The relaying connection's client_type (gateway / hub / studio / pocket). */
  relayClientType?: string;
  targetFps?: number | null;
  sensorCount?: number | null;
  rawAdcColumns?: boolean | null;
  battery?: Dict | null;
  /**
   * NH Studio / NH Pocket: the device streams to this host directly, so the
   * relay is the host itself rather than "direct". Unset (the Desktop
   * backend's behavior), a device without a connected relay is "direct".
   */
  localRelay?: 'studio' | 'pocket' | null;
  /** The local host's gateway id, written as relay_id with localRelay. */
  localRelayId?: string | null;
};

/** build_device_meta: the device-describing blocks of the meta. */
export function buildDeviceMeta(deviceUid: string, device: Dict, status: Dict, options: BuildDeviceMetaOptions = {}): Dict {
  const system = asDict(status.system);
  const runtime = asDict(status.runtime);
  const summary = asDict(device.system_summary);
  const calibration = asDict(status.calibration);
  const scan = asDict(runtime.scan_timing);
  const imu = asDict(status.imu);
  const streamBattery = pyTruthyOf(asDict(options.battery)) ? asDict(options.battery) : asDict(status.battery);
  const transport = asDict(runtime.transport);

  const gatewayId = pyStrOr(device.gateway_id);
  let relay: string;
  let relayId: string | null;
  if (gatewayId && pyTruthyOf(device.gateway_connected)) {
    relay = options.relayClientType || pyStrOr(device.client_type) || 'gateway';
    relayId = relay !== 'direct' ? gatewayId : null;
  } else if (options.localRelay) {
    relay = options.localRelay;
    relayId = options.localRelayId || null;
  } else {
    relay = 'direct';
    relayId = null;
  }
  const prerelease = known(status.firmware_prerelease, system.firmware_prerelease);
  const nickname = options.nickname ?? '';
  const group = options.group ?? '';
  const copyDict = (value: unknown) => (isDict(value) ? deepCopy(value) : null);
  const bool = (value: unknown) => (typeof value === 'boolean' ? value : null);

  return {
    device: {
      uid: deviceUid,
      display_name: known(device.display_name, nickname, device.device_name, status.device_name),
      nickname: nickname || null,
      group: group || null,
      hardware_model: known(system.hardware_model, status.hardware_model, device.hardware_model, summary.hardware_model),
      firmware_version: known(system.firmware_version, status.firmware_version, device.firmware_version, summary.firmware_version),
      firmware_prerelease: bool(prerelease),
      protocol: known(status.protocol, runtime.protocol, device.protocol),
    },
    sensors: {
      count: options.sensorCount ?? null,
      matrix_shape: matrixShape(status.matrix_shape, device.matrix_shape, summary.matrix_shape),
      matrix_layout: copyDict(status.matrix_layout),
      order: 'row-major from P1',
      raw_adc_columns: options.rawAdcColumns ?? null,
    },
    calibration: {
      enabled: bool(calibration.enabled),
      output_mode: known(calibration.output_mode),
      tare_complete: bool(calibration.tare_complete),
      // The settings, not the fitted levels/coefficients.
      fit_settings: copyDict(calibration.fit_settings),
      metadata: copyDict(calibration.metadata),
    },
    stream: {
      target_fps: options.targetFps ?? null,
      send_every_n_frames: known(scan.send_every_n_frames),
      filter: copyDict(status.filter),
      stream_raw_adc: bool(status.stream_raw_adc),
      imu: pyTruthyOf(imu) ? { chip: known(imu.chip), sample_rate_hz: known(imu.sample_rate_hz) } : null,
      magnetometer: isDict(status.magnetometer) || typeof status.magnetometer === 'boolean' ? deepCopy(status.magnetometer) : null,
    },
    transport: {
      path: known(device.transport_path, status.transport_path, transport.mode, device.transport_mode),
      relay,
      relay_id: relayId,
    },
    clock: copyDict(status.clock),
    battery_at_start: pyTruthyOf(streamBattery)
      ? { soc_percent: known(streamBattery.soc_percent), vbat_mv: known(streamBattery.vbat_mv) }
      : null,
    status_received_at: statusIsFull(status) ? known(status.received_at) : null,
  };
}

/** service._extract_target_fps. */
export function extractTargetFps(payload: Dict): number | null {
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
    try {
      fps = pyIntOf(value);
    } catch {
      continue;
    }
    if (fps > 0) return fps;
  }
  return null;
}

/** What the host knows about a device when a recording starts or a status arrives. */
export type DeviceKnowledge = {
  /** The device entry (the backend's _devices[uid]). */
  device: Dict;
  /** The device's last full status (_latest_status[uid]). */
  status: Dict;
  nickname?: string;
  group?: string;
  /** client_type of the relay the device's gateway_id names, if connected through one. */
  relayClientType?: string;
  localRelay?: 'studio' | 'pocket' | null;
  localRelayId?: string | null;
};

/**
 * service._recording_device_meta: the meta's device blocks from what is
 * known now; `firstFrame` adds what only the stream carries.
 */
export function recordingDeviceMeta(deviceUid: string, knowledge: DeviceKnowledge, firstFrame?: ParsedPacket | null): Dict {
  const pressures = firstFrame ? firstFrame.p : null;
  const rawAdc = firstFrame ? firstFrame.raw_adc : null;
  const sensorCount = Array.isArray(pressures) ? pressures.length : null;
  const battery = firstFrame && isDict(firstFrame.battery) ? { ...firstFrame.battery } : null;
  if (battery && typeof battery.soc_percent === 'number') (battery as Dict).soc_percent = new PyFloat(battery.soc_percent);
  return buildDeviceMeta(deviceUid, knowledge.device, knowledge.status, {
    nickname: knowledge.nickname ?? '',
    group: knowledge.group ?? '',
    relayClientType: knowledge.relayClientType ?? '',
    targetFps: extractTargetFps(knowledge.status) ?? extractTargetFps(knowledge.device),
    sensorCount,
    rawAdcColumns: firstFrame ? Array.isArray(rawAdc) && rawAdc.length === sensorCount : null,
    battery: battery as Dict | null,
    localRelay: knowledge.localRelay ?? null,
    localRelayId: knowledge.localRelayId ?? null,
  });
}

export type RecordingMetaOptions = {
  sink: RecordingFileSink;
  clock: RecordingClock;
  startedAtUs: number;
  firstFrameSeq: number;
  firstTimestampMs: number;
  /** "+09:00"; default: the host's offset at startedAtUs (Python's server time zone). */
  serverTimeZone?: string;
};

/** The `.meta.json` of one recording in progress. */
export class RecordingMeta {
  static readonly WRITE_EVERY_SEC = 10.0;
  static readonly MAX_CHANGES = 200;
  /** Followed for the whole recording; everything else stays as it was at the start. */
  static readonly TRACKED: ReadonlyArray<readonly [string, string]> = [
    ['calibration', 'enabled'],
    ['calibration', 'output_mode'],
    ['stream', 'target_fps'],
    ['stream', 'stream_raw_adc'],
    ['transport', 'path'],
    ['transport', 'relay_id'],
    ['device', 'firmware_version'],
  ];

  private readonly sink: RecordingFileSink;
  private readonly clock: RecordingClock;
  private writtenAt = 0.0;
  private readonly doc: Dict;

  constructor(
    readonly paths: RecordingPaths,
    deviceMeta: Dict,
    options: RecordingMetaOptions,
  ) {
    this.sink = options.sink;
    this.clock = options.clock;
    const started = isoMs(options.startedAtUs);
    this.doc = {
      format: META_FORMAT,
      files: { data: basename(paths.data), events: basename(paths.events) },
      ...deepCopy(deviceMeta),
      recording: {
        started_at: started,
        name_time_zone: 'UTC',
        server_time_zone: options.serverTimeZone ?? localTimeZoneOffset(options.startedAtUs),
        first_frame_seq: options.firstFrameSeq || null,
        first_timestamp_ms: options.firstTimestampMs,
        last_frame_seq: options.firstFrameSeq || null,
        last_timestamp_ms: options.firstTimestampMs,
        rows: 0,
        lag_ms: null,
        max_lag_ms: null,
        updated_at: started,
        stop_requested_at: null,
        stopped_at: null,
        stop_reason: null,
      },
      changes: [],
    };
  }

  private get recording(): Dict {
    return this.doc.recording as Dict;
  }

  /** A copy of the document. */
  get document(): Dict {
    return deepCopy(this.doc);
  }

  onFrame(frameSeq: number, timestampMs: number, lagMs: number | null = null, maxLagMs: number | null = null): void {
    const recording = this.recording;
    recording.rows = (recording.rows as number) + 1;
    if (frameSeq) recording.last_frame_seq = frameSeq;
    recording.last_timestamp_ms = timestampMs;
    if (lagMs !== null) recording.lag_ms = pyRoundInt(lagMs);
    if (maxLagMs !== null) recording.max_lag_ms = pyRoundInt(maxLagMs);
    if (monotonicSec(this.clock) - this.writtenAt >= RecordingMeta.WRITE_EVERY_SEC) this.write();
  }

  /** Fills in what was unknown and logs a change in a TRACKED field. */
  refreshDevice(deviceMeta: Dict): void {
    let changed = false;
    const at = isoMs(this.clock.nowEpochUs());
    const frameSeq = this.recording.last_frame_seq;
    const isTracked = (block: string, field: string) => RecordingMeta.TRACKED.some(([b, f]) => b === block && f === field);
    for (const [block, values] of Object.entries(deviceMeta)) {
      const current = this.doc[block];
      if (!isDict(values)) {
        if ((current === null || current === undefined) && values !== null && values !== undefined) {
          this.doc[block] = deepCopy(values);
          changed = true;
        }
        continue;
      }
      if (!isDict(current)) {
        this.doc[block] = deepCopy(values);
        changed = true;
        continue;
      }
      for (const [field, value] of Object.entries(values)) {
        if (value === null || value === undefined) continue;
        const old = current[field];
        if (old === null || old === undefined) {
          current[field] = deepCopy(value);
          changed = true;
        } else if (isTracked(block, field) && !pyEquals(old, value)) {
          const changes = this.doc.changes as Dict[];
          if (changes.length < RecordingMeta.MAX_CHANGES) {
            changes.push({ at, frame_seq: frameSeq, field: `${block}.${field}`, from: old, to: value });
          }
          current[field] = deepCopy(value);
          changed = true;
        }
      }
    }
    if (changed) this.write();
  }

  requestStop(): void {
    if (this.recording.stop_requested_at === null) this.recording.stop_requested_at = isoMs(this.clock.nowEpochUs());
    this.write();
  }

  stop(reason: string): void {
    if (this.recording.stopped_at === null) {
      this.recording.stopped_at = isoMs(this.clock.nowEpochUs());
      this.recording.stop_reason = reason;
    }
    this.write();
  }

  /** The document as Python writes it. */
  text(): string {
    return `${pyJsonDumps(this.doc, { indent: 2, ensureAscii: false })}\n`;
  }

  write(): boolean {
    this.recording.updated_at = isoMs(this.clock.nowEpochUs());
    const text = this.text();
    this.writtenAt = monotonicSec(this.clock);
    try {
      this.sink.writeAtomic(this.paths.meta, text);
    } catch {
      return false;
    }
    return true;
  }
}
