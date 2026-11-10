// The tools area's main-process side: streamed reads, recording files,
// terminal history, dialogs, and the pressure chamber proxy against a fake
// HTTP (pressure_cal_client.py + the /api/pressure-cal routes' checks).
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PRESSURE_CAL_MAX_KPA,
  PressureCalClient,
  applyPressureSettings,
  normalizePressureSettings,
  pressureSettingsView,
  type FetchLike,
} from '@nhgw/host';

import { createToolsArea, readFileChunk, recordingFilesIn } from '../../src/main/areas/tools';
import type { AreaContext } from '../../src/main/areas/registry';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeFetch(reply: (call: Call) => { status?: number; body: string } = () => ({ body: '{"ok":true}' })) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const r = reply(call);
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => r.body };
  };
  return { fn, calls };
}

function setup(fetchFn?: FetchLike, dialog: { save?: string | null; open?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nh-tools-'));
  const warnings: string[] = [];
  const logger = { info() {}, warn: (m: string) => void warnings.push(m), error() {} };
  const module = createToolsArea({
    fetch: fetchFn,
    dialogs: { save: async () => dialog.save ?? null, open: async () => dialog.open ?? null },
    recordingPath: (id) => {
      if (id.split('/').length !== 3 || id.includes('..')) throw new Error('invalid_recording_id');
      return join(dir, 'recordings', id);
    },
  });
  const context = { controller: {} as AreaContext['controller'], emit() {}, logger, userDataDir: dir, version: 'v0' } as AreaContext;
  const h = module.register(context) as Record<string, (...args: any[]) => any>;
  return { dir, h, warnings };
}

describe('streamed file reads', () => {
  it('reads a file in chunks that concatenate to the whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nh-chunk-'));
    const text = 'timestamp_ms,P1\n' + Array.from({ length: 5000 }, (_, i) => `${i},${i % 9}`).join('\n');
    writeFileSync(join(dir, 'a.csv'), text);
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const chunk = await readFileChunk(join(dir, 'a.csv'), offset, 1000);
      expect(chunk.data.length).toBeLessThanOrEqual(1000);
      expect(chunk.totalBytes).toBe(Buffer.byteLength(text));
      parts.push(chunk.data);
      offset = chunk.nextOffset;
      if (chunk.done) break;
    }
    expect(Buffer.concat(parts).toString('utf8')).toBe(text);
  });
  it('caps a chunk at 8 MB and reads past the end as empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nh-chunk-'));
    writeFileSync(join(dir, 'b'), 'abc');
    const chunk = await readFileChunk(join(dir, 'b'), 10, 1e12);
    expect(chunk).toMatchObject({ nextOffset: 10, done: true, totalBytes: 3 });
    expect(chunk.data.length).toBe(0);
  });
});

describe('recording files', () => {
  it('finds data/events by meta.files, refuses names outside the folder', async () => {
    const { dir, h } = setup();
    const folder = join(dir, 'recordings', 'UID1', '20261110', '101010');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'x.data.csv'), 'timestamp_ms,P1\n1,2\n');
    writeFileSync(join(folder, '101010.events.csv'), 'seq\n');
    writeFileSync(join(folder, '101010.meta.json'), JSON.stringify({ files: { data: 'x.data.csv', events: '../evil.csv' } }));
    const files = await recordingFilesIn(folder);
    expect(files.data).toBe(join(folder, 'x.data.csv'));
    expect(files.events).toBe(join(folder, '101010.events.csv'));
    const view = await h.recordingFiles!('UID1/20261110/101010');
    expect(view).toMatchObject({ dataBytes: 20, dataName: 'x.data.csv' });
    const chunk = await h.readChunk!({ kind: 'recording', recordingId: 'UID1/20261110/101010', file: 'data' }, 0);
    expect(Buffer.from(chunk.data).toString()).toBe('timestamp_ms,P1\n1,2\n');
    await expect(h.readChunk!({ kind: 'recording', recordingId: '../../etc', file: 'data' }, 0)).rejects.toThrow();
    await expect(h.readChunk!({ kind: 'opened', token: 'nope' }, 0)).rejects.toThrow('unknown_file');
  });
  it('reads an opened file only by its token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nh-open-'));
    writeFileSync(join(dir, 'pick.csv'), 'a,b\n');
    const { h } = setup(undefined, { open: join(dir, 'pick.csv') });
    const file = await h.openAnalysisFile!();
    expect(file).toMatchObject({ name: 'pick.csv', bytes: 4 });
    const chunk = await h.readChunk!({ kind: 'opened', token: file.token }, 0);
    expect(Buffer.from(chunk.data).toString()).toBe('a,b\n');
  });
});

