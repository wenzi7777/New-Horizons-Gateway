import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../../src/bytes';
import { binManifestUrlFor, GatewayUpdateManager, localizedNotesUrl, parseBinManifest, type UpdateManagerOptions } from '../../src/update';
import { FakeClock, FakeHttp, FakeInstaller, nodeSha256 } from './fakes';

const CURRENT = 'v2.0.0';
const MANIFEST = 'https://example.com/releases/gateway-bin-latest.json';
const BIN_URL = 'https://example.com/releases/newhorizons-gateway-v9.9.9-darwin-arm64';
const NOTES = 'https://example.com/releases/notes/v9.9.9.md';
const BINARY = utf8Encode('new gateway binary v9.9.9');
const BINARY_SHA = '' + (await nodeSha256(BINARY));

function manifestBody(overrides: Record<string, unknown> = {}, asset: Record<string, unknown> | null = {}) {
  return JSON.stringify({
    version: 'v9.9.9',
    notes_url: NOTES,
    assets: {
      'win32-x64': { url: 'https://example.com/win.exe', sha256: 'aa', size: 3 },
      ...(asset ? { 'darwin-arm64': { url: BIN_URL, sha256: BINARY_SHA, size: BINARY.length, ...asset } } : {}),
    },
    ...overrides,
  });
}

function setup(options: Partial<UpdateManagerOptions> = {}, body: string | null = manifestBody()) {
  const clock = new FakeClock();
  const http = new FakeHttp();
  const installer = new FakeInstaller();
  if (body !== null) http.texts.set(MANIFEST, body);
  http.texts.set(NOTES, '# Changes\n\n- Force OTA update\n');
  http.bytes.set(BIN_URL, BINARY);
  const manager = new GatewayUpdateManager({
    version: CURRENT,
    platformKey: 'darwin-arm64',
    http,
    sha256: nodeSha256,
    clock,
    installer,
    manifestUrl: MANIFEST,
    ...options,
  });
  const restarts: string[] = [];
  return { clock, http, installer, manager, restarts, withRestart: () => manager.setRestartCallback(() => restarts.push('requested')) };
}

describe('state (test_gateway_update_manager.py)', () => {
  it('maps the slot boot metadata onto the installer', () => {
    const { manager, installer } = setup();
    let state = manager.state();
    expect(state).toMatchObject({
      phase: 'idle',
      current_version: CURRENT,
      active_slot: 'current',
      inactive_slot: 'staged',
      pending_slot: '',
      boot_phase: 'idle',
      rollback_reason: '',
      target_version: '',
      pending_release_ready: false,
      health_ready: true,
      platform_key: 'darwin-arm64',
      platform_supported: true,
      progress_pct: 0,
      progress_label: 'Waiting',
    });
    installer.rollbackReason = 'health_timeout';
    expect(manager.state()).toMatchObject({ boot_phase: 'rolled_back', rollback_reason: 'health_timeout' });
    installer.stagedUpdate = { version: 'v9.9.9' };
    state = manager.state();
    expect(state).toMatchObject({ boot_phase: 'pending_switch', pending_slot: 'staged', target_version: 'v9.9.9', pending_release_ready: true, pending_slot_version: 'v9.9.9' });
  });

  it('a newer server version requires an update without a manifest', () => {
    const { manager } = setup();
    manager.setServerLatestVersion('v9.9.9');
    const state = manager.state();
    expect(state.required_update).toBe(true);
    expect(manager.requiredUpdate).toBe(true);
    expect(state.latest_gateway_version).toBe('v9.9.9');
    expect(state.update_signal_source).toBe('server_ws');
    expect(state.latest_version).toBe('');
    expect(state.update_available).toBe(true);
  });

  it('the same server version does not lock the gateway; blank is ignored', () => {
    const { manager } = setup();
    manager.setServerLatestVersion(CURRENT);
    expect(manager.state().required_update).toBe(false);
    manager.setServerLatestVersion('  ');
    expect(manager.state().update_signal_source).toBe('server_ws');
  });

  it('a prerelease of the current version is not an update', () => {
    const { manager } = setup();
    manager.setServerLatestVersion(`${CURRENT}-beta.1`);
    expect(manager.state().required_update).toBe(false);
  });

  it('update_block carries the Hub field names', () => {
    const { manager } = setup();
    manager.setServerLatestVersion('v9.9.9');
    expect(manager.updateBlock('waiting_for_idle')).toEqual({
      channel: 'stable',
      resolved_manifest_url: MANIFEST,
      required_update: true,
      latest_gateway_version: 'v9.9.9',
      auto_apply: 'waiting_for_idle',
      phase: 'idle',
      operation: 'Waiting',
      available: true,
      version: 'v9.9.9',
      current_version: CURRENT,
      changelog_url: '',
      notes_url: '',
      progress_pct: 0,
      busy: false,
      error: '',
      checked_at: '',
    });
    manager.setServerLatestVersion(CURRENT);
    expect(manager.updateBlock('waiting_for_idle').auto_apply).toBe('');
  });
});

