// GatewayRuntime (main.py): the UDP demux, forwarding rules, command routing,
// upstream messages, gateway_status and the tick loop. Mostly behaviour the
// Python suite did not cover; the demux-order case is test_time_service.py's.
import { describe, expect, it } from 'vitest';

import type { Json } from '../../src/contracts';
import { GATEWAY_STATUS_INTERVAL_MS } from '../../src/runtime';
import { DEVICE_ADDR, UID, heartbeatPacket, jsonFrame, makeRuntime, timeRequest, v5Packet } from './helpers';

async function started(config: Json = {}) {
  const h = await makeRuntime(config);
  await h.runtime.start();
  return h;
}

describe('UDP demux', () => {
  it('answers a time request first, locally, and never forwards it', async () => {
    const h = await started();
    const rx = h.clock.nowEpochUs() - 250;
    h.runtime.onUdpPacket(timeRequest(7, 123456789n), DEVICE_ADDR, rx);
    expect(h.stream.sent).toHaveLength(1);
    const reply = h.stream.sent[0]!;
    expect(reply.to).toEqual(DEVICE_ADDR);
    const view = new DataView(reply.data.buffer, reply.data.byteOffset, reply.data.byteLength);
    expect(reply.data[0]).toBe(0xe9);
    expect(reply.data[2]).toBe(7);
    expect(view.getBigInt64(4, true)).toBe(123456789n);
    expect(view.getBigInt64(12, true)).toBe(BigInt(rx)); // t2 = the host's receive stamp
    expect(view.getBigInt64(20, true)).toBe(BigInt(h.clock.nowEpochUs())); // t3 read when replying
    expect(h.upstream().packets).toEqual([]);
    expect(h.upstream().deviceMessages).toEqual([]);
    expect(h.runtime.state.snapshot([]).devices).toEqual([]);
  });

  it('stamps t2 from the clock when the host gives no receive time', async () => {
    const h = await started();
    h.runtime.onUdpPacket(timeRequest(1, 5n), DEVICE_ADDR);
    const data = h.stream.sent[0]!.data;
    expect(new DataView(data.buffer).getBigInt64(12, true)).toBe(BigInt(h.clock.nowEpochUs()));
  });

  it('a failing time reply is swallowed', async () => {
    const h = await started();
    h.stream.fail = 'ENETUNREACH';
    expect(() => h.runtime.onUdpPacket(timeRequest(1, 5n), DEVICE_ADDR)).not.toThrow();
  });

  it('ignores datagrams while the Gateway is disabled', async () => {
    const h = await started({ enabled: false });
    h.runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    h.runtime.onUdpPacket(timeRequest(1, 5n), DEVICE_ADDR);
    expect(h.upstream().packets).toEqual([]);
    expect(h.stream.sent).toEqual([]);
  });
});

