import { describe, expect, it } from 'vitest';

import {
  GatewayConfigStore,
  LOCAL_URL,
  PRODUCTION_URL,
  applyEnvOverrides,
  defaultConfig,
  normalizeConfig,
  parseBool,
  resolveServerUrl,
  validateGatewayId,
  type RawConfig,
} from '../src/config';
import type { JsonStore } from '../src/ports';

class MemoryStore implements JsonStore<RawConfig> {
  saved: RawConfig[] = [];
  constructor(public value: RawConfig | null = null) {}
  async load() {
    return this.value === null ? null : structuredClone(this.value);
  }
  async save(value: RawConfig) {
    this.value = structuredClone(value);
    this.saved.push(this.value);
  }
}

async function snapshotOf(payload: RawConfig | null, env: Record<string, string | undefined> = {}) {
  return (await GatewayConfigStore.load(new MemoryStore(payload), env)).snapshot();
}

describe('control_stale_sec', () => {
  it('defaults to 16', async () => expect((await snapshotOf(null)).control_stale_sec).toBe(16));
  it('takes an override', async () => expect((await snapshotOf({ control_stale_sec: 25 })).control_stale_sec).toBe(25));
  it('falls back on garbage', async () => expect((await snapshotOf({ control_stale_sec: 'abc' })).control_stale_sec).toBe(16));
  it('clamps to at least 1', async () => expect((await snapshotOf({ control_stale_sec: 0 })).control_stale_sec).toBe(1));
  it('parses numeric strings and treats null as garbage', async () => {
    expect((await snapshotOf({ control_stale_sec: ' 2.5 ' })).control_stale_sec).toBe(2.5);
    expect((await snapshotOf({ control_stale_sec: null })).control_stale_sec).toBe(16);
    expect((await snapshotOf({ control_stale_sec: 'nan' })).control_stale_sec).toBe(1);
  });
});

describe('update channel in config', () => {
  it('defaults and normalizes the channel, and persists it', async () => {
    const disk = new MemoryStore();
    const store = await GatewayConfigStore.load(disk);
    expect(store.snapshot().update_channel).toBe('stable');
    expect((await store.save({ update_channel: 'beta' })).update_channel).toBe('beta');
    expect((await GatewayConfigStore.load(disk)).snapshot().update_channel).toBe('beta');
    expect((await store.save({ update_channel: 'weird' })).update_channel).toBe('stable');
  });
});

