import { describe, expect, it } from 'vitest';

import { base64ToBytes, utf8Encode } from '../../src/bytes';
import type { Json } from '../../src/contracts';
import type { Clock, WsConnection, WsConnector, WsHandlers } from '../../src/ports';
import { CAPABILITIES, PACKET_TEXT_PREFIX, UpstreamClient, pyIsoUtcFromEpochUs } from '../../src/upstream';

class FakeClock implements Clock {
  mono = 0;
  wallMs = 1_762_000_000_000;
  nowMs() {
    return this.wallMs + this.mono;
  }
  nowEpochUs() {
    return (this.wallMs + this.mono) * 1000;
  }
  monotonicMs() {
    return this.mono;
  }
}

class FakeSocket implements WsConnection {
  sent: string[] = [];
  closed = false;
  failSends = false;
  bufferedAmount = 0;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
    readonly handlers: WsHandlers,
  ) {}
  send(text: string) {
    if (this.failSends) throw new Error('broken pipe');
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
  json() {
    return this.sent.filter((s) => !s.startsWith(PACKET_TEXT_PREFIX)).map((s) => JSON.parse(s) as Json);
  }
}

class FakeConnector implements WsConnector {
  sockets: FakeSocket[] = [];
  connectTimes: number[] = [];
  throwOnConnect: string | null = null;
  constructor(private readonly clock: FakeClock) {}
  connect(url: string, headers: Record<string, string>, handlers: WsHandlers): WsConnection {
    this.connectTimes.push(this.clock.mono);
    if (this.throwOnConnect) throw new Error(this.throwOnConnect);
    const socket = new FakeSocket(url, headers, handlers);
    this.sockets.push(socket);
    return socket;
  }
  get last(): FakeSocket {
    return this.sockets[this.sockets.length - 1]!;
  }
}

function setup(overrides: Partial<ConstructorParameters<typeof UpstreamClient>[0]> = {}) {
  const clock = new FakeClock();
  const connector = new FakeConnector(clock);
  const commands: [string, Json][] = [];
  const messages: Json[] = [];
  const connection: boolean[] = [];
  const client = new UpstreamClient({
    serverUrl: 'ws://example.invalid',
    gatewayId: 'gateway-test',
    version: 'v2.0.0',
    platform: 'darwin-arm64',
    connector,
    clock,
    callbacks: {
      onCommand: (uid, payload) => commands.push([uid, payload]),
      onMessage: (message) => messages.push(message),
      onConnectionChange: (c) => connection.push(c),
    },
    ...overrides,
  });
  const tick = (ms: number, step = 500) => {
    for (let t = 0; t < ms; t += step) {
      clock.mono += step;
      client.service();
    }
  };
  const open = () => {
    client.start();
    connector.last.handlers.onOpen();
    return connector.last;
  };
  return { clock, connector, client, commands, messages, connection, tick, open };
}