describe('check()', () => {
  it('maybe_refresh fetches manifest and notes for a required update', async () => {
    const { manager } = setup();
    manager.setServerLatestVersion('v9.9.9');
    const state = await manager.maybeRefresh();
    expect(state.required_update).toBe(true);
    expect(state.latest_version).toBe('v9.9.9');
    expect(state.zip_url).toBe(BIN_URL);
    expect(state.asset_url).toBe(BIN_URL);
    expect(state.sha256).toBe(BINARY_SHA);
    expect(state.notes_markdown).toBe('# Changes\n\n- Force OTA update\n');
    expect(state.update_signal_source).toBe('server_ws');
    expect(state.phase).toBe('checked');
    expect(state.last_checked_at).toMatch(/^\d{4}-\d\d-\d\dT.*\+00:00$/);
  });

  it('maybe_refresh does nothing without a required update, and refetches only when stale', async () => {
    const { manager, http, clock } = setup();
    await manager.maybeRefresh();
    expect(http.requests).toEqual([]);
    manager.setServerLatestVersion('v9.9.9');
    await manager.maybeRefresh();
    const fetched = http.requests.filter((u) => u === MANIFEST).length;
    expect(fetched).toBe(1);
    clock.mono += 599_000;
    await manager.maybeRefresh();
    expect(http.requests.filter((u) => u === MANIFEST).length).toBe(1);
    clock.mono += 1_000;
    await manager.maybeRefresh();
    expect(http.requests.filter((u) => u === MANIFEST).length).toBe(2);
  });

  it('a newer manifest alone makes the update required', async () => {
    const { manager } = setup();
    const state = await manager.check(true);
    expect(state).toMatchObject({ required_update: true, latest_gateway_version: 'v9.9.9', update_signal_source: 'manifest' });
  });

  it('check(force=false) is a no-op without a required update', async () => {
    const { manager, http } = setup();
    await manager.check(false);
    expect(http.requests).toEqual([]);
  });

  it('fetches translated notes beside the original; a missing one is not an error', async () => {
    const { manager, http } = setup();
    http.texts.set(NOTES, '# 中文');
    http.texts.set('https://example.com/releases/notes/v9.9.9.ja.md', '# 日本語');
    const state = await manager.check(true);
    expect(state.notes_markdown).toBe('# 中文');
    expect(state.notes_markdown_i18n).toEqual({ ja: '# 日本語' });
    expect(state.last_error).toBe('');
  });

  it('blank translations are ignored', async () => {
    const { manager, http } = setup();
    http.texts.set('https://example.com/releases/notes/v9.9.9.en.md', '  \n');
    expect((await manager.check(true)).notes_markdown_i18n).toEqual({});
  });

  it('unreachable notes are reported but do not fail the check', async () => {
    const { manager, http } = setup();
    http.texts.delete(NOTES);
    const state = await manager.check(true);
    expect(state.phase).toBe('checked');
    expect(state.notes_markdown).toBe('');
    expect(String(state.last_error)).toMatch(/^notes_unavailable: HTTP Error 404/);
  });

  it('a manifest failure keeps required_update and shows empty notes', async () => {
    const { manager } = setup({}, null);
    manager.setServerLatestVersion('v9.9.9');
    const state = await manager.maybeRefresh();
    expect(state.required_update).toBe(true);
    expect(state.notes_markdown).toBe('');
    expect(state.phase).toBe('error');
    expect(state.last_error).toBeTruthy();
    expect(state.progress_label).toBe('Update failed');
  });

  it('a forced failing check marks the signal source as manifest', async () => {
    const { manager } = setup({}, null);
    const state = await manager.check(true);
    expect(state.update_signal_source).toBe('manifest');
  });

  it.each([
    ['not json', /JSON|Unexpected/],
    ['[1]', /^invalid_manifest$/],
    [JSON.stringify({ assets: {} }), /^manifest_missing_version$/],
    [JSON.stringify({ version: 'v9.9.9' }), /^manifest_missing_assets$/],
    [JSON.stringify({ version: 'v9.9.9', assets: [] }), /^manifest_missing_assets$/],
    [manifestBody({}, { url: '' }), /^manifest_missing_url$/],
    [manifestBody({}, { sha256: ' ' }), /^manifest_missing_sha256$/],
    [manifestBody({}, { size: undefined }), /^manifest_missing_size$/],
    [manifestBody({}, { size: -1 }), /^manifest_missing_size$/],
    [manifestBody({ assets: { 'darwin-arm64': 'x' } }), /^manifest_invalid_asset$/],
  ])('rejects manifest %s', async (body, error) => {
    const { manager } = setup({}, body);
    const state = await manager.check(true);
    expect(state.phase).toBe('error');
    expect(String(state.last_error)).toMatch(error);
    expect(state.latest_version).toBe('');
  });

  it('only validates this platform\'s asset', () => {
    const body = JSON.stringify({ version: 'v1.0.0', assets: { 'win32-x64': {}, 'darwin-arm64': { url: 'u', sha256: 'AB', size: '12' } } });
    expect(parseBinManifest(body, 'darwin-arm64').asset).toEqual({ url: 'u', sha256: 'ab', size: 12 });
  });

  it('concurrent checks share one fetch', async () => {
    const { manager, http } = setup();
    await Promise.all([manager.check(true), manager.check(true), manager.maybeRefresh()]);
    expect(http.requests.filter((u) => u === MANIFEST).length).toBe(1);
  });
});

