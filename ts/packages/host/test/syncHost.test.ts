// AppHost's sync hooks: upload states reach RecordingSummary.syncState; the token lives in the config.
import { describe, expect, it } from 'vitest';
import type { WsConnection, WsConnector, WsHandlers } from '@nhgw/core';

import { AppHost } from '../src/host';
import { relayToken, SYNC_KEYS } from '../src/sync/config';
import { FakeNative } from './fakeNative';

class Offline implements WsConnector {
  headers: Record<string, string>[] = [];
  connect(_url: string, headers: Record<string, string>, _h: WsHandlers): WsConnection {
    this.headers.push(headers);
    return { send() {}, close() {} };
  }
}

describe('AppHost sync hooks', () => {
  it('overlays sync states on recordings and keeps the token per server', async () => {
    const native = new FakeNative();
    const id = '3CDC7545CCD0/20261110/100000';
    native.writeAtomic(`recordings/${id}/100000.data.csv`, 'a\n');
    native.writeAtomic(`recordings/${id}/100000.meta.json`, '{"recording":{"started_at":"2026-11-10T00:00:00Z"}}');
    const host = new AppHost({ native, connector: new Offline(), logger: { info() {}, warn() {}, error() {} }, tickIntervalMs: 60_000 });
    host.refreshRecordings();
    expect(host.recordings()[0]!.syncState).toBe('local');
    host.setRecordingSyncStates(new Map([[id, 'synced']]));
    const first = host.recordings();
    expect(first[0]!.syncState).toBe('synced');
    expect(host.recordings()).toBe(first); // stable snapshot
    const token = 'nhapp_0123456789ab_abcdefghijklmnop';
    await host.saveAppConfig({ [SYNC_KEYS.token]: token, [SYNC_KEYS.tokenServer]: 'https://isensing-s1.u-aizu.ac.jp/newhorizons' });
    expect(relayToken(await host.appConfig())).toBe(token);
    await host.updateSettings({ serverTarget: 'local' });
    expect(relayToken(await host.appConfig())).toBe('');
    expect(host.readLabels()).toEqual({ nicknames: {}, groups: {} });
  });
});