describe('save and upload dialogs', () => {
  it('writes text and bytes; cancel resolves null', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'nh-save-')), 'o.csv');
    const { h } = setup(undefined, { save: out });
    expect(await h.saveFile!({ defaultName: '../x.csv', data: 'hi' })).toBe(out);
    expect(readFileSync(out, 'utf8')).toBe('hi');
    await h.saveFile!({ defaultName: 'x.bin', data: Uint8Array.from([1, 2]) });
    expect([...readFileSync(out)]).toEqual([1, 2]);
    expect(await setup().h.saveFile!({ defaultName: 'x', data: '' })).toBeNull();
  });
  it('refuses an upload above the limit', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nh-up-')), 'big.bin');
    writeFileSync(path, Buffer.alloc(100));
    const { h } = setup(undefined, { open: path });
    await expect(h.openUploadFile!(10)).rejects.toThrow('file_too_large');
    expect((await h.openUploadFile!(1000)).data.length).toBe(100);
  });
});

describe('terminal', () => {
  it('compiles like terminal.py and reports its error codes', async () => {
    const { h } = setup();
    expect(await h.terminalCompile!('status')).toMatchObject({ ok: true, compiled: { command: 'status', payload: { command: 'status' } } });
    expect(await h.terminalCompile!('')).toEqual({ ok: false, error: 'empty_command' });
    expect(await h.terminalCompile!('no-such-thing')).toEqual({ ok: false, error: 'unknown_command' });
    expect((await h.terminalHelp!()).length).toBeGreaterThan(10);
  });
  it('keeps per-device history, de-duplicated, newest last, capped', async () => {
    const { h } = setup();
    await h.terminalHistoryAdd!('abc', 'status');
    await h.terminalHistoryAdd!('abc', 'health');
    expect(await h.terminalHistoryAdd!('ABC', 'status')).toEqual(['health', 'status']);
    expect(await h.terminalHistory!('other')).toEqual([]);
    await Promise.all(Array.from({ length: 250 }, (_, i) => h.terminalHistoryAdd!('abc', `c${i}`)));
    const list = await h.terminalHistory!('abc');
    expect(list.length).toBe(200);
    expect(list.at(-1)).toBe('c249');
    await h.terminalHistoryClear!('abc');
    expect(await h.terminalHistory!('abc')).toEqual([]);
    await expect(h.terminalHistory!('../x')).rejects.toThrow('invalid_uid');
  });
});

