// NodeNative against real dgram sockets on 127.0.0.1 (ephemeral ports): time
// replies, datagram delivery under the logical ports, port conflicts as a
// status error with automatic retry, and `.nhraw` bytes equal to the fake
// native's (which mirrors RawCapture.kt) for the same calls.
import { createSocket, type Socket } from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { base64ToBytes, type Clock, wire } from '@nhgw/core';
import { encodeNhrawEvent } from '@nhgw/engine';
import { DISCOVERY_PORT, RAW_SOURCE, STREAM_PORT, type DatagramEvent } from '@nhgw/host';

import { encodePacket } from '../../../../packages/engine/test/parse/packets';
import { FakeNative } from '../../../../packages/host/test/fakeNative';
import { NodeNative } from '../../src/main/nodeNative';

const UID = '3CDC7545CCD0';
const T0 = Date.UTC(2026, 10, 10, 3, 0, 0) * 1000;

class FakeClock implements Clock {
  us = T0;
  nowEpochUs() {
    return this.us;
  }
  nowMs() {
    return this.us / 1000;
  }
  monotonicMs() {
    return this.us / 1000;
  }
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nh-studio-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeNative(options: { clock?: Clock; ports?: { stream: number; discovery: number }; bindRetryMs?: number } = {}) {
  const root = tempDir();
  let changes = 0;
  const native = new NodeNative({
    root,
    exportDir: join(root, '.export'),
    host: '127.0.0.1',
    ports: options.ports ?? { stream: 0, discovery: 0 },
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.bindRetryMs ? { bindRetryMs: options.bindRetryMs } : {}),
    onStateChange: () => {
      changes += 1;
    },
  });
  cleanup.push(() => native.stopServiceAndWait());
  return { native, root, changes: () => changes };
}

async function client(): Promise<Socket> {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()));
  cleanup.push(() => new Promise<void>((resolve) => socket.close(() => resolve())));
  return socket;
}

function nextMessage(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => socket.once('message', (msg) => resolve(msg)));
}