describe('stream forwarding', () => {
  it('forwards a complete stream packet without a FindMe attachment, but does not attach the device', async () => {
    const h = await started();
    const packet = v5Packet();
    h.runtime.onUdpPacket(packet, DEVICE_ADDR);
    expect(h.upstream().packets).toEqual([packet]);
    const device = h.runtime.state.snapshot([]).devices[0]!;
    expect(device.udp_forwarded).toBe(1);
    expect(device.connected).toBeUndefined();
    expect(h.runtime.udpCommands.sessions.has(UID)).toBe(false);
  });

  it('attaches a streaming device after an accepted FindMe from the same IP', async () => {
    const h = await started();
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), { ip: DEVICE_ADDR.ip, port: 22346 });
    expect(h.findme.json(0).accept).toBe(true);
    h.runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    const device = h.runtime.state.snapshot([]).devices[0]!;
    expect(device.connected).toBe(true);
    expect(device.transport_path).toBe('arduino_udp');
    expect(device.device_name).toBe(`NHOS-${UID}`);
    expect(h.runtime.udpCommands.sessions.get(UID)).toEqual(DEVICE_ADDR);
  });

  it('keeps attaching a device that already streamed/heartbeated from the same IP', async () => {
    const h = await started();
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    h.clock.advance(100); // past the session TTL and the stale window
    h.runtime.onUdpPacket(v5Packet(), { ip: DEVICE_ADDR.ip, port: 5555 });
    expect(h.runtime.state.isServing(UID)).toBe(true);
    expect(h.runtime.udpCommands.sessions.get(UID)).toEqual({ ip: DEVICE_ADDR.ip, port: 5555 });
  });

  it('never forwards a denied device, and counts the drop', async () => {
    const h = await started({ denied_devices: [UID] });
    h.runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    expect(h.upstream().packets).toEqual([]);
    const device = h.runtime.state.snapshot([]).devices[0]!;
    expect(device.udp_dropped).toBe(1);
    expect(device.connected).toBeUndefined();
  });

  it('forwards an incomplete packet only while the device is served (loose UID routing)', async () => {
    const h = await started();
    const truncated = v5Packet(UID, 100, 0, 10);
    h.runtime.onUdpPacket(truncated, DEVICE_ADDR);
    expect(h.upstream().packets).toEqual([]);
    expect(h.runtime.state.snapshot([]).devices[0]!.udp_dropped).toBe(1);
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    h.runtime.onUdpPacket(truncated, DEVICE_ADDR);
    expect(h.upstream().packets).toEqual([truncated]);
  });

  it('a heartbeat opens a session and attaches, but is neither forwarded nor counted', async () => {
    const h = await started();
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    expect(h.upstream().packets).toEqual([]);
    const device = h.runtime.state.snapshot([]).devices[0]!;
    expect(device.connected).toBe(true);
    expect(device.last_control_type).toBe('heartbeat');
    expect(device.udp_packets).toBe(0);
    expect(h.runtime.udpCommands.sessions.get(UID)).toEqual(DEVICE_ADDR);
  });

  it('ignores packets without the stream magic', async () => {
    const h = await started();
    h.runtime.onUdpPacket(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), DEVICE_ADDR);
    expect(h.upstream().packets).toEqual([]);
    expect(h.runtime.state.snapshot([]).devices).toEqual([]);
  });
});

