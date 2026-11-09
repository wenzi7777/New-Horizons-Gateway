// Ported from tests/test_udp_control.py, plus the acked-without-result fix.
import { describe, expect, it } from 'vitest';

import { utf8Decode } from '../../src/bytes';
import type { Json } from '../../src/contracts';
import { ACKED_RESULT_TIMEOUT_MS, MAX_UNACKED_ATTEMPTS, RESEND_INTERVAL_MS, UdpCommandDispatcher, encodeCommandEnvelope } from '../../src/runtime';
import { FakeClock, FakeSocket } from './helpers';

const UID = '3CDC7545CCD0';
const RESEND_SEC = RESEND_INTERVAL_MS / 1000;

function setup(options: { sessionTtlSec?: number; failing?: string } = {}) {
  const clock = new FakeClock();
  const socket = new FakeSocket();
  if (options.failing) socket.fail = options.failing;
  const timeouts: [string, Json][] = [];
  const dispatcher = new UdpCommandDispatcher({
    send: (data, to) => socket.send(data, to),
    clock,
    onDeliveryTimeout: (uid, payload) => timeouts.push([uid, payload]),
    ...(options.sessionTtlSec !== undefined ? { sessionTtlSec: options.sessionTtlSec } : {}),
  });
  return { clock, socket, dispatcher, timeouts };
}

describe('UdpCommandDispatcher', () => {
  it('a direct command uses the standard envelope without an existing session', () => {
    const { clock, socket, dispatcher } = setup();
    expect(
      dispatcher.sendCommandTo(UID, { ip: '192.168.50.32', port: 13250 }, {
        command: 'findme_switch_gateway',
        request_id: 'findme-claim-claim-1',
        preferred_gateway_id: 'gw-target',
        claim_id: 'claim-1',
        ttl_ms: 30000,
      }),
    ).toBe(true);
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]!.to).toEqual({ ip: '192.168.50.32', port: 13250 });
    const frame = socket.json(0);
    expect(frame.type).toBe('command');
    expect(frame.device_uid).toBe(UID);
    expect(frame.request_id).toBe('findme-claim-claim-1');
    expect((frame.payload as Json).command).toBe('findme_switch_gateway');
    expect((frame.payload as Json).claim_id).toBe('claim-1');

    dispatcher.handleAck(UID, { device_uid: UID, ack: frame.seq, request_id: 'findme-claim-claim-1' });
    clock.advance(RESEND_SEC * 2);
    dispatcher.service();
    expect(socket.sent).toHaveLength(1);
    expect(dispatcher.snapshot().commands_acked).toBe(1);
  });

  it('a direct claim retries until its explicit expiry', () => {
    const { clock, socket, dispatcher, timeouts } = setup();
    const expiresAtMs = clock.wallMs + 30_000;
    dispatcher.sendCommandTo(UID, { ip: '192.168.50.32', port: 13250 }, {
      command: 'findme_switch_gateway',
      request_id: 'findme-claim-claim-1',
      claim_id: 'claim-1',
      expires_at_ms: expiresAtMs,
    });
    for (let i = 0; i < MAX_UNACKED_ATTEMPTS + 5; i++) {
      clock.advance(RESEND_SEC);
      dispatcher.service();
    }
    expect(timeouts).toEqual([]);
    expect(socket.sent.length).toBeGreaterThan(MAX_UNACKED_ATTEMPTS);
    clock.advance(30);
    dispatcher.service();
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]![1].claim_id).toBe('claim-1');
    expect(dispatcher.snapshot().pending).toBe(0);
  });

  it('a command is retried until acked', () => {
    const { clock, socket, dispatcher } = setup();
    dispatcher.setSession(UID, { ip: '192.168.50.32', port: 43309 });
    expect(dispatcher.sendCommand('3c:dc:75:45:cc:d0', { command: 'status', request_id: 'req-1' })).toBe(true);
    expect(socket.sent).toHaveLength(1);
    clock.advance(RESEND_SEC);
    dispatcher.service();
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[0]!.to).toEqual({ ip: '192.168.50.32', port: 43309 });
    const first = socket.json(0);
    const second = socket.json(1);
    expect(first.seq).toBe(second.seq);
    expect((second.payload as Json).command).toBe('status');
    expect(dispatcher.snapshot().commands_retried).toBe(1);
  });

  it('commands to a device use JSON command names', () => {
    const { socket, dispatcher } = setup();
    dispatcher.setSession(UID, { ip: '192.168.50.32', port: 43309 });
    dispatcher.sendCommand(UID, { command: 'status', request_id: 'req-status' });
    const frame = socket.json(0);
    expect(frame.type).toBe('command');
    expect(frame.device_uid).toBe(UID);
    expect((frame.payload as Json).command).toBe('status');
  });

  it('an ack stops retries until the result clears the pending entry', () => {
    const { clock, socket, dispatcher } = setup();
    dispatcher.setSession(UID, { ip: '192.168.50.32', port: 43309 });
    dispatcher.sendCommand(UID, { command: 'status', request_id: 'req-2' });
    const frame = socket.json(0);
    dispatcher.handleAck(UID, { device_uid: UID, ack: frame.seq, request_id: 'req-2' });
    clock.advance(RESEND_SEC * 3);
    dispatcher.service();
    expect(socket.sent).toHaveLength(1);
    expect(dispatcher.snapshot().commands_acked).toBe(1);
    expect(dispatcher.snapshot().pending).toBe(1);
    dispatcher.handleResult(UID, { request_id: 'req-2' });
    expect(dispatcher.snapshot().pending).toBe(0);
  });

  it('an unacked command timeout emits a delivery error', () => {
    const { clock, dispatcher, timeouts } = setup();
    dispatcher.setSession(UID, { ip: '192.168.50.32', port: 43309 });
    const expiresAtMs = clock.wallMs + 1000;
    dispatcher.sendCommand(UID, { command: 'status', request_id: 'req-3', expires_at_ms: expiresAtMs });
    clock.advance(1.1);
    dispatcher.service();
    expect(timeouts).toEqual([[UID, { command: 'status', request_id: 'req-3', expires_at_ms: expiresAtMs }]]);
    expect(dispatcher.snapshot().pending).toBe(0);
    expect(dispatcher.snapshot().commands_timeout).toBe(1);
  });

  it('a stale session rejects a command without retrying', () => {
    const { clock, socket, dispatcher } = setup({ sessionTtlSec: 1 });
    dispatcher.setSession(UID, { ip: '192.168.50.32', port: 43309 });
    clock.advance(1.1);
    expect(dispatcher.sendCommand(UID, { command: 'memory_status', request_id: 'req-memory' })).toBe(false);
    expect(socket.sent).toEqual([]);
    expect(dispatcher.snapshot().sessions).toBe(0);
  });

  it('service does not throw when the send fails', () => {
    const { clock, dispatcher } = setup({ failing: 'network unreachable' });
    dispatcher.setSession(UID, { ip: '192.168.50.32', port: 43309 });
    dispatcher.sendCommand(UID, { command: 'status', request_id: 'req-fail' });
    const firstError = dispatcher.lastError;
    for (let i = 0; i < MAX_UNACKED_ATTEMPTS + 2; i++) {
      clock.advance(RESEND_SEC);
      dispatcher.service();
    }
    expect(firstError).toContain('network unreachable');
    expect(dispatcher.snapshot().commands_timeout).toBe(1);
    expect(dispatcher.snapshot().pending).toBe(0);
  });

  it('sendCommandTo fails gracefully when the send throws', () => {
    const { dispatcher } = setup({ failing: 'connection refused' });
    expect(dispatcher.sendCommandTo(UID, { ip: '192.168.50.32', port: 13250 }, { command: 'findme_switch_gateway', request_id: 'req-1' })).toBe(true);
    expect(dispatcher.lastError).toContain('connection refused');
  });
});