describe('platform without an asset', () => {
  it('is "no update here", not a lock', async () => {
    const { manager, installer } = setup({}, manifestBody({}, null));
    manager.setServerLatestVersion('v9.9.9');
    expect(manager.requiredUpdate).toBe(true);
    const state = await manager.maybeRefresh();
    expect(state).toMatchObject({
      phase: 'checked',
      last_error: '',
      latest_version: 'v9.9.9',
      platform_supported: false,
      required_update: false,
      update_available: false,
      zip_url: '',
    });
    expect(manager.requiredUpdate).toBe(false);
    expect(manager.updateBlock('waiting_for_idle')).toMatchObject({ required_update: false, auto_apply: '', available: false });

    await manager.startUpdate();
    await manager.waitForIdle();
    expect(manager.state()).toMatchObject({ phase: 'checked', busy: false });
    expect(installer.stagedUpdate).toBeNull();
  });

  it('still requires the update while the manifest lags behind the server', async () => {
    const { manager } = setup({}, manifestBody({ version: 'v9.9.8' }, null));
    manager.setServerLatestVersion('v9.9.9');
    await manager.maybeRefresh();
    expect(manager.requiredUpdate).toBe(true);
  });

  it('download() reports it plainly', async () => {
    const { manager } = setup({}, manifestBody({}, null));
    expect((await manager.download()).last_error).toBe('no_asset_for_platform');
  });
});

