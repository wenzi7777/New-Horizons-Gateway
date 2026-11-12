// Ported from tests/test_gateway_discovery.py (fake sockets instead of real ones).
import { describe, expect, it } from 'vitest';

import { utf8Decode } from '../../src/bytes';
import type { Json } from '../../src/contracts';
import { DiscoveryResponder, GatewayState, OFFER_VERSION, type DiscoveryResponderOptions, decideFindme, decodeFindmeRequest } from '../../src/runtime';
import { FakeClock, FakeSocket, jsonFrame } from './helpers';

const UID = '3CDC7545CCD0';
const DEVICE = { ip: '192.168.1.152', port: 50000 };

function discover(payload: Json): Uint8Array {
  return jsonFrame({ type: 'findme_discover', ...payload });
}

function responder(options: Partial<DiscoveryResponderOptions> & { gatewayId: string }) {
  const socket = new FakeSocket();
  const r = new DiscoveryResponder({ socket, clock: new FakeClock(), udpPort: 13250, discoveryPort: 22346, ...options });
  r.started = true;
  return { socket, r };
}

function ask(options: Partial<DiscoveryResponderOptions> & { gatewayId: string }, payload: Json): Json {
  const { socket, r } = responder(options);
  r.handleDatagram(discover(payload), DEVICE);
  expect(socket.sent).toHaveLength(1);
  expect(socket.sent[0]!.to).toEqual(DEVICE);
  return socket.json(0);
}

describe('DiscoveryResponder', () => {
  it('replies with JSON and the local ports', () => {
    const reply = ask({ gatewayId: 'gw-test', priority: 80 }, { device_uid: UID, mode: 'normal' });
    expect(reply.type).toBe('findme_offer');
    expect(reply.gateway_id).toBe('gw-test');
    expect(reply.gateway_name).toBe('NH Gateway');
    expect(reply.accept).toBe(true);
    expect(reply.udp_port).toBe(13250);
  });

  it('rejects a denied device', () => {
    const reply = ask({ gatewayId: 'gw-test', isDenied: (uid) => uid === UID }, { device_uid: UID, mode: 'normal' });
    expect(reply.accept).toBe(false);
    expect(reply.reason).toBe('device_rejected');
    expect(reply.cooldown_ms).toBe(30000);
  });

  it('declines when the device prefers another gateway', () => {
    const reply = ask({ gatewayId: 'gw-a', priority: 100 }, { device_uid: UID, mode: 'normal', preferred_gateway_id: 'gw-b' });
    expect(reply.type).toBe('findme_offer');
    expect(reply.accept).toBe(false);
    expect(reply.reason).toBe('device_switching_gateway');
    expect(reply.gateway_id).toBe('gw-a');
  });

  it('responds normally when the preferred gateway is this one', () => {
    expect(ask({ gatewayId: 'gw-a' }, { device_uid: UID, preferred_gateway_id: 'gw-a' }).accept).toBe(true);
  });

  it('responds normally when the preferred gateway is empty', () => {
    expect(ask({ gatewayId: 'gw-a' }, { device_uid: UID }).accept).toBe(true);
  });

  it('marks a matching claim offer', () => {
    const reply = ask(
      { gatewayId: 'gw-test', priority: 80, activeClaim: (uid) => (uid === UID ? { claim_id: 'claim-1' } : null) },
      { device_uid: UID, mode: 'normal', preferred_gateway_id: 'gw-test', claim_id: 'claim-1' },
    );
    expect(reply.accept).toBe(true);
    expect(reply.claim_id).toBe('claim-1');
    expect(reply.priority as number).toBeGreaterThan(80);
  });

  it('gateway handover: the old gateway declines, the target attaches after a heartbeat', () => {
    const clock = new FakeClock();
    const target = new GatewayState({ clock, newClaimId: () => 'claim-x' });
    const claim = target.createClaim(UID, 30000);
    const a = responder({ gatewayId: 'gw-a', priority: 100 });
    const b = responder({
      gatewayId: 'gw-b',
      priority: 100,
      activeClaim: (uid) => target.activeClaimFor(uid),
      onRequest: (p, addr, accepted, reason) => target.recordFindmeRequest(p, addr, accepted, reason),
    });
    const packet = discover({ device_uid: UID, mode: 'normal', preferred_gateway_id: 'gw-b', claim_id: claim.claim_id });
    a.r.handleDatagram(packet, DEVICE);
    b.r.handleDatagram(packet, DEVICE);
    const replyA = a.socket.json(0);
    const replyB = b.socket.json(0);
    expect(replyA.accept).toBe(false);
    expect(replyA.reason).toBe('device_switching_gateway');
    expect(replyB.accept).toBe(true);
    expect(replyB.claim_id).toBe(claim.claim_id);
    expect(replyB.priority as number).toBeGreaterThan(100);
    expect(target.activeClaimFor(UID)!.state).toBe('created');

    target.recordHeartbeat(UID, {}, { ip: '192.0.2.10', port: 13250 });
    const attached = target.activeClaimFor(UID);
    expect(attached!.state).toBe('attached');
    expect(target.snapshot([]).devices[0]!.claim_id).toBe(claim.claim_id);
  });

  it("mirrors the discover's claim_id when the claim record is absent", () => {
    const reply = ask(
      { gatewayId: 'gw-b', priority: 100, activeClaim: () => null },
      { device_uid: UID, mode: 'normal', preferred_gateway_id: 'gw-b', claim_id: 'abc123' },
    );
    expect(reply.accept).toBe(true);
    expect(reply.claim_id).toBe('abc123');
    expect(reply.priority as number).toBeGreaterThan(100);
  });

  it('does not mirror the claim_id when not the preferred gateway', () => {
    const reply = ask(
      { gatewayId: 'gw-a', priority: 100, activeClaim: () => null },
      { device_uid: UID, mode: 'normal', preferred_gateway_id: 'gw-b', claim_id: 'abc123' },
    );
    expect(reply.accept).toBe(false);
    expect(reply.reason).toBe('device_switching_gateway');
    expect(reply).not.toHaveProperty('claim_id');
  });
});

