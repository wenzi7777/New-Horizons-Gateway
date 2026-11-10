// packet_parser.py: NHO/Arduino/1 binary stream packets (v2-v5) into the
// visualization payload the Desktop backend builds, field for field. The
// numbers are what Python produces: each float32 widened to a double, then
// round(value, 6) (pyNumber.ts), so CSV rows written from this match the
// Python backend's byte for byte.
import { pyStrip } from '../../../core/src/py';
import {
  APP_EVENT_FLAG_VALUE,
  BATTERY_BYTES_V5,
  EXT_APP_EVENT,
  FLAG_BATTERY,
  FLAG_EPOCH_VALID,
  FLAG_EXTENSIONS,
  FLAG_IMU,
  FLAG_MAG,
  FLAG_RAW_ADC,
  IMU_BYTES,
  MAG_BYTES,
  PACKET_MAGIC,
  PACKET_VERSION_V5,
} from '../../../core/src/wire';
import { utf8Decode, utf8Encode } from '../../../core/src/bytes';
import { boardProfileForHardwareModel, normalizeHardwareModel } from './boardProfile';
import { pyRound } from './pyNumber';
import { isDict, PyFloat, pyIntOf as pyInt, pyStrOr, pyTruthyOf as pyTruthy } from './pyJson';

export const HEADER_LEN = 20;
export const HEADER_LEN_V4 = 24;
export const PACKET_VERSION = 2;
export const ARDUINO_PACKET_VERSION = 3;
export const ARDUINO_PACKET_VERSION_V4 = 4;
export const ARDUINO_PACKET_VERSION_V5 = PACKET_VERSION_V5;
export const BATTERY_BYTES = 4;
const APP_EVENT_FIXED_SIZE = 13; // <IIIB: seq, frame_seq, uptime_ms, flags

export type PacketParseErrorCode =
  | 'packet_too_short'
  | 'invalid_magic'
  | 'unsupported_version'
  | 'invalid_device_uid'
  | 'truncated_payload'
  | 'invalid_payload_layout'
  | 'invalid_extension_layout'
  | 'sensor_count_ambiguous'
  | 'sensor_count_required_for_extensions'
  | 'sensor_count_out_of_range';

export class PacketParseError extends Error {
  constructor(readonly code: PacketParseErrorCode) {
    super(code);
    this.name = 'PacketParseError';
  }
}

/** One app_event TLV, in the shape the `app_events` command reports. */
export type AppEvent = {
  seq: number;
  frame_seq: number;
  ms: number;
  app: string;
  event: string;
  detail: string;
  /** round(float32, 3); absent when the event carries no value. */
  value?: number;
};

export type ParsedImu = {
  acc?: number[];
  gyro?: number[];
  temperature_c?: number;
  mag?: number[];
};

export type ParsedBattery = {
  status: number;
  fault: number;
  vbat_mv: number;
  soc_centi_percent?: number;
  /** A Python float (soc_centi_percent / 100.0). */
  soc_percent?: number;
};

/**
 * parse_binary_packet()'s dict. Every number in p / raw_adc / acc / gyro /
 * mag / imu.temperature_c / ts / battery.soc_percent / app event value is a
 * Python float; every other number is a Python int.
 */
export type ParsedPacket = {
  protocol: 'NHO/Arduino/1' | 'NewHorizons/Binary/2';
  dn: string;
  device_uid: string;
  device_id: string;
  packet_device_uid: string;
  packet_version: number;
  frame_id: number;
  timestamp_ms: number;
  ts: number;
  sn: number;
  p: number[];
  raw_adc: number[] | null;
  acc: number[] | null;
  gyro: number[] | null;
  mag: number[] | null;
  imu: ParsedImu | null;
  battery: ParsedBattery | null;
  extensions: { type: number; hex: string }[];
  app_events: AppEvent[];
  flags: number;
  device_epoch_ms?: number;
};

