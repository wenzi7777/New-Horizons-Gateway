// One device's recording switch, as the Desktop backend's service runs it
// (service.py set_recording_enabled / _write_csv_sample / _finish_recording,
// datagram_ingest.py _record_parsed's recording branch, and
// app_event_capture.py): feed it every parsed frame and app_events reply for
// the device; it starts a recording on the first frame after the switch is
// turned on, writes `.data.csv` / `.events.csv` / `.meta.json` exactly as
// Python does, and finishes on stop (after draining queued frames), on a
// write error, or on shutdown.
//
// No timers: the host calls drainTimedOut(token) `drainWaitSec + 0.5` s after
// a stop that returned one, and pollAppEvents() every APP_EVENT_POLL_SEC
// while the switch is on (Python's poller thread).
import type { AppEvent, ParsedPacket } from '../parse/packetParser';
import { isDict, pyIntOf, pyStrOr, pyTruthyOf } from '../parse/pyJson';
import { pyRoundInt } from '../parse/pyNumber';
import { appendDroppedMarker, appendEvents, eventsLostSince, eventValueToPy, FrameClock } from './appEventLog';
import { csvFloat, csvInt, csvRowText } from './csv';
import { monotonicSec, RecordingMeta, recordingDeviceMeta, statusIsFull, type DeviceKnowledge, type RecordingClock } from './meta';
import { epochMsFromUs, newRecordingPaths } from './paths';
import { RecordingSession, type StopReason } from './session';
import type { RecordingFileSink } from './sink';

type Dict = Record<string, unknown>;

export type RecordingUpdate = {
  type: 'recording_update';
  device_uid: string;
  enabled: boolean;
  finishing?: boolean;
  error?: string;
};

export type DeviceRecorderDeps = {
  sink: RecordingFileSink;
  /** Root of `<UID>/<YYYYMMDD>/<HHMMSS>/`. */
  dataRoot: string;
  clock: RecordingClock;
  /** What is known about the device now (its entry and last status). */
  knowledge: () => DeviceKnowledge;
  /** Recording meta's server_time_zone ("+09:00"); default: the host's offset. */
  serverTimeZone?: string;
  /**
   * Sends a command to the device (`app_events` polls and gap repairs);
   * throws when it cannot be sent (offline). Omitted: nothing is sent.
   */
  publishCommand?: (payload: Dict) => void;
  /** The random part of a request id (Python uuid4().hex). */
  newRequestId?: () => string;
  onUpdate?: (update: RecordingUpdate) => void;
};

/** An opaque handle for the recording a drain timer belongs to. */
export type DrainToken = { readonly session: RecordingSession };

export type SetEnabledResult = {
  device_uid: string;
  enabled: boolean;
  finishing: boolean;
  /** Call drainTimedOut(drain.token) after drain.waitSec + 0.5 s. */
  drain: { waitSec: number; token: DrainToken } | null;
  /** No full status yet: ask the device for one (the meta fills in from it). */
  needsStatus: boolean;
};

export type FrameResult = {
  /** round(lag) when the frame carries the device's clock (shown while recording falls behind). */
  recording_lag_ms?: number;
  /** The recording ended on this frame (drained stop, or a write error). */
  finished?: StopReason;
};

function intField(event: Dict, key: string): number {
  try {
    return pyIntOf(pyTruthyOf(event[key]) ? event[key] : 0);
  } catch {
    return 0;
  }
}

let fallbackRequestCounter = 0;
const defaultRequestId = () => (++fallbackRequestCounter).toString(16).padStart(32, '0');

export class DeviceRecorder {
  static readonly APP_EVENT_POLL_SEC = 0.5;
  static readonly APP_EVENT_STREAM_CHECK_SEC = 5.0;
  static readonly APP_EVENT_REPAIR_MIN_SEC = 1.0;
  static readonly APP_EVENT_HOLD_SEC = 3.0;
  static readonly APP_EVENT_WRITTEN_KEEP = 1024;
  static readonly APP_EVENT_REQUESTS_KEEP = 64;

  private enabledFlag = false;
  private errorText: string | null = null;
  private finishingFlag = false;
  private session: RecordingSession | null = null;
  private samplePath: string | null = null;
  private frameClock: FrameClock | null = null;
  // app_event_capture.py state for this device
  private eventSeq: number | null = null;
  private eventHold: [number, number] | null = null;
  private eventWritten: Map<number, null> | null = null;
  private eventMissing: Set<number> | null = null;
  private eventStreaming = false;
  private eventRequestedAt: number | null = null;
  private readonly eventRequests = new Map<string, number>();

