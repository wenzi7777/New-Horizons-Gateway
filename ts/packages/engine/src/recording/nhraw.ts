// `.nhraw`: NH Pocket's raw capture (format in NHRAW.md). The native side
// appends received datagrams with their arrival time, so nothing is lost if
// JS is throttled; convertRaw() later replays them through parseBinaryPacket
// and DeviceRecorder with the recorded times as the clocks, giving the same
// `.data.csv` / `.events.csv` / `.meta.json` a live recording would.
import { bytesToHex, hexToBytes, utf8Decode, utf8Encode } from '../../../core/src/bytes';
import { isHeartbeatPacket } from '../../../core/src/protocol';
import { extensionSensorCount, PacketParseError, parseBinaryPacket } from '../parse/packetParser';
import { isDict, parsePyJson, pyIntOf, pyJsonDumps, pyStrOr } from '../parse/pyJson';
import { DeviceRecorder, type DrainToken } from './deviceRecorder';
import type { DeviceKnowledge, RecordingClock } from './meta';
import type { RecordingPaths } from './paths';
import { MemoryRecordingSink, type RecordingFileSink } from './sink';

export const NHRAW_MAGIC = [0x4e, 0x48, 0x52, 0x57] as const; // "NHRW"
export const NHRAW_VERSION = 1;
export const NHRAW_HEADER_LEN = 24;
/** Bytes before a record's payload, after its length field: rxEpochUs (8) + source (1). */
export const NHRAW_RECORD_FIXED = 9;

export const NhrawSource = { stream: 0, control: 1, event: 2 } as const;
export type NhrawSourceName = keyof typeof NhrawSource;

export type NhrawHeader = { version: number; deviceUid: string; startEpochUs: number };
export type NhrawRecord = { rxEpochUs: number; source: NhrawSourceName; payload: Uint8Array };

const SOURCE_NAMES: Record<number, NhrawSourceName> = { 0: 'stream', 1: 'control', 2: 'event' };

function setInt64(view: DataView, offset: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`not a non-negative safe integer: ${value}`);
  const hi = Math.floor(value / 2 ** 32);
  view.setUint32(offset, value - hi * 2 ** 32, true);
  view.setUint32(offset + 4, hi, true);
}

function getInt64(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getInt32(offset + 4, true);
  return hi * 2 ** 32 + lo;
}

/** The file header. */
export function encodeNhrawHeader(header: { deviceUid: string; startEpochUs: number }): Uint8Array {
  const uid = hexToBytes(header.deviceUid);
  if (uid.length !== 6 || bytesToHex(uid) !== header.deviceUid.toUpperCase()) throw new Error('device_uid must be 12 hex digits');
  const out = new Uint8Array(NHRAW_HEADER_LEN);
  const view = new DataView(out.buffer);
  out.set(NHRAW_MAGIC, 0);
  view.setUint16(4, NHRAW_VERSION, true);
  view.setUint16(6, NHRAW_HEADER_LEN, true);
  out.set(uid, 8);
  // 14..15 reserved (0)
  setInt64(view, 16, header.startEpochUs);
  return out;
}

/** One record: u32 length, i64 rxEpochUs, u8 source, payload. */
export function encodeNhrawRecord(record: NhrawRecord): Uint8Array {
  const out = new Uint8Array(4 + NHRAW_RECORD_FIXED + record.payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, NHRAW_RECORD_FIXED + record.payload.length, true);
  setInt64(view, 4, record.rxEpochUs);
  out[12] = NhrawSource[record.source];
  out.set(record.payload, 13);
  return out;
}

/** An event record's payload: compact JSON that keeps Python's int/float distinction. */
export function encodeNhrawEvent(event: Record<string, unknown>): Uint8Array {
  return utf8Encode(pyJsonDumps(event, { separators: [',', ':'], ensureAscii: false }));
}

/** Builds a `.nhraw` in memory (tests, and hosts that write from JS). */
export class NhrawWriter {
  private readonly chunks: Uint8Array[] = [];

  constructor(readonly header: { deviceUid: string; startEpochUs: number }) {
    this.chunks.push(encodeNhrawHeader(header));
  }

  /** Appends a record and returns its bytes (what a streaming writer appends to the file). */
  record(rxEpochUs: number, source: NhrawSourceName, payload: Uint8Array): Uint8Array {
    const bytes = encodeNhrawRecord({ rxEpochUs, source, payload });
    this.chunks.push(bytes);
    return bytes;
  }

  event(rxEpochUs: number, event: Record<string, unknown>): Uint8Array {
    return this.record(rxEpochUs, 'event', encodeNhrawEvent(event));
  }

