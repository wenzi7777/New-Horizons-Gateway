// End to end through the real pieces: GatewayRuntime + UpstreamClient +
// GatewayUpdateManager + RequiredUpdateAutoApplier, with only the sockets,
// the WebSocket and HTTP faked. Each piece has its own suite against fakes of
// the others; this one proves they fit together the way a host will wire them.
import { describe, expect, it } from 'vitest';

import { base64ToBytes, utf8Decode } from '../src/bytes';
import type { WsConnection, WsConnector, WsHandlers } from '../src/ports';
import { GatewayRuntime } from '../src/runtime';
import { UpstreamClient } from '../src/upstream';
import { GatewayUpdateManager, RequiredUpdateAutoApplier } from '../src/update';
import { DEVICE_ADDR, FakeClock, FakeSocket, UID, configStore, jsonFrame, timeRequest, v5Packet } from './runtime/helpers';
import { FakeHttp, FakeInstaller, nodeSha256 } from './update/fakes';

class FakeWs implements WsConnection {
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string, readonly handlers: WsHandlers) {}
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
  json(): Record<string, any>[] {
    return this.sent.filter((s) => s.startsWith('{')).map((s) => JSON.parse(s));
  }
  ofType(type: string) {
    return this.json().filter((m) => m.type === type);
  }
}

class FakeConnector implements WsConnector {
  connections: FakeWs[] = [];
  connect(url: string, _headers: Record<string, string>, handlers: WsHandlers): WsConnection {
    const ws = new FakeWs(url, handlers);
    this.connections.push(ws);
    return ws;
  }
  get last() {
    return this.connections.at(-1)!;
  }
}

async function harness() {
  const clock = new FakeClock();
  const connector = new FakeConnector();
  const stream = new FakeSocket();
  const findme = new FakeSocket();
  const http = new FakeHttp();
  const installer = new FakeInstaller();
  const store = await configStore({ enabled: true, gateway_id: 'nh-gateway-e2e', target_mode: 'local' });
  const updates = new GatewayUpdateManager({
    version: 'v2.0.0',
    platformKey: 'linux-x64',
    http,
    sha256: nodeSha256,
    clock,
    installer,
  });
  const runtime = new GatewayRuntime({
    configStore: store,
    clock,
    streamSocket: stream,
    findmeSocket: findme,
    createUpstream: (params, callbacks) =>
      new UpstreamClient({ ...params, version: 'v2.0.0', platform: 'linux-x64', connector, clock, callbacks }),
    updateControl: updates,
    createAutoApplier: (isIdle) => new RequiredUpdateAutoApplier(updates, { isIdle, clock }),
    platform: 'linux',
  });
  await runtime.start();
  // A connector opens asynchronously on real hosts; simulate the handshake.
  connector.last.handlers.onOpen();
  return { clock, connector, stream, findme, http, runtime, updates };
}

