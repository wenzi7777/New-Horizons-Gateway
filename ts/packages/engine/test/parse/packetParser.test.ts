import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hexToBytes } from '../../../core/src/bytes';
import {
  decodeAppEvent,
  extensionSensorCount,
  knownSensorCountFromDevice,
  PacketParseError,
  parseBinaryPacket,
  parsedPacketToPy,
} from '../../src/parse/packetParser';
import { pyJsonDumps } from '../../src/parse/pyJson';
import { hasFixtures, hasPython, OS_REPO, rng, runPython } from '../recording/pyHarness';
import { encodePacket, FLAG, toHex, type PacketSpec } from './packets';

type FixtureCase = {
  name: string;
  hex: string;
  expect: {
    flags: number;
    device_uid: string;
    sequence: number;
    epoch_valid: boolean;
    epoch_ms: number;
    point_count: number;
    matrix: number[];
    raw: number[] | null;
    imu: number[] | null;
    mag: number[] | null;
    app_events?: (Record<string, unknown> & { value: number | null })[];
    battery: Record<string, number> | null;
  };
};

const fixture = hasFixtures
  ? (JSON.parse(readFileSync(join(OS_REPO, 'spec/fixtures/packets.json'), 'utf-8')) as { packet_version: number; packets: FixtureCase[] })
  : { packet_version: 5, packets: [] };

describe.skipIf(!hasFixtures)('spec/fixtures/packets.json', () => {
  it.each(fixture.packets.map((c) => [c.name, c] as const))('%s parses to what it was built from', (_name, c) => {
    const parsed = parseBinaryPacket(hexToBytes(c.hex));
    const e = c.expect;
    expect(parsed.packet_version).toBe(fixture.packet_version);
    expect(parsed.flags).toBe(e.flags);
    expect(parsed.packet_device_uid).toBe(e.device_uid);
    expect(parsed.frame_id).toBe(e.sequence);
    expect(parsed.sn).toBe(e.point_count);
    expect(parsed.p).toEqual(e.matrix);
    expect(parsed.raw_adc).toEqual(e.raw);
    if (e.epoch_valid) expect(parsed.device_epoch_ms).toBe(e.epoch_ms);
    else expect(parsed.device_epoch_ms).toBeUndefined();
    if (e.imu === null) expect(parsed.acc).toBeNull();
    else {
      expect(parsed.acc).toEqual(e.imu.slice(0, 3));
      expect(parsed.gyro).toEqual(e.imu.slice(3, 6));
      expect(parsed.imu?.temperature_c).toBe(e.imu[6]);
    }
    expect(parsed.mag).toEqual(e.mag);
    if (e.battery === null) expect(parsed.battery).toBeNull();
    else {
      const { soc_percent: _soc, ...battery } = parsed.battery!;
      expect(battery).toEqual(e.battery);
    }
    const expectedEvents = (e.app_events ?? []).map((event) => {
      const { value, ...rest } = event;
      return value === null ? rest : { ...rest, value };
    });
    expect(parsed.app_events).toEqual(expectedEvents);
    expect(parsed.extensions.length).toBe(expectedEvents.length);
  });

  it('a packet with events parses with a known sensor count too', () => {
    const c = fixture.packets.find((p) => p.expect.app_events?.length)!;
    const parsed = parseBinaryPacket(hexToBytes(c.hex), c.expect.point_count);
    expect(parsed.app_events.map((event) => event.seq)).toEqual([3, 4]);
  });
});

describe('packetParser', () => {
  it('reports Python error codes', () => {
    const code = (bytes: Uint8Array, count: number | null = null) => {
      try {
        parseBinaryPacket(bytes, count);
        return 'ok';
      } catch (error) {
        return (error as PacketParseError).code;
      }
    };
    expect(code(new Uint8Array(10))).toBe('packet_too_short');
    expect(code(new Uint8Array(24))).toBe('invalid_magic');
    expect(code(encodePacket({ matrix: [1, 2], payloadLen: 40 }))).toBe('truncated_payload');
    expect(code(encodePacket({ matrix: [1, 2] }), 3)).toBe('sensor_count_out_of_range');
    expect(code(encodePacket({ matrix: [1, 2], trailing: [] , payloadLen: 7 }))).toBe('invalid_payload_layout');
    expect(code(encodePacket({ matrix: [1, 2], extraTlv: [9, 1, 0] }))).toBe('sensor_count_required_for_extensions');
  });

  it('decodes an app event TLV exactly or not at all', () => {
    const event = { seq: 1, frame_seq: 2, ms: 3, app: 'a', event: 'é', detail: '', value: 0.1 };
    const parsed = parseBinaryPacket(encodePacket({ matrix: [1], events: [event] }));
    expect(parsed.app_events).toEqual([{ ...event, value: 0.1 }]);
    expect(decodeAppEvent(new Uint8Array(12))).toBeNull();
  });

  it('infers the sensor count from the device entry or board profile', () => {
    expect(knownSensorCountFromDevice({ matrix_shape: { rows: 7, cols: 16 } })).toBe(112);
    expect(knownSensorCountFromDevice({ last_status: { matrix_layout: { analog_pins: [1, 2], select_pins: [3, 4, 5] } } })).toBe(6);
    expect(knownSensorCountFromDevice({ hardware_model: 'VD-CTL/R v1.5.F 2026.7' })).toBe(196);
    expect(knownSensorCountFromDevice({ hardware_model: 'TIA-CTL v1.0.F 2026.4' })).toBeNull();
    expect(knownSensorCountFromDevice({ hardware_model: 'something else' })).toBeNull();
    const packet = encodePacket({ matrix: [1, 2, 3, 4], events: [{ seq: 1, frame_seq: 1, ms: 1, app: 'x', event: 'y', detail: 'z' }] });
    expect(extensionSensorCount(packet, () => ({ matrix_shape: { rows: 2, cols: 2 } }))).toBe(4);
    expect(extensionSensorCount(encodePacket({ matrix: [1] }), () => ({ matrix_shape: { rows: 2, cols: 2 } }))).toBeNull();
  });
});