  bytes(): Uint8Array {
    const total = this.chunks.reduce((n, chunk) => n + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export type NhrawFile = {
  header: NhrawHeader;
  records: NhrawRecord[];
  /** The file ended inside a record (the writer was killed mid-append); that record is dropped. */
  truncated: boolean;
};

/** Reads a `.nhraw`. Throws on a bad header; a truncated tail is reported, not thrown. */
export function readNhraw(bytes: Uint8Array): NhrawFile {
  if (bytes.length < 8 || NHRAW_MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('nhraw_bad_magic');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  const headerLen = view.getUint16(6, true);
  if (version !== NHRAW_VERSION) throw new Error('nhraw_unsupported_version');
  if (headerLen < NHRAW_HEADER_LEN || bytes.length < headerLen) throw new Error('nhraw_bad_header');
  const header: NhrawHeader = {
    version,
    deviceUid: bytesToHex(bytes.subarray(8, 14)),
    startEpochUs: getInt64(view, 16),
  };
  const records: NhrawRecord[] = [];
  let offset = headerLen;
  let truncated = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) {
      truncated = true;
      break;
    }
    const length = view.getUint32(offset, true);
    if (length < NHRAW_RECORD_FIXED || offset + 4 + length > bytes.length) {
      truncated = true;
      break;
    }
    const source = SOURCE_NAMES[bytes[offset + 12]!];
    if (source !== undefined) {
      records.push({
        rxEpochUs: getInt64(view, offset + 4),
        source,
        payload: bytes.subarray(offset + 13, offset + 4 + length),
      });
    }
    // Unknown sources (a later version) are skipped.
    offset += 4 + length;
  }
  return { header, records, truncated };
}

export type ConvertRawOptions = {
  /** Where the recording folder goes (default '' -> `<UID>/<YYYYMMDD>/...`). */
  dataRoot?: string;
  /**
   * Files go here; default a fresh MemoryRecordingSink, whose files are
   * returned. Pass the host's real sink to write in place (and to have the
   * folder name skip recordings already there).
   */
  sink?: RecordingFileSink;
  /** What was known about the device at the start (a `knowledge` event updates it). */
  knowledge?: DeviceKnowledge;
  /** meta server_time_zone; default the host's offset at the start. */
  serverTimeZone?: string;
};

export type ConvertRawResult = {
  /** The recording's files (null when no frame was ever recorded). */
  paths: RecordingPaths | null;
  /** path -> text, when the default memory sink was used. */
  files: Map<string, string>;
  truncated: boolean;
  /** Stream records that did not parse (as the backend drops them). */
  skippedPackets: number;
};

/** The clock convertRaw drives: wall = the record's arrival, monotonic = the same in ms. */
class ReplayClock implements RecordingClock {
  us = 0;
  nowEpochUs(): number {
    return this.us;
  }
  monotonicMs(): number {
    return this.us / 1000;
  }
}

/**
 * Replays a `.nhraw` into the three recording files. The switch is on from
 * the header's start time; event records toggle it and update what is known
 * about the device (NHRAW.md lists them); a stop's drain timer fires at its
 * deadline as a live host's would.
 */
export function convertRaw(rawBytes: Uint8Array, options: ConvertRawOptions = {}): ConvertRawResult {
  const file = readNhraw(rawBytes);
  const converter = new NhrawConverter(file.header, options);
  for (const record of file.records) converter.push(record);
  return converter.finish({ truncated: file.truncated });
}

export type NhrawFinishOptions = {
  /** The file ended inside a record (reported in the result). */
  truncated?: boolean;
  /**
   * A recording still open at the end of the file (no stop: the app was
   * killed mid-recording) is ended as a shutdown ("server_stopped") at the
   * last record's time, so its meta gets stopped_at. Default false (as
   * convertRaw: the files are left as a live host had them).
   */
  closeOpen?: boolean;
};

/**
 * convertRaw() one record at a time, for a `.nhraw` too large to hold in
 * memory (NH Pocket reads it in chunks with NhrawStreamReader): push() every
 * record in file order, then finish().
 */
export class NhrawConverter {
  private readonly memory: MemoryRecordingSink | null;
  private readonly clock = new ReplayClock();
  private knowledge: DeviceKnowledge;
  private readonly uid: string;
  private readonly recorder: DeviceRecorder;
  private paths: RecordingPaths | null = null;
  private skipped = 0;
  private drain: { atUs: number; token: DrainToken } | null = null;
  private readonly chunks = new Map<string, { total: number; parts: Map<number, string> }>();
  private finished = false;

  constructor(header: NhrawHeader | { deviceUid: string; startEpochUs: number }, options: ConvertRawOptions = {}) {
    this.memory = options.sink ? null : new MemoryRecordingSink();
    const sink = options.sink ?? this.memory!;
    this.knowledge = options.knowledge ?? { device: {}, status: {} };
    this.uid = header.deviceUid;
    this.recorder = new DeviceRecorder(this.uid, {
      sink,
      dataRoot: options.dataRoot ?? '',
      clock: this.clock,
      knowledge: () => this.knowledge,
      ...(options.serverTimeZone !== undefined ? { serverTimeZone: options.serverTimeZone } : {}),
    });
    this.at(header.startEpochUs);
    this.setEnabled(true);
  }

  private at(us: number): void {
    this.clock.us = us;
  }

  private fireDrainUpTo(us: number): void {
    if (this.drain !== null && us >= this.drain.atUs) {
      const pending = this.drain;
      this.drain = null;
      this.at(pending.atUs);
      this.recorder.drainTimedOut(pending.token);
    }
  }

  private setEnabled(enabled: boolean): void {
    const result = this.recorder.setEnabled(enabled);
    if (result.drain) this.drain = { atUs: this.clock.us + Math.round((result.drain.waitSec + 0.5) * 1e6), token: result.drain.token };
  }

  private remember(): void {
    this.paths = this.recorder.paths ?? this.paths;
  }

  /** The recording's files so far (null before the first frame). */
  get currentPaths(): RecordingPaths | null {
    return this.recorder.paths ?? this.paths;
  }

  push(record: NhrawRecord): void {
    if (this.finished) throw new Error('nhraw_converter_finished');
    const recorder = this.recorder;
    this.fireDrainUpTo(record.rxEpochUs);
    this.at(record.rxEpochUs);
    if (record.source === 'stream') {
      const packet = record.payload;
      if (packet.length >= 2 && packet[0] === 0x7b) return; // JSON on the stream port: a control reply
      if (isHeartbeatPacket(packet)) return;
      let parsed;
      try {
        parsed = parseBinaryPacket(packet, extensionSensorCount(packet, () => deviceForCount(this.knowledge)));
      } catch (error) {
        if (error instanceof PacketParseError) {
          this.skipped += 1;
          return;
        }
        throw error;
      }
      if (parsed.packet_device_uid !== this.uid) return;
      recorder.onFrame(parsed);
      this.remember();
    } else if (record.source === 'control') {
      const result = controlResult(record.payload, this.chunks);
      // Firmware replies say `cmd`; the Gateway relays it as `command` (both accepted).
      if (result && (pyStrOr(result.command) || pyStrOr(result.cmd)) === 'app_events') recorder.onAppEventsResult(result);
    } else {
      let event: unknown;
      try {
        event = parsePyJson(utf8Decode(record.payload));
      } catch {
        return;
      }
      if (!isDict(event)) return;
      switch (event.type) {
        case 'start':
          this.setEnabled(true);
          break;
        case 'stop':
          this.setEnabled(false);
          break;
        case 'shutdown':
          recorder.shutdown();
          break;
        case 'knowledge': {
          this.knowledge = knowledgeFromEvent(event, this.knowledge);
          if (event.status_update === true) recorder.onDeviceStatus();
          break;
        }
        case 'app_events_request': {
          try {
            recorder.noteAppEventsRequest(pyStrOr(event.request_id), pyIntOf(event.since));
          } catch {
            // malformed: ignored
          }
          break;
        }
        default:
          break;
      }
    }
    this.remember();
  }

  finish(options: NhrawFinishOptions = {}): ConvertRawResult {
    if (!this.finished) {
      this.finished = true;
      if (this.drain !== null) this.fireDrainUpTo(this.drain.atUs);
      this.remember();
      if (options.closeOpen) this.recorder.shutdown();
      this.remember();
    }
    return {
      paths: this.paths,
      files: this.memory ? new Map(this.memory.files) : new Map(),
      truncated: options.truncated ?? false,
      skippedPackets: this.skipped,
    };
  }
}

/**
 * Reads a `.nhraw` from consecutive chunks (any sizes): push() returns the
 * records completed by each chunk, end() says whether the file stopped
 * inside a record. Throws as readNhraw() does on a bad header.
 */
export class NhrawStreamReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private headerValue: NhrawHeader | null = null;
  private headerLen = 0;

  /** The header, once enough bytes arrived. */
  get header(): NhrawHeader | null {
    return this.headerValue;
  }

  push(chunk: Uint8Array): NhrawRecord[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer, 0);
    joined.set(chunk, this.buffer.length);
    let bytes = joined;
    if (this.headerValue === null) {
      if (bytes.length < 8) {
        this.buffer = bytes;
        return [];
      }
      if (NHRAW_MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('nhraw_bad_magic');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getUint16(4, true) !== NHRAW_VERSION) throw new Error('nhraw_unsupported_version');
      const headerLen = view.getUint16(6, true);
      if (headerLen < NHRAW_HEADER_LEN) throw new Error('nhraw_bad_header');
      if (bytes.length < headerLen) {
        this.buffer = bytes;
        return [];
      }
      this.headerValue = readNhraw(bytes.subarray(0, headerLen)).header;
      this.headerLen = headerLen;
      bytes = bytes.subarray(headerLen);
    }
    const records: NhrawRecord[] = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    while (bytes.length - offset >= 4) {
      const length = view.getUint32(offset, true);
      if (length < NHRAW_RECORD_FIXED) {
        // Corrupt length: nothing after it can be trusted; keep it so end() reports truncation.
        break;
      }
      if (offset + 4 + length > bytes.length) break;
      const source = SOURCE_NAMES[bytes[offset + 12]!];
      if (source !== undefined) {
        records.push({
          rxEpochUs: getInt64(view, offset + 4),
          source,
          // A copy: the buffer is reused for the next chunk.
          payload: bytes.slice(offset + 13, offset + 4 + length),
        });
      }
      offset += 4 + length;
    }
    this.buffer = bytes.slice(offset);
    return records;
  }