describe('DiscoveryResponder (TS additions)', () => {
  it('records a device attached elsewhere without offering', () => {
    const recorded: [Json, boolean, string][] = [];
    const { socket, r } = responder({ gatewayId: 'gw-a', onRequest: (p, _a, accepted, reason) => recorded.push([p, accepted, reason]) });
    const decision = r.handleDatagram(discover({ device_uid: UID, current_gateway_id: 'gw-z' }), DEVICE);
    expect(decision!.reply).toBeNull();
    expect(socket.sent).toEqual([]);
    expect(recorded).toEqual([[{ device_uid: UID, current_gateway_id: 'gw-z' }, false, 'device_attached_elsewhere']]);
  });

  it('ignores anything that is not a findme_discover with a device_uid', () => {
    expect(decodeFindmeRequest(jsonFrame({ type: 'findme_offer', device_uid: UID }))).toBeNull();
    expect(decodeFindmeRequest(jsonFrame({ type: 'findme_discover' }))).toBeNull();
    expect(decodeFindmeRequest(new Uint8Array([0xff, 0x00]))).toBeNull();
    const { socket, r } = responder({ gatewayId: 'gw-a' });
    expect(r.handleDatagram(jsonFrame([1, 2]), DEVICE)).toBeNull();
    expect(socket.sent).toEqual([]);
  });

  it('the offer keeps Python key order and fields', () => {
    const clock = new FakeClock();
    const decision = decideFindme(
      { device_uid: 'aa' },
      {
        gatewayId: 'gw-a',
        gatewayName: 'NH Gateway',
        priority: 100,
        udpPort: 13250,
        upstreamStatus: 'offline',
        isDenied: () => false,
        activeClaim: () => null,
        nowMs: clock.wallMs,
      },
    );
    expect(Object.keys(decision.reply!)).toEqual([
      'version', 'gateway_name', 'gateway_id', 'udp_port', 'priority', 'accept', 'upstream_status', 'ttl_ms', 'server_time', 'served_devices', 'type', 'device_uid',
    ]);
    expect(decision.reply!.version).toBe(OFFER_VERSION);
    expect(decision.reply!.served_devices).toBe(0);
    expect(decision.reply!.device_uid).toBe('AA');
    expect(decision.reply!.upstream_status).toBe('offline');
    expect(decision.reply!.server_time).toBe(clock.wallMs);
  });

  it('the probe is a broadcast to the FindMe port, only while started', () => {
    const { socket, r } = responder({ gatewayId: 'gw-a', gatewayName: 'Lab', udpPort: () => 40000, discoveryPort: 22346 });
    r.sendProbe();
    expect(socket.broadcasts).toHaveLength(1);
    expect(socket.broadcasts[0]!.port).toBe(22346);
    expect(utf8Decode(socket.broadcasts[0]!.data)).toBe('{"type":"findme_probe","gateway_id":"gw-a","gateway_name":"Lab","udp_port":40000}');
    r.started = false;
    r.sendProbe();
    expect(socket.broadcasts).toHaveLength(1);
  });

  it('a failing send is recorded, not thrown', () => {
    const { socket, r } = responder({ gatewayId: 'gw-a' });
    socket.fail = 'EHOSTUNREACH';
    r.handleDatagram(discover({ device_uid: UID }), DEVICE);
    r.sendProbe();
    expect(r.lastError).toBe('EHOSTUNREACH');
  });
});

describe('DiscoveryResponder: two hosts offering the same device', () => {
  function contest(serving: boolean, payload: Json = { device_uid: UID }) {
    const deferred: { ms: number; run: () => void }[] = [];
    const { socket, r } = responder({
      gatewayId: 'studio-a',
      isServing: () => serving,
      nonOwnerDelayMs: 250,
      defer: (run, ms) => void deferred.push({ run, ms }),
      activeClaim: (uid) => (payload.claim === 'mine' && uid === UID ? { claim_id: 'c-1' } : null),
    });
    r.handleDatagram(discover(payload), DEVICE);
    return { socket, deferred };
  }

  it('the host the device streams to answers at once and keeps it', () => {
    const { socket, deferred } = contest(true);
    expect(socket.sent).toHaveLength(1);
    expect(deferred).toHaveLength(0);
  });

  it('another host answers later, so it only takes over when the current one is silent', () => {
    const { socket, deferred } = contest(false);
    expect(socket.sent).toHaveLength(0);
    expect(deferred.map((d) => d.ms)).toEqual([250]);
    deferred[0]!.run();
    expect(socket.json(0)).toMatchObject({ type: 'findme_offer', accept: true, gateway_id: 'studio-a' });
  });

  it('a claim (adopt) is answered at once', () => {
    const { socket, deferred } = contest(false, { device_uid: UID, claim: 'mine' });
    expect(deferred).toHaveLength(0);
    expect(socket.json(0)).toMatchObject({ accept: true, claim_id: 'c-1' });
  });
});
