import { describe, expect, it } from 'vitest';

import { PocketUpdater, updateErrorCode, type UpdaterPorts } from '../src/host/updater';

const ASSET = { url: 'https://github.com/x/nh-pocket-v2.1.0.apk', sha256: 'a'.repeat(64), size: 1000 };

function ports(over: Partial<UpdaterPorts> = {}) {
  const calls: string[] = [];
  let channel = '';
  let allowed = false;
  const p: UpdaterPorts & { calls: string[]; allow(): void } = {
    calls,
    allow: () => (allowed = true),
    currentVersion: 'v2.0.0',
    fetchText: async (url) => {
      calls.push(`get ${url.split('?')[0]}`);
      if (url.includes('-beta')) return { status: 404, text: '' };
      return { status: 200, text: JSON.stringify({ version: 'v2.1.0', notes_url: 'https://n', assets: { android: ASSET } }) };
    },
    download: async (asset, progress) => {
      calls.push(`download ${asset.url}`);
      progress(500, 1000);
      progress(1000, 1000);
      return '/cache/updates/nh-pocket-update.apk';
    },
    canInstall: () => allowed,
    openInstallSettings: () => void calls.push('settings'),
    install: (path) => void calls.push(`install ${path}`),
    loadChannel: async () => channel,
    saveChannel: async (c) => void (channel = c),
    now: () => 42,
    ...over,
  };
  return p;
}

describe('PocketUpdater', () => {
  it('finds a newer release, downloads once, waits for the install permission, then opens the installer', async () => {
    const p = ports();
    const u = new PocketUpdater(p);
    await u.loadChannel();
    expect((await u.check())).toMatchObject({ phase: 'available', latestVersion: 'v2.1.0', notesUrl: 'https://n' });
    expect(p.calls[0]).toBe('get https://raw.githubusercontent.com/wenzi7777/New-Horizons-Gateway/main/releases/pocket-latest.json');
    expect((await u.install()).phase).toBe('needsPermission');
    expect(u.snapshot()).toMatchObject({ receivedBytes: 1000, totalBytes: 1000 });
    p.allow();
    expect((await u.install()).phase).toBe('installing');
    expect(p.calls.filter((c) => c.startsWith('download'))).toHaveLength(1);
    expect(p.calls.at(-1)).toBe('install /cache/updates/nh-pocket-update.apk');
  });

  it('says "no release yet" for a missing manifest and up to date for the same version', async () => {
    const u = new PocketUpdater(ports({ currentVersion: 'v2.1.0' }));
    expect((await u.check()).phase).toBe('upToDate');
    expect((await u.setChannel('beta')).phase).toBe('none');
  });

  it('reports download failures by code', async () => {
    const u = new PocketUpdater(ports({ download: async () => { throw new Error('Call to function updateDownload has been rejected. sha256_mismatch'); } }));
    await u.check();
    expect(await u.install()).toMatchObject({ phase: 'error', error: 'sha256_mismatch' });
    expect(updateErrorCode(new Error('boom: network'))).toBe('network');
  });
});
