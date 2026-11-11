// The relay id must not change behind the user's back: a damaged config file,
// concurrent first-run loads, a renamed relay and a failed start all keep one id
// (and one upstream link).
import { afterEach, describe, expect, it } from 'vitest';
import type { WsConnection, WsConnector, WsHandlers } from '@nhgw/core';

import { encodePacket, FLAG } from '../../engine/test/parse/packets';

import { NativeJsonStore, PATHS } from '../src/files';
import { AppHost, salvageGatewayId } from '../src/host';
import { FakeNative } from './fakeNative';

const UID = '3CDC7545CCD0';

class TrackingConnector implements WsConnector {
  readonly links: { url: string; closed: boolean }[] = [];
  connect(url: string, _headers: Record<string, string>, _handlers: WsHandlers): WsConnection {
    const link = { url, closed: false };
    this.links.push(link);
    return {
      send() {},
      close() {
        link.closed = true;
      },
    };
  }
  open() {
    return this.links.filter((link) => !link.closed);
  }
}

const hosts: AppHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

function makeHost(native: FakeNative, connector: WsConnector = new TrackingConnector(), warnings: string[] = []) {
  const host = new AppHost({
    native,
    clientType: 'pocket',
    connector,
    logger: { info() {}, warn: (m) => warnings.push(m), error() {} },
    tickIntervalMs: 60_000,
  });
  hosts.push(host);
  return host;
}

function config(native: FakeNative): Record<string, any> {
  return JSON.parse(native.text(PATHS.config)!) as Record<string, any>;
}

