// The sync area's handlers over a fake controller and server.
import { describe, expect, it } from 'vitest';

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CREDENTIALS_FILE, fileCredentialStore, type Cipher } from '../../src/main/areas/credentialStore';
import { createSyncArea } from '../../src/main/areas/sync';
import type { AreaContext } from '../../src/main/areas';
import type { SyncHttp, SyncRequest } from '@nhgw/host';
import { FakeNative } from '../../../../packages/host/test/fakeNative';

const TOKEN = 'nhapp_0123456789ab_SECRETsecretSECRETsecret0123456789';

function fakeHost() {
  const config: Record<string, unknown> = { target_mode: 'local', manual_url: '' };
  return {
    clientType: 'studio' as const,
    config,
    settings: () => ({ pocketId: 'studio-1', displayName: 'S', serverTarget: 'local' as const, manualUrl: '', relayEnabled: true, offerPolicy: 'managed' as const, syncPolicy: 'manual' as const, theme: 'auto' as const, locale: 'en' as const }),
    recordings: () => [],
    refreshRecordings() {},
    setRecordingSyncStates() {},
    appConfig: async () => ({ ...config }),
    saveAppConfig: async (patch: Record<string, unknown>) => void Object.assign(config, patch),
    readLabels: () => ({ nicknames: {}, groups: {} }),
    setNickname: async () => undefined,
    setGroup: async () => undefined,
  };
}

describe('sync area', () => {
  it('signs in, remembers the account encrypted, emits state, never returns the token or password', async () => {
    const requests: SyncRequest[] = [];
    const http: SyncHttp = {
      async request(req) {
        requests.push(req);
        if (req.url.endsWith('/api/app-tokens/login')) {
          return { status: 200, text: JSON.stringify({ token: TOKEN, user: { username: 'nick', role: 'admin' } }) };
        }
        if (req.url.endsWith('/api/auth/me')) return { status: 200, text: JSON.stringify({ authenticated: true, role: 'admin', username: 'app:0123456789ab' }) };
        return { status: 200, text: JSON.stringify({ items: [] }) };
      },
    };
    const host = Object.assign(fakeHost(), { status: () => ({ authRejected: false }) });
    const userDataDir = mkdtempSync(join(tmpdir(), 'nh-studio-sync-'));
    // A stand-in for safeStorage: reversible but not the plain text.
    const cipher: Cipher = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)),
      decryptString: (encrypted) => Buffer.from(encrypted.map((b) => b ^ 0x5a)).toString('utf8'),
    };
    const events: [string, unknown][] = [];
    const area = createSyncArea({ http, autoStart: false, credentials: (ctx) => fileCredentialStore(ctx.userDataDir, async () => cipher) });
    const context = {
      controller: { host, native: new FakeNative() } as unknown as AreaContext['controller'],
      emit: (event: string, payload?: unknown) => void events.push([event, payload]),
      logger: { info() {}, warn() {}, error() {} },
      userDataDir,
      version: 'v0',
    } as AreaContext;
    const handlers = area.register(context) as Record<string, (...args: unknown[]) => Promise<any>>;
    try {
      expect(handlers.setToken).toBeUndefined();
      expect(handlers.clearToken).toBeUndefined();
      const result = await handlers.login!('nick', 'hunter2');
      expect(result.ok).toBe(true);
      expect(requests[0]!.url).toBe('http://127.0.0.1:5051/newhorizons/api/app-tokens/login');
      const status = await handlers.status!();
      expect(status).toMatchObject({ configured: true, account: 'nick', remembered: true });
      expect(JSON.stringify(status)).not.toContain('SECRET');
      expect(JSON.stringify(events)).not.toContain('SECRET');
      expect(JSON.stringify(events)).not.toContain('hunter2');
      const file = readFileSync(join(userDataDir, CREDENTIALS_FILE));
      expect(file.toString('utf8')).not.toContain('hunter2');
      expect(await fileCredentialStore(userDataDir, async () => cipher).load()).toEqual({ username: 'nick', password: 'hunter2' });
      expect(events.some(([name]) => name === 'state')).toBe(true);
      const paused = await handlers.pause!();
      expect(paused.paused).toBe(true);
      const out = await handlers.logout!();
      expect(out).toMatchObject({ configured: false, remembered: false });
      expect(existsSync(join(userDataDir, CREDENTIALS_FILE))).toBe(false);
      await expect(handlers.uploadNow!('nope/1/2')).rejects.toThrow('recording_not_found');
    } finally {
      await area.dispose?.();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('keeps nothing when the OS cannot encrypt', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'nh-studio-sync-'));
    try {
      const store = fileCredentialStore(userDataDir, async () => ({ isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' }));
      await store.save({ username: 'nick', password: 'pw' });
      expect(existsSync(join(userDataDir, CREDENTIALS_FILE))).toBe(false);
      expect(await store.load()).toBeNull();
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('concurrent calls build one client, and a host swap replaces it once', async () => {
    const http: SyncHttp = { request: async () => ({ status: 200, text: JSON.stringify({ items: [] }) }) };
    const controller = { host: fakeHost(), native: new FakeNative() };
    const area = createSyncArea({ http, autoStart: false });
    const context = {
      controller: controller as unknown as AreaContext['controller'],
      emit: () => undefined,
      logger: { info() {}, warn() {}, error() {} },
      userDataDir: '/tmp',
      version: 'v0',
    } as AreaContext;
    const handlers = area.register(context) as Record<string, (...args: unknown[]) => Promise<any>>;
    try {
      await Promise.all([handlers.status!(), handlers.status!(), handlers.status!()]);
      const first = area.client();
      expect(first).not.toBeNull();
      await handlers.status!();
      expect(area.client()).toBe(first);
      controller.host = fakeHost();
      await Promise.all([handlers.status!(), handlers.status!()]);
      const second = area.client();
      expect(second).not.toBe(first);
      expect(second!.host).toBe(controller.host);
      await handlers.status!();
      expect(area.client()).toBe(second);
    } finally {
      await area.dispose?.();
    }
  });
});