describe('start_update / restart', () => {
  it('downloads, verifies, stages via the installer, activates and requests the restart', async () => {
    const { manager, installer, restarts, withRestart } = setup();
    withRestart();
    manager.setServerLatestVersion('v9.9.9');
    const started = await manager.startUpdate();
    expect(started).toMatchObject({ busy: true, phase: 'checking', progress_pct: 2, progress_label: 'Checking for update' });
    expect((await manager.startUpdate()).busy).toBe(true); // a second start joins the first
    await manager.waitForIdle();
    const state = manager.state();
    expect(state).toMatchObject({
      phase: 'switch_pending',
      busy: false,
      pending_slot: 'staged',
      target_version: 'v9.9.9',
      download_progress_pct: 100,
      apply_progress_pct: 100,
      progress_pct: 100,
      progress_label: 'Switching to update',
      downloaded: true,
      downloaded_sha256: BINARY_SHA,
      restart_required: false,
      last_error: '',
    });
    expect(installer.stagedBytes).toEqual(BINARY);
    expect(installer.stagedInfo).toEqual({ version: 'v9.9.9', platformKey: 'darwin-arm64', url: BIN_URL, sha256: BINARY_SHA, size: BINARY.length });
    expect(installer.progressSeen).toEqual([10, 50, 100]);
    expect(installer.activations).toBe(1);
    expect(restarts).toEqual(['requested']);
    expect(manager.softRestartRequested).toBe(false);
  });

  it('reports download progress below 100 until verified', async () => {
    const { manager, http } = setup();
    const big = new Uint8Array(200 * 1024).fill(7);
    const sha = await nodeSha256(big);
    http.texts.set(MANIFEST, manifestBody({}, { sha256: sha, size: big.length }));
    http.bytes.set(BIN_URL, big);
    const seen: number[] = [];
    const getBytes = http.getBytes.bind(http);
    http.getBytes = (url, timeout, onProgress) =>
      getBytes(url, timeout, (r, t) => {
        onProgress?.(r, t);
        seen.push(manager.state().download_progress_pct as number);
      });
    http.reportTotal = false; // falls back to the manifest size
    await manager.check(true);
    await manager.download();
    expect(seen).toEqual([0, 32, 64, 96, 99]);
    expect(manager.state()).toMatchObject({ phase: 'downloaded', download_progress_pct: 100, progress_pct: 50 });
  });

  it('a sha256 mismatch stops before staging', async () => {
    const { manager, installer, restarts, withRestart } = setup({}, manifestBody({}, { sha256: 'ab'.repeat(32) }));
    withRestart();
    await manager.startUpdate();
    await manager.waitForIdle();
    expect(manager.state()).toMatchObject({ phase: 'error', last_error: 'sha256_mismatch', busy: false, downloaded: false, progress_pct: 0 });
    expect(installer.stagedUpdate).toBeNull();
    expect(restarts).toEqual([]);
  });

  it('a size mismatch stops before staging', async () => {
    const { manager, installer } = setup({}, manifestBody({}, { size: BINARY.length + 1 }));
    await manager.startUpdate();
    await manager.waitForIdle();
    expect(manager.state()).toMatchObject({ phase: 'error', last_error: 'size_mismatch' });
    expect(installer.stagedUpdate).toBeNull();
  });

  it('a download failure is an error', async () => {
    const { manager, http } = setup();
    http.bytes.delete(BIN_URL);
    await manager.startUpdate();
    await manager.waitForIdle();
    expect(String(manager.state().last_error)).toMatch(/404/);
  });

  it('an installer failure is an error and nothing restarts', async () => {
    const { manager, installer, restarts, withRestart } = setup();
    withRestart();
    installer.failStage = 'disk full';
    await manager.startUpdate();
    await manager.waitForIdle();
    expect(manager.state()).toMatchObject({ phase: 'error', last_error: 'disk full', busy: false });
    expect(restarts).toEqual([]);
  });

  it('an activation failure is an error and the restart callback is not called', async () => {
    const { manager, installer, restarts, withRestart } = setup();
    withRestart();
    installer.failActivate = 'EACCES';
    await manager.startUpdate();
    await manager.waitForIdle();
    expect(manager.state()).toMatchObject({ phase: 'error', last_error: 'EACCES' });
    expect(restarts).toEqual([]);
  });

  it('nothing newer: the sequence ends at checked', async () => {
    const { manager, installer } = setup({}, manifestBody({ version: CURRENT }));
    await manager.startUpdate();
    await manager.waitForIdle();
    expect(manager.state()).toMatchObject({ phase: 'checked', busy: false, update_available: false });
    expect(installer.stagedUpdate).toBeNull();
  });

  it('without a restart callback the staged update waits for a manual restart', async () => {
    const { manager, installer, restarts } = setup();
    await manager.startUpdate();
    await manager.waitForIdle();
    expect(manager.state()).toMatchObject({ phase: 'switch_pending', restart_required: true, manual_update_required: true });
    expect(installer.activations).toBe(0);

    expect(manager.restart()).toMatchObject({ restart_required: true, manual_update_required: true });
    manager.setRestartCallback(() => restarts.push('requested'));
    expect(manager.restart()).toMatchObject({ phase: 'switch_pending', restart_required: false, manual_update_required: false });
    await manager.waitForIdle();
    expect(installer.activations).toBe(1);
    expect(restarts).toEqual(['requested']);
    expect(manager.softRestartRequested).toBe(false);
  });

  it('restart with nothing staged is a soft restart', () => {
    const { manager, restarts, withRestart } = setup();
    withRestart();
    const state = manager.restart();
    expect(state).toMatchObject({ phase: 'restarting', progress_label: 'Restarting', restart_required: false });
    expect(manager.softRestartRequested).toBe(true);
    expect(restarts).toEqual(['requested']);
  });

  it('a throwing restart callback is reported', () => {
    const { manager } = setup();
    manager.setRestartCallback(() => {
      throw new Error('nope');
    });
    expect(manager.restart()).toMatchObject({ phase: 'error', last_error: 'nope' });
  });

  it('check() during a download does not interfere', async () => {
    const { manager, http } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const getBytes = http.getBytes.bind(http);
    http.getBytes = async (url, timeout, onProgress) => {
      await gate;
      return getBytes(url, timeout, onProgress);
    };
    await manager.startUpdate();
    while (manager.phase !== 'downloading') await new Promise((r) => setTimeout(r, 0));
    const before = http.requests.length;
    expect((await manager.check(true)).phase).toBe('downloading');
    expect(http.requests.length).toBe(before);
    release();
    await manager.waitForIdle();
    expect(manager.phase).toBe('switch_pending');
  });
});

