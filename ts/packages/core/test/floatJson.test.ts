// Device floats survive the relay as they did through the Python Gateway's
// json.dumps(json.loads(frame)); and under offer_policy "managed" devices
// that are not ours are not relayed.
import { describe, expect, it } from 'vitest';

import { JsonFloat, parseJsonKeepFloats, pyFloatJsonRepr, stringifyKeepFloats } from '../src/floatJson';
import { DEVICE_ADDR, UID, heartbeatPacket, jsonFrame, makeRuntime, v5Packet } from './runtime/helpers';

describe('parseJsonKeepFloats / stringifyKeepFloats', () => {
  it('round-trips like Python json.dumps(json.loads(text), separators=(",", ":"))', () => {
    const text = '{"a":1.0,"b":1e16,"c":0.00001,"d":-0.0,"e":1.50,"f":2,"g":"x 1.0","h":[1.5e300,NaN,Infinity,-Infinity],"k":"q\\"1.0"}';
    // Captured from python3 (the same text, minus the ü / big-int cases JSON.parse never kept).
    expect(stringifyKeepFloats(parseJsonKeepFloats(text))).toBe(
      '{"a":1.0,"b":1e+16,"c":1e-05,"d":-0.0,"e":1.5,"f":2,"g":"x 1.0","h":[1.5e+300,NaN,Infinity,-Infinity],"k":"q\\"1.0"}',
    );
  });

  it('floats read as numbers; ints and float-free text are plain JSON', () => {
    const value = parseJsonKeepFloats('{"x":2.5,"n":[1,2]}') as { x: JsonFloat; n: number[] };
    expect(value.x).toBeInstanceOf(JsonFloat);
    expect(Number(value.x)).toBe(2.5);
    expect(JSON.stringify(value)).toBe('{"x":2.5,"n":[1,2]}');
    expect(parseJsonKeepFloats('{"n":[1,-2,"3.0"]}')).toEqual({ n: [1, -2, '3.0'] });
    expect(() => parseJsonKeepFloats('{"a":')).toThrow();
  });

  it('repr matches Python for the edge cases', () => {
    expect([0.1, 100.0, 1e-4, 1.5e-7, 123456789.125, 1e22].map(pyFloatJsonRepr)).toEqual(['0.1', '100.0', '0.0001', '1.5e-07', '123456789.125', '1e+22']);
  });
});

describe('the relay keeps device floats', () => {
  it('a status with 1.0 goes upstream as 1.0', async () => {
    const h = await makeRuntime();
    await h.runtime.start();
    h.runtime.onUdpPacket(utf8('{"type":"status","device_uid":"' + UID + '","payload":{"scale":1.0,"n":3,"fps":59.5}}'), DEVICE_ADDR);
    const [, data] = h.upstream().deviceMessages[0]!;
    expect(stringifyKeepFloats(data)).toContain('"scale":1.0,"n":3,"fps":59.5');
  });

  it('a chunked result too', async () => {
    const h = await makeRuntime();
    await h.runtime.start();
    const reply = '{"ok":true,"cmd":"status","data":{"alpha":0.5,"scale":1.0}}';
    for (const [i, part] of [reply.slice(0, 20), reply.slice(20)].entries()) {
      h.runtime.onUdpPacket(jsonFrame({ type: 'result_chunk', device_uid: UID, request_id: 'r', chunk: i, chunks: 2, data: part }), DEVICE_ADDR);
    }
    expect(stringifyKeepFloats(h.upstream().deviceMessages[0]![1])).toContain('"data":{"alpha":0.5,"scale":1.0}');
  });

  it('the observer gets every non-denied JSON datagram byte for byte', async () => {
    const h = await makeRuntime({ denied_devices: ['AABBCCDDEEFF'] });
    await h.runtime.start();
    const seen: [string, string][] = [];
    h.runtime.setObserver({ onControlDatagram: (uid, bytes) => seen.push([uid, new TextDecoder().decode(bytes)]) });
    const chunk = jsonFrame({ type: 'result_chunk', device_uid: UID, request_id: 'r', chunk: 0, chunks: 2, data: '{' });
    h.runtime.onUdpPacket(chunk, DEVICE_ADDR);
    h.runtime.onUdpPacket(jsonFrame({ type: 'ack', device_uid: UID, ack: 1 }), DEVICE_ADDR);
    h.runtime.onUdpPacket(jsonFrame({ type: 'status', device_uid: 'AABBCCDDEEFF' }), DEVICE_ADDR);
    h.runtime.onUdpPacket(jsonFrame({ type: 'status', payload: { device_uid: UID.toLowerCase() } }), DEVICE_ADDR);
    expect(seen.map(([uid]) => uid)).toEqual([UID, UID, UID]);
    expect(seen[0]![1]).toBe(new TextDecoder().decode(chunk));
  });
});

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('offer_policy "managed": devices that are not ours are not relayed', () => {
  async function managed(config: Record<string, unknown> = {}) {
    const h = await makeRuntime({ offer_policy: 'managed', managed_devices: ['AABBCCDDEEFF'], ...config });
    await h.runtime.start();
    const packets: unknown[] = [];
    h.runtime.setObserver({ onDevicePacket: (uid, _p, _f, info) => packets.push([uid, info]) });
    return { ...h, packets };
  }

  it('an unmanaged device: stream not forwarded, no session, no roster entry, status not relayed', async () => {
    const h = await managed();
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    h.runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    h.runtime.onUdpPacket(jsonFrame({ type: 'status', device_uid: UID, payload: { mode: 'normal' } }), DEVICE_ADDR);
    expect(h.upstream().packets).toEqual([]);
    expect(h.upstream().deviceMessages).toEqual([]);
    expect(h.runtime.state.isServing(UID)).toBe(false);
    expect(h.packets).toEqual([
      [UID, { kind: 'heartbeat', attached: false, forwarded: false }],
      [UID, { kind: 'stream', attached: false, forwarded: false }],
    ]);
    // A reply to a command this host sent still goes through.
    h.runtime.onUdpPacket(jsonFrame({ type: 'result', device_uid: UID, payload: { cmd: 'findme_discover', ok: true } }), DEVICE_ADDR);
    expect(h.upstream().deviceMessages.map(([t]) => t)).toEqual(['result']);
  });

  it('a released device is excluded even though it was managed; a managed one streams', async () => {
    const h = await managed({ managed_devices: [UID] });
    h.runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    expect(h.upstream().packets).toHaveLength(1);
    await h.runtime.operations().release(UID);
    h.runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    expect(h.upstream().packets).toHaveLength(1);
  });

  it('under "all" nothing changes: unmanaged devices stream and attach as before', async () => {
    const h = await makeRuntime({ managed_devices: [] });
    await h.runtime.start();
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    h.runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    h.runtime.onUdpPacket(jsonFrame({ type: 'status', device_uid: UID }), DEVICE_ADDR);
    expect(h.upstream().packets).toHaveLength(1);
    expect(h.upstream().deviceMessages).toHaveLength(1);
    expect(h.runtime.state.isServing(UID)).toBe(true);
  });
});