  /** Whether bytes were left over (a record cut short, or a corrupt length). Throws if the header never completed. */
  end(): { truncated: boolean } {
    if (this.headerValue === null) throw new Error(this.buffer.length < 8 ? 'nhraw_bad_magic' : 'nhraw_bad_header');
    return { truncated: this.buffer.length > 0 };
  }

  /** Header length in bytes (0 before it is known). */
  get headerBytes(): number {
    return this.headerLen;
  }
}

function deviceForCount(knowledge: DeviceKnowledge): Record<string, unknown> {
  const device = knowledge.device ?? {};
  return isDict(device.last_status) ? device : { ...device, last_status: knowledge.status ?? {} };
}

function knowledgeFromEvent(event: Record<string, unknown>, previous: DeviceKnowledge): DeviceKnowledge {
  const next: DeviceKnowledge = { ...previous };
  if (isDict(event.device)) next.device = event.device;
  if (isDict(event.status)) next.status = event.status;
  if (typeof event.nickname === 'string') next.nickname = event.nickname;
  if (typeof event.group === 'string') next.group = event.group;
  if (typeof event.relay_client_type === 'string') next.relayClientType = event.relay_client_type;
  if (event.local_relay === 'studio' || event.local_relay === 'pocket' || event.local_relay === null) next.localRelay = event.local_relay;
  if (typeof event.local_relay_id === 'string' || event.local_relay_id === null) next.localRelayId = event.local_relay_id;
  return next;
}