describe('defaults and normalize', () => {
  it('produces the Python defaults for an empty file', async () => {
    expect(await snapshotOf(null)).toEqual({
      enabled: false,
      gateway_name: 'NH Gateway',
      gateway_id: '',
      target_mode: 'production',
      manual_url: '',
      server_url: PRODUCTION_URL,
      listen_udp_host: '0.0.0.0',
      listen_udp_port: 13250,
      listen_discovery_host: '0.0.0.0',
      listen_discovery_port: 22346,
      listen_web_host: '0.0.0.0',
      listen_web_port: 5052,
      discovery_enabled: true,
      discovery_priority: 100,
      control_stale_sec: 16,
      denied_devices: [],
      update_channel: 'stable',
      remote_management: true,
    });
  });

  it('drops auth_token, keeps unknown keys, coerces types', async () => {
    const config = await snapshotOf({
      auth_token: 'secret',
      future_key: { a: 1 },
      listen_udp_port: '13251',
      discovery_priority: 7.9,
      enabled: 'yes',
      discovery_enabled: 'off',
      remote_management: 0,
      gateway_id: '  lab-1  ',
      denied_devices: ['b', ' a ', 'B', '', null],
      target_mode: 'bogus',
    });
    expect('auth_token' in config).toBe(false);
    expect(config.future_key).toEqual({ a: 1 });
    expect(config.listen_udp_port).toBe(13251);
    expect(config.discovery_priority).toBe(7);
    expect(config.enabled).toBe(true);
    expect(config.discovery_enabled).toBe(false);
    expect(config.remote_management).toBe(false);
    expect(config.gateway_id).toBe('lab-1');
    // str(None) is 'None', kept as Python did.
    expect(config.denied_devices).toEqual(['A', 'B', 'NONE']);
    expect(config.target_mode).toBe('production');
  });

  it('clears an invalid gateway_id and disables the Gateway', async () => {
    const config = await snapshotOf({ gateway_id: 'bad id!', enabled: true });
    expect(config.gateway_id).toBe('');
    expect(config.enabled).toBe(false);
    expect((await snapshotOf({ gateway_id: 'x'.repeat(65), enabled: true })).gateway_id).toBe('');
    expect((await snapshotOf({ gateway_id: 'x'.repeat(64) })).gateway_id).toBe('x'.repeat(64));
  });

  it('throws on a non-integer port, as int() did', async () => {
    await expect(snapshotOf({ listen_web_port: 'abc' })).rejects.toThrow();
    await expect(snapshotOf({ listen_web_port: null })).rejects.toThrow();
    await expect(snapshotOf({ listen_web_port: '50.5' })).rejects.toThrow();
  });

  it('a non-list denied_devices becomes empty', async () => {
    expect((await snapshotOf({ denied_devices: 'ABC' })).denied_devices).toEqual([]);
  });

  it('does not mutate its input', () => {
    const raw: RawConfig = { ...defaultConfig(), auth_token: 'x', listen_udp_port: '1' };
    normalizeConfig(raw);
    expect(raw.auth_token).toBe('x');
    expect(raw.listen_udp_port).toBe('1');
  });
});

describe('parseBool and validateGatewayId', () => {
  it('parses like Python parse_bool', () => {
    expect(parseBool(undefined, true)).toBe(true);
    expect(parseBool(null)).toBe(false);
    for (const v of ['0', 'false', 'No', ' off ', '', 0]) expect(parseBool(v, true), String(v)).toBe(false);
    for (const v of ['1', 'true', 'yes', 'anything', 2, [], {}]) expect(parseBool(v), String(v)).toBe(true);
  });

  it('validates gateway ids', () => {
    expect(validateGatewayId(' lab.1_A-b ')).toBe('lab.1_A-b');
    expect(() => validateGatewayId('')).toThrow('gateway_id_required');
    expect(() => validateGatewayId(null)).toThrow('gateway_id_required');
    expect(() => validateGatewayId('a b')).toThrow('gateway_id_invalid');
    expect(validateGatewayId('a\n')).toBe('a');
  });
});

describe('server URL', () => {
  it('resolves production, local and manual', () => {
    expect(resolveServerUrl({})).toBe(PRODUCTION_URL);
    expect(resolveServerUrl({ target_mode: 'local' })).toBe(LOCAL_URL);
    expect(resolveServerUrl({ target_mode: 'manual', manual_url: ' wss://x/ws ' })).toBe('wss://x/ws');
    expect(resolveServerUrl({ target_mode: 'manual', manual_url: '   ' })).toBe(LOCAL_URL);
    expect(resolveServerUrl({ target_mode: 'other' })).toBe(PRODUCTION_URL);
  });

  it('is recomputed on load and save', async () => {
    const store = await GatewayConfigStore.load(new MemoryStore({ target_mode: 'local', server_url: 'stale' }));
    expect(store.snapshot().server_url).toBe(LOCAL_URL);
    expect((await store.save({ target_mode: 'manual', manual_url: 'ws://h:1/ws' })).server_url).toBe('ws://h:1/ws');
  });
});

