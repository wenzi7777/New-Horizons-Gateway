// Ported from tests/test_gateway_state.py.
import { describe, expect, it } from 'vitest';

import { GatewayState, utcIsoFormat } from '../../src/runtime';
import { FakeClock } from './helpers';

const UID = '3CDC7545CCD0';
const PEER = { ip: '192.168.1.152', port: 12345 };

function make(options: { t?: { t: number }; controlStaleSec?: number; pruneAfterSec?: number; findmeAttachWindowSec?: number } = {}) {
  const clock = new FakeClock();
  const t = options.t;
  return new GatewayState({
    clock,
    ...(t ? { now: () => t.t } : {}),
    ...(options.controlStaleSec !== undefined ? { controlStaleSec: options.controlStaleSec } : {}),
    ...(options.pruneAfterSec !== undefined ? { pruneAfterSec: options.pruneAfterSec } : {}),
    ...(options.findmeAttachWindowSec !== undefined ? { findmeAttachWindowSec: options.findmeAttachWindowSec } : {}),
    newClaimId: (() => {
      let n = 0;
      return () => `claim-${++n}`;
    })(),
  });
}

function statusReply(findmeGatewayId: string, findmeState = 'attached') {
  return { device_uid: UID, ok: true, cmd: 'status', data: { findme: { state: findmeState, gateway_id: findmeGatewayId } } };
}