type Extension = { type: number; value: Uint8Array };

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function lowerHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** bytes.decode('utf-8') (strict): null where Python raises UnicodeDecodeError. */
function strictUtf8(bytes: Uint8Array): string | null {
  const text = utf8Decode(bytes);
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) return null;
  }
  const again = utf8Encode(text);
  if (again.length !== bytes.length) return null;
  for (let i = 0; i < again.length; i++) if (again[i] !== bytes[i]) return null;
  return text;
}

export function inferSensorCount(flags: number, payloadLen: number, version: number = ARDUINO_PACKET_VERSION): number {
  let matrixBytes = payloadLen;
  if (flags & FLAG_IMU) matrixBytes -= IMU_BYTES;
  if (flags & FLAG_MAG) matrixBytes -= MAG_BYTES;
  if (flags & FLAG_BATTERY) matrixBytes -= version === ARDUINO_PACKET_VERSION_V5 ? BATTERY_BYTES_V5 : BATTERY_BYTES;
  // With raw ADC streaming the matrix region holds two float arrays.
  const bytesPerSensor = flags & FLAG_RAW_ADC ? 8 : 4;
  if (matrixBytes < 0 || matrixBytes % bytesPerSensor !== 0) throw new PacketParseError('invalid_payload_layout');
  return matrixBytes / bytesPerSensor;
}

function parseExtensions(payload: Uint8Array): Extension[] {
  const extensions: Extension[] = [];
  let offset = 0;
  while (offset < payload.length) {
    if (payload.length - offset < 2) throw new PacketParseError('invalid_extension_layout');
    const type = payload[offset]!;
    const length = payload[offset + 1]!;
    offset += 2;
    const end = offset + length;
    if (end > payload.length) throw new PacketParseError('invalid_extension_layout');
    extensions.push({ type, value: payload.subarray(offset, end) });
    offset = end;
  }
  return extensions;
}

/** decode_app_event: an app_event TLV value, or null when it is not exactly one. */
export function decodeAppEvent(value: Uint8Array): AppEvent | null {
  if (value.length < APP_EVENT_FIXED_SIZE) return null;
  const view = viewOf(value);
  const seq = view.getUint32(0, true);
  const frameSeq = view.getUint32(4, true);
  const uptimeMs = view.getUint32(8, true);
  const eventFlags = value[12]!;
  let offset = APP_EVENT_FIXED_SIZE;
  let number: number | null = null;
  if (eventFlags & APP_EVENT_FLAG_VALUE) {
    if (value.length < offset + 4) return null;
    // app_events prints the value with three decimals; match it.
    number = pyRound(view.getFloat32(offset, true), 3);
    offset += 4;
  }
  const texts: string[] = [];
  for (let i = 0; i < 3; i++) {
    if (offset >= value.length) return null;
    const length = value[offset]!;
    offset += 1;
    if (offset + length > value.length) return null;
    const text = strictUtf8(value.subarray(offset, offset + length));
    if (text === null) return null;
    texts.push(text);
    offset += length;
  }
  if (offset !== value.length) return null;
  const event: AppEvent = { seq, frame_seq: frameSeq, ms: uptimeMs, app: texts[0]!, event: texts[1]!, detail: texts[2]! };
  if (number !== null) event.value = number;
  return event;
}

function extensionsAreKnown(extensions: Extension[]): boolean {
  return extensions.length > 0 && extensions.every((item) => item.type === EXT_APP_EVENT && decodeAppEvent(item.value) !== null);
}

function v5FixedTrailerLen(flags: number): number {
  return (flags & FLAG_IMU ? IMU_BYTES : 0) + (flags & FLAG_MAG ? MAG_BYTES : 0) + (flags & FLAG_BATTERY ? BATTERY_BYTES_V5 : 0);
}

/**
 * Without the matrix shape the extensions' start is unknown: try each sensor
 * count and keep the one whose tail is exactly well-formed known TLVs.
 */