function nextDatagram(native: NodeNative): Promise<DatagramEvent> {
  return new Promise((resolve) => {
    const sub = native.addListener('onDatagram', (event) => {
      sub.remove();
      resolve(event);
    });
  });
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('NodeNative UDP', () => {
  it('binds both ports, delivers datagrams under the logical port and sends replies', async () => {
    const { native } = makeNative();
    expect(native.startService()).toBe(true);
    await native.whenBound();
    expect(native.isRunning()).toBe(true);
    expect(native.serviceError()).toBe('');
    const ports = native.boundPorts();
    const device = await client();

    const arriving = nextDatagram(native);
    device.send(Buffer.from('{"type":"findme"}'), ports.discovery!, '127.0.0.1');
    const event = await arriving;
    expect(event.localPort).toBe(DISCOVERY_PORT);
    expect(event.ip).toBe('127.0.0.1');
    expect(event.srcPort).toBe(device.address().port);
    expect(new TextDecoder().decode(base64ToBytes(event.data))).toBe('{"type":"findme"}');
    expect(Math.abs(event.rxEpochUs - Date.now() * 1000)).toBeLessThan(5_000_000);

    const stream = nextDatagram(native);
    const packet = encodePacket({ uid: UID, frameId: 1, matrix: [1, 2] });
    device.send(packet, ports.stream!, '127.0.0.1');
    expect((await stream).localPort).toBe(STREAM_PORT);

    const reply = nextMessage(device);
    native.send(STREAM_PORT, '127.0.0.1', device.address().port, Buffer.from('hello').toString('base64'));
    expect((await reply).toString()).toBe('hello');
    expect(native.stats()).toMatchObject({ running: true, datagramsIn: 2, datagramsOut: 1, sendErrors: 0 });
  });

  it('answers TIME_REQ itself (t2 = receive time) and does not hand it to the host', async () => {
    const clock = new FakeClock();
    const { native } = makeNative({ clock });
    native.startService();
    await native.whenBound();
    const served: { seq: number; turnaroundUs: number }[] = [];
    native.addListener('onTimeServed', (event) => served.push(event));
    const delivered: DatagramEvent[] = [];
    native.addListener('onDatagram', (event) => delivered.push(event));
    const device = await client();
    const request = Buffer.alloc(12);
    request[0] = wire.TIME_REQ_MAGIC;
    request[1] = 1;
    request[2] = 7;
    request.writeBigInt64LE(123456789n, 4);
    const reply = nextMessage(device);
    device.send(request, native.boundPorts().stream!, '127.0.0.1');
    const response = await reply;
    expect(response.length).toBe(wire.TIME_RESP_LEN);
    expect(response[2]).toBe(7);
    expect(response[3]! & 0x01).toBe(1); // synced
    expect(response.readBigInt64LE(4)).toBe(123456789n);
    expect(response.readBigInt64LE(12)).toBe(BigInt(T0));
    expect(response.readBigInt64LE(20)).toBe(BigInt(T0));
    expect(served).toEqual([{ seq: 7, turnaroundUs: 0 }]);
    expect(delivered).toHaveLength(0);
    expect(native.stats().timeRequests).toBe(1);
  });

  it('reports a port held by another app as a status error, not a crash, and retries until it is free', async () => {
    const blocker = createSocket({ type: 'udp4', reuseAddr: false });
    await new Promise<void>((resolve) => blocker.bind(0, '127.0.0.1', () => resolve()));
    const taken = blocker.address().port;
    const { native, changes } = makeNative({ ports: { stream: taken, discovery: 0 }, bindRetryMs: 50 });
    native.startService();
    await native.whenBound();
    expect(native.isRunning()).toBe(false);
    expect(native.serviceError()).toMatch(new RegExp(`UDP port ${taken} .*already in use.*another NH Studio, NH Gateway`));
    expect(native.boundPorts().discovery).not.toBeNull(); // the other port is up
    expect(changes()).toBeGreaterThan(0);

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await waitFor(() => native.isRunning());
    expect(native.serviceError()).toBe('');
    expect(native.boundPorts().stream).toBe(taken);

    native.stopService();
    await native.stopServiceAndWait();
    expect(native.isRunning()).toBe(false);
    expect(native.boundPorts()).toEqual({ stream: null, discovery: null });
  });

  it('send without a bound socket counts an error instead of throwing', () => {
    const { native } = makeNative();
    native.send(STREAM_PORT, '127.0.0.1', 9, 'AA==');
    expect(native.stats().sendErrors).toBe(1);
  });
});

describe('NodeNative .nhraw', () => {
  it('writes the same bytes as the fake native (RawCapture.kt) for the same calls', async () => {
    const clock = new FakeClock();
    const { native, root } = makeNative({ clock });
    native.startService();
    await native.whenBound();
    const fake = new FakeNative();
    fake.nowUs = T0;
    const path = `recordings/.raw/${UID}-${T0}.nhraw`;
    const knowledge = encodeNhrawEvent({ type: 'knowledge', device: { device_uid: UID }, local_relay: 'studio' });
    const h1 = native.rawStart(UID, path, T0, knowledge);
    const h2 = fake.rawStart(UID, path, T0, knowledge);
    expect(() => native.rawStart(UID.toLowerCase(), 'recordings/.raw/x.nhraw', T0, null)).toThrow('capture_already_running');

    const device = await client();
    const send = async (packet: Uint8Array, rxUs: number) => {
      clock.us = rxUs;
      const got = nextDatagram(native);
      device.send(packet, native.boundPorts().stream!, '127.0.0.1');
      await got;
      fake.receive(STREAM_PORT, packet, { ip: '127.0.0.1', port: 1 }, rxUs);
    };
    await send(encodePacket({ uid: UID, frameId: 1, matrix: [1, 2] }), T0 + 1000);
    await send(encodePacket({ uid: 'AAAAAAAAAAAA', frameId: 1, matrix: [9] }), T0 + 1500); // another device: not captured
    clock.us = T0 + 2000;
    fake.nowUs = T0 + 2000;
    expect(native.rawAppend(h1, RAW_SOURCE.event, encodeNhrawEvent({ type: 'stop' }))).toBe(T0 + 2000);
    fake.rawAppend(h2, RAW_SOURCE.event, encodeNhrawEvent({ type: 'stop' }));
    // A datagram stamped before the last record is written with the last stamp (max ordering).
    await send(encodePacket({ uid: UID, frameId: 2, matrix: [3, 4] }), T0 + 1900);
    clock.us = T0 + 3000;
    fake.nowUs = T0 + 3000;
    native.rawAppend(h1, RAW_SOURCE.control, new TextEncoder().encode('{"type":"result"}'));
    fake.rawAppend(h2, RAW_SOURCE.control, new TextEncoder().encode('{"type":"result"}'));

    native.rawFlushAll();
    expect(native.rawStats(h1)).toMatchObject({ uid: UID, path, records: 5, lastEpochUs: T0 + 3000, error: '' });
    native.rawStop(h1);
    expect(native.rawStats(h1)).toBeNull();
    const written = new Uint8Array(readFileSync(join(root, 'recordings', '.raw', `${UID}-${T0}.nhraw`)));
    expect(written).toEqual(fake.files.get(path));
    // The capture is closed: a new one for the same UID may start.
    native.rawStop(native.rawStart(UID, 'recordings/.raw/again.nhraw', T0, null));
  });

  it('refuses a malformed UID and paths outside the root', () => {
    const { native } = makeNative();
    expect(() => native.rawStart('XYZ', 'recordings/.raw/a.nhraw', T0, null)).toThrow();
    expect(() => native.rawStart(UID, '../escape.nhraw', T0, null)).toThrow('invalid_path');
  });
});