describe('GatewayState', () => {
  it('default control stale window is fast offline detect', () => {
    const state = make();
    expect(state.controlStaleSec).toBeGreaterThanOrEqual(15);
    expect(state.controlStaleSec).toBeLessThanOrEqual(20);
  });

  it('powered-off device goes disconnected within the window', () => {
    const clock = { t: 1000 };
    const state = make({ t: clock, controlStaleSec: 16 });
    state.recordHeartbeat(UID, {}, PEER);
    clock.t = 1010;
    expect(state.isServing(UID)).toBe(true);
    expect(state.snapshot([]).devices[0]!.connected).toBe(true);
    clock.t = 1017;
    expect(state.isServing(UID)).toBe(false);
    const snap = state.snapshot([]);
    expect(snap.devices[0]!.connected).toBe(false);
    expect(snap.devices[0]!.findme_state).toBe('disconnected');
  });

  it('device is pruned after prune_after_sec of inactivity', () => {
    const clock = { t: 1000 };
    const state = make({ t: clock, controlStaleSec: 16, pruneAfterSec: 300 });
    state.recordHeartbeat(UID, {}, PEER);
    clock.t = 1200;
    let snap = state.snapshot([]);
    expect(snap.devices).toHaveLength(1);
    expect(snap.devices[0]!.connected).toBe(false);
    clock.t = 1301;
    expect(state.isServing(UID)).toBe(false);
    snap = state.snapshot([]);
    expect(snap.devices).toEqual([]);
  });

  it('a FindMe-only device is still prunable', () => {
    const clock = { t: 1000 };
    const state = make({ t: clock, controlStaleSec: 16, pruneAfterSec: 300 });
    state.recordFindmeRequest({ device_uid: UID }, PEER, false, 'denied');
    clock.t = 1301;
    expect(state.snapshot([]).devices).toEqual([]);
  });

  it('a forwarded UDP packet refreshes liveness', () => {
    const clock = { t: 1000 };
    const state = make({ t: clock, controlStaleSec: 16 });
    state.recordHeartbeat(UID, {}, PEER);
    clock.t = 1012;
    state.recordUdpPacket(UID, 64, true);
    clock.t = 1020;
    expect(state.isServing(UID)).toBe(true);
  });

  it('a non-forwarded UDP packet is not liveness', () => {
    const clock = { t: 1000 };
    const state = make({ t: clock, controlStaleSec: 16 });
    state.recordHeartbeat(UID, {}, PEER);
    clock.t = 1012;
    state.recordUdpPacket(UID, 64, false);
    clock.t = 1020;
    expect(state.isServing(UID)).toBe(false);
  });

  it('control attach and disconnect update findme_state', () => {
    const state = make();
    state.recordFindmeRequest({ device_uid: UID, device_name: `New Horizons OS-${UID}`, mode: 'normal' }, PEER, true);
    state.recordControl(UID, 'hello', { device_uid: UID, mode: 'normal' }, { ip: '192.168.1.152', port: 54321 }, true);
    expect(state.snapshot([]).devices[0]!.findme_state).toBe('attached');
    state.recordDisconnect(UID);
    expect(state.snapshot([]).devices[0]!.findme_state).toBe('disconnected');
  });

  it('nearby devices are marked serving and denied', () => {
    const state = make();
    state.recordFindmeRequest({ device_uid: UID, device_name: 'x', mode: 'recovery' }, PEER, true);
    state.recordFindmeRequest(
      { device_uid: 'AAAAAAAAAAAA', device_name: 'Other Device', mode: 'normal' },
      { ip: '192.168.1.160', port: 12345 },
      false,
      'device_rejected',
    );
    state.recordControl(UID, 'hello', { device_uid: UID, mode: 'recovery' }, { ip: '192.168.1.152', port: 54321 }, true);
    const nearby = Object.fromEntries(state.snapshot(['AAAAAAAAAAAA']).nearby_devices.map((i) => [i.device_uid, i]));
    expect(nearby[UID]!.serving).toBe(true);
    expect(nearby[UID]!.denied).toBe(false);
    expect(nearby.AAAAAAAAAAAA!.serving).toBe(false);
    expect(nearby.AAAAAAAAAAAA!.denied).toBe(true);
    // Serving first, then not denied, then by uid.
    expect(state.snapshot(['AAAAAAAAAAAA']).nearby_devices.map((i) => i.device_uid)).toEqual([UID, 'AAAAAAAAAAAA']);
  });

  it("a reply to our command does not claim a device attached elsewhere", () => {
    const state = make({ t: { t: 1000 } });
    state.recordControl(UID, 'result', statusReply('gw-a'), { ip: '192.168.1.152', port: 54321 }, true, 'gw-b');
    expect(state.isServing(UID)).toBe(false);
    const device = state.snapshot([]).devices[0]!;
    expect(device.connected).toBe(false);
    expect(device.findme_state).toBe('disconnected');
  });

  it('a status reply naming us attaches', () => {
    const state = make({ t: { t: 1000 } });
    state.recordControl(UID, 'result', statusReply('gw-a'), { ip: '192.168.1.152', port: 54321 }, true, 'gw-a');
    expect(state.isServing(UID)).toBe(true);
  });

  it('a status reply releases a stale attachment', () => {
    const state = make({ t: { t: 1000 } });
    state.recordHeartbeat(UID, {}, PEER);
    state.recordControl(UID, 'result', statusReply('gw-a'), { ip: '192.168.1.152', port: 54321 }, true, 'gw-b');
    expect(state.isServing(UID)).toBe(false);
  });

  it('a result without findme is not liveness', () => {
    const clock = { t: 1000 };
    const state = make({ t: clock, controlStaleSec: 16 });
    const reply = { device_uid: UID, ok: true, cmd: 'ping', data: {} };
    state.recordControl(UID, 'result', reply, { ip: '192.168.1.152', port: 54321 }, true, 'gw-b');
    expect(state.isServing(UID)).toBe(false);
    state.recordHeartbeat(UID, {}, PEER);
    clock.t = 1010;
    state.recordControl(UID, 'result', reply, { ip: '192.168.1.152', port: 54321 }, true, 'gw-b');
    expect(state.isServing(UID)).toBe(true);
    clock.t = 1017;
    expect(state.isServing(UID)).toBe(false);
  });

  it('a stale control session is not serving', () => {
    const clock = { t: 1000 };
    const state = make({ t: clock, controlStaleSec: 1 });
    state.recordFindmeRequest({ device_uid: UID, device_name: 'x', mode: 'normal' }, PEER, true);
    state.recordControl(UID, 'hello', { device_uid: UID, mode: 'normal' }, { ip: '192.168.1.152', port: 54321 }, true);
    expect(state.isServing(UID)).toBe(true);
    clock.t = 1001.1;
    const snap = state.snapshot([]);
    const nearby = Object.fromEntries(snap.nearby_devices.map((i) => [i.device_uid, i]));
    expect(snap.devices[0]!.connected).toBe(false);
    expect(snap.devices[0]!.findme_state).toBe('disconnected');
    expect(nearby[UID]!.serving).toBe(false);
    expect(state.isServing(UID)).toBe(false);
  });

  it('a heartbeat attaches a device without a recent FindMe', () => {
    const state = make();
    state.recordHeartbeat(
      UID,
      { device_uid: UID, protocol: 'NHO/Arduino/1', transport_path: 'arduino_heartbeat' },
      { ip: '192.168.1.152', port: 22345 },
    );
    const device = state.snapshot([]).devices[0]!;
    expect(device.connected).toBe(true);
    expect(device.findme_state).toBe('attached');
    expect(device.transport_path).toBe('arduino_heartbeat');
    expect(device.peer).toBe('192.168.1.152:22345');
    expect(device).toHaveProperty('last_heartbeat_at');
  });

  it('a switch command result does not complete the claim before a heartbeat', () => {
    const state = make();
    const claim = state.createClaim(UID);
    state.recordControl(
      UID,
      'result',
      {
        device_uid: UID,
        command: 'findme_switch_gateway',
        request_id: `findme-claim-${claim.claim_id}`,
        ok: true,
        message: 'findme_switch_started',
      },
      { ip: '192.168.1.152', port: 13250 },
    );
    const pending = state.activeClaimFor(UID);
    expect(pending).not.toBeNull();
    expect(pending!.state).not.toBe('attached');
    const device = state.snapshot([]).devices[0]!;
    expect(device.connected ?? false).toBe(false);
    expect(device.findme_state).not.toBe('attached');

    state.recordHeartbeat(UID, { device_uid: UID }, { ip: '192.168.1.152', port: 13250 });
    const attached = state.snapshot([]).claims.find((c) => c.claim_id === claim.claim_id)!;
    expect(attached.state).toBe('attached');
  });

  it('a delivery timeout does not downgrade an attached claim', () => {
    const state = make();
    const claim = state.createClaim(UID);
    state.recordHeartbeat(UID, {}, { ip: '192.168.1.152', port: 13250 });
    const updated = state.failClaimDelivery(claim.claim_id, 'switch_command_delivery_timeout');
    expect(updated).not.toBeNull();
    expect(updated!.state).toBe('attached');
    expect(updated!.last_error).toBe('');
  });

  it('a heartbeat does not downgrade the FindMe-reported mode', () => {
    const state = make();
    state.recordFindmeRequest({ device_uid: UID, device_name: 'x', mode: 'maintenance' }, { ip: '192.168.1.152', port: 22346 }, true);
    state.recordHeartbeat(UID, { device_uid: UID, mode: 'normal' }, { ip: '192.168.1.152', port: 22345 });
    expect(state.snapshot([]).devices[0]!.mode).toBe('maintenance');
  });

  it('an Arduino stream requires a recent accepted FindMe', () => {
    const clock = { t: 1000 };
    const state = make({ t: clock, findmeAttachWindowSec: 5 });
    const streamPeer = { ip: '192.168.1.152', port: 13250 };
    expect(state.findmeAllowsStream(UID, streamPeer)).toBe(false);
    state.recordFindmeRequest({ device_uid: UID, mode: 'normal' }, { ip: '192.168.1.152', port: 22346 }, false, 'device_rejected');
    expect(state.findmeAllowsStream(UID, streamPeer)).toBe(false);
    state.recordFindmeRequest({ device_uid: UID, mode: 'normal' }, { ip: '192.168.1.152', port: 22346 }, true);
    expect(state.findmeAllowsStream(UID, streamPeer)).toBe(true);
    expect(state.findmeAllowsStream(UID, { ip: '192.168.1.153', port: 13250 })).toBe(false);
    clock.t = 1006;
    expect(state.findmeAllowsStream(UID, streamPeer)).toBe(false);
  });

  it('an enter_maintenance result sets the mode to maintenance', () => {
    const state = make();
    state.recordHeartbeat(UID, { device_uid: UID }, { ip: '192.168.1.152', port: 22345 });
    expect(state.snapshot([]).devices[0]!.mode).toBe('normal');
    state.recordControl(
      UID,
      'result',
      { command: 'enter_maintenance', ok: true, message: 'maintenance_entered', device_uid: UID },
      { ip: '192.168.1.152', port: 13250 },
    );
    expect(state.snapshot([]).devices[0]!.mode).toBe('maintenance');
  });

  it('an exit_maintenance result sets the mode to normal', () => {
    const state = make();
    state.recordFindmeRequest({ device_uid: UID, mode: 'maintenance' }, { ip: '192.168.1.152', port: 22346 }, true);
    expect(state.snapshot([]).devices[0]!.mode).toBe('maintenance');
    state.recordControl(
      UID,
      'result',
      { command: 'exit_maintenance', ok: true, message: 'maintenance_exited', device_uid: UID },
      { ip: '192.168.1.152', port: 13250 },
    );
    expect(state.snapshot([]).devices[0]!.mode).toBe('normal');
  });

  it('a failed enter_maintenance result does not change the mode', () => {
    const state = make();
    state.recordHeartbeat(UID, { device_uid: UID }, { ip: '192.168.1.152', port: 22345 });
    state.recordControl(
      UID,
      'result',
      { command: 'enter_maintenance', ok: false, status: 'error', device_uid: UID },
      { ip: '192.168.1.152', port: 13250 },
    );
    expect(state.snapshot([]).devices[0]!.mode).toBe('normal');
  });
});