describe('environment overrides', () => {
  it('applies non-empty variables as strings, then normalize coerces them', async () => {
    const env = {
      NEWHORIZONS_GATEWAY_UDP_PORT: '14000',
      NEWHORIZONS_GATEWAY_ENABLED: 'true',
      NEWHORIZONS_GATEWAY_ID: 'gw-env',
      NEWHORIZONS_GATEWAY_NAME: '',
      NEWHORIZONS_GATEWAY_UPDATE_CHANNEL: 'Beta',
    };
    expect(applyEnvOverrides({ a: 1 }, env)).toEqual({
      a: 1,
      listen_udp_port: '14000',
      enabled: 'true',
      gateway_id: 'gw-env',
      update_channel: 'Beta',
    });
    const config = await snapshotOf({ listen_udp_port: 1 }, env);
    expect(config.listen_udp_port).toBe(14000);
    expect(config.enabled).toBe(true);
    expect(config.gateway_id).toBe('gw-env');
    expect(config.gateway_name).toBe('NH Gateway');
    expect(config.update_channel).toBe('beta');
  });

  it('SERVER_URL forces manual unless a target mode is given', async () => {
    let config = await snapshotOf({ target_mode: 'local' }, { NEWHORIZONS_GATEWAY_SERVER_URL: 'wss://e/ws' });
    expect(config.target_mode).toBe('manual');
    expect(config.manual_url).toBe('wss://e/ws');
    expect(config.server_url).toBe('wss://e/ws');
    config = await snapshotOf(null, { NEWHORIZONS_GATEWAY_SERVER_URL: 'wss://e/ws', NEWHORIZONS_GATEWAY_TARGET_MODE: 'local' });
    expect(config.target_mode).toBe('local');
    expect(config.server_url).toBe(LOCAL_URL);
  });
});

describe('save', () => {
  it('validates, persists sorted keys and never writes auth_token', async () => {
    const disk = new MemoryStore({ auth_token: 'old' });
    const store = await GatewayConfigStore.load(disk);
    await expect(store.save({ enabled: true })).rejects.toThrow('gateway_id_required');
    expect(disk.saved).toHaveLength(0);
    const saved = await store.save({ enabled: true, gateway_id: 'gw1', auth_token: 'new' });
    expect(saved.enabled).toBe(true);
    const written = disk.saved[0]!;
    expect('auth_token' in written).toBe(false);
    expect(Object.keys(written)).toEqual([...Object.keys(written)].sort());
  });

  it('an invalid id in a patch is cleared, not refused (normalize runs first)', async () => {
    const store = await GatewayConfigStore.load(new MemoryStore());
    const saved = await store.save({ gateway_id: 'bad id', enabled: true });
    expect(saved.gateway_id).toBe('');
    expect(saved.enabled).toBe(false);
  });

  it('writes env overrides into the file, as Python did', async () => {
    const disk = new MemoryStore();
    const store = await GatewayConfigStore.load(disk, { NEWHORIZONS_GATEWAY_WEB_PORT: '6000' });
    await store.save({});
    expect(disk.value!.listen_web_port).toBe(6000);
  });

  it('snapshot is a copy', async () => {
    const store = await GatewayConfigStore.load(new MemoryStore());
    store.snapshot().denied_devices.push('X');
    expect(store.snapshot().denied_devices).toEqual([]);
  });
});

describe('deny / allow', () => {
  it('normalizes UIDs and persists the sorted list', async () => {
    const disk = new MemoryStore();
    const store = await GatewayConfigStore.load(disk);
    await store.deny(' bbb ');
    await store.deny('aaa');
    expect(store.isDenied('BBB')).toBe(true);
    expect(store.isDenied(' aaa')).toBe(true);
    expect(disk.value!.denied_devices).toEqual(['AAA', 'BBB']);
    expect((await store.allow('bbb')).denied_devices).toEqual(['AAA']);
    expect(store.isDenied('BBB')).toBe(false);
    // An empty UID changes nothing but still saves.
    await store.deny('  ');
    expect(store.snapshot().denied_devices).toEqual(['AAA']);
    expect(disk.saved).toHaveLength(4);
  });
});