describe('queues (test_upstream_wss.py)', () => {
  it('default binary queue covers short bursts: 32 kept, oldest dropped', () => {
    const { client } = setup();
    for (let i = 0; i < 40; i++) client.sendPacket(Uint8Array.of(i % 256));
    const status = client.status();
    expect(status.data_queue_size).toBe(32);
    expect(status.data_queue_dropped).toBe(8);
    expect(status.data_packets_enqueued).toBe(40);
    expect(client.dataQueue.get()).toEqual(Uint8Array.of(8));
  });

  it('coalesces gateway_status, keeping the newest at the back', () => {
    const { client } = setup();
    client.sendGatewayStatus({ seq: 1 });
    client.sendDeviceMessage('hello', { device_uid: 'AA' });
    client.sendGatewayStatus({ seq: 2 });
    const queued = client.controlQueue.peekAll();
    expect(queued.map((m) => m.type)).toEqual(['device_hello', 'gateway_status']);
    expect((queued[1]!.payload as Json).seq).toBe(2);
  });

  it('control queue drops oldest beyond its size', () => {
    const { client } = setup({ controlQueueSize: 3 });
    for (let i = 0; i < 5; i++) client.sendGatewayCommandResult(`r${i}`, { ok: true });
    expect(client.controlQueue.peekAll().map((m) => m.request_id)).toEqual(['r2', 'r3', 'r4']);
  });

  it('command result message shape (test_gateway_remote_commands)', () => {
    const { client } = setup();
    client.sendGatewayCommandResult('r9', { ok: true, message: 'x' });
    const message = client.controlQueue.get()!;
    expect(message.type).toBe('gateway_command_result');
    expect(message.request_id).toBe('r9');
    expect((message.result as Json).message).toBe('x');
    expect(message.gateway_id).toBe('gateway-test');
  });

  it('device message types and claim requests are normalised as in Python', () => {
    const { client } = setup();
    client.sendDeviceMessage('update_progress', { device_uid: 'AB', pct: 3 });
    client.sendDeviceMessage('weird', { x: 1 });
    client.sendClaimRequest(' 3cdc7545ccd0 ', 'c1', 0);
    const [a, b, c] = client.controlQueue.peekAll();
    expect(a).toMatchObject({ type: 'device_update_progress', device_uid: 'AB', payload: { device_uid: 'AB', pct: 3 } });
    expect(b).toMatchObject({ type: 'device_status', device_uid: '' });
    expect(c).toEqual({ type: 'gateway_claim_request', gateway_id: 'gateway-test', device_uid: '3CDC7545CCD0', claim_id: 'c1', ttl_ms: 30000 });
  });
});

