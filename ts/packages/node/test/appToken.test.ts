import { describe, expect, it } from 'vitest';

import { isLoopback } from '../src/web/server';
import { appTokenStatus, withoutSecrets } from '../src/appToken';

describe('app token', () => {
  it('only loopback requests may change it', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a)).toBe(true);
    for (const a of ['192.168.1.14', '::ffff:10.0.0.2', '', undefined]) expect(isLoopback(a)).toBe(false);
  });

  it('is masked in status and dropped from the public config', () => {
    const token = 'nhapp_0123456789ab_secretsecret9z';
    const config = { target_mode: 'local', manual_url: '', sync_app_token: token, sync_app_token_server: 'http://127.0.0.1:5051/newhorizons' };
    expect(appTokenStatus(config)).toEqual({ set: true, masked: 'nhapp_0123456789ab_…et9z', server: 'http://127.0.0.1:5051/newhorizons', active: true, account: '' });
    expect(withoutSecrets(config)).not.toHaveProperty('sync_app_token');
    expect(appTokenStatus({ ...config, target_mode: 'production' }).active).toBe(false);
  });
});

import { GatewayConfigStore, type JsonStore, type RawConfig } from '@nhgw/core';
import { loginAppToken, logoutAppToken } from '../src/appToken';

class Memory implements JsonStore<RawConfig> {
  constructor(public data: RawConfig | null = null) {}
  async load() {
    return this.data;
  }
  async save(value: RawConfig) {
    this.data = { ...value };
  }
}

describe('headless sign-in', () => {
  const TOKEN = 'nhapp_0123456789ab_' + 'k'.repeat(40);
  function fakeServer() {
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const fetch = async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      calls.push({ url, headers: init.headers, body: init.body });
      const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
      if (url.endsWith('/api/app-tokens/login')) {
        const b = JSON.parse(init.body!);
        return b.password === 'pw' ? reply(200, { token: TOKEN, user: { username: 'nick', role: 'admin' } }) : reply(401, { error: 'invalid_credentials' });
      }
      if (url.endsWith('/api/app-tokens/self/revoke')) return reply(200, { status: 'revoked' });
      return reply(404, {});
    };
    return { calls, fetch };
  }

  it('exchanges a Desktop account for a key, keeps no password, and revokes it on sign-out', async () => {
    const disk = new Memory({ target_mode: 'local' });
    const store = await GatewayConfigStore.load(disk);
    const server = fakeServer();
    await expect(loginAppToken(store, 'nick', 'nope', { fetch: server.fetch })).rejects.toThrow('invalid_credentials');
    const status = await loginAppToken(store, 'nick', 'pw', { fetch: server.fetch, deviceName: 'lab-pi' });
    expect(status).toMatchObject({ set: true, active: true, account: 'nick', server: 'http://127.0.0.1:5051/newhorizons' });
    expect(JSON.parse(server.calls[1]!.body!)).toEqual({ username: 'nick', password: 'pw', client_type: 'studio', device_name: 'lab-pi' });
    expect(JSON.stringify(disk.data)).not.toContain('"pw"');
    const out = await logoutAppToken(store, { fetch: server.fetch });
    expect(server.calls.at(-1)).toMatchObject({ url: 'http://127.0.0.1:5051/newhorizons/api/app-tokens/self/revoke', headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(out).toMatchObject({ set: false, account: '' });
  });
});