describe('UdpCommandDispatcher (TS additions)', () => {
  it('an acked command without expiry and without a result is dropped after the budget, silently', () => {
    const { clock, socket, dispatcher, timeouts } = setup();
    dispatcher.setSession(UID, { ip: '192.168.50.32', port: 43309 });
    dispatcher.sendCommand(UID, { command: 'status', request_id: 'req-leak' });
    dispatcher.handleAck(UID, { ack: socket.json(0).seq });
    clock.advance(ACKED_RESULT_TIMEOUT_MS / 1000 - 1);
    dispatcher.service();
    expect(dispatcher.snapshot().pending).toBe(1);
    clock.advance(1);
    dispatcher.service();
    expect(dispatcher.snapshot().pending).toBe(0);
    expect(timeouts).toEqual([]);
    expect(dispatcher.snapshot().commands_timeout).toBe(0);
    expect(socket.sent).toHaveLength(1);
  });

  it('an acked command with an explicit expiry waits for it, not for the budget', () => {
    const { clock, socket, dispatcher } = setup();
    dispatcher.setSession(UID, { ip: '192.168.50.32', port: 43309 });
    dispatcher.sendCommand(UID, { command: 'status', request_id: 'r', expires_at_ms: clock.wallMs + 60_000 });
    dispatcher.handleAck(UID, { request_id: 'r' });
    clock.advance(30);
    dispatcher.service();
    expect(dispatcher.snapshot().pending).toBe(1);
    clock.advance(31);
    dispatcher.service();
    expect(dispatcher.snapshot().pending).toBe(0);
    expect(socket.sent).toHaveLength(1);
  });

  it('an unacked command without expiry times out after 30 attempts', () => {
    const { clock, socket, dispatcher, timeouts } = setup();
    dispatcher.setSession(UID, { ip: '192.168.50.32', port: 43309 });
    dispatcher.sendCommand(UID, { command: 'status', request_id: 'r' });
    for (let i = 0; i < MAX_UNACKED_ATTEMPTS; i++) {
      clock.advance(RESEND_SEC);
      dispatcher.service();
    }
    expect(socket.sent).toHaveLength(MAX_UNACKED_ATTEMPTS);
    expect(timeouts).toHaveLength(1);
    expect(dispatcher.snapshot().last_error).toBe('command_delivery_timeout');
  });

  it('pending commands of a device whose session went stale time out', () => {
    const { clock, dispatcher, timeouts } = setup({ sessionTtlSec: 1 });
    dispatcher.setSession(UID, { ip: '192.168.50.32', port: 43309 });
    dispatcher.sendCommand(UID, { command: 'status', request_id: 'r', expires_at_ms: clock.wallMs + 60_000 });
    clock.advance(1.1);
    dispatcher.service();
    expect(timeouts).toHaveLength(1);
  });

  it('the envelope is byte-identical to Python json.dumps (order, separators, ASCII escapes)', () => {
    const bytes = encodeCommandEnvelope(UID, 7, 'r1', { command: 'set_name', name: 'Café', request_id: 'r1' });
    expect(utf8Decode(bytes)).toBe(
      '{"type":"command","device_uid":"3CDC7545CCD0","seq":7,"request_id":"r1","payload":{"command":"set_name","name":"Caf\\u00e9","request_id":"r1"}}',
    );
  });

  it('seq wraps from 0xFFFF to 1', () => {
    const { socket, dispatcher } = setup();
    dispatcher.setSession(UID, { ip: '1.2.3.4', port: 1 });
    dispatcher.seq = 0xffff;
    dispatcher.sendCommand(UID, { command: 'a' });
    expect(socket.json(0).seq).toBe(1);
  });
});