describe('connection and sending', () => {
  it('sends hello first, then queued control before queued data', () => {
    const { client, connector } = setup();
    client.sendPacket(Uint8Array.of(1));
    client.sendGatewayStatus({ seq: 1 });
    client.sendPacket(Uint8Array.of(2));
    client.sendDeviceMessage('status', { device_uid: 'AA' });
    client.start();
    const ws = connector.last;
    expect(ws.sent).toEqual([]);
    ws.handlers.onOpen();
    expect(ws.sent.length).toBe(5);
    expect(JSON.parse(ws.sent[0]!).type).toBe('hello');
    expect(JSON.parse(ws.sent[1]!).type).toBe('gateway_status');
    expect(JSON.parse(ws.sent[2]!).type).toBe('device_status');
    expect(ws.sent[3]).toBe(PACKET_TEXT_PREFIX + 'AQ==');
    expect(ws.sent[4]).toBe(PACKET_TEXT_PREFIX + 'Ag==');
    expect(client.status().data_packets_sent).toBe(2);
    expect(client.isConnected()).toBe(true);
  });

  it('sends straight through while connected', () => {
    const { client, open } = setup();
    const ws = open();
    client.sendGatewayStatus({ seq: 9 });
    client.sendPacket(Uint8Array.of(0x5a, 0xa5));
    expect(ws.sent.length).toBe(3);
    expect(client.status().control_queue_size).toBe(0);
    expect(client.status().data_queue_size).toBe(0);
  });

  it('sensor packets travel as the NHPKT1 text envelope', () => {
    const { client, open } = setup();
    const ws = open();
    const packet = Uint8Array.from([0x5a, 0xa5, ...utf8Encode('packet')]);
    client.sendPacket(packet);
    const frame = ws.sent[1]!;
    expect(frame.startsWith(PACKET_TEXT_PREFIX)).toBe(true);
    expect(base64ToBytes(frame.slice(PACKET_TEXT_PREFIX.length))).toEqual(packet);
  });

  it('control messages are JSON text', () => {
    const { client, open } = setup();
    const ws = open();
    client.sendGatewayStatus({ seq: 2 });
    const payload = JSON.parse(ws.sent[1]!);
    expect(payload).toEqual({ type: 'gateway_status', gateway_id: 'gateway-test', payload: { seq: 2 } });
  });

  it('hello identifies the gateway, its capabilities, channel and platform', () => {
    const { client, clock, open } = setup();
    const ws = open();
    const hello = JSON.parse(ws.sent[0]!);
    expect(hello).toEqual({
      type: 'hello',
      gateway_id: 'gateway-test',
      version: 'v2.0.0',
      update_channel: 'stable',
      client_type: 'gateway',
      capabilities: ['gateway_command', 'auto_update'],
      connected_at: pyIsoUtcFromEpochUs(clock.nowEpochUs()),
      platform: 'darwin-arm64',
    });
    expect([...CAPABILITIES]).toEqual(['gateway_command', 'auto_update']);
    expect(client.status().last_connected_at).toMatch(/\+00:00$/);
  });

  it('set_update_channel re-announces when connected and only remembers otherwise', () => {
    const { client, open } = setup();
    client.setUpdateChannel('beta'); // not connected: just remembered
    expect(client.helloPayload().update_channel).toBe('beta');
    const ws = open();
    expect(JSON.parse(ws.sent[0]!).update_channel).toBe('beta');
    client.setUpdateChannel('beta');
    expect(ws.sent.length).toBe(1);
    client.setUpdateChannel('stable');
    expect(ws.sent.length).toBe(2);
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ type: 'hello', update_channel: 'stable' });
  });

  it('Authorization header only with a token', () => {
    const a = setup();
    a.client.start();
    expect(a.connector.last.headers).toEqual({});
    const b = setup({ authToken: 'tok' });
    b.client.start();
    expect(b.connector.last.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('a failed control send re-queues it and reconnects; the next connection sends it', () => {
    const { client, connector, open, tick } = setup();
    const ws = open();
    ws.failSends = true;
    client.sendGatewayCommandResult('r1', { ok: true });
    expect(client.isConnected()).toBe(false);
    expect(ws.closed).toBe(true);
    expect(client.status().last_error).toBe('broken pipe');
    expect(client.controlQueue.peekAll().map((m) => m.request_id)).toEqual(['r1']);
    tick(1000);
    const ws2 = connector.last;
    expect(ws2).not.toBe(ws);
    ws2.handlers.onOpen();
    expect(ws2.json().map((m) => m.type)).toEqual(['hello', 'gateway_command_result']);
  });

  it('a failed packet send drops the packet and reconnects', () => {
    const { client, open } = setup();
    const ws = open();
    ws.failSends = true;
    client.sendPacket(Uint8Array.of(1));
    expect(client.isConnected()).toBe(false);
    expect(client.status().data_queue_size).toBe(0);
    expect(client.status().data_packets_sent).toBe(0);
  });

  it('pauses the drain while the socket is congested, then resumes on service()', () => {
    const { client, open, clock } = setup({ maxBufferedBytes: 100 });
    const ws = open();
    ws.bufferedAmount = 1000;
    for (let i = 0; i < 40; i++) client.sendPacket(Uint8Array.of(i));
    client.sendGatewayStatus({ seq: 1 });
    client.sendGatewayStatus({ seq: 2 });
    expect(ws.sent.length).toBe(1);
    expect(client.status().data_queue_dropped).toBe(8);
    ws.bufferedAmount = 0;
    clock.mono += 500;
    client.service();
    expect(JSON.parse(ws.sent[1]!).payload).toEqual({ seq: 2 });
    expect(ws.sent.length).toBe(2 + 32);
    expect(ws.sent[2]).toBe(PACKET_TEXT_PREFIX + 'CA=='); // packet 8: the oldest survivor
  });

  it('reconnect backoff 1, 2, 4, 8, 10, 10 s, reset after a successful connect', () => {
    const { client, connector, tick } = setup();
    connector.throwOnConnect = 'refused';
    client.start();
    tick(40_000, 100);
    const gaps = connector.connectTimes.slice(1).map((t, i) => t - connector.connectTimes[i]!);
    expect(gaps.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
    expect(client.status().last_error).toBe('refused');

    connector.throwOnConnect = null;
    tick(10_000, 100);
    connector.last.handlers.onOpen();
    expect(client.isConnected()).toBe(true);
    expect(client.status().last_error).toBe('');
    const before = connector.connectTimes.length;
    const droppedAt = (connector as unknown as { clock: FakeClock }).clock.mono;
    connector.last.handlers.onClose('bye');
    expect(client.status().last_error).toBe('bye');
    tick(3000, 100);
    expect(connector.connectTimes[before]! - droppedAt).toBe(1000);
  });

  it('a handshake that never completes times out after 10 s', () => {
    const { client, connector, tick } = setup();
    client.start();
    tick(9500);
    expect(connector.sockets.length).toBe(1);
    tick(500);
    expect(connector.sockets[0]!.closed).toBe(true);
    expect(client.status().last_error).toBe('timed out');
    tick(1000);
    expect(connector.sockets.length).toBe(2);
  });

  it('ignores events from a superseded connection', () => {
    const { client, connector, open, messages } = setup();
    const ws = open();
    client.updateServer('ws://other.invalid');
    expect(ws.closed).toBe(true);
    ws.handlers.onMessage('{"type":"pong"}');
    ws.handlers.onClose('late');
    expect(messages).toEqual([]);
    expect(client.status().last_error).toBe('');
    expect(client.status().server_url).toBe('ws://other.invalid');
    client.service();
    expect(connector.sockets.length).toBe(1);
  });

  it('updateServer reconnects to the new URL after the backoff', () => {
    const { client, connector, open, tick } = setup();
    open();
    client.updateServer('ws://other.invalid');
    tick(1000);
    expect(connector.last.url).toBe('ws://other.invalid');
  });

  it('stop closes and never reconnects; start again connects at once', () => {
    const { client, connector, open, tick, connection } = setup();
    const ws = open();
    client.stop();
    expect(ws.closed).toBe(true);
    expect(client.isConnected()).toBe(false);
    tick(30_000);
    expect(connector.sockets.length).toBe(1);
    expect(connection).toEqual([true, false]);
    client.start();
    expect(connector.sockets.length).toBe(2);
  });

  it('copes with a connector that opens synchronously', () => {
    const clock = new FakeClock();
    const sent: string[] = [];
    const connector: WsConnector = {
      connect(_url, _headers, handlers) {
        handlers.onOpen();
        return { send: (t) => sent.push(t), close() {} };
      },
    };
    const client = new UpstreamClient({
      serverUrl: 'ws://x',
      gatewayId: 'g',
      version: 'v2.0.0',
      platform: 'android',
      connector,
      clock,
      callbacks: { onCommand() {}, onMessage() {} },
    });
    client.sendGatewayStatus({ a: 1 });
    client.start();
    expect(client.isConnected()).toBe(true);
    expect(sent.map((s) => JSON.parse(s).type)).toEqual(['hello', 'gateway_status']);
  });
});

describe('receiving', () => {
  const command = { type: 'command', device_uid: '3CDC7545CCD0', payload: { command: 'status', request_id: 'req-1' } };

  it('JSON text command reaches onCommand', () => {
    const { open, commands, messages } = setup();
    open().handlers.onMessage(JSON.stringify(command));
    expect(commands).toEqual([['3CDC7545CCD0', { command: 'status', request_id: 'req-1' }]]);
    expect(messages).toEqual([]);
  });

  it('JSON bytes command reaches onCommand', () => {
    const { open, commands } = setup();
    open().handlers.onMessage(utf8Encode(JSON.stringify(command)));
    expect(commands).toEqual([['3CDC7545CCD0', { command: 'status', request_id: 'req-1' }]]);
  });

  it('device_uid falls back to the payload, and a non-object payload becomes {}', () => {
    const { open, commands } = setup();
    const ws = open();
    ws.handlers.onMessage(JSON.stringify({ type: 'command', payload: { device_uid: 'AA', command: 'x' } }));
    ws.handlers.onMessage(JSON.stringify({ type: 'command', payload: 'nope' }));
    expect(commands).toEqual([
      ['AA', { device_uid: 'AA', command: 'x' }],
      ['', {}],
    ]);
  });

  it('everything else goes to onMessage; junk frames are skipped and the route survives', () => {
    const { open, commands, messages } = setup();
    const ws = open();
    ws.handlers.onMessage('not json');
    ws.handlers.onMessage('[1,2]');
    ws.handlers.onMessage(Uint8Array.of(0xff, 0xfe, 0x7b, 0x7d));
    ws.handlers.onMessage(JSON.stringify({ type: 'gateway_hello_ack', latest_gateway_version: 'v9.9.9' }));
    ws.handlers.onMessage(JSON.stringify({ ...command, payload: { command: 'status', request_id: 'req-timeout' } }));
    expect(messages).toEqual([{ type: 'gateway_hello_ack', latest_gateway_version: 'v9.9.9' }]);
    expect(commands).toEqual([['3CDC7545CCD0', { command: 'status', request_id: 'req-timeout' }]]);
  });

  it('a throwing callback drops the connection, as the escaping exception did in Python', () => {
    const clock = new FakeClock();
    const connector = new FakeConnector(clock);
    const client = new UpstreamClient({
      serverUrl: 'ws://x',
      gatewayId: 'g',
      version: 'v2.0.0',
      platform: 'linux-x64',
      connector,
      clock,
      callbacks: {
        onCommand() {
          throw new Error('boom');
        },
        onMessage() {},
      },
    });
    client.start();
    connector.last.handlers.onOpen();
    connector.last.handlers.onMessage(JSON.stringify(command));
    expect(client.isConnected()).toBe(false);
    expect(client.status().last_error).toBe('boom');
  });
});

describe('rates', () => {
  it('udp_in_fps and upstream_sent_fps count the last second', () => {
    const { client, clock, open } = setup();
    for (let i = 0; i < 5; i++) {
      client.sendPacket(Uint8Array.of(i));
      clock.mono += 100;
    }
    expect(client.status().udp_in_fps).toBe(5);
    expect(client.status().upstream_sent_fps).toBe(0);
    open();
    expect(client.status().upstream_sent_fps).toBe(5);
    clock.mono += 1001;
    expect(client.status()).toMatchObject({ udp_in_fps: 0, upstream_sent_fps: 0, data_packets_sent: 5 });
  });

  it('status() carries the Python field names', () => {
    const { client } = setup();
    expect(Object.keys(client.status()).sort()).toEqual(
      [
        'server_url',
        'connected',
        'last_error',
        'last_connected_at',
        'data_queue_size',
        'data_queue_dropped',
        'data_packets_enqueued',
        'data_packets_sent',
        'udp_in_fps',
        'upstream_sent_fps',
        'control_queue_size',
      ].sort(),
    );
  });
});

describe('pyIsoUtcFromEpochUs', () => {
  it('matches datetime.isoformat()', () => {
    expect(pyIsoUtcFromEpochUs(1_762_000_000_123_456)).toBe('2025-11-01T12:26:40.123456+00:00');
    expect(pyIsoUtcFromEpochUs(1_762_000_000_000_000)).toBe('2025-11-01T12:26:40+00:00');
  });
});

describe('connect failure logging', () => {
  it('logs each distinct failure once, and again after a successful connection', () => {
    const warnings: string[] = [];
    const logger = { info() {}, warn: (m: string) => warnings.push(m), error() {} };
    const { client, connector, tick } = setup({ logger });
    client.start();
    connector.last.handlers.onError('ECONNREFUSED');
    connector.last.handlers.onClose('closed');
    tick(1000);
    connector.last.handlers.onError('ECONNREFUSED');
    connector.last.handlers.onClose('closed');
    expect(warnings.filter((w) => w.includes('connect failed'))).toHaveLength(1);
    tick(2000);
    connector.last.handlers.onOpen();
    connector.last.handlers.onError('ECONNRESET');
    connector.last.handlers.onClose('closed');
    tick(1000);
    connector.last.handlers.onError('ECONNREFUSED');
    connector.last.handlers.onClose('closed');
    expect(warnings.filter((w) => w.includes('connect failed: ECONNREFUSED'))).toHaveLength(2);
  });
});
