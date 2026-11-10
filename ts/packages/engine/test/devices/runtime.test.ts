// DeviceService on a real GatewayRuntime: devices on the LAN appear and go
// offline, local commands reach them, Backend commands for managed devices go
// through the same gating ("settings can be changed from any side"), and the
// FindMe roster feeds the entries and the nearby list.
import { describe, expect, it } from 'vitest';

import type { Json } from '@nhgw/core';

import { DEVICE_ADDR, UID, heartbeatPacket, jsonFrame, makeRuntime, v5Packet } from '../../../core/test/runtime/helpers';
import { DeviceService, type DeviceEvent } from '../../src/devices';

const OTHER = 'AABBCCDDEEFF';
const FINDME_FROM = { ip: DEVICE_ADDR.ip, port: 22346 };

async function setup(config: Json = {}, options: Partial<ConstructorParameters<typeof DeviceService>[0]> = {}) {
  const h = await makeRuntime(config);
  await h.runtime.start();
  let seq = 0;
  const service = new DeviceService({ clock: h.clock, newRequestId: () => `rid-${++seq}`, ...options });
  service.bindRuntime(h.runtime);
  const events: DeviceEvent[] = [];
  service.on((event) => events.push(event));
  const deviceSays = (type: string, payload: Json, extra: Json = {}) =>
    h.runtime.onUdpPacket(jsonFrame({ type, device_uid: UID, payload, ...extra }), DEVICE_ADDR);
  return { ...h, service, events, deviceSays };
}

describe('devices on the LAN', () => {
  it('a heartbeat makes a connected entry; silence takes it offline', async () => {
    const h = await setup();
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    expect(h.service.getDevice(UID)).toMatchObject({
      device_uid: UID,
      device_name: `NHOS-${UID}`,
      gateway_connected: true,
      transport_path: 'arduino_heartbeat',
      findme: { state: 'attached', host: DEVICE_ADDR.ip, udp_port: 13250 },
    });
    h.service.tick();
    expect(h.service.getDevice(UID)).toMatchObject({ gateway_id: 'gw-a', client_type: 'studio', gateway_state: { connected: true } });
    // Still served by the runtime (its 16 s window): no flicker at 12 s.
    h.clock.advance(13);
    h.service.tick();
    expect(h.service.getDevice(UID)!.gateway_connected).toBe(true);
    // The runtime drops it at 16 s; one disconnected snapshot within 5 s of
    // the last live one is ridden out (FINDME_DISCONNECT_GRACE), the next is not.
    h.clock.advance(5);
    h.service.tick();
    expect(h.service.getDevice(UID)!.gateway_connected).toBe(true);
    h.clock.advance(5);
    h.service.tick();
    expect(h.service.getDevice(UID)).toMatchObject({ gateway_connected: false, gateway_state: { connected: false } });
  });

  it('a stream packet from an attached device records its presence', async () => {
    const h = await setup();
    const packets: string[] = [];
    const s = await setup({}, { onDevicePacket: (uid, _p, _f, info) => packets.push(`${uid}:${info.kind}`) });
    s.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), FINDME_FROM);
    s.runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    expect(s.service.getDevice(UID)).toMatchObject({ transport_path: 'arduino_udp', gateway_connected: true });
    expect(packets).toEqual([`${UID}:stream`]);
    // Not attached (no FindMe, no heartbeat) but forwarded: recorded as the
    // Backend recorded what a Gateway forwarded (presence + parsed frame).
    h.runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    expect(h.service.getDevice(UID)).toMatchObject({ transport_path: 'arduino_udp', visualization_source: 'udp' });
  });

  it('status and results from the device update the entry, and still go upstream', async () => {
    const h = await setup();
    h.deviceSays('status', { device_name: 'Glove', mode: 'normal', firmware_version: 'v1.14.0' });
    h.deviceSays('result', { cmd: 'memory_status', ok: true, message: 'memory_status', memory: { heap_free: 7 } }, { request_id: 'r1' });
    expect(h.service.getDevice(UID)).toMatchObject({
      device_name: 'Glove',
      mode: 'normal',
      last_status: { memory: { heap_free: 7 } },
      last_result: { command: 'memory_status', status: 'ok', request_id: 'r1' },
    });
    expect(h.upstream().deviceMessages.map(([t]) => t)).toEqual(['status', 'result']);
    expect(h.events.filter((e) => e.type === 'command_result')).toHaveLength(1);
  });
});

describe('local commands', () => {
  it('go to the device as UDP JSON through the runtime dispatcher; the reply is a command_result', async () => {
    const h = await setup();
    h.deviceSays('status', { mode: 'normal' });
    const queued = h.service.sendCommand(UID, { command: 'scan_health' });
    expect(queued).toMatchObject({ status: 'queued', transport: 'udp', request_id: 'rid-1', peer: `${DEVICE_ADDR.ip}:${DEVICE_ADDR.port}` });
    expect(h.stream.sent.at(-1)!.to).toEqual(DEVICE_ADDR);
    expect(h.stream.json()).toMatchObject({ type: 'command', device_uid: UID, request_id: 'rid-1', payload: { command: 'scan_health' } });
    h.deviceSays('ack', {}, { request_id: 'rid-1', ack: 1 });
    h.deviceSays('result', { cmd: 'scan_health', ok: true, message: 'scan_health', measured_scan_fps: 60 }, { request_id: 'rid-1' });
    expect(h.events.find((e) => e.type === 'command_result' && e.request_id === 'rid-1')).toBeDefined();
    expect(h.runtime.udpCommands.pending.size).toBe(0);
  });

  it('a device that never acks yields a command_delivery_timeout result', async () => {
    const h = await setup();
    h.deviceSays('status', { mode: 'normal' });
    h.service.sendCommand(UID, { command: 'status' });
    for (let i = 0; i < 31; i++) {
      h.clock.advance(0.5);
      await h.runtime.tick();
    }
    const result = h.events.filter((e) => e.type === 'command_result').at(-1) as { result: Json };
    expect(result.result).toMatchObject({ request_id: 'rid-1', status: 'error', message: 'command_delivery_timeout' });
  });

  it('a device without a session is unavailable', async () => {
    const h = await setup();
    expect(() => h.service.sendCommand(UID, { command: 'status' })).toThrow('device_control_unavailable');
  });

  it('an unsynced device is pushed the time through the runtime', async () => {
    const h = await setup();
    h.deviceSays('status', { mode: 'normal', clock: { synced: false } });
    expect(h.stream.json()).toMatchObject({ payload: { command: 'set_time', quiet: true, epoch_ms: String(h.clock.wallMs) } });
  });
});