describe('JSON control frames', () => {
  it('relays hello upstream with the defaults filled in and records the device', async () => {
    const h = await started();
    h.runtime.onUdpPacket(jsonFrame({ type: 'hello', device_uid: '3c:dc:75:45:cc:d0', payload: { mode: 'normal' } }), DEVICE_ADDR);
    expect(h.upstream().deviceMessages).toEqual([
      ['hello', { mode: 'normal', device_uid: UID, request_id: '', received_at_ms: h.clock.wallMs }],
    ]);
    expect(h.runtime.state.isServing(UID)).toBe(true);
    expect(h.runtime.udpCommands.sessions.get(UID)).toEqual(DEVICE_ADDR);
  });

  it('normalizes a result (cmd -> command, ok -> status, transport_path) and clears the pending command', async () => {
    const h = await started();
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    h.runtime.onCommand(UID, { command: 'ping', request_id: 'r1' });
    expect(h.runtime.udpCommands.pending.size).toBe(1);
    h.runtime.onUdpPacket(
      jsonFrame({ type: 'result', device_uid: UID, request_id: 'r1', payload: { cmd: 'ping', ok: true } }),
      DEVICE_ADDR,
    );
    expect(h.runtime.udpCommands.pending.size).toBe(0);
    const [type, data] = h.upstream().deviceMessages.at(-1)!;
    expect(type).toBe('result');
    expect(data).toMatchObject({ cmd: 'ping', command: 'ping', ok: true, status: 'ok', transport_path: 'arduino_udp', request_id: 'r1' });
  });

  it('acks are consumed locally', async () => {
    const h = await started();
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    h.runtime.onCommand(UID, { command: 'ping', request_id: 'r1' });
    h.runtime.onUdpPacket(jsonFrame({ type: 'ack', device_uid: UID, request_id: 'r1' }), DEVICE_ADDR);
    expect(h.runtime.udpCommands.snapshot().commands_acked).toBe(1);
    expect(h.upstream().deviceMessages).toEqual([]);
  });

  it('a malformed ack drops the datagram instead of throwing', async () => {
    const h = await started();
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    h.runtime.onCommand(UID, { command: 'ping' });
    expect(() => h.runtime.onUdpPacket(jsonFrame({ type: 'ack', device_uid: UID, ack: 'x' }), DEVICE_ADDR)).not.toThrow();
  });

  it('reassembles result chunks before relaying', async () => {
    const h = await started();
    const full = JSON.stringify({ cmd: 'status', ok: true, data: { battery: 80 } });
    const half = Math.floor(full.length / 2);
    const chunk = (i: number, data: string) =>
      jsonFrame({ type: 'result_chunk', device_uid: UID, request_id: 'big', chunk: i, chunks: 2, data });
    h.runtime.onUdpPacket(chunk(1, full.slice(half)), DEVICE_ADDR);
    expect(h.upstream().deviceMessages).toEqual([]);
    h.runtime.onUdpPacket(chunk(0, full.slice(0, half)), DEVICE_ADDR);
    const [type, data] = h.upstream().deviceMessages[0]!;
    expect(type).toBe('result');
    expect(data).toMatchObject({ command: 'status', status: 'ok', request_id: 'big', device_uid: UID });
  });

  it('drops frames from denied or unidentifiable devices, and unknown types', async () => {
    const h = await started({ denied_devices: [UID] });
    h.runtime.onUdpPacket(jsonFrame({ type: 'hello', device_uid: UID }), DEVICE_ADDR);
    h.runtime.onUdpPacket(jsonFrame({ type: 'hello', device_uid: '000000000000' }), DEVICE_ADDR);
    h.runtime.onUdpPacket(jsonFrame({ type: 'telemetry', device_uid: 'AABBCCDDEEFF' }), DEVICE_ADDR);
    h.runtime.onUdpPacket(jsonFrame({ type: 'hello', payload: { device_id: 'AABBCCDDEEFF' } }), DEVICE_ADDR);
    expect(h.upstream().deviceMessages.map(([t, d]) => [t, d.device_uid])).toEqual([['hello', 'AABBCCDDEEFF']]);
    // The unknown type still opened a session (Python set it before looking at the type).
    expect(h.runtime.udpCommands.sessions.has('AABBCCDDEEFF')).toBe(true);
  });

  it('a result naming another Gateway does not attach the device here', async () => {
    const h = await started();
    h.runtime.onUdpPacket(
      jsonFrame({ type: 'result', device_uid: UID, payload: { cmd: 'status', ok: true, data: { findme: { gateway_id: 'gw-z', state: 'attached' } } } }),
      DEVICE_ADDR,
    );
    expect(h.runtime.state.isServing(UID)).toBe(false);
  });
});

describe('commands from the Backend', () => {
  it('reports command_expired with the raw uid', async () => {
    const h = await started();
    h.runtime.onCommand('3c:dc:75:45:cc:d0', { command: 'status', request_id: 'r1', expires_at_ms: h.clock.wallMs - 1 });
    expect(h.upstream().deviceMessages).toEqual([
      ['result', { device_uid: '3c:dc:75:45:cc:d0', request_id: 'r1', command: 'status', status: 'error', message: 'command_expired' }],
    ]);
    expect(h.stream.sent).toEqual([]);
  });

  it('reports device_not_connected_to_gateway without a session', async () => {
    const h = await started();
    h.runtime.onCommand('3c:dc:75:45:cc:d0', { command: 'status', request_id: 'r1', expires_at_ms: h.clock.wallMs + 15000 });
    expect(h.upstream().deviceMessages).toEqual([
      ['result', { device_uid: UID, request_id: 'r1', command: 'status', status: 'error', message: 'device_not_connected_to_gateway' }],
    ]);
  });

  it('sends to the session address', async () => {
    const h = await started();
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    h.runtime.onCommand(UID, { command: 'status', request_id: 'r1' });
    expect(h.stream.sent).toHaveLength(1);
    expect(h.stream.sent[0]!.to).toEqual(DEVICE_ADDR);
    expect(h.stream.json(0)).toMatchObject({ type: 'command', device_uid: UID, request_id: 'r1' });
    expect(h.upstream().deviceMessages).toEqual([]);
  });

  it('reports command_delivery_timeout when the device never acks', async () => {
    const h = await started();
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    h.runtime.onCommand(UID, { command: 'status', request_id: 'r1', expires_at_ms: h.clock.wallMs + 2000 });
    for (let i = 0; i < 6; i++) {
      h.clock.advance(0.5);
      await h.runtime.tick();
    }
    expect(h.upstream().deviceMessages).toContainEqual([
      'result',
      { device_uid: UID, request_id: 'r1', command: 'status', status: 'error', message: 'command_delivery_timeout' },
    ]);
  });
});

