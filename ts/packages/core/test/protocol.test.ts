import { describe, expect, it } from 'vitest';

import { hexToBytes, utf8Decode, utf8Encode } from '../src/bytes';
import {
  decodeJsonLine,
  encodeCommandLine,
  isHeartbeatPacket,
  isStreamPacket,
  looseDeviceUid,
  normalizeDeviceUid,
  packetDeviceUid,
} from '../src/protocol';
import { FLAG_HEARTBEAT } from '../src/wire';
import { hasFixtures, readFixture } from './fixtures';

function v3(payloadLen: number, flags: number, frameId: number, ts: number, extra = payloadLen): Uint8Array {
  const packet = new Uint8Array(20 + extra);
  const view = new DataView(packet.buffer);
  view.setUint16(0, 0xa55a, true);
  packet[2] = 3;
  packet[3] = flags;
  packet.set(hexToBytes('3CDC7545CCD0'), 4);
  view.setUint32(10, frameId, true);
  view.setUint32(14, ts, true);
  view.setUint16(18, payloadLen, true);
  return packet;
}

function v5(payloadLen: number, flags: number, frameId: number, ts: number, extra = payloadLen): Uint8Array {
  const packet = new Uint8Array(24 + extra);
  const view = new DataView(packet.buffer);
  view.setUint16(0, 0xa55a, true);
  packet[2] = 5;
  packet[3] = flags;
  packet.set(hexToBytes('9CCC01E2BD2C'), 4);
  view.setUint32(10, frameId, true);
  view.setBigUint64(14, BigInt(ts), true);
  view.setUint16(22, payloadLen, true);
  return packet;
}

describe('command line envelope', () => {
  it('encodes with the NHO/Arduino/1 envelope', () => {
    const line = encodeCommandLine({ command: 'check_update', request_id: 'req-1' });
    expect(line[line.length - 1]).toBe(0x0a);
    const decoded = decodeJsonLine(line);
    expect(decoded.protocol).toBe('NHO/Arduino/1');
    expect(decoded.command).toBe('check_update');
    expect(decoded.request_id).toBe('req-1');
  });

  it('rejects a foreign protocol', () => {
    expect(() => decodeJsonLine(utf8Encode('{"protocol":"NHCP/1","command":"status"}\n'))).toThrow('unsupported_protocol');
  });

  // Byte-identity with Python json.dumps(separators=(",", ":"), sort_keys=True), ensure_ascii on.
  it('matches Python json.dumps bytes: sorted keys at every level, ASCII escapes', () => {
    const line = encodeCommandLine({ z: 1, a: { y: [1, 'x'], b: null }, name: 'café 研究 😀\u007f', '10': true, '2': false });
    expect(utf8Decode(line)).toBe(
      '{"10":true,"2":false,"a":{"b":null,"y":[1,"x"]},"name":"caf\\u00e9 \\u7814\\u7a76 \\ud83d\\ude00\\u007f","protocol":"NHO/Arduino/1","z":1}\n',
    );
  });

  it('lets a payload protocol override the default and accepts a null payload', () => {
    expect(utf8Decode(encodeCommandLine({ protocol: 'X' }))).toBe('{"protocol":"X"}\n');
    expect(utf8Decode(encodeCommandLine(null))).toBe('{"protocol":"NHO/Arduino/1"}\n');
  });

  it('decodes strings, strips Python whitespace and can skip the protocol check', () => {
    expect(decodeJsonLine('\x1c {"protocol":"NHO/Arduino/1","a":1}\r\n').a).toBe(1);
    expect(decodeJsonLine('{"a":1}', false)).toEqual({ a: 1 });
    expect(() => decodeJsonLine('[1]')).toThrow();
    expect(() => decodeJsonLine('{not json')).toThrow();
  });

  it('rejects malformed UTF-8 like bytes.decode does', () => {
    const good = utf8Encode('{"protocol":"NHO/Arduino/1","n":"x"}');
    const bad = Uint8Array.from([...good.subarray(0, 32), 0xff, ...good.subarray(32)]);
    expect(() => decodeJsonLine(bad)).toThrow();
    const surrogate = Uint8Array.from([...good.subarray(0, 32), 0xed, 0xa0, 0x80, ...good.subarray(32)]);
    expect(() => decodeJsonLine(surrogate)).toThrow();
    const overlong = Uint8Array.from([...good.subarray(0, 32), 0xc0, 0xaf, ...good.subarray(32)]);
    expect(() => decodeJsonLine(overlong)).toThrow();
  });
});