  constructor(
    readonly deviceUid: string,
    private readonly deps: DeviceRecorderDeps,
  ) {}

  get enabled(): boolean {
    return this.enabledFlag;
  }
  get error(): string | null {
    return this.errorText;
  }
  get finishing(): boolean {
    return this.finishingFlag;
  }
  /** The recording's files, once its first frame arrived. */
  get paths() {
    return this.session?.paths ?? null;
  }
  get currentSession(): RecordingSession | null {
    return this.session;
  }

  /** Frames are written: recording, or stopped with frames still being written up to the stop. */
  get active(): boolean {
    return this.enabledFlag || (this.session !== null && this.session.draining);
  }

  private emit(update: Omit<RecordingUpdate, 'type' | 'device_uid'>): void {
    this.deps.onUpdate?.({ type: 'recording_update', device_uid: this.deviceUid, ...update });
  }

  private pop(): RecordingSession | null {
    const session = this.session;
    this.session = null;
    this.samplePath = null;
    this.frameClock = null;
    return session;
  }

  /** set_recording_enabled. */
  setEnabled(enabled: boolean): SetEnabledResult {
    const ended: RecordingSession[] = [];
    let drainWait: number | null = null;
    let session = this.session;
    let needsStatus = false;
    if (enabled) {
      if (session !== null && session.draining) {
        // Started again while the last recording was still writing its queued frames.
        ended.push(this.pop()!);
        session = null;
      }
      if (session === null) {
        this.frameClock = null;
        this.resetAppEventState();
      }
      this.enabledFlag = true;
      this.errorText = null;
      needsStatus = !statusIsFull(this.deps.knowledge().status ?? {});
    } else {
      this.enabledFlag = false;
      this.errorText = null;
      if (session !== null && !session.draining) drainWait = session.beginDrain();
      if (drainWait === null && session !== null && !session.draining) {
        ended.push(this.pop()!);
        this.resetAppEventState();
      }
    }
    const finishing = drainWait !== null;
    this.finishingFlag = finishing;
    for (const done of ended) done.finish('user');
    const result: SetEnabledResult = {
      device_uid: this.deviceUid,
      enabled,
      finishing,
      drain: drainWait !== null && session !== null ? { waitSec: drainWait, token: { session } } : null,
      needsStatus,
    };
    this.emit({ enabled, finishing });
    return result;
  }

  /** The drain timer: ends the recording it was started for, if it is still the current one. */
  drainTimedOut(token: DrainToken): void {
    this.finishRecording('user_drain_timeout', token.session);
  }

  /** The host is shutting down (Python stop()): the recording ends as "server_stopped". */
  shutdown(): void {
    if (this.session === null) return;
    this.enabledFlag = false;
    this.finishRecording('server_stopped');
  }

  private finishRecording(reason: StopReason, expected: RecordingSession | null = null): void {
    const session = this.session;
    if (session === null || (expected !== null && session !== expected)) return;
    this.pop();
    if (!this.enabledFlag) this.resetAppEventState();
    this.finishingFlag = false;
    session.finish(reason);
    this.emit({ enabled: this.enabledFlag, finishing: false });
  }

  /** A full status arrived: the meta fills in what was unknown and logs tracked changes. */
  onDeviceStatus(): void {
    const session = this.session;
    if (session === null) return;
    const refreshed = recordingDeviceMeta(this.deviceUid, this.deps.knowledge());
    // Taken from the first frame; a later status says nothing about the start.
    delete refreshed.battery_at_start;
    session.meta.refreshDevice(refreshed);
  }

  /** Every parsed stream frame of this device (datagram_ingest._record_parsed). */
  onFrame(payload: ParsedPacket): FrameResult {
    if (!this.active) return {};
    const result: FrameResult = {};
    const sessionBefore = this.session;
    try {
      const lag = this.writeCsvSample(payload);
      if (lag !== null) result.recording_lag_ms = pyRoundInt(lag);
      // After the sample, so the frame clock already has this frame.
      if (payload.app_events && payload.app_events.length) this.captureStreamedAppEvents(payload.app_events);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.enabledFlag = false;
      const finished = this.pop();
      this.errorText = text;
      if (finished !== null) finished.finish(`write_error: ${text}`);
      result.finished = `write_error: ${text}`;
      this.emit({ enabled: false, error: text });
      return result;
    }
    if (sessionBefore !== null && this.session === null) {
      const stopped = sessionBefore.meta.document.recording as Dict;
      result.finished = String(stopped.stop_reason ?? '');
    }
    return result;
  }