function inferSensorCountWithExtensions(flags: number, payload: Uint8Array): number {
  const perSensor = flags & FLAG_RAW_ADC ? 8 : 4;
  const fixed = v5FixedTrailerLen(flags);
  const candidates: number[] = [];
  for (let count = Math.max(0, Math.floor((payload.length - fixed) / perSensor)); count >= 0; count--) {
    const start = count * perSensor + fixed;
    if (start >= payload.length) continue;
    let extensions: Extension[];
    try {
      extensions = parseExtensions(payload.subarray(start));
    } catch (error) {
      if (error instanceof PacketParseError) continue;
      throw error;
    }
    if (extensionsAreKnown(extensions)) {
      candidates.push(count);
      if (candidates.length > 1) throw new PacketParseError('sensor_count_ambiguous');
    }
  }
  if (candidates.length === 0) throw new PacketParseError('sensor_count_required_for_extensions');
  return candidates[0]!;
}

function splitV5Extensions(flags: number, payload: Uint8Array, sensorCount: number | null): [Uint8Array, Extension[]] {
  if (!(flags & FLAG_EXTENSIONS)) return [payload, []];
  const count = sensorCount ?? inferSensorCountWithExtensions(flags, payload);
  const baseLen = count * (flags & FLAG_RAW_ADC ? 8 : 4) + v5FixedTrailerLen(flags);
  if (baseLen > payload.length) throw new PacketParseError('sensor_count_out_of_range');
  // Python slicing clamps a negative end at 0 from the end; counts are >= 0 here.
  return [payload.subarray(0, baseLen), parseExtensions(payload.subarray(baseLen))];
}

function floats(view: DataView, offset: number, count: number): number[] {
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = pyRound(view.getFloat32(offset + i * 4, true), 6);
  return out;
}

/**
 * parse_binary_packet(payload, sensor_count, device_uid). Throws
 * PacketParseError with Python's error code.
 */