describe('pressure chamber proxy', () => {
  it('client: paths, bearer token, JSON body', async () => {
    const fake = fakeFetch();
    const client = new PressureCalClient('http://pi.local/', 'secret-token', fake.fn);
    await client.health();
    await client.readings();
    await client.setTarget(10);
    await client.stop();
    expect(fake.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://pi.local/api/v1/health',
      'GET http://pi.local/api/v1/readings/all',
      'POST http://pi.local/api/v1/pressure/target',
      'POST http://pi.local/api/v1/pressure/stop',
    ]);
    expect(fake.calls[0]!.headers.Authorization).toBe('Bearer secret-token');
    expect(JSON.parse(fake.calls[2]!.body!)).toEqual({ target_kpa: 10 });
    expect('setControlEnabled' in client || 'enterSafeMode' in client).toBe(false);
  });
  it('caps the target at 28 kPa: nothing above it or below 0 reaches the chamber', async () => {
    expect(PRESSURE_CAL_MAX_KPA).toBe(28);
    const fake = fakeFetch();
    const { h } = setup(fake.fn);
    await h.pressureSaveSettings!({ preset: 'custom', url: 'http://pi.local', token: 'tok-123456789' });
    expect(await h.pressureSetTarget!(28.01)).toEqual({ ok: false, error: 'target_kpa_exceeds_safety_limit', status: 422 });
    expect(await h.pressureSetTarget!(-1)).toEqual({ ok: false, error: 'target_kpa_must_be_non_negative', status: 422 });
    expect(await h.pressureSetTarget!(Number.NaN)).toMatchObject({ ok: false, error: 'target_kpa_required' });
    expect(await h.pressureSetTarget!('10' as unknown as number)).toMatchObject({ ok: false, error: 'target_kpa_required' });
    expect(fake.calls).toHaveLength(0);
    expect(await h.pressureSetTarget!(28)).toEqual({ ok: true, data: { ok: true } });
    expect(fake.calls).toHaveLength(1);
    await expect(new PressureCalClient('http://x', 't', fake.fn).setTarget(30)).rejects.toThrow('target_kpa_exceeds_safety_limit');
  });
  it('not configured until a token is entered; the token is masked and never logged', async () => {
    const fake = fakeFetch(() => ({ status: 500, body: 'boom' }));
    const { h, dir, warnings } = setup(fake.fn);
    expect(await h.pressureHealth!()).toEqual({ ok: false, error: 'pressure_cal_not_configured' });
    const view0 = await h.pressureSettings!();
    expect(view0).toMatchObject({ preset: 'lab_pi', configured: false, tokenHint: '' });
    await h.pressureSaveSettings!({ preset: 'lab_pi', token: 'pcapi-ABCDEFGHIJ' });
    const view = await h.pressureSettings!();
    expect(view).toMatchObject({ configured: true, tokenHint: 'pcapi-AB...' });
    expect(JSON.stringify(view)).not.toContain('ABCDEFGHIJ');
    const failed = await h.pressureReadings!();
    expect(failed).toMatchObject({ ok: false, status: 500 });
    expect(warnings.join('\n')).not.toContain('pcapi');
    expect(readFileSync(join(dir, 'tools-pressure.json'), 'utf8')).toContain('pcapi-ABCDEFGHIJ');
  });
  it('custom settings need a URL and token, http(s) only; old {url, token} files migrate', () => {
    const empty = normalizePressureSettings(null);
    expect(applyPressureSettings(empty, { preset: 'custom', url: 'http://a' })).toEqual({ error: 'url_and_token_required_for_custom' });
    expect(applyPressureSettings(empty, { preset: 'custom', url: 'ftp://a', token: 't' })).toEqual({ error: 'url_scheme_must_be_http_or_https' });
    const saved = applyPressureSettings(empty, { preset: 'custom', url: 'https://a', token: 't' });
    expect(applyPressureSettings(saved as never, { preset: 'custom', url: 'https://b' })).toMatchObject({ url: 'https://b', token: 't' });
    expect(normalizePressureSettings({ url: 'http://old', token: 'x' })).toMatchObject({ preset: 'custom', url: 'http://old' });
    expect(pressureSettingsView(normalizePressureSettings({ url: 'http://old', token: 'x' })).configured).toBe(true);
  });
  it('network errors and bad JSON become errors, not crashes', async () => {
    const client = new PressureCalClient('http://pi', 't', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(client.health()).rejects.toThrow(/Network error/);
    const bad = new PressureCalClient('http://pi', 't', fakeFetch(() => ({ body: '<html>' })).fn);
    await expect(bad.health()).rejects.toThrow(/Invalid JSON/);
  });
});