  private writeCsvSample(payload: ParsedPacket): number | null {
    const pressures = payload.p;
    if (!Array.isArray(pressures)) return null;
    const nowUs = this.deps.clock.nowEpochUs();
    let session = this.session;
    if (session === null) {
      // A frame let through just as its recording ended must not start a new one.
      if (!this.enabledFlag) return null;
      const paths = newRecordingPaths(this.deps.sink, this.deps.dataRoot, this.deviceUid, nowUs);
      const meta = new RecordingMeta(paths, recordingDeviceMeta(this.deviceUid, this.deps.knowledge(), payload), {
        sink: this.deps.sink,
        clock: this.deps.clock,
        startedAtUs: nowUs,
        firstFrameSeq: frameSeqOf(payload),
        firstTimestampMs: csvTimestampMs(payload, nowUs),
        ...(this.deps.serverTimeZone !== undefined ? { serverTimeZone: this.deps.serverTimeZone } : {}),
      });
      session = new RecordingSession(paths, meta, this.deps.sink, this.deps.clock);
      this.session = session;
      this.samplePath = paths.data;
      this.frameClock = new FrameClock();
      meta.write();
    }
    const imu = isDict(payload.imu) ? (payload.imu as Dict) : {};
    const pick = (own: unknown, nested: unknown): string[] => {
      const list = pyTruthyOf(own) ? own : pyTruthyOf(nested) ? nested : null;
      return Array.isArray(list) ? list.slice(0, 3).map((v) => csvFloat(v as number)) : ['0', '0', '0'];
    };
    const gyro = pick(payload.gyro, imu.gyro);
    const acc = pick(payload.acc, imu.acc);
    const mag = pick(payload.mag, imu.mag);
    const rawAdc = payload.raw_adc;
    const includeRaw = Array.isArray(rawAdc) && rawAdc.length === pressures.length;
    const timestamp = csvTimestampMs(payload, nowUs);
    const timeRef = csvTimeRef(payload);
    const frameSeq = frameSeqOf(payload);
    const count = pressures.length;

    const header = (): string =>
      csvRowText([
        'timestamp_ms',
        ...Array.from({ length: count }, (_, i) => `P${i + 1}`),
        ...(includeRaw ? Array.from({ length: count }, (_, i) => `RawADC_${i + 1}`) : []),
        'Mag_x',
        'Mag_y',
        'Mag_z',
        'Gyro_x',
        'Gyro_y',
        'Gyro_z',
        'Acc_x',
        'Acc_y',
        'Acc_z',
        // Appended, not inserted, so positional readers keep working.
        'frame_seq',
        'time_ref',
      ]);
    const row = csvRowText([
      csvInt(timestamp),
      ...pressures.map(csvFloat),
      ...(includeRaw ? rawAdc!.map(csvFloat) : []),
      ...mag,
      ...gyro,
      ...acc,
      csvInt(frameSeq),
      timeRef,
    ]);
    const deviceClock = timeRef === 'device';
    const ended = session.write(header, row, frameSeq, timestamp, deviceClock);
    this.frameClock?.record(frameSeq, timestamp, timeRef);
    if (ended) this.finishRecording(ended, session);
    return deviceClock ? session.lag.lagMs : null;
  }

  // ── App events (app_event_capture.py) ───────────────────────────────────

  private resetAppEventState(keepStreaming = false): void {
    this.eventSeq = null;
    this.eventHold = null;
    this.eventWritten = null;
    this.eventMissing = null;
    if (!keepStreaming) {
      this.eventRequestedAt = null;
      this.eventStreaming = false;
    }
  }

  private appEventTarget(): [string, FrameClock] | null {
    if (!this.active) return null;
    if (this.samplePath === null || this.frameClock === null) return null;
    return [this.samplePath, this.frameClock];
  }

  /** Where to ask from: just before the oldest event the stream lost, else after the newest written. */
  private appEventSince(): number {
    if (this.eventMissing && this.eventMissing.size) return Math.max(0, Math.min(...this.eventMissing) - 1);
    return this.eventSeq ?? 0;
  }