// ── Differential: the same packets through Python's parse_binary_packet ──

function specs(): { hex: string; sensor_count: number | null }[] {
  const random = rng(7);
  const f = () => (random() - 0.5) * 10 ** (Math.floor(random() * 10) - 4);
  const list = (n: number) => Array.from({ length: n }, f);
  const out: { hex: string; sensor_count: number | null }[] = [];
  const add = (spec: PacketSpec, count: number | null = null) => out.push({ hex: toHex(encodePacket(spec)), sensor_count: count });
  for (const version of [2, 3, 4, 5] as const) {
    for (const n of [0, 1, 4, 14, 112, 196]) {
      add({ version, matrix: list(n), frameId: n + 1, timestamp: 1792056866178 + n, flags: version >= 4 ? FLAG.EPOCH : 0 });
      add({ version, matrix: list(n), raw: list(n), imu: list(7), mag: list(3), battery: { status: 1, fault: 0, vbat_mv: 4012, soc_centi_percent: 7350 } });
      add({ version, matrix: list(n), mag: list(3) });
      add({ version, matrix: list(n), battery: { status: 2, fault: 3, vbat_mv: 3700, soc_centi_percent: 10000 } }, n);
    }
  }
  const events = [
    { seq: 5, frame_seq: 100, ms: 4000, app: 'flow1', event: 'slouch', detail: 'rise', value: 0.1 },
    { seq: 6, frame_seq: 100, ms: 4001, app: 'bal', event: 'tilt', detail: '', value: 1 },
    { seq: 7, frame_seq: 101, ms: 4002, app: '日本', event: 'é', detail: 'x' },
  ];
  add({ matrix: list(6), events, imu: list(7) });
  add({ matrix: list(6), events, imu: list(7) }, 6);
  add({ matrix: list(6), raw: list(6), events: events.slice(0, 1), battery: { status: 0, fault: 0, vbat_mv: 1, soc_centi_percent: 1 } });
  add({ matrix: list(3), events: events.slice(0, 1), extraTlv: [0x09, 0x02, 0xaa, 0xbb] }, 3);
  add({ matrix: list(3), events: events.slice(0, 1), extraTlv: [0x09, 0x02, 0xaa, 0xbb] });
  add({ matrix: list(3), extraTlv: [0x01, 0x05, 1, 2, 3, 4, 5] }, 3);
  add({ matrix: list(3), extraTlv: [0x01, 0x05, 1, 2] }, 3);
  // Exact float32 corner values.
  add({ matrix: [0.0078125, -0.0078125, 1e-7, -1e-7, 3.4e38, -0, NaN, Infinity, -Infinity, 0.1, 2 ** -149, 16777217] });
  // Fuzz: random bytes behind a valid header, random flags and lengths.
  for (let i = 0; i < 400; i++) {
    const version = ([2, 3, 4, 5, 6] as const)[Math.floor(random() * 5)]!;
    const n = Math.floor(random() * 40);
    const bytes = encodePacket({ version: version as 5, matrix: list(n), flags: Math.floor(random() * 256) & ~0x2f, frameId: Math.floor(random() * 2 ** 32) });
    // flip some bytes in the payload, maybe the flags too
    for (let k = 0; k < 3; k++) if (random() < 0.5 && bytes.length > 24) bytes[24 + Math.floor(random() * (bytes.length - 24))] = Math.floor(random() * 256);
    if (random() < 0.5) bytes[3] = Math.floor(random() * 256);
    const cut = random() < 0.2 ? bytes.subarray(0, Math.floor(random() * bytes.length)) : bytes;
    out.push({ hex: toHex(cut), sensor_count: random() < 0.3 ? Math.floor(random() * 50) : null });
  }
  return out;
}

describe.skipIf(!hasPython)('parse_binary_packet, differential', () => {
  const cases = specs();
  if (hasFixtures) for (const c of fixture.packets) cases.push({ hex: c.hex, sensor_count: null }, { hex: c.hex, sensor_count: c.expect.point_count });
  const py = runPython<({ ok: string } | { error: string })[]>('parse', { packets: cases });

  it(`${cases.length} packets give the same dict (json.dumps) or the same error`, () => {
    const mismatches: unknown[] = [];
    cases.forEach((c, i) => {
      let ts: { ok: string } | { error: string };
      try {
        ts = { ok: pyJsonDumps(parsedPacketToPy(parseBinaryPacket(hexToBytes(c.hex), c.sensor_count))) };
      } catch (error) {
        if (!(error instanceof PacketParseError)) throw error;
        ts = { error: error.code };
      }
      if (JSON.stringify(ts) !== JSON.stringify(py[i])) mismatches.push({ case: c, ts, py: py[i] });
    });
    expect(mismatches).toEqual([]);
    // Both outcomes are well represented (the fuzz is not all errors).
    const errors = new Set(py.flatMap((r) => ('error' in r ? [r.error] : [])));
    expect(py.filter((r) => 'ok' in r).length).toBeGreaterThan(150);
    expect(errors.size).toBeGreaterThanOrEqual(5);
  });
});
