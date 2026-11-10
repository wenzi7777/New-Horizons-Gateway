// Canned PocketSync for the mock store (Expo Go, web): sign in with any
// user name and the password "admin".
import type { SyncStatus } from '@nhgw/host';

import type { PocketSync } from './sync';

export function createMockSync(): PocketSync {
  const listeners = new Set<() => void>();
  let status: SyncStatus = {
    configured: false,
    tokenMasked: '',
    account: '',
    baseUrl: 'https://isensing-s1.u-aizu.ac.jp/newhorizons',
    policy: 'manual',
    paused: false,
    autoAllowed: false,
    network: { online: true, metered: false },
    connection: null,
    recordings: [],
    counts: { local: 0, queued: 2, uploading: 0, synced: 5, failed: 0 },
    current: null,
    lastUploadMs: 0,
    labels: null,
    profiles: null,
  };
  const set = (patch: Partial<SyncStatus>) => {
    status = { ...status, ...patch };
    for (const listener of [...listeners]) listener();
  };
  return {
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async login(username, password) {
      await new Promise((r) => setTimeout(r, 400));
      if (!username.trim() || !password) throw new Error('username_and_password_required');
      if (password !== 'admin') throw new Error('invalid_credentials');
      set({ configured: true, account: username.trim(), tokenMasked: 'nhapp_0123456789ab_…mock', connection: { ok: true, error: '', checkedAtMs: Date.now(), username: 'app:0123456789ab', role: 'admin', clientType: 'pocket' } });
    },
    async logout() {
      set({ configured: false, account: '', tokenMasked: '', connection: null });
    },
    async uploadNow() {
      set({ counts: { ...status.counts, queued: 0, synced: status.counts.synced + status.counts.queued }, lastUploadMs: Date.now() });
    },
    async retry() {},
  };
}