/** A control datagram's `result` payload (as _handle_udp_control_datagram builds it), joining chunked replies. */
function controlResult(
  payload: Uint8Array,
  chunks: Map<string, { total: number; parts: Map<number, string> }>,
): Record<string, unknown> | null {
  let frame: unknown;
  try {
    frame = parsePyJson(utf8Decode(payload).trim());
  } catch {
    return null;
  }
  if (!isDict(frame)) return null;
  if (frame.type === 'result_chunk') {
    const requestId = pyStrOr(frame.request_id);
    let index: number;
    let total: number;
    try {
      index = pyIntOf(frame.chunk);
      total = pyIntOf(frame.chunks);
    } catch {
      return null;
    }
    if (!requestId || total <= 0 || index < 0 || index >= total || typeof frame.data !== 'string') return null;
    let buffer = chunks.get(requestId);
    if (!buffer || buffer.total !== total) {
      buffer = { total, parts: new Map() };
      chunks.set(requestId, buffer);
    }
    buffer.parts.set(index, frame.data);
    if (buffer.parts.size < total) return null;
    chunks.delete(requestId);
    let assembled = '';
    for (let i = 0; i < total; i++) assembled += buffer.parts.get(i)!;
    let inner: unknown;
    try {
      inner = parsePyJson(assembled);
    } catch {
      return null;
    }
    if (!isDict(inner)) return null;
    frame = { type: 'result', request_id: requestId, payload: inner };
  }
  const outer = frame as Record<string, unknown>;
  if (outer.type !== 'result') return null;
  const data: Record<string, unknown> = isDict(outer.payload) ? { ...outer.payload } : {};
  if (!('request_id' in data)) data.request_id = outer.request_id ?? '';
  return data;
}