describe('commands from the server ("from any side")', () => {
  it('a managed device: gated here, refusals answered upstream as its result', async () => {
    const h = await setup({ offer_policy: 'managed', managed_devices: [UID] });
    h.deviceSays('status', { mode: 'normal' });
    h.upstream().callbacks!.onCommand(UID, { command: 'file_delete', request_id: 'srv-1', expires_at_ms: h.clock.wallMs + 15000 });
    expect(h.upstream().deviceMessages.at(-1)).toEqual([
      'result',
      { device_uid: UID, request_id: 'srv-1', command: 'file_delete', status: 'error', message: 'maintenance_required' },
    ]);
    expect(h.stream.sent.filter((s) => JSON.parse(new TextDecoder().decode(s.data)).type === 'command')).toEqual([]);
  });

  it('a managed device: an allowed command is sent with the server request_id and expiry, the reply goes back up', async () => {
    const h = await setup({ offer_policy: 'managed', managed_devices: [UID] });
    h.deviceSays('status', { mode: 'normal' });
    const expires = h.clock.wallMs + 15000;
    h.upstream().callbacks!.onCommand(UID, { command: 'set_scan_timing', target_fps: 90, request_id: 'srv-2', expires_at_ms: expires });
    expect(h.stream.json()).toMatchObject({ request_id: 'srv-2', payload: { command: 'set_scan_timing', target_fps: 90, expires_at_ms: expires } });
    expect(h.service.gating.pending.get(UID)!.has('srv-2')).toBe(true);
    h.deviceSays('result', { cmd: 'set_scan_timing', ok: true, message: 'scan_timing_updated' }, { request_id: 'srv-2' });
    expect(h.upstream().deviceMessages.at(-1)).toMatchObject(['result', { request_id: 'srv-2', command: 'set_scan_timing', status: 'ok' }]);
    // And this host saw it too.
    expect(h.service.getDevice(UID)!.last_result).toMatchObject({ request_id: 'srv-2' });
  });

  it('a managed device that is not reachable answers device_not_connected_to_gateway', async () => {
    const h = await setup({ offer_policy: 'managed', managed_devices: [UID] });
    h.upstream().callbacks!.onCommand(UID, { command: 'status', request_id: 'srv-3' });
    expect(h.upstream().deviceMessages.at(-1)![1]).toMatchObject({ request_id: 'srv-3', status: 'error', message: 'device_not_connected_to_gateway' });
  });

  it('an unmanaged device under "managed" is left to the runtime (plain Gateway routing)', async () => {
    const h = await setup({ offer_policy: 'managed', managed_devices: [] });
    h.deviceSays('status', { mode: 'recovery' });
    // The service would refuse set_scan_timing in recovery; the runtime just sends it.
    h.upstream().callbacks!.onCommand(UID, { command: 'set_scan_timing', request_id: 'srv-4' });
    expect(h.stream.json()).toMatchObject({ request_id: 'srv-4' });
    expect(h.service.gating.pending.has(UID)).toBe(false);
  });

  it('under "all" every device is this host\'s to gate', async () => {
    const h = await setup();
    h.deviceSays('status', { mode: 'normal' });
    h.upstream().callbacks!.onCommand(UID, { command: 'write_os', request_id: 'srv-5' });
    expect(h.upstream().deviceMessages.at(-1)![1]).toMatchObject({ request_id: 'srv-5', message: 'unknown_command' });
  });
});

describe('nearby, adopt and release', () => {
  it('lists FindMe devices marked managed / released, and announces changes', async () => {
    const h = await setup({ offer_policy: 'managed', managed_devices: [UID] });
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), FINDME_FROM);
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: OTHER, current_gateway_id: 'server' }), FINDME_FROM);
    const nearby = Object.fromEntries(h.service.nearby().map((d) => [d.device_uid, d]));
    expect(nearby[UID]).toMatchObject({ managed: true, released: false, findme_accepted: true });
    expect(nearby[OTHER]).toMatchObject({ managed: false, findme_reason: 'device_attached_elsewhere' });
    expect(h.events.filter((e) => e.type === 'nearby_update')).toHaveLength(2);

    expect((await h.runtime.operations().adopt(OTHER)).ok).toBe(true);
    await h.runtime.operations().release(UID);
    const after = Object.fromEntries(h.service.nearby().map((d) => [d.device_uid, d]));
    expect(after[OTHER]!.managed).toBe(true);
    expect(after[UID]).toMatchObject({ managed: false, released: true });
    // Released: the server's commands for it are no longer this host's to gate.
    h.upstream().callbacks!.onCommand(UID, { command: 'write_os', request_id: 'srv-6' });
    expect(h.upstream().deviceMessages.at(-1)![1]).toMatchObject({ message: 'device_not_connected_to_gateway' });
  });
});
