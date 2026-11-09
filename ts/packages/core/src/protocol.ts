// Stream-packet recognition and the NHO/Arduino/1 JSON envelope
// (arduino_protocol.py, local_device.py, udp_control.py). The Gateway never
// decodes sensor data: it only recognises a packet and reads its device UID.
import { bytesToHex, utf8Decode, utf8Encode } from './bytes';
import { isPlainObject, pyJsonDumpsCompactSorted, pyStr, pyStrip, pyTruthy } from './py';
import { FLAG_HEARTBEAT, HEADER_LEN_V5, PACKET_MAGIC, PACKET_VERSION_V5, PROTOCOL } from './wire';

// v3/v4 are frozen history (not in wire.json); a device on old firmware still sends them.
export const PACKET_VERSION_V3 = 3;
export const PACKET_VERSION_V4 = 4;
export const HEADER_LEN_V3 = 20;
export const HEADER_LEN_V4 = 24;

type Header = { flags: number; headerLen: number; payloadLen: number };

/** Header fields, or null when the bytes are not a v3/v4/v5 header. */
function readHeader(packet: Uint8Array): Header | null {
  if (packet.length < HEADER_LEN_V3) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const magic = view.getUint16(0, true);
  const version = packet[2]!;
  const flags = packet[3]!;
  let headerLen: number;
  let payloadLenOffset: number;
  if (version === PACKET_VERSION_V3) {
    headerLen = HEADER_LEN_V3;
    payloadLenOffset = 18; // <IIH at 10
  } else if (version === PACKET_VERSION_V4 || version === PACKET_VERSION_V5) {
    headerLen = HEADER_LEN_V5; // == HEADER_LEN_V4
    payloadLenOffset = 22; // <IQH at 10
  } else {
    return null;
  }
  if (magic !== PACKET_MAGIC || packet.length < headerLen) return null;
  return { flags, headerLen, payloadLen: view.getUint16(payloadLenOffset, true) };
}

/** is_arduino_stream_packet: a complete v3/v4/v5 packet (header + declared payload). */
export function isStreamPacket(packet: Uint8Array): boolean {
  const header = readHeader(packet);
  return header !== null && packet.length >= header.headerLen + header.payloadLen;
}

/** is_arduino_heartbeat_packet: heartbeat flag set and no payload. */
export function isHeartbeatPacket(packet: Uint8Array): boolean {
  const header = readHeader(packet);
  return header !== null && (header.flags & FLAG_HEARTBEAT) !== 0 && header.payloadLen === 0;
}

/** arduino_protocol.packet_device_uid: the UID of a complete stream packet, else ''. */
export function packetDeviceUid(packet: Uint8Array): string {
  if (!isStreamPacket(packet)) return '';
  return bytesToHex(packet.subarray(4, 10));
}

/**
 * local_device.packet_device_uid: only magic and length >= 10 checked. This is
 * what main.py routes on, so a truncated or future-version packet still
 * reaches its device's session; keep it loose.
 */
export function looseDeviceUid(packet: Uint8Array): string {
  if (packet.length < 10) return '';
  const magic = packet[0]! | (packet[1]! << 8);
  if (magic !== PACKET_MAGIC) return '';
  return bytesToHex(packet.subarray(4, 10));
}

/** udp_control.normalize_device_uid: '3c:dc-75 45ccd0' -> '3CDC7545CCD0'; all-zero means none. */
export function normalizeDeviceUid(value: unknown): string {
  const raw = pyTruthy(value) ? pyStr(value) : '';
  const uid = pyStrip(raw.replace(/[:\- ]/g, '')).toUpperCase();
  if (!uid || uid === '000000000000') return '';
  return uid;
}

/**
 * One command line for a device: {"protocol": ..., ...payload} as compact,
 * key-sorted, ASCII-escaped JSON plus '\n', byte for byte what the Python
 * Gateway sent. A `protocol` key in the payload overrides the default, as in Python.
 */
export function encodeCommandLine(payload: Record<string, unknown> | null | undefined): Uint8Array {
  const message: Record<string, unknown> = { protocol: PROTOCOL, ...(payload ?? {}) };
  return utf8Encode(`${pyJsonDumpsCompactSorted(message)}\n`);
}

/**
 * Parse one JSON line from a device. Throws on invalid UTF-8, invalid JSON
 * and (with requireProtocol) a missing or foreign protocol ('unsupported_protocol').
 * With requireProtocol=false the value is returned as parsed, object or not,
 * as Python did.
 */
export function decodeJsonLine(payload: Uint8Array | string, requireProtocol = true): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : strictUtf8Decode(payload);
  const data: unknown = JSON.parse(pyStrip(text));
  if (requireProtocol) {
    // Python's data.get() raised AttributeError on a non-object; callers only see "it threw".
    if (!isPlainObject(data)) throw new Error('unsupported_protocol');
    if (data.protocol !== PROTOCOL) throw new Error('unsupported_protocol');
  }
  return data as Record<string, unknown>;
}

/** bytes.decode('utf-8') raises on malformed input; utf8Decode replaces instead. */
function strictUtf8Decode(bytes: Uint8Array): string {
  const text = utf8Decode(bytes);
  // Lone surrogates come from encoded surrogates (ED A0..BF xx), which strict UTF-8 rejects.
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) throw new Error('invalid utf-8');
  }
  const again = utf8Encode(text);
  if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i])) throw new Error('invalid utf-8');
  return text;
}