describe('FindMe claims (serve)', () => {
  it('serve() claims, tells the Backend, and sends findme_switch_gateway to the last FindMe IP on 13250', async () => {
    const h = await started();
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID, current_gateway_id: 'gw-z' }), { ip: '10.0.0.9', port: 22346 });
    expect(h.findme.sent).toEqual([]); // attached elsewhere: recorded, not offered
    const result = await h.runtime.operations().serve(UID.toLowerCase());
    expect(h.runtime.configStore.isOwned(UID)).toBe(true);
    expect(result.ok).toBe(true);
    expect((result.data.claim as Json).state).toBe('requested');
    expect(h.upstream().claims).toEqual([[UID, 'claim-1', 30000]]);
    expect(h.stream.sent).toHaveLength(1);
    expect(h.stream.sent[0]!.to).toEqual({ ip: '10.0.0.9', port: 13250 });
    expect(h.stream.json(0)).toMatchObject({
      type: 'command',
      request_id: 'findme-claim-claim-1',
      payload: {
        command: 'findme_switch_gateway',
        preferred_gateway_id: 'gw-a',
        claim_id: 'claim-1',
        ttl_ms: 30000,
        expires_at_ms: h.clock.wallMs + 30000,
      },
    });
  });

  it('a switch command that is never delivered fails the claim', async () => {
    const h = await started();
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID, current_gateway_id: 'gw-z' }), { ip: '10.0.0.9', port: 22346 });
    await h.runtime.operations().serve(UID);
    for (let i = 0; i < 62; i++) {
      h.clock.advance(0.5);
      await h.runtime.tick();
    }
    const claim = h.runtime.state.snapshot([]).claims[0]!;
    expect(claim.state).toBe('failed');
    expect(claim.last_error).toBe('switch_command_delivery_timeout');
    expect(h.upstream().deviceMessages.at(-1)![1].message).toBe('command_delivery_timeout');
  });

  it('serve() works while upstream is offline (a local claim only)', async () => {
    const h = await started();
    h.upstream().connected = false;
    expect(await h.runtime.operations().serve(UID)).toMatchObject({ ok: true });
    expect(h.upstream().claims).toEqual([]);
  });

  it('gateway_claim_update updates the claim', async () => {
    const h = await started();
    await h.runtime.operations().serve(UID);
    h.runtime.onUpstreamMessage({ type: 'gateway_claim_update', claim_id: 'claim-1', state: 'rejected', message: 'owner_busy' });
    const claim = h.runtime.state.snapshot([]).claims[0]!;
    expect(claim.state).toBe('rejected');
    expect(claim.last_error).toBe('owner_busy');
  });
});

describe('upstream messages', () => {
  it('gateway_hello_ack with a newer version makes the update required and locks operations', async () => {
    const h = await started();
    h.runtime.onUpstreamMessage({ type: 'gateway_hello_ack', latest_gateway_version: 'v9.0.0' });
    expect(h.updates.required).toBe(true);
    const result = await h.runtime.operations().deny(UID);
    expect(result).toMatchObject({ ok: false, error: 'update_required', status: 409 });
    expect(h.runtime.operations().discover().status).toBe(409);
    expect((await h.runtime.operations().saveSettings({ gateway_id: 'gw-b' })).error).toBe('update_required');
  });

  it('gateway_command is routed to the command handler and replied over upstream', async () => {
    const h = await started();
    h.runtime.onUpstreamMessage({ type: 'gateway_command', request_id: 'q1', payload: { command: 'discover' } });
    await h.runtime.idle();
    expect(h.upstream().commandResults).toEqual([['q1', { ok: true, message: 'discover_sent', command: 'discover' }]]);
    expect(h.findme.broadcasts).toHaveLength(1);
  });

  it('a remote restart goes through the updater to the host', async () => {
    const h = await started();
    h.runtime.onUpstreamMessage({ type: 'gateway_command', request_id: 'q1', payload: { command: 'restart' } });
    await h.runtime.idle();
    expect(h.updates.restarts).toBe(0);
    h.clock.advance(1);
    await h.runtime.tick();
    expect(h.updates.restarts).toBe(1);
    expect(h.restartRequests).toBe(1);
    expect(h.runtime.restartRequested).toBe(true);
  });

  it('the upstream link callbacks reach the runtime', async () => {
    const h = await started();
    h.upstream().callbacks!.onCommand(UID, { command: 'status' });
    expect(h.upstream().deviceMessages[0]![1].message).toBe('device_not_connected_to_gateway');
  });
});