  private requestAppEvents(): void {
    const since = this.appEventSince();
    const requestId = `appev-${(this.deps.newRequestId ?? defaultRequestId)()}`;
    this.eventRequestedAt = monotonicSec(this.deps.clock);
    this.eventRequests.set(requestId, since);
    while (this.eventRequests.size > DeviceRecorder.APP_EVENT_REQUESTS_KEEP) {
      this.eventRequests.delete(this.eventRequests.keys().next().value as string);
    }
    try {
      if (!this.deps.publishCommand) throw new Error('device_not_connected');
      // quiet: polled, so the device skips its LED ack.
      this.deps.publishCommand({ command: 'app_events', since_seq: since, quiet: true, request_id: requestId });
    } catch {
      this.eventRequests.delete(requestId);
    }
  }

  /**
   * An app_events request sent outside this recorder (a replayed `.nhraw`
   * `app_events_request` event): its reply is matched to `since` by request id.
   */
  noteAppEventsRequest(requestId: string, since: number): void {
    // As requestAppEvents() stamps it: a stream gap right after a request is
    // not repaired by another one (or the replay would ask where live did not).
    this.eventRequestedAt = monotonicSec(this.deps.clock);
    this.eventRequests.set(requestId, since);
    while (this.eventRequests.size > DeviceRecorder.APP_EVENT_REQUESTS_KEEP) {
      this.eventRequests.delete(this.eventRequests.keys().next().value as string);
    }
  }

  /** One tick of the app_events poller (every APP_EVENT_POLL_SEC while the switch is on). */
  pollAppEvents(): void {
    if (!this.enabledFlag) return;
    const now = monotonicSec(this.deps.clock);
    const interval = this.eventStreaming ? DeviceRecorder.APP_EVENT_STREAM_CHECK_SEC : DeviceRecorder.APP_EVENT_POLL_SEC;
    if (now - (this.eventRequestedAt ?? 0.0) >= interval - 0.1) this.requestAppEvents();
  }

  /** Appends the events not written before, leaving out those from before the first frame. Throws on a sink failure. */
  private writeAppEvents(samplePath: string, clock: FrameClock, events: Dict[]): void {
    const written = (this.eventWritten ??= new Map());
    const handled: number[] = [];
    const rows: Dict[] = [];
    for (const event of events) {
      const seq = intField(event, 'seq');
      if (seq <= 0 || written.has(seq) || handled.includes(seq)) continue;
      handled.push(seq);
      const frameSeq = intField(event, 'frame_seq');
      if (frameSeq && clock.first && frameSeq < clock.first) continue;
      rows.push(event);
    }
    appendEvents(this.deps.sink, samplePath, rows, clock);
    for (const seq of handled) written.set(seq, null);
    while (written.size > DeviceRecorder.APP_EVENT_WRITTEN_KEEP) written.delete(written.keys().next().value as number);
    const missing = this.eventMissing;
    if (missing && missing.size) {
      for (const seq of handled) missing.delete(seq);
      if (!missing.size) this.eventMissing = null;
    }
    if (handled.length) this.eventSeq = Math.max(this.eventSeq ?? 0, Math.max(...handled));
  }

  private captureStreamedAppEvents(events: AppEvent[]): void {
    const target = this.appEventTarget();
    if (target === null) return;
    const [samplePath, clock] = target;
    const dicts = events.filter(isDict).map(eventValueToPy);
    const seqs = dicts.map((event) => intField(event, 'seq')).filter((seq) => seq > 0).sort((a, b) => a - b);
    if (!seqs.length) return;
    let repair = false;
    this.eventStreaming = true;
    let high = this.eventSeq ?? 0;
    const first = seqs[0]!;
    const known = (this.eventWritten?.has(first) ?? false) || (this.eventMissing?.has(first) ?? false);
    if (high && first <= high && !known) {
      // An older event than any seen: the device restarted and counts from 1 again.
      this.resetAppEventState(true);
      high = 0;
    }
    if (high && first > high + 1) {
      // A packet (or more) was lost: ask the device for what it held.
      const missing = (this.eventMissing ??= new Set());
      for (let seq = high + 1; seq < first; seq++) missing.add(seq);
      repair = true;
    }
    try {
      this.writeAppEvents(samplePath, clock, dicts);
    } catch {
      // A failed sidecar write never interrupts the sample recording.
      return;
    }
    if (repair && monotonicSec(this.deps.clock) - (this.eventRequestedAt ?? 0.0) >= DeviceRecorder.APP_EVENT_REPAIR_MIN_SEC) {
      this.requestAppEvents();
    }
  }

