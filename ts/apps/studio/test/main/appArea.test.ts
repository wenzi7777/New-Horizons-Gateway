import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AppService, normalizePrefs, redactSecrets, type AppAreaDeps } from '../../src/main/areas/app';
import { QuitRequested, StartupSequence } from '../../src/main/app/startup';
import { readCentralDirectory } from '../../src/main/zip';

function setup(overrides: Partial<AppAreaDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nhs-app-'));
  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'logs', 'studio.log'), 'hello log\n');
  let login = false;
  const deleted: string[] = [];
  const updates: unknown[] = [];
  const now = 100 * 86_400_000;
  const controller = {
    settings: () => ({ dataFolder: '/data' }),
    snapshot: () => ({
      settings: { pocketId: 'studio-1', manualUrl: 'wss://x', authToken: 'SECRET-TOKEN' },
      status: { serviceRunning: true, serviceError: '', upstream: 'online' },
      devices: [],
      recordings: [
        { id: 'A/1', startedAtMs: now - 40 * 86_400_000, inProgress: false, bytes: 10 },
        { id: 'A/2', startedAtMs: now - 5 * 86_400_000, inProgress: false, bytes: 20 },
        { id: 'A/3', startedAtMs: now - 50 * 86_400_000, inProgress: true, bytes: 30 },
      ],
    }),
    updateSettings: async (patch: unknown) => void updates.push(patch),
    host: { deleteRecording: async (id: string) => void deleted.push(id) },
    native: { boundPorts: () => ({ stream: 13250, discovery: 22346 }) },
  };
  const deps: AppAreaDeps = {
    platform: 'darwin',
    arch: 'arm64',
    versions: { electron: '45', node: '22', chrome: '142' },
    osRelease: '25',
    packaged: false,
    loginItem: { get: () => login, set: (v) => void (login = v) },
    openPath: () => undefined,
    showItemInFolder: () => undefined,
    openExternal: () => undefined,
    saveDialog: async (name) => join(dir, name),
    http: async () => ({ status: 404, text: async () => '', body: null }),
    install: async () => undefined,
    now: () => now,
    ...overrides,
  };
  const logger = { info() {}, warn() {}, error() {} };
  const service = new AppService({ controller: controller as never, emit: () => undefined, logger, userDataDir: dir, version: 'v2.0.0' }, deps);
  return { service, dir, deleted, updates, login: () => login };
}

describe('app area', () => {
  it('normalizes prefs with platform defaults', () => {
    expect(normalizePrefs(null, 'darwin').keepRunningInBackground).toBe(true);
    expect(normalizePrefs(null, 'win32').keepRunningInBackground).toBe(false);
    expect(normalizePrefs({ updateChannel: 'nightly' }, 'win32').updateChannel).toBe('stable');
  });

  it('sets the login item and persists prefs', async () => {
    const { service, login } = setup();
    await service.setPrefs({ openAtLogin: true, updateChannel: 'beta' });
    expect(login()).toBe(true);
    expect(service.updater.state.channel).toBe('beta');
  });

  it('diagnostics hold logs and versions but no secrets', async () => {
    const { service } = setup();
    const path = await service.exportDiagnostics();
    expect(path).toBeTruthy();
    const zip = new Uint8Array(require('node:fs').readFileSync(path!));
    const names = readCentralDirectory(zip).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['versions.json', 'settings.json', 'status.json', 'logs/studio.log']));
    expect(JSON.stringify(redactSecrets({ a: { authToken: 'x', password: 'y', ok: 1 } }))).toBe('{"a":{"authToken":"[redacted]","password":"[redacted]","ok":1}}');
    const work = join(require('node:os').tmpdir(), 'nhs-diag-check');
    mkdirSync(work, { recursive: true });
    const entries = await service.diagnosticsEntries(work);
    const settings = require('node:fs').readFileSync(entries.find((e) => e.name === 'settings.json')!.path, 'utf8');
    expect(settings).not.toContain('SECRET-TOKEN');
  });

  it('prunes only finished recordings older than N days', async () => {
    const { service, deleted } = setup();
    expect(await service.pruneRecordings(30, true)).toEqual({ count: 1, bytes: 10, failed: 0 });
    expect(deleted).toEqual([]);
    await service.pruneRecordings(30, false);
    expect(deleted).toEqual(['A/1']);
    await expect(service.pruneRecordings(0, true)).rejects.toThrow('invalid_days');
  });

  it('missing manifest is not an error', async () => {
    const { service } = setup();
    expect((await service.updater.check()).phase).toBe('none');
  });
});

describe('startup sequence', () => {
  const base = { version: 'v2', theme: 'light' as const, locale: 'en' };

  it('runs steps in order, skips missing ones, survives a failing step', async () => {
    const order: string[] = [];
    const seq = new StartupSequence(base);
    const state = await seq.run({
      settings: async () => (order.push('settings'), { status: 'done' }),
      recovery: async () => {
        order.push('recovery');
        throw new Error('boom');
      },
      server: async () => (order.push('server'), { status: 'warn', detail: 'serverLater' }),
    });
    expect(order).toEqual(['settings', 'recovery', 'server']);
    expect(state.steps.map((s) => s.status)).toEqual(['done', 'warn', 'skipped', 'warn', 'skipped']);
    expect(state.done).toBe(true);
  });

  it('waits on a prompt and resumes with the answer', async () => {
    const seq = new StartupSequence(base);
    const run = seq.run({ ports: async (ctx) => ({ status: (await ctx.ask({ kind: 'ports', message: 'busy' })) === 'continue' ? 'warn' : 'done' }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(seq.state.prompt).toEqual({ kind: 'ports', message: 'busy' });
    expect(seq.state.steps.find((s) => s.id === 'ports')!.status).toBe('blocked');
    seq.answer('continue');
    const state = await run;
    expect(state.prompt).toBeNull();
    expect(state.steps.find((s) => s.id === 'ports')!.status).toBe('warn');
  });

  it('stops on QuitRequested', async () => {
    const seq = new StartupSequence(base);
    await expect(seq.run({ settings: async () => { throw new QuitRequested(); } })).rejects.toBeInstanceOf(QuitRequested);
  });
});