describe('stream packets', () => {
  it('identifies a v3 stream packet', () => {
    const packet = v3(4, 0, 1, 2);
    expect(isStreamPacket(packet)).toBe(true);
    expect(packetDeviceUid(packet)).toBe('3CDC7545CCD0');
    packet[2] = 2;
    expect(isStreamPacket(packet)).toBe(false);
  });

  it('identifies a v3 heartbeat packet', () => {
    const packet = v3(0, FLAG_HEARTBEAT, 9, 5000);
    expect(isStreamPacket(packet)).toBe(true);
    expect(isHeartbeatPacket(packet)).toBe(true);
    expect(packetDeviceUid(packet)).toBe('3CDC7545CCD0');
    expect(isHeartbeatPacket(v3(4, 0, 10, 5010))).toBe(false);
  });

  it('identifies v5 stream and heartbeat packets', () => {
    const stream = v5(6, 0, 1, 1_725_000_000_000);
    expect(isStreamPacket(stream)).toBe(true);
    expect(isHeartbeatPacket(stream)).toBe(false);
    expect(packetDeviceUid(stream)).toBe('9CCC01E2BD2C');
    const heartbeat = v5(0, FLAG_HEARTBEAT, 2, 1_725_000_000_005);
    expect(isStreamPacket(heartbeat)).toBe(true);
    expect(isHeartbeatPacket(heartbeat)).toBe(true);
  });

  it('rejects truncated payloads, bad magic and short headers', () => {
    expect(isStreamPacket(v5(6, 0, 1, 1, 5))).toBe(false);
    expect(packetDeviceUid(v5(6, 0, 1, 1, 5))).toBe('');
    const badMagic = v3(0, 0, 1, 1);
    badMagic[0] = 0;
    expect(isStreamPacket(badMagic)).toBe(false);
    // A v5 header needs 24 bytes even though the v3 minimum is 20.
    expect(isStreamPacket(v5(0, 0, 1, 1).subarray(0, 22))).toBe(false);
    expect(isStreamPacket(new Uint8Array(0))).toBe(false);
  });

  it('works on a subarray view (non-zero byteOffset)', () => {
    const packet = v3(4, 0, 1, 2);
    const backing = new Uint8Array(packet.length + 3);
    backing.set(packet, 3);
    expect(packetDeviceUid(backing.subarray(3))).toBe('3CDC7545CCD0');
  });

  it('loose UID only needs magic and 10 bytes (main.py routes on it)', () => {
    const truncated = v5(6, 0, 1, 1, 0).subarray(0, 10);
    expect(packetDeviceUid(truncated)).toBe('');
    expect(looseDeviceUid(truncated)).toBe('9CCC01E2BD2C');
    expect(looseDeviceUid(truncated.subarray(0, 9))).toBe('');
    const future = v5(0, 0, 1, 1);
    future[2] = 9;
    expect(looseDeviceUid(future)).toBe('9CCC01E2BD2C');
    expect(looseDeviceUid(Uint8Array.from([0x7b, ...new Uint8Array(11)]))).toBe('');
  });
});

describe('normalizeDeviceUid', () => {
  it('strips separators, uppercases and treats all-zero as none', () => {
    expect(normalizeDeviceUid('3c:dc-75 45cc:d0')).toBe('3CDC7545CCD0');
    expect(normalizeDeviceUid(' 3cdc7545ccd0\n')).toBe('3CDC7545CCD0');
    expect(normalizeDeviceUid('00:00:00:00:00:00')).toBe('');
    expect(normalizeDeviceUid(null)).toBe('');
    expect(normalizeDeviceUid('')).toBe('');
    expect(normalizeDeviceUid(0)).toBe('');
    expect(normalizeDeviceUid(123)).toBe('123');
  });
});

type PacketFixture = { packets: { name: string; hex: string; expect: { device_uid: string } }[] };

describe.skipIf(!hasFixtures)('firmware packet fixtures', () => {
  it('recognises every packet the firmware encoder built', () => {
    const fixture = readFixture<PacketFixture>('packets.json');
    expect(fixture.packets.length).toBeGreaterThanOrEqual(5);
    for (const c of fixture.packets) {
      const packet = hexToBytes(c.hex);
      expect(isStreamPacket(packet), c.name).toBe(true);
      expect(isHeartbeatPacket(packet), c.name).toBe(false);
      expect(packetDeviceUid(packet), c.name).toBe(c.expect.device_uid);
      expect(looseDeviceUid(packet), c.name).toBe(c.expect.device_uid);
    }
  });
});
