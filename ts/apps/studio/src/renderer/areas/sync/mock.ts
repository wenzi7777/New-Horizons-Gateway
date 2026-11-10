// Browser-preview (mock) implementation of the "sync" area: the same
// methods as main/areas/sync.ts with canned behaviour.
import type { SyncAreaStatus, SyncConnectionResult, SyncMetadataResult } from '../../../shared/areas/sync';
import type { AreaMock } from '../mockTypes';

export const syncMock: AreaMock = (emit) => {
  const now = Date.now();
  const status: SyncAreaStatus = {
    configured: false,
    tokenMasked: '',
    account: '',
    baseUrl: 'https://isensing-s1.u-aizu.ac.jp/newhorizons',
    policy: 'manual',
    paused: false,
    autoAllowed: false,
    network: { online: true, metered: false },
    connection: null,
    recordings: [
      { id: '3C84279A1F20/20261109/160500', uid: '3C84279A1F20', deviceName: 'Left insole', startedAtMs: now - 86_400_000, bytes: 18_400_000, state: 'queued', sentBytes: 0, totalBytes: 18_400_000, error: '', attempts: 0, nextAttemptMs: 0, syncedAtMs: 0, serverPath: '' },
      { id: 'F412FA0C77D8/20261109/113000', uid: 'F412FA0C77D8', deviceName: 'Bench pad', startedAtMs: now - 90_000_000, bytes: 2_100_000, state: 'failed', sentBytes: 0, totalBytes: 2_100_000, error: 'network', attempts: 2, nextAttemptMs: now + 40_000, syncedAtMs: 0, serverPath: '' },
      { id: '3C84279A2B44/20261108/150200', uid: '3C84279A2B44', deviceName: 'NHOS-3C84279A2B44', startedAtMs: now - 172_800_000, bytes: 4_000_000, state: 'synced', sentBytes: 4_000_000, totalBytes: 4_000_000, error: '', attempts: 0, nextAttemptMs: 0, syncedAtMs: now - 3_600_000, serverPath: '3C84279A2B44/20261108/150200' },
    ],
    counts: { local: 0, queued: 1, uploading: 0, synced: 1, failed: 1 },
    current: null,
    lastUploadMs: now - 3_600_000,
    labels: null,
    profiles: null,
  };
  const changed = () => emit('state', status);
  const ok = (): SyncConnectionResult => ({ ok: status.configured, error: status.configured ? '' : 'no_token', checkedAtMs: Date.now(), username: 'app:0123456789ab', role: 'admin', clientType: 'studio' });
  const meta = (): SyncMetadataResult => ({ ok: true, error: '', atMs: Date.now(), pushed: 1, pulled: 2 });
  return {
    status: () => status,
    login: (username: string, password: string) => {
      if (!String(username).trim() || !password) throw new Error('username_and_password_required');
      if (password !== 'admin') throw new Error('invalid_credentials');
      Object.assign(status, { configured: true, tokenMasked: 'nhapp_0123456789ab_…mock', account: String(username).trim() });
      status.connection = ok();
      changed();
      return status.connection;
    },
    logout: () => {
      Object.assign(status, { configured: false, tokenMasked: '', account: '', connection: null });
      changed();
      return status;
    },
    setToken: (token: string) => {
      if (!/^nhapp_[0-9a-f]{12}_[A-Za-z0-9_-]{8,}$/.test(String(token).trim())) throw new Error('token_invalid');
      status.configured = true;
      status.tokenMasked = `${String(token).trim().slice(0, 18)}_…${String(token).trim().slice(-4)}`;
      status.connection = ok();
      changed();
      return status.connection;
    },
    clearToken: () => {
      Object.assign(status, { configured: false, tokenMasked: '', connection: null });
      changed();
      return status;
    },
    relayBench: async () => {
      await new Promise((r) => setTimeout(r, 1200));
      return {
        framesPerSecond: 180_000,
        packetBytes: 472,
        link: { ok: true, error: '', rttMs: 18, uploadBytesPerSecond: status.configured ? 3_000_000 : null },
        estimate: { fps: 60, sensors: 112, bytesPerDevicePerSecond: 39_180, devicesByMachine: 1800, devicesByNetwork: status.configured ? 45 : null, devices: status.configured ? 45 : 1800, bottleneck: status.configured ? 'network' : 'unknown' },
      };
    },
    testConnection: () => (status.connection = ok()),
    uploadNow: () => status,
    retry: () => status,
    pause: () => ((status.paused = true), changed(), status),
    resume: () => ((status.paused = false), changed(), status),
    syncLabelsNow: () => (status.labels = meta()),
    syncProfilesNow: () => (status.profiles = meta()),
  };
};