describe('channels (test_gateway_update_channel.py)', () => {
  it('defaults to stable and the bin manifest', () => {
    const { manager } = setup({ manifestUrl: undefined });
    expect(manager.updateChannel).toBe('stable');
    expect(manager.manifestUrl().endsWith('/releases/gateway-bin-latest.json')).toBe(true);
    expect(manager.state().update_channel).toBe('stable');
  });

  it('beta reads the beta bin manifest', () => {
    const { manager } = setup({ manifestUrl: undefined, channel: 'beta' });
    expect(manager.manifestUrl().endsWith('/releases/gateway-bin-beta.json')).toBe(true);
  });

  it('an explicit manifest overrides the channel', () => {
    const { manager } = setup({ manifestUrl: 'file:///tmp/custom.json', channel: 'beta' });
    expect(manager.manifestUrl()).toBe('file:///tmp/custom.json');
  });

  it('binManifestUrlFor sits beside the Python manifests', () => {
    expect(binManifestUrlFor('stable')).toBe('https://raw.githubusercontent.com/wenzi7777/New-Horizons-Gateway/main/releases/gateway-bin-latest.json');
    expect(binManifestUrlFor('BETA')).toMatch(/gateway-bin-beta\.json$/);
    expect(binManifestUrlFor('nightly')).toMatch(/gateway-bin-latest\.json$/);
  });

  it('switching back to stable drops the beta requirement', async () => {
    const { manager } = setup({ manifestUrl: undefined, channel: 'beta' });
    manager.setServerLatestVersion('v99.0.0-beta.1');
    expect(manager.state().required_update).toBe(true);
    const state = manager.setChannel('stable');
    expect(state.required_update).toBe(false);
    expect(state.latest_gateway_version).toBe('');
    expect(state.update_signal_source).toBe('');
    expect(state.update_channel).toBe('stable');
    expect(String(state.manifest_url).endsWith('gateway-bin-latest.json')).toBe(true);
  });

  it('an unknown channel is stable; the same channel keeps state', () => {
    const { manager } = setup();
    manager.setServerLatestVersion('v9.9.9');
    expect(manager.setChannel('nightly')).toMatchObject({ update_channel: 'stable', required_update: true });
  });

  it('a switch while busy changes the channel but keeps the running update\'s state', async () => {
    const { manager } = setup();
    manager.setServerLatestVersion('v9.9.9');
    await manager.startUpdate();
    expect(manager.setChannel('beta')).toMatchObject({ update_channel: 'beta', required_update: true, latest_gateway_version: 'v9.9.9' });
    await manager.waitForIdle();
  });

  it('auto check interval is at least 60 s', () => {
    expect(setup().manager.autoCheckIntervalMs).toBe(600_000);
    expect(setup({ autoCheckIntervalSec: 5 }).manager.autoCheckIntervalSec).toBe(60);
  });
});

describe('localizedNotesUrl', () => {
  it('follows the Python rule', () => {
    const base = 'https://raw.githubusercontent.com/x/y/v1.1.2/releases/notes/v1.1.2.md';
    expect(localizedNotesUrl(base, 'en')).toBe(base.slice(0, -3) + '.en.md');
    expect(localizedNotesUrl('https://x/v1.0.0-beta.1.md', 'ja')).toBe('https://x/v1.0.0-beta.1.ja.md');
    expect(localizedNotesUrl('https://x/v1.0.0.md?raw=1', 'ja')).toBe('https://x/v1.0.0.ja.md?raw=1');
    expect(localizedNotesUrl('https://x/v1.0.0.ja.md', 'en')).toBe('');
    expect(localizedNotesUrl('https://x/notes.md', 'en')).toBe('');
    expect(localizedNotesUrl('', 'en')).toBe('');
  });
});

describe('rolled-back release', () => {
  it('stops requiring exactly the version that failed its health check, not a newer one', () => {
    const { manager, installer } = setup();
    manager.setServerLatestVersion('v9.9.9');
    expect(manager.requiredUpdate).toBe(true);
    installer.bootStatus = () => ({ rollbackReason: 'health_timeout', healthReady: true, rolledBackVersion: 'v9.9.9' });
    expect(manager.requiredUpdate).toBe(false);
    expect(manager.state().required_update).toBe(false);
    manager.setServerLatestVersion('v9.9.10');
    expect(manager.requiredUpdate).toBe(true);
  });
});
