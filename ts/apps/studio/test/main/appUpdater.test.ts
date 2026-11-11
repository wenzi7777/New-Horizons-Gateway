import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { StudioUpdater, studioManifestUrl, type HttpGet } from '../../src/main/app/updater';

const payload = new TextEncoder().encode('fake installer bytes');
const sha = createHash('sha256').update(payload).digest('hex');

function fakeHttp(manifest: unknown | 404, body: Uint8Array = payload): { http: HttpGet; urls: string[] } {
  const urls: string[] = [];
  const http: HttpGet = async (url) => {
    urls.push(url);
    if (url.endsWith('.json')) {
      if (manifest === 404) return { status: 404, text: async () => 'nope', body: null };
      return { status: 200, text: async () => JSON.stringify(manifest), body: null };
    }
    return { status: 200, text: async () => '', body: (async function* () { yield body; })() };
  };
  return { http, urls };
}

const manifest = (version: string, asset: Record<string, unknown> = { url: 'https://x/NH-Studio.dmg', sha256: sha, size: payload.length }) => ({
  version,
  notes_url: 'https://x/notes.md',
  assets: { 'darwin-arm64': asset },
});

function updater(http: HttpGet, installed: string[] = []) {
  return new StudioUpdater({
    currentVersion: 'v2.0.0',
    platformKey: 'darwin-arm64',
    downloadDir: mkdtempSync(join(tmpdir(), 'nhs-upd-')),
    http,
    install: async (file) => void installed.push(file),
  });
}

describe('StudioUpdater', () => {
  it('uses studio-latest / studio-beta manifests', () => {
    expect(studioManifestUrl('stable')).toMatch(/releases\/studio-latest\.json$/);
    expect(studioManifestUrl('beta')).toMatch(/releases\/studio-beta\.json$/);
  });

  it('reports a newer release and installs it after verifying', async () => {
    const installed: string[] = [];
    const u = updater(fakeHttp(manifest('v2.1.0')).http, installed);
    expect((await u.check()).phase).toBe('available');
    const after = await u.install();
    expect(after.phase).toBe('installing');
    expect(readFileSync(installed[0]!)).toEqual(Buffer.from(payload));
  });

  it('is current for an older or equal release', async () => {
    expect((await updater(fakeHttp(manifest('v1.9.9')).http).check()).phase).toBe('current');
    expect((await updater(fakeHttp(manifest('v2.0.0')).http).check()).phase).toBe('current');
  });

  it('treats a missing manifest as no release yet', async () => {
    const state = await updater(fakeHttp(404).http).check();
    expect(state.phase).toBe('none');
    expect(state.error).toBe('');
  });

  it('flags a release without this platform', async () => {
    const m = { version: 'v3.0.0', assets: { 'win32-x64': { url: 'https://x/a.exe', sha256: sha, size: 3 } } };
    const state = await updater(fakeHttp(m).http).check();
    expect(state).toMatchObject({ phase: 'current', noAssetForPlatform: true });
  });

  it('refuses a sha256 mismatch and a size mismatch', async () => {
    const installed: string[] = [];
    const bad = updater(fakeHttp(manifest('v2.1.0', { url: 'https://x/a.dmg', sha256: 'ab'.repeat(32), size: payload.length })).http, installed);
    await bad.check();
    expect(await bad.install()).toMatchObject({ phase: 'error', error: 'sha256_mismatch' });
    const short = updater(fakeHttp(manifest('v2.1.0', { url: 'https://x/a.dmg', sha256: sha, size: payload.length + 5 })).http, installed);
    await short.check();
    expect(await short.install()).toMatchObject({ phase: 'error', error: 'size_mismatch' });
    expect(installed).toEqual([]);
  });

  it('reports http errors without throwing', async () => {
    const http: HttpGet = async () => ({ status: 500, text: async () => '', body: null });
    expect(await updater(http).check()).toMatchObject({ phase: 'error', error: 'http_500' });
  });

  it('gives up a download that stalls, as a timeout error', async () => {
    const http: HttpGet = async (url, signal) => {
      if (url.endsWith('.json')) return { status: 200, text: async () => JSON.stringify(manifest('v2.1.0')), body: null };
      return {
        status: 200,
        text: async () => '',
        body: (async function* () {
          yield payload.subarray(0, 4);
          // Then nothing more arrives (the stream ignores the abort signal, as a stuck socket may).
          await new Promise(() => undefined);
        })(),
      };
    };
    const installed: string[] = [];
    const u = new StudioUpdater({
      currentVersion: 'v2.0.0',
      platformKey: 'darwin-arm64',
      downloadDir: mkdtempSync(join(tmpdir(), 'nhs-upd-')),
      http,
      install: async (file) => void installed.push(file),
      downloadStallTimeoutMs: 30,
    });
    await u.check();
    const after = await u.install();
    expect(after).toMatchObject({ phase: 'error', error: 'timeout' });
    expect(installed).toEqual([]);
  });

  it('gives up a download whose server never answers', async () => {
    const http: HttpGet = async (url) => {
      if (url.endsWith('.json')) return { status: 200, text: async () => JSON.stringify(manifest('v2.1.0')), body: null };
      return new Promise(() => undefined);
    };
    const u = new StudioUpdater({
      currentVersion: 'v2.0.0',
      platformKey: 'darwin-arm64',
      downloadDir: mkdtempSync(join(tmpdir(), 'nhs-upd-')),
      http,
      install: async () => undefined,
      downloadStallTimeoutMs: 30,
    });
    await u.check();
    expect(await u.install()).toMatchObject({ phase: 'error', error: 'timeout' });
  });
});