describe('gateway_status and the tick loop', () => {
  it('sends gateway_status on the first tick and every 5 s, with every field main.py sends plus platform', async () => {
    const h = await started({ gateway_name: 'Lab GW', update_channel: 'beta', remote_management: false });
    await h.runtime.tick();
    expect(h.upstream().statuses).toHaveLength(1);
    const status = h.upstream().statuses[0]!;
    expect(Object.keys(status)).toEqual([
      'gateway_name', 'gateway_id', 'enabled', 'version', 'update_channel', 'target_mode', 'server_url',
      'listen_udp_port', 'listen_discovery_port', 'upstream', 'udp_control', 'state', 'update', 'remote_management', 'platform',
    ]);
    expect(status).toMatchObject({
      gateway_name: 'Lab GW',
      gateway_id: 'gw-a',
      enabled: true,
      version: 'v2.0.0',
      update_channel: 'beta',
      target_mode: 'local',
      server_url: 'ws://127.0.0.1:5051/newhorizons/gateway/ws',
      listen_udp_port: 13250,
      listen_discovery_port: 22346,
      remote_management: false,
      platform: 'android',
    });
    expect(Object.keys(status.udp_control as Json)).toEqual([
      'sessions', 'pending', 'commands_sent', 'commands_retried', 'commands_acked', 'commands_timeout', 'last_command', 'last_error',
    ]);
    expect(Object.keys(status.state as Json)).toEqual(['devices', 'denied_devices', 'findme_requests', 'nearby_devices', 'claims']);
    expect((status.update as Json).channel).toBe('beta');

    h.clock.advance(4.5);
    await h.runtime.tick();
    expect(h.upstream().statuses).toHaveLength(1);
    h.clock.advance(GATEWAY_STATUS_INTERVAL_MS / 1000 - 4.5);
    await h.runtime.tick();
    expect(h.upstream().statuses).toHaveLength(2);
  });

  it('uses the host-bound ports when the host reports them', async () => {
    const h = await makeRuntime({}, { boundUdpPort: () => 40001, boundDiscoveryPort: () => 40002 });
    await h.runtime.start();
    const status = h.runtime.gatewayStatus();
    expect(status.listen_udp_port).toBe(40001);
    expect(status.listen_discovery_port).toBe(40002);
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), DEVICE_ADDR);
    expect(h.findme.json(0).udp_port).toBe(40001);
  });

  it('pushes gateway_status right after a remote command', async () => {
    const h = await started();
    await h.runtime.tick();
    h.runtime.onUpstreamMessage({ type: 'gateway_command', request_id: 'q', payload: { command: 'discover' } });
    await h.runtime.idle();
    h.clock.advance(0.5);
    await h.runtime.tick();
    expect(h.upstream().statuses).toHaveLength(2);
  });

  it('publishes the console status with the Python fields', async () => {
    const h = await started();
    expect(Object.keys(h.console.at(-1)!).sort()).toEqual(
      [
        'current_version', 'enabled', 'gateway_id', 'gateway_name', 'latest_gateway_version', 'listen_discovery_port',
        'listen_udp_port', 'required_update', 'server_url', 'target_mode', 'upstream_connected', 'web_ui_url',
      ].sort(),
    );
    expect(h.console.at(-1)!.web_ui_url).toBe('http://127.0.0.1:5052');
  });

  it('checks for updates on the first tick, then every max(60 s, interval), one at a time', async () => {
    const h = await started();
    h.updates.autoCheckIntervalMs = 1000; // floored to 60 s
    await h.runtime.tick();
    await h.runtime.idle();
    expect(h.updates.checks).toBe(1);
    h.clock.advance(59);
    await h.runtime.tick();
    expect(h.updates.checks).toBe(1);
    h.clock.advance(1);
    await h.runtime.tick();
    await h.runtime.idle();
    expect(h.updates.checks).toBe(2);
  });

  it('services the auto-applier, idle meaning no device served', async () => {
    const h = await started();
    await h.runtime.tick();
    expect(h.applier().services).toBe(1);
    expect(h.applier().isIdle()).toBe(true);
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    expect(h.applier().isIdle()).toBe(false);
    expect((h.runtime.updateBlock() as Json).current_version).toBe('v2.0.0');
  });

  it('a throwing upstream does not stop the loop', async () => {
    const h = await started();
    h.upstream().sendGatewayStatus = () => {
      throw new Error('queue closed');
    };
    await expect(h.runtime.tick()).resolves.toBeUndefined();
    expect(h.applier().services).toBe(1);
  });
});

