// The sync area's handlers over a fake controller and server.
import { describe, expect, it } from 'vitest';

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
  it('sets a token, tests the connection, emits state, never returns the token', async () => {
    const requests: SyncRequest[] = [];
    const http: SyncHttp = {
      async request(req) {
        requests.push(req);
        if (req.url.endsWith('/api/auth/me')) return { status: 200, text: JSON.stringify({ authenticated: true, role: 'admin', username: 'app:0123456789ab' }) };
        return { status: 200, text: JSON.stringify({ items: [] }) };
      },
    };
    const host = fakeHost();
    const events: [string, unknown][] = [];
    const area = createSyncArea({ http, autoStart: false });
    const context = {
      controller: { host, native: new FakeNative() } as unknown as AreaContext['controller'],
      emit: (event: string, payload?: unknown) => void events.push([event, payload]),
      logger: { info() {}, warn() {}, error() {} },
      userDataDir: '/tmp',
      version: 'v0',
    } as AreaContext;
    const handlers = area.register(context) as Record<string, (...args: unknown[]) => Promise<any>>;
    try {
      await expect(handlers.setToken!('bogus')).rejects.toThrow('token_invalid');
      const result = await handlers.setToken!(TOKEN);
      expect(result.ok).toBe(true);
      expect(requests[0]!.url).toBe('http://127.0.0.1:5051/newhorizons/api/auth/me');
      const status = await handlers.status!();
      expect(status.configured).toBe(true);
      expect(JSON.stringify(status)).not.toContain('SECRET');
      expect(JSON.stringify(events)).not.toContain('SECRET');
      expect(events.some(([name]) => name === 'state')).toBe(true);
      const paused = await handlers.pause!();
      expect(paused.paused).toBe(true);
      const cleared = await handlers.clearToken!();
      expect(cleared.configured).toBe(false);
      await expect(handlers.uploadNow!('nope/1/2')).rejects.toThrow('recording_not_found');
    } finally {
      await area.dispose?.();
    }
  });
});