function backups(native: FakeNative): string[] {
  return [...native.files.keys()].filter((path) => path.startsWith(`${PATHS.config}.corrupt-`));
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('NativeJsonStore', () => {
  it('a missing file loads the defaults without a backup', async () => {
    const native = new FakeNative();
    const store = new NativeJsonStore(native, 'a.json', () => ({ x: 1 }));
    expect(await store.load()).toEqual({ x: 1 });
    expect(store.lastLoad).toBe('missing');
  });

  it('retries a read that fails once', async () => {
    const native = new FakeNative();
    native.writeAtomic('a.json', '{"x":2}');
    const realRead = native.readText.bind(native);
    let calls = 0;
    native.readText = (path: string) => {
      calls += 1;
      if (calls === 1) throw new Error('EBUSY');
      return realRead(path);
    };
    const store = new NativeJsonStore(native, 'a.json', () => ({ x: 1 }), { retryDelayMs: 1 });
    expect(await store.load()).toEqual({ x: 2 });
    expect(store.lastLoad).toBe('ok');
    expect(native.files.has('a.json')).toBe(true);
  });

  it('moves an unparsable file aside and uses what recover makes of it', async () => {
    const native = new FakeNative();
    native.writeAtomic('a.json', '{"x": 3,');
    const store = new NativeJsonStore<{ x: number }>(native, 'a.json', () => ({ x: 1 }), {
      retryDelayMs: 1,
      now: () => Date.UTC(2026, 10, 11, 3, 15, 0),
      recover: (text) => (text?.includes('3') ? { x: 3 } : null),
    });
    expect(await store.load()).toEqual({ x: 3 });
    expect(store.lastLoad).toBe('recovered');
    expect(store.lastBackup).toBe('a.json.corrupt-20261111T031500Z');
    expect(native.text('a.json.corrupt-20261111T031500Z')).toBe('{"x": 3,');
    expect(native.files.has('a.json')).toBe(false);
  });
});

describe('AppHost relay id', () => {
  it('salvages the id from a damaged config', () => {
    expect(salvageGatewayId('{ "enabled": true, "gateway_id": "pocket-1a2b3c4d", "gateway_na')).toBe('pocket-1a2b3c4d');
    expect(salvageGatewayId('garbage')).toBe('');
    expect(salvageGatewayId(null)).toBe('');
    expect(salvageGatewayId('{"gateway_id": "bad id!"}')).toBe('');
  });

  it('a config that will not parse keeps its relay id, is backed up and rewritten at once', async () => {
    const native = new FakeNative();
    native.writeAtomic(PATHS.config, '{\n  "enabled": true,\n  "gateway_id": "pocket-1a2b3c4d",\n  "managed_devices": ["3CDC');
    const warnings: string[] = [];
    const host = makeHost(native, new TrackingConnector(), warnings);
    await host.start();
    expect(host.settings().pocketId).toBe('pocket-1a2b3c4d');
    expect(config(native).gateway_id).toBe('pocket-1a2b3c4d');
    expect(backups(native)).toHaveLength(1);
    expect(warnings.some((line) => line.includes('rebuilt with relay id pocket-1a2b3c4d'))).toBe(true);
  });

  it('a config with nothing recoverable gets one new id, saved before anything else reads it', async () => {
    const native = new FakeNative();
    native.writeAtomic(PATHS.config, '\u0000\u0000\u0000');
    const host = makeHost(native);
    const first = (await host.appConfig()).gateway_id as string;
    expect(first).toMatch(/^pocket-[0-9a-f]{8}$/);
    expect(config(native).gateway_id).toBe(first);
    expect(backups(native)).toHaveLength(1);
    await host.start();
    expect(host.settings().pocketId).toBe(first);
    // A second host on the same files (the next launch) sees the same id.
    await host.stop();
    const again = makeHost(native);
    expect((await again.appConfig()).gateway_id).toBe(first);
  });

  it('concurrent appConfig(), saveAppConfig() and start() on a first run mint one id', async () => {
    const native = new FakeNative();
    const written = new Set<string>();
    const realWrite = native.writeAtomic.bind(native);
    native.writeAtomic = (path: string, text: string) => {
      if (path === PATHS.config) written.add(String((JSON.parse(text) as Record<string, unknown>).gateway_id));
      realWrite(path, text);
    };
    const host = makeHost(native);
    const [a, , b] = await Promise.all([host.appConfig(), host.saveAppConfig({ sync_policy: 'manual' }), host.appConfig(), host.start()]);
    expect(a.gateway_id).toBe(b.gateway_id);
    expect(host.settings().pocketId).toBe(a.gateway_id);
    expect([...written]).toEqual([a.gateway_id]);
  });

  it('a renamed relay remembers its old id and does not give up devices still attached to it', async () => {
    const native = new FakeNative();
    const host = makeHost(native);
    await host.start();
    const oldId = host.settings().pocketId;
    await host.adopt(UID);
    const dev = { ip: '192.168.1.250', port: 5000 };
    native.receive(13250, encodePacket({ uid: UID, frameId: 0, flags: FLAG.HEARTBEAT }), dev);
    await host.updateSettings({ pocketId: 'pocket-bench01' });
    expect(config(native).previous_gateway_ids).toEqual([oldId]);
    native.nowUs += 60_000_000; // past the adopt grace and the claim
    const enc = (o: object) => new TextEncoder().encode(JSON.stringify(o));
    native.receive(22346, enc({ type: 'findme_discover', device_uid: UID, current_gateway_id: oldId }), dev);
    await settle();
    expect(config(native).managed_devices).toEqual([UID]);
    expect(host.devices().map((d) => d.uid)).toEqual([UID]);
  });

  it('a failed start leaves no listener or upstream link behind, and the retry opens exactly one', async () => {
    const native = new FakeNative();
    const connector = new TrackingConnector();
    const host = makeHost(native, connector);
    const realStart = native.startService.bind(native);
    native.startService = () => {
      throw new Error('port busy');
    };
    await expect(host.start()).rejects.toThrow('port busy');
    expect((native as unknown as { listeners: unknown[] }).listeners).toHaveLength(0);
    expect(connector.open()).toHaveLength(0);
    native.startService = realStart;
    await host.start();
    expect((native as unknown as { listeners: unknown[] }).listeners).toHaveLength(1);
    expect(connector.open()).toHaveLength(1);
    // An unchanged config re-applied keeps the link (no reconnect).
    await host.updateSettings({ displayName: 'Bench phone' });
    expect(connector.links).toHaveLength(connector.links.filter((l) => l.closed).length + 1);
    expect(connector.open()).toHaveLength(1);
    const opened = connector.links.length;
    await host.updateSettings({ displayName: 'Bench phone 2' });
    expect(connector.links).toHaveLength(opened);
  });
});