describe('GatewayState claims and records (TS additions)', () => {
  it('claims time out at expires_at_ms and leave pendingClaims', () => {
    const clock = new FakeClock();
    const state = new GatewayState({ clock, newClaimId: () => 'c1' });
    const claim = state.createClaim(UID, 5000);
    expect(claim.expires_at_ms).toBe(clock.wallMs + 5000);
    expect(state.pendingClaims()).toHaveLength(1);
    clock.advance(5.001);
    expect(state.pendingClaims()).toHaveLength(0);
    expect(state.activeClaimFor(UID)).toBeNull();
    const stored = state.snapshot([]).claims[0]!;
    expect(stored.state).toBe('timeout');
    expect(stored.last_error).toBe('claim_timeout');
  });

  it('claim TTL is floored at 1 s and defaults to 30 s', () => {
    const state = new GatewayState({ clock: new FakeClock() });
    expect(state.createClaim(UID, 10).ttl_ms).toBe(1000);
    expect(state.createClaim(UID, 0).ttl_ms).toBe(30000);
    expect(state.createClaim(UID).claim_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('the FindMe request log keeps the newest 120', () => {
    const state = make();
    for (let i = 0; i < 130; i++) state.recordFindmeRequest({ device_uid: UID, mode: String(i) }, PEER, true);
    const log = state.snapshot([]).findme_requests;
    expect(log).toHaveLength(120);
    expect(log[0]!.mode).toBe('129');
  });

  it('timestamps use Python isoformat', () => {
    expect(utcIsoFormat(Date.UTC(2026, 10, 9, 1, 2, 3, 456))).toBe('2026-11-09T01:02:03.456000+00:00');
    expect(utcIsoFormat(Date.UTC(2026, 10, 9, 1, 2, 3, 0))).toBe('2026-11-09T01:02:03+00:00');
  });

  it('the snapshot lists connected devices first', () => {
    const state = make();
    state.recordFindmeRequest({ device_uid: '000000000001' }, PEER, true);
    state.recordHeartbeat('FFFFFFFFFFFF', {}, PEER);
    expect(state.snapshot([]).devices.map((d) => d.device_uid)).toEqual(['FFFFFFFFFFFF', '000000000001']);
  });
});