export function parseBinaryPacket(packet: Uint8Array, sensorCount: number | null = null, deviceUid: string | null = null): ParsedPacket {
  if (packet.length < HEADER_LEN) throw new PacketParseError('packet_too_short');
  const view = viewOf(packet);
  const magic = view.getUint16(0, true);
  const version = packet[2]!;
  const flags = packet[3]!;
  if (magic !== PACKET_MAGIC) throw new PacketParseError('invalid_magic');
  if (version !== PACKET_VERSION && version !== ARDUINO_PACKET_VERSION && version !== ARDUINO_PACKET_VERSION_V4 && version !== ARDUINO_PACKET_VERSION_V5) {
    throw new PacketParseError('unsupported_version');
  }
  const packetDeviceUid = lowerHex(packet.subarray(4, 10)).toUpperCase();

  let epochMs: number | null = null;
  let headerLen: number;
  let frameId: number;
  let timestampMs: number;
  let payloadLen: number;
  if (version === ARDUINO_PACKET_VERSION_V4 || version === ARDUINO_PACKET_VERSION_V5) {
    if (packet.length < HEADER_LEN_V4) throw new PacketParseError('packet_too_short');
    headerLen = HEADER_LEN_V4;
    frameId = view.getUint32(10, true);
    // u64 as two u32 halves (no BigInt DataView on every Hermes); one rounding, as float(int) would.
    timestampMs = view.getUint32(18, true) * 4294967296 + view.getUint32(14, true);
    payloadLen = view.getUint16(22, true);
    if (flags & FLAG_EPOCH_VALID) epochMs = timestampMs;
  } else {
    headerLen = HEADER_LEN;
    frameId = view.getUint32(10, true);
    timestampMs = view.getUint32(14, true);
    payloadLen = view.getUint16(18, true);
  }

  const expectedLen = headerLen + payloadLen;
  if (packet.length < expectedLen) throw new PacketParseError('truncated_payload');

  const body = packet.subarray(headerLen, expectedLen);
  const [basePayload, extensions] = version === ARDUINO_PACKET_VERSION_V5 ? splitV5Extensions(flags, body, sensorCount) : [body, []];
  const basePayloadLen = basePayload.length;
  const count = sensorCount ?? inferSensorCount(flags, basePayloadLen, version);

  const matrixEnd = headerLen + count * 4;
  const baseExpectedLen = headerLen + basePayloadLen;
  if (matrixEnd > baseExpectedLen) throw new PacketParseError('sensor_count_out_of_range');
  const matrix = count ? floats(view, headerLen, count) : [];
  let offset = matrixEnd;

  let rawAdc: number[] | null = null;
  if (flags & FLAG_RAW_ADC) {
    const rawEnd = offset + count * 4;
    if (rawEnd > baseExpectedLen) throw new PacketParseError('sensor_count_out_of_range');
    rawAdc = count ? floats(view, offset, count) : [];
    offset = rawEnd;
  }

  let imu: ParsedImu | null = null;
  let acc: number[] | null = null;
  let gyro: number[] | null = null;
  if (flags & FLAG_IMU) {
    if (offset + IMU_BYTES > baseExpectedLen) throw new PacketParseError('invalid_payload_layout');
    acc = floats(view, offset, 3);
    gyro = floats(view, offset + 12, 3);
    imu = { acc, gyro, temperature_c: pyRound(view.getFloat32(offset + 24, true), 6) };
    offset += IMU_BYTES;
  }

  let mag: number[] | null = null;
  if (flags & FLAG_MAG) {
    if (offset + MAG_BYTES > baseExpectedLen) throw new PacketParseError('invalid_payload_layout');
    mag = floats(view, offset, 3);
    offset += MAG_BYTES;
    if (imu === null) imu = {};
    imu.mag = mag;
  }

  let battery: ParsedBattery | null = null;
  if (flags & FLAG_BATTERY) {
    const batteryBytes = version === ARDUINO_PACKET_VERSION_V5 ? BATTERY_BYTES_V5 : BATTERY_BYTES;
    if (offset + batteryBytes > baseExpectedLen) throw new PacketParseError('invalid_payload_layout');
    battery = { status: packet[offset]!, fault: packet[offset + 1]!, vbat_mv: view.getUint16(offset + 2, true) };
    if (version === ARDUINO_PACKET_VERSION_V5) {
      const soc = view.getUint16(offset + 4, true);
      battery.soc_centi_percent = soc;
      battery.soc_percent = soc / 100.0;
    }
    offset += batteryBytes;
  }

  if (offset !== baseExpectedLen) throw new PacketParseError('invalid_payload_layout');

  const dn = deviceUid || packetDeviceUid;
  const appEvents: AppEvent[] = [];
  for (const item of extensions) {
    if (item.type !== EXT_APP_EVENT) continue;
    const event = decodeAppEvent(item.value);
    if (event !== null) appEvents.push(event);
  }
  const result: ParsedPacket = {
    protocol: version === PACKET_VERSION ? 'NewHorizons/Binary/2' : 'NHO/Arduino/1',
    dn,
    device_uid: dn,
    device_id: dn,
    packet_device_uid: packetDeviceUid,
    packet_version: version,
    frame_id: frameId,
    timestamp_ms: timestampMs,
    ts: timestampMs / 1000.0,
    sn: count,
    p: matrix,
    raw_adc: rawAdc,
    acc,
    gyro,
    mag,
    imu,
    battery,
    extensions: extensions.map((item) => ({ type: item.type, hex: lowerHex(item.value) })),
    app_events: appEvents,
    flags,
  };
  if (epochMs !== null) result.device_epoch_ms = epochMs;
  return result;
}

// ── Sensor count from what is known about the device (datagram_ingest.py) ──

function intList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    try {
      out.push(pyInt(item));
    } catch {
      continue;
    }
  }
  return out;
}