  private holdExpired(seq: number): boolean {
    const held = this.eventHold;
    const now = monotonicSec(this.deps.clock);
    if (held === null || held[0] !== seq) {
      this.eventHold = [seq, now];
      return false;
    }
    return now - held[1] >= DeviceRecorder.APP_EVENT_HOLD_SEC;
  }

  /**
   * An `app_events` command result for this device (the result payload:
   * {request_id, data: {events, seq, streaming, ...}}). Device JSON should be
   * read with parsePyJson so an event value of 1.0 stays a float.
   */
  onAppEventsResult(payload: Dict): void {
    if (!this.active) return;
    const target = this.appEventTarget();
    if (target === null) return;
    const [samplePath, clock] = target;
    const data = payload.data;
    if (!isDict(data)) return;
    const events = data.events;
    if (!Array.isArray(events)) return;
    const requestKey = pyStrOr(payload.request_id);
    let askedSince: number | null = this.eventRequests.has(requestKey) ? this.eventRequests.get(requestKey)! : null;
    this.eventRequests.delete(requestKey);
    if (data.streaming === true) this.eventStreaming = true;

    const deviceSeq = intField(data, 'seq');
    let previous = this.eventSeq ?? 0;
    if (previous && deviceSeq < previous) {
      // The device restarted and its sequence began again.
      this.resetAppEventState(true);
      previous = 0;
      askedSince = null;
    }

    // Oldest first. An event on a frame not yet recorded waits for the next
    // read (to get that frame's exact time) unless it has waited too long.
    const ordered = events.filter(isDict).map((event, index) => ({ event, index }));
    ordered.sort((a, b) => intField(a.event, 'seq') - intField(b.event, 'seq') || a.index - b.index);
    const keep: Dict[] = [];
    let heldSeq = 0;
    for (const { event } of ordered) {
      const frameSeq = intField(event, 'frame_seq');
      if (frameSeq > clock.last && !this.holdExpired(intField(event, 'seq'))) {
        heldSeq = intField(event, 'seq');
        break;
      }
      keep.push(event);
    }
    if (!heldSeq) this.eventHold = null;

    try {
      this.writeAppEvents(samplePath, clock, keep);
      // Not data.dropped: that is cumulative since boot.
      const lost = eventsLostSince(previous, deviceSeq, events);
      if (lost) appendDroppedMarker(this.deps.sink, samplePath, previous, lost, clock);
      // A gap the stream left, asked for from before it: what this reply did
      // not bring had already rolled off the ring.
      const missing = this.eventMissing;
      if (missing && missing.size && askedSince !== null) {
        const since = askedSince;
        const gone = [...missing].filter((seq) => seq > since && (!heldSeq || seq < heldSeq)).sort((a, b) => a - b);
        if (gone.length) {
          appendDroppedMarker(this.deps.sink, samplePath, gone[0]! - 1, gone.length, clock);
          for (const seq of gone) missing.delete(seq);
          if (!missing.size) this.eventMissing = null;
        }
      }
    } catch {
      return;
    }

    if (heldSeq) {
      this.eventSeq = Math.max(this.eventSeq ?? 0, heldSeq - 1);
    } else if (deviceSeq > (this.eventSeq ?? 0) && !ordered.length) {
      // Nothing returned but the device moved on: advance, or the same loss is counted again.
      this.eventSeq = deviceSeq;
    }
  }
}

function frameSeqOf(payload: ParsedPacket): number {
  try {
    return pyIntOf(pyTruthyOf(payload.frame_id) ? payload.frame_id : 0);
  } catch {
    return 0;
  }
}

/** service._csv_timestamp_ms for a stream frame: the device's epoch, else when it arrived. */
export function csvTimestampMs(payload: { device_epoch_ms?: number }, nowUs: number): number {
  if (typeof payload.device_epoch_ms === 'number' && Number.isInteger(payload.device_epoch_ms)) return payload.device_epoch_ms;
  return epochMsFromUs(nowUs);
}

/** service._csv_time_ref. */
export function csvTimeRef(payload: { device_epoch_ms?: number }): 'device' | 'received' {
  return typeof payload.device_epoch_ms === 'number' && Number.isInteger(payload.device_epoch_ms) ? 'device' : 'received';
}
