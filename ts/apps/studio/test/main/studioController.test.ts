// StudioController end to end on real sockets (ephemeral ports): the host
// starts as an NH Studio relay, a device streams to it over UDP, records,
// exports a zip, and the data folder moves.
import { createSocket, type Socket } from 'node:dgram';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { WsConnection, WsConnector, WsHandlers } from '@nhgw/core';

import { encodePacket, FLAG } from '../../../../packages/engine/test/parse/packets';
import { readCentralDirectory } from '../../src/main/zip';
import { StudioController } from '../../src/main/studioController';

const UID = '3CDC7545CCD0';
const quiet = { info() {}, warn() {}, error() {} };

class OfflineConnector implements WsConnector {
  urls: string[] = [];
  connect(url: string, _headers: Record<string, string>, _handlers: WsHandlers): WsConnection {
    this.urls.push(url);
    return { send() {}, close() {} };
  }
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nh-studio-ctl-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeController(base = temp()) {
  const connector = new OfflineConnector();
  const controller = new StudioController({
    userDataDir: join(base, 'userData'),
    defaultDataFolder: join(base, 'Documents', 'NH Studio'),
    tempDir: join(base, 'tmp'),
    version: 'v2.0.0',
    platform: 'darwin',
    upstreamPlatform: 'darwin-arm64',
    logger: quiet,
    connector,
    native: { ports: { stream: 0, discovery: 0 }, host: '127.0.0.1' },
    tickIntervalMs: 60_000,
  });
  cleanup.push(() => controller.stop());
  return { controller, connector, base };
}

async function device(): Promise<Socket> {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()));
  cleanup.push(() => new Promise<void>((resolve) => socket.close(() => resolve())));
  return socket;
}

describe('StudioController', () => {
  it('runs the host as an NH Studio relay with its config in userData', async () => {
    const { controller, connector, base } = makeController();
    await controller.start();
    await controller.native.whenBound();
    const snapshot = controller.snapshot();
    expect(snapshot.status.serviceRunning).toBe(true);
    expect(snapshot.status.serviceError).toBe('');
    expect(snapshot.settings).toMatchObject({ displayName: 'NH Studio', offerPolicy: 'managed', dataFolder: join(base, 'Documents', 'NH Studio') });
    expect(snapshot.settings.pocketId).toMatch(/^studio-[0-9a-f]{8}$/);
    expect(snapshot.version).toBe('v2.0.0');
    expect(connector.urls[0]).toBe('wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws');
    const config = JSON.parse(readFileSync(join(base, 'userData', 'config', 'studio.json'), 'utf8')) as Record<string, unknown>;
    expect(config.gateway_id).toBe(snapshot.settings.pocketId);

    await controller.updateSettings({ displayName: 'Lab Mac', relayEnabled: false });
    expect(controller.snapshot().settings).toMatchObject({ displayName: 'Lab Mac', relayEnabled: false });
    expect(controller.snapshot().status.upstream).toBe('offline');
  });

  it('adopts a streaming device, records it, exports a zip and keeps its details', async () => {
    const { controller, base } = makeController();
    await controller.start();
    await controller.native.whenBound();
    const port = controller.native.boundPorts().stream!;
    const dev = await device();
    const send = (packet: Uint8Array) => dev.send(packet, port, '127.0.0.1');

    expect((await controller.host.adopt(UID)).ok).toBe(true);
    send(encodePacket({ uid: UID, frameId: 0, flags: FLAG.HEARTBEAT }));
    send(encodePacket({ uid: UID, frameId: 1, matrix: [1, 2] }));
    await waitFor(() => controller.snapshot().devices.some((item) => item.uid === UID && item.online));
    expect(controller.snapshot().deviceDetails[UID]?.record).toMatchObject({ device_uid: UID });

    const frames: number[][] = [];
    const off = controller.subscribeLive(UID, (frame) => frames.push(frame.values));
    send(encodePacket({ uid: UID, frameId: 2, matrix: [3, 4] }));
    await waitFor(() => frames.length > 0);
    off();
    expect(frames[0]).toEqual([3, 4]);

    expect((await controller.host.setRecording(UID, true)).ok).toBe(true);
    expect(controller.recordingCount()).toBe(1);
    await expect(controller.setDataFolder(join(base, 'Elsewhere'))).rejects.toThrow('recording_in_progress');
    for (let i = 3; i <= 12; i++) send(encodePacket({ uid: UID, frameId: i, timestamp: i * 17, matrix: [i, i + 1] }));
    await waitFor(() => existsSync(join(base, 'Documents', 'NH Studio', 'recordings', '.raw')) && controller.native.rawStats(1)?.records === 11);
    expect((await controller.host.setRecording(UID, false)).ok).toBe(true);
    await waitFor(() => controller.host.recordings().length === 1 && !controller.host.recordings()[0]!.inProgress);
    const recording = controller.host.recordings()[0]!;
    expect(recording).toMatchObject({ uid: UID, frames: 10 });
    const meta = JSON.parse(
      readFileSync(join(controller.recordingPath(recording.id), `${recording.id.split('/')[2]}.meta.json`), 'utf8'),
    ) as Record<string, any>;
    expect(JSON.stringify(meta)).toContain('studio');
    // The raw capture is gone after the clean stop.
    expect(controller.native.listDir('recordings/.raw')).toEqual([]);

    const destination = join(base, 'export.zip');
    expect(await controller.exportTo(recording.id, destination)).toBe(destination);
    const names = readCentralDirectory(new Uint8Array(readFileSync(destination))).map((entry) => entry.name);
    expect(names.some((name) => name.endsWith('.data.csv'))).toBe(true);
    expect(names.every((name) => name.startsWith(`${recording.id.split('/')[2]}/`))).toBe(true);
    expect(StudioController.zipName(recording.id)).toBe(`${recording.id.split('/').join('_')}.zip`);
  });

  it('moves the data folder (the host restarts there) and remembers it', async () => {
    const { controller, base } = makeController();
    await controller.start();
    const target = join(base, 'Lab Data');
    let pushes = 0;
    controller.subscribe(() => (pushes += 1));
    await controller.setDataFolder(target);
    expect(controller.snapshot().settings.dataFolder).toBe(target);
    await controller.native.whenBound();
    expect(controller.snapshot().status.serviceRunning).toBe(true);
    expect(controller.native.root).toBe(target);
    expect(pushes).toBeGreaterThan(0);
    await expect(controller.setDataFolder('relative/path')).rejects.toThrow('invalid_data_folder');
    await controller.stop();

    // A new controller over the same userData starts in the remembered folder.
    const again = makeController(base).controller;
    await again.start();
    expect(again.snapshot().settings.dataFolder).toBe(target);
  });
});