describe('applyRuntimeConfig and lifecycle', () => {
  it('starts the services when enabled and stops them when disabled', async () => {
    const h = await started();
    expect(h.services).toEqual([{ udp: true, discovery: true }]);
    expect(h.upstream().started).toBe(1);
    expect(h.runtime.running).toBe(true);
    const result = await h.runtime.operations().saveSettings({ enabled: false });
    expect(result.ok).toBe(true);
    expect(h.services.at(-1)).toEqual({ udp: false, discovery: false });
    expect(h.upstream().stopped).toBe(1);
    expect(h.runtime.running).toBe(false);
  });

  it('a disabled Gateway starts nothing', async () => {
    const h = await started({ enabled: false });
    expect(h.services).toEqual([]);
    expect(h.upstream().started).toBe(0);
  });

  it('discovery disabled: no FindMe service, no offers, configured port reported', async () => {
    const h = await started({ discovery_enabled: false, listen_discovery_port: 23000 });
    expect(h.services).toEqual([{ udp: true, discovery: false }]);
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), DEVICE_ADDR);
    expect(h.findme.sent).toEqual([]);
    expect(h.runtime.gatewayStatus().listen_discovery_port).toBe(23000);
  });

  it('a new Gateway ID rebuilds the upstream link (gatewayId is read-only) and restarts it', async () => {
    const h = await started();
    const first = h.upstream();
    await h.runtime.operations().saveSettings({ gateway_id: 'gw-b' });
    expect(h.upstreams).toHaveLength(2);
    expect(first.stopped).toBe(1);
    expect(h.upstream().gatewayId).toBe('gw-b');
    expect(h.upstream().started).toBe(1);
    expect(h.runtime.upstream).toBe(h.upstream());
    expect(h.runtime.discovery!.gatewayId).toBe('gw-b');
  });

  it('the same ID reconnects the existing link to the new URL', async () => {
    const h = await started();
    await h.runtime.operations().saveSettings({ target_mode: 'manual', manual_url: 'ws://10.0.0.2:5051/x' });
    expect(h.upstreams).toHaveLength(1);
    expect(h.upstream().serverUrl).toBe('ws://10.0.0.2:5051/x');
  });

  it('a channel change reaches the updater and the link', async () => {
    const h = await started();
    await h.runtime.operations().setUpdateChannel('beta');
    expect(h.updates.channel).toBe('beta');
    expect(h.upstream().channel).toBe('beta');
  });

  it('stop() closes everything and later ticks do nothing', async () => {
    const h = await started();
    await h.runtime.stop();
    expect(h.services.at(-1)).toEqual({ udp: false, discovery: false });
    expect(h.upstream().stopped).toBe(1);
    await h.runtime.tick();
    expect(h.upstream().statuses).toEqual([]);
  });
});
