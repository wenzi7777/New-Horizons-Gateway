// The host end to end against the fake native module: adopt, stream,
// record live (CSV + .nhraw), and recover a capture a killed app left.
import { afterEach, describe, expect, it } from 'vitest';
import { base64ToBytes, utf8Decode, type WsConnection, type WsConnector, type WsHandlers } from '@nhgw/core';

import { encodePacket, FLAG } from '../../engine/test/parse/packets';
import { convertRaw } from '@nhgw/engine';

import { PATHS } from '../src/files';
import { AppHost } from '../src/host';
import { recoverCaptures } from '../src/recovery';
import { FakeNative } from './fakeNative';

const UID = '3CDC7545CCD0';

/** An upstream that never connects (offline phone). */
class OfflineConnector implements WsConnector {
  urls: string[] = [];
  connect(url: string, _headers: Record<string, string>, _handlers: WsHandlers): WsConnection {
    this.urls.push(url);
    return { send() {}, close() {} };
  }
}

const hosts: AppHost[] = [];

function makeHost(native: FakeNative, connector = new OfflineConnector()) {
  const shared: string[] = [];
  const host = new AppHost({
    native,
    clientType: 'pocket',
    platform: 'android',
    connector,
    share: async (uri) => {
      shared.push(uri);
    },
    logger: { info() {}, warn() {}, error() {} },
    tickIntervalMs: 60_000,
  });
  hosts.push(host);
  return { host, shared, connector };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

function frame(native: FakeNative, frameId: number, values: number[]) {
  native.nowUs += 16_667;
  native.receive(13250, encodePacket({ uid: UID, frameId, timestamp: frameId * 17, matrix: values }));
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('AppHost (pocket)', () => {
  it('first start writes a managed, relay-on config with a pocket id', async () => {
    const native = new FakeNative();
    const { host, connector } = makeHost(native);
    await host.start();
    const config = JSON.parse(native.text(PATHS.config)!) as Record<string, unknown>;
    expect(config.gateway_id).toMatch(/^pocket-[0-9a-f]{8}$/);
    expect(config.offer_policy).toBe('managed');
    expect(config.enabled).toBe(true);
    expect(host.settings()).toMatchObject({ relayEnabled: true, serverTarget: 'production', offerPolicy: 'managed' });
    expect(connector.urls[0]).toBe('wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws');
    expect(native.running).toBe(true);
    expect(host.status().upstream).toBe('connecting');
    // stable snapshots between changes
    expect(host.devices()).toBe(host.devices());

    await host.updateSettings({ relayEnabled: false, displayName: 'Bench phone' });
    expect(host.status().upstream).toBe('offline');
    expect(host.settings()).toMatchObject({ relayEnabled: false, displayName: 'Bench phone' });
    expect(JSON.parse(native.text(PATHS.config)!).gateway_name).toBe('Bench phone');
  });

  it('adopts a device, shows it, records it live and drops the raw capture after a clean stop', async () => {
    const native = new FakeNative();
    const { host, shared } = makeHost(native);
    await host.start();
    expect((await host.adopt(UID)).ok).toBe(true);
    native.receive(13250, encodePacket({ uid: UID, frameId: 0, flags: FLAG.HEARTBEAT }));
    frame(native, 1, [1, 2]);
    const device = host.devices().find((item) => item.uid === UID);
    expect(device).toMatchObject({ uid: UID, online: true });

    const live: number[][] = [];
    const off = host.subscribeLive(UID, (f) => live.push(f.values));
    frame(native, 2, [3, 4]);
    off();
    expect(live[0]).toEqual([3, 4]);

    expect((await host.setRecording(UID, true)).ok).toBe(true);
    expect(native.activeCaptures()).toHaveLength(1);
    const rawPath = native.activeCaptures()[0]!;
    for (let i = 3; i <= 12; i++) frame(native, i, [i, i + 0.5]);
    const deleted = new Map<string, Uint8Array>();
    const realDelete = native.deletePath.bind(native);
    native.deletePath = (path: string) => {
      const bytes = native.files.get(path);
      if (bytes) deleted.set(path, bytes);
      return realDelete(path);
    };
    expect((await host.setRecording(UID, false)).ok).toBe(true);
    expect(native.activeCaptures()).toHaveLength(0);
    // The capture converts to exactly what was written live (the engine saw native's arrival times).
    const converted = convertRaw(deleted.get(rawPath)!, { dataRoot: PATHS.dataRoot });
    expect([...converted.files.keys()].map((p) => p.slice(p.indexOf('.'))).sort()).toEqual(['.data.csv', '.meta.json']);
    for (const [path, text] of converted.files) expect(native.text(path), path).toBe(text);
    expect(native.files.has(rawPath)).toBe(false); // clean finish: only the CSV stays
    const recordings = host.recordings();
    expect(recordings).toHaveLength(1);
    expect(recordings[0]).toMatchObject({ uid: UID, frames: 10, inProgress: false });
    const data = [...native.files.keys()].find((path) => path.endsWith('.data.csv'))!;
    expect(native.text(data)!.trim().split('\r\n')).toHaveLength(11);

    const timeline = await host.timeline(recordings[0]!.id);
    expect(timeline.buckets.length).toBeGreaterThan(0);
    await host.exportRecording(recordings[0]!.id);
    expect(native.zips[0]).toMatchObject({ path: `recordings/${recordings[0]!.id}`, skip: '.nhraw' });
    expect(shared[0]).toMatch(/^file:\/\/\/cache\/export\/3CDC7545CCD0_\d{8}_\d{6}\.zip$/);
    await host.deleteRecording(recordings[0]!.id);
    expect(host.recordings()).toHaveLength(0);
  });

  it('a device adopted by another Studio / Pocket leaves this host\'s devices; other relays do not take it', async () => {
    const native = new FakeNative();
    const { host } = makeHost(native);
    await host.start();
    await host.adopt(UID);
    const enc = (o: object) => new TextEncoder().encode(JSON.stringify(o));
    const dev = { ip: '192.168.1.250', port: 5000 };
    const probeReply = (current: string) => ({ type: 'findme_discover', device_uid: UID, current_gateway_id: current });
    native.receive(13250, encodePacket({ uid: UID, frameId: 0, flags: FLAG.HEARTBEAT }), dev);
    expect(host.devices().map((d) => d.uid)).toEqual([UID]);
    native.receive(22346, enc(probeReply('hub-1')), dev); // not an app relay: ownership stays
    await settle();
    expect(host.devices().map((d) => d.uid)).toEqual([UID]);
    native.receive(22346, enc(probeReply('studio-0a1b2c3d')), dev);
    await settle();
    expect(host.devices()).toEqual([]);
    expect(JSON.parse(native.text(PATHS.config)!).managed_devices).toEqual([]);
    expect(host.nearby().map((d) => [d.uid, d.attachedTo])).toEqual([[UID, 'studio-0a1b2c3d']]);
  });

  it('a killed recording is rebuilt from its .nhraw on the next start', async () => {
    const native = new FakeNative();
    const first = makeHost(native).host;
    await first.start();
    await first.adopt(UID);
    native.receive(13250, encodePacket({ uid: UID, frameId: 0, flags: FLAG.HEARTBEAT }));
    await first.setRecording(UID, true);
    for (let i = 1; i <= 20; i++) frame(native, i, [i, 2 * i]);
    // The app dies: no stop, no shutdown. JS saw only the first 20 frames;
    // native keeps capturing 10 more before the process is gone.
    hosts.splice(hosts.indexOf(first), 1);
    const sidecar = [...native.files.keys()].find((path) => path.startsWith(`${PATHS.rawDir}/`) && path.endsWith('.json'))!;
    expect(JSON.parse(native.text(sidecar)!).live_directory).toMatch(/^recordings\/3CDC7545CCD0\/\d{8}\/\d{6}$/);
    native.detachJs();
    for (let i = 21; i <= 30; i++) frame(native, i, [i, 2 * i]); // captured natively only
    native.kill();
    const liveDir = JSON.parse(native.text(sidecar)!).live_directory as string;
    const partialMeta = [...native.files.keys()].find((path) => path.startsWith(liveDir) && path.endsWith('.meta.json'))!;
    expect(JSON.parse(native.text(partialMeta)!).recording.stopped_at).toBeNull();

    const second = makeHost(native).host;
    await second.start();
    await settle();
    expect([...native.files.keys()].some((path) => path.endsWith('.nhraw'))).toBe(false);
    const meta = JSON.parse(native.text(partialMeta)!) as { recording: Record<string, unknown> };
    expect(meta.recording.stop_reason).toBe('server_stopped');
    expect(meta.recording.rows).toBe(30); // the frames JS never saw are in it too
    expect(second.recordings()).toHaveLength(1);
  });

  it('recovery keeps a capture it cannot read, renamed so it is not retried', async () => {
    const native = new FakeNative();
    native.mkdirp(PATHS.rawDir);
    native.files.set(`${PATHS.rawDir}/AAAAAAAAAAAA-1.nhraw`, new Uint8Array(40)); // bad header
    const outcomes = await recoverCaptures({ native, logger: { info() {}, warn() {}, error() {} }, yieldToUi: async () => {} });
    expect(outcomes[0]!.error).not.toBe('');
    expect(native.files.has(`${PATHS.rawDir}/AAAAAAAAAAAA-1.nhraw.failed`)).toBe(true);
  });

  it('quick commands go to the device and fail fast when it is unreachable', async () => {
    const native = new FakeNative();
    const { host } = makeHost(native);
    await host.start();
    expect(await host.run(UID, { kind: 'status' })).toMatchObject({ ok: false, message: 'device_control_unavailable' });
    await host.adopt(UID);
    native.receive(13250, encodePacket({ uid: UID, frameId: 0, flags: FLAG.HEARTBEAT }), { ip: '192.168.1.50', port: 4210 });
    const pending = host.run(UID, { kind: 'scan_rate', fps: 90 });
    const sent = native.sent.filter((item) => item.localPort === 13250).map((item) => JSON.parse(utf8Decode(base64ToBytes(item.data))) as Record<string, any>);
    const command = sent.find((item) => item.payload?.command === 'set_scan_timing')!;
    expect(command.payload).toMatchObject({ target_fps: 90, settle_us: 15, send_every_n_frames: 1 });
    const reply = { type: 'result', device_uid: UID, request_id: command.request_id, payload: { cmd: 'set_scan_timing', ok: true, data: { applied: true } } };
    native.receive(13250, new TextEncoder().encode(JSON.stringify(reply)), { ip: '192.168.1.50', port: 4210 });
    expect(await pending).toEqual({ ok: true, message: 'ok', data: { applied: true } });
  });
});

describe('AppHost (studio)', () => {
  function makeStudio(native: FakeNative, documents: FakeNative) {
    const host = new AppHost({
      native,
      clientType: 'studio',
      platform: 'darwin',
      upstreamPlatform: 'darwin-arm64',
      documents: { files: documents, config: 'config/studio.json', nicknames: 'config/device_nicknames.json', groups: 'config/device_groups.json' },
      connector: new OfflineConnector(),
      logger: { info() {}, warn() {}, error() {} },
      tickIntervalMs: 60_000,
    });
    hosts.push(host);
    return host;
  }

  it('keeps config and labels in its documents, names itself NH Studio and exposes the full HostStore', async () => {
    const native = new FakeNative();
    const documents = new FakeNative();
    const host = makeStudio(native, documents);
    await host.start();
    const config = JSON.parse(documents.text('config/studio.json')!) as Record<string, unknown>;
    expect(config.gateway_id).toMatch(/^studio-[0-9a-f]{8}$/);
    expect(config.gateway_name).toBe('NH Studio');
    expect(native.files.has(PATHS.config)).toBe(false);
    expect(host.status().serviceError).toBe('');
    await host.updateSettings({ displayName: '  ' });
    expect(host.settings().displayName).toBe('NH Studio');

    await host.adopt(UID);
    native.receive(13250, encodePacket({ uid: UID, frameId: 0, flags: FLAG.HEARTBEAT }));
    frame(native, 1, [1, 2]);
    await host.setNickname(UID, 'Glove');
    await host.setGroup(UID, 'Lab');
    expect(host.devices()[0]).toMatchObject({ uid: UID, nickname: 'Glove', group: 'Lab' });
    expect(JSON.parse(documents.text('config/device_groups.json')!)).toEqual({ [UID]: 'Lab' });
    const details = host.deviceDetails();
    expect(details[UID]!.record).toMatchObject({ device_uid: UID, nickname: 'Glove' });
    expect(details[UID]!.status).toEqual(expect.any(Object));

    // Any payload, validated like the Desktop terminal, answered by the device.
    await expect(host.sendCommand(UID, { command: '' })).resolves.toMatchObject({ ok: false });
    const pending = host.sendCommand(UID, { command: 'status' });
    const sent = native.sent.map((item) => JSON.parse(utf8Decode(base64ToBytes(item.data))) as Record<string, any>);
    const command = sent.find((item) => item.payload?.command === 'status')!;
    native.receive(13250, new TextEncoder().encode(JSON.stringify({ type: 'result', device_uid: UID, request_id: command.request_id, payload: { cmd: 'status', ok: true, data: { mode: 'normal' } } })));
    expect(await pending).toEqual({ ok: true, message: 'ok', data: { mode: 'normal' } });

    await host.setRecording(UID, true);
    for (let i = 2; i <= 5; i++) frame(native, i, [i, i]);
    await host.setRecording(UID, false);
    const id = host.recordings()[0]!.id;
    expect(await host.exportZip(id)).toEqual({ path: `/cache/export/${id.split('/').join('_')}.zip`, name: `${id.split('/').join('_')}.zip` });
    await expect(host.exportRecording(id)).rejects.toThrow('share_unavailable');
    const meta = [...native.files.keys()].find((path) => path.endsWith('.meta.json'))!;
    expect(native.text(meta)).toContain('"studio"');
  });

  it('reports the native service error', async () => {
    const native = Object.assign(new FakeNative(), { serviceError: () => 'UDP port 13250 is already in use' });
    const host = makeStudio(native, new FakeNative());
    await host.start();
    host.invalidate();
    expect(host.status().serviceError).toBe('UDP port 13250 is already in use');
  });
});