describe('gateway end to end', () => {
  it('announces itself with platform and Python-compatible hello fields', async () => {
    const { connector } = await harness();
    expect(connector.last.url).toBe('ws://127.0.0.1:5051/newhorizons/gateway/ws');
    const hello = connector.last.ofType('hello')[0]!;
    expect(hello).toMatchObject({
      gateway_id: 'nh-gateway-e2e',
      version: 'v2.0.0',
      client_type: 'gateway',
      capabilities: ['gateway_command', 'auto_update'],
      platform: 'linux-x64',
    });
  });

  it('offers to a FindMe request, relays the stream and answers time locally', async () => {
    const { runtime, findme, stream, connector, clock } = await harness();
    runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), DEVICE_ADDR);
    expect(findme.json()).toMatchObject({ type: 'findme_offer', device_uid: UID, gateway_id: 'nh-gateway-e2e', accept: true, udp_port: 13250 });

    const packet = v5Packet();
    runtime.onUdpPacket(packet, DEVICE_ADDR);
    const frames = connector.last.sent.filter((s) => s.startsWith('NHPKT1:'));
    expect(frames).toHaveLength(1);
    expect([...base64ToBytes(frames[0]!.slice('NHPKT1:'.length))]).toEqual([...packet]);

    const t1 = BigInt(clock.nowEpochUs() - 500);
    runtime.onUdpPacket(timeRequest(7, t1), DEVICE_ADDR, clock.nowEpochUs());
    const reply = stream.sent.at(-1)!;
    expect(reply.to).toEqual(DEVICE_ADDR);
    expect(reply.data.length).toBe(32);
    expect(reply.data[0]).toBe(0xe9);
    expect(reply.data[2]).toBe(7);
    // Time requests are never forwarded upstream.
    expect(connector.last.sent.filter((s) => s.startsWith('NHPKT1:'))).toHaveLength(1);
  });

  it('without FindMe a stream alone opens no command session (as in Python)', async () => {
    const { runtime, stream, connector, clock } = await harness();
    runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    const sentBefore = stream.sent.length;
    connector.last.handlers.onMessage(
      JSON.stringify({ type: 'command', device_uid: UID, payload: { command: 'status', request_id: 'r0', expires_at_ms: clock.nowMs() + 15_000 } }),
    );
    expect(stream.sent.length).toBe(sentBefore);
    expect(connector.last.ofType('device_result').at(-1)!.payload).toMatchObject({ message: 'device_not_connected_to_gateway' });
  });

  it('routes a Backend command to the device and its result back up', async () => {
    const { runtime, stream, connector, clock } = await harness();
    runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), DEVICE_ADDR);
    runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    connector.last.handlers.onMessage(
      JSON.stringify({
        type: 'command',
        device_uid: UID,
        payload: { command: 'status', request_id: 'r1', expires_at_ms: clock.nowMs() + 15_000 },
      }),
    );
    const command = JSON.parse(utf8Decode(stream.sent.at(-1)!.data));
    expect(stream.sent.at(-1)!.to).toEqual(DEVICE_ADDR);
    expect(command).toMatchObject({ type: 'command', device_uid: UID, request_id: 'r1', payload: { command: 'status' } });

    runtime.onUdpPacket(jsonFrame({ type: 'ack', device_uid: UID, ack: command.seq, request_id: 'r1' }), DEVICE_ADDR);
    runtime.onUdpPacket(
      jsonFrame({ type: 'result', device_uid: UID, request_id: 'r1', payload: { cmd: 'status', ok: true, device_uid: UID } }),
      DEVICE_ADDR,
    );
    const result = connector.last.ofType('device_result').at(-1)!;
    expect(result.device_uid).toBe(UID);
    expect(result.payload).toMatchObject({ request_id: 'r1', command: 'status', status: 'ok', transport_path: 'arduino_udp' });

    // Delivered: no resends after the result cleared it.
    const sentBefore = stream.sent.length;
    clock.advance(2);
    await runtime.tick();
    expect(stream.sent.length).toBe(sentBefore);
  });

  it('reports a device as connected in gateway_status, with platform', async () => {
    const { runtime, connector, clock } = await harness();
    runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), DEVICE_ADDR);
    runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    clock.advance(6);
    await runtime.tick();
    const status = connector.last.ofType('gateway_status').at(-1)!;
    expect(status.payload.platform).toBe('linux');
    expect(status.payload.gateway_id).toBe('nh-gateway-e2e');
    const device = status.payload.state.devices.find((d: any) => d.device_uid === UID);
    expect(device).toMatchObject({ connected: true });
    expect(status.payload.update).toMatchObject({ required_update: false });
  });

  it('a newer version from hello_ack makes the update required', async () => {
    const { connector, runtime } = await harness();
    connector.last.handlers.onMessage(JSON.stringify({ type: 'gateway_hello_ack', latest_gateway_version: 'v2.1.0' }));
    expect(runtime.updateBlock()).toMatchObject({ required_update: true, latest_gateway_version: 'v2.1.0' });
  });
});