function matrixShapeTuple(value: unknown): [number, number] | null {
  if (!isDict(value)) return null;
  let rows: number;
  let cols: number;
  try {
    rows = pyInt(pyTruthy(value.rows) ? value.rows : 0);
    cols = pyInt(pyTruthy(value.cols) ? value.cols : 0);
  } catch {
    return null;
  }
  if (rows <= 0 || cols <= 0) return null;
  return [rows, cols];
}

const asDict = (value: unknown): Record<string, unknown> => (isDict(value) ? value : {});
const orElse = (a: unknown, b: unknown): unknown => (pyTruthy(a) ? a : b);

/**
 * _known_sensor_count_from_device: the matrix size a device entry (with its
 * last_status) implies, from its layout, its shape, or its board's defaults.
 */
export function knownSensorCountFromDevice(device: Record<string, unknown>): number | null {
  const status = asDict(device.last_status);
  for (const candidate of [status, device]) {
    const layout = asDict(candidate.matrix_layout);
    const rows = intList(orElse(layout.analog_pins, layout.active_rows));
    const cols = intList(orElse(layout.select_pins, layout.active_cols));
    if (rows.length && cols.length) return rows.length * cols.length;
    const shape = matrixShapeTuple(candidate.matrix_shape);
    if (shape !== null) return shape[0] * shape[1];
  }
  const model = orElse(status.hardware_model, device.hardware_model);
  const hardwareModel = pyStrip(pyStrOr(model));
  if (!hardwareModel) return null;
  const profile = boardProfileForHardwareModel(hardwareModel);
  if (normalizeHardwareModel(profile.hardware_model) !== normalizeHardwareModel(hardwareModel)) return null;
  const rows = intList(profile.default_analog_pins);
  const cols = intList(profile.default_select_pins);
  return rows.length && cols.length ? rows.length * cols.length : null;
}

/**
 * _v5_extension_sensor_count: only a v5 packet with extensions needs the
 * count up front; `lookupDevice` returns the device entry for a UID (or null).
 */
export function extensionSensorCount(
  packet: Uint8Array,
  lookupDevice: (deviceUid: string) => Record<string, unknown> | null | undefined,
): number | null {
  if (packet.length < 10 || packet[2] !== 5 || !(packet[3]! & 0x20)) return null;
  const uid = lowerHex(packet.subarray(4, 10)).toUpperCase();
  return knownSensorCountFromDevice(lookupDevice(uid) ?? {});
}

const floatList = (values: number[] | null | undefined) => (values ? values.map((v) => new PyFloat(v)) : values ?? null);

/**
 * The parsed packet with every Python float wrapped as a PyFloat, so
 * pyJsonDumps() writes it exactly as json.dumps() writes Python's dict
 * (e.g. the visualization payload a browser gets).
 */
export function parsedPacketToPy(packet: ParsedPacket): Record<string, unknown> {
  const imu = packet.imu
    ? {
        ...(packet.imu.acc ? { acc: floatList(packet.imu.acc) } : {}),
        ...(packet.imu.gyro ? { gyro: floatList(packet.imu.gyro) } : {}),
        ...(packet.imu.temperature_c !== undefined ? { temperature_c: new PyFloat(packet.imu.temperature_c) } : {}),
        ...(packet.imu.mag ? { mag: floatList(packet.imu.mag) } : {}),
      }
    : null;
  const battery = packet.battery
    ? {
        ...packet.battery,
        ...(packet.battery.soc_percent !== undefined ? { soc_percent: new PyFloat(packet.battery.soc_percent) } : {}),
      }
    : null;
  return {
    ...packet,
    ts: new PyFloat(packet.ts),
    p: floatList(packet.p),
    raw_adc: floatList(packet.raw_adc),
    acc: floatList(packet.acc),
    gyro: floatList(packet.gyro),
    mag: floatList(packet.mag),
    imu,
    battery,
    app_events: packet.app_events.map((event) => (event.value !== undefined ? { ...event, value: new PyFloat(event.value) } : event)),
  };
}
