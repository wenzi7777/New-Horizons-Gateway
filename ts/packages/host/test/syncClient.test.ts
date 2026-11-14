// SyncClient against an in-memory server implementing docs/studio-sync-api.md.
import { describe, expect, it } from 'vitest';

import type { HostSettings, RecordingSummary } from '../src/contract';
import { syncBaseUrl, SYNC_KEYS } from '../src/sync/config';
import { AUTO_LOGIN_RETRY_MS, SyncClient, SYNC_PATHS, type CredentialStore, type Credentials, type SyncHost } from '../src/sync/client';
import type { SyncHttp, SyncRequest, SyncResponse } from '../src/sync/http';
import { sha256Hex } from '../src/sync/sha256';
import { FakeNative } from './fakeNative';

const TOKEN = 'nhapp_0123456789ab_SECRETsecretSECRETsecret0123456789';
const BASE = 'http://127.0.0.1:5051/newhorizons';

class FakeServer implements SyncHttp {
  uploads = new Map<string, { files: { role: string; size: number; sha256: string }[]; received: Map<string, Uint8Array>; complete: boolean; path: string }>();
  labels = new Map<string, { nickname: string; nickname_updated_ms: number; group: string; group_updated_ms: number }>();
  profiles = new Map<string, { updated_ms: number; deleted: boolean; profile?: Record<string, unknown> }>();
  requests: SyncRequest[] = [];
  /** Fail the next N requests (network) or answer 500. */
  dropNext = 0;
  failPutsAfter = Infinity;
  puts = 0;
  role = 'admin';
  offline = false;
  loginBodies: Record<string, string>[] = [];
  revoked = 0;
  password = 'pw';
  /** false: the server has ended the token (idle, or the account's next sign-in replaced it). */
  tokenValid = true;

  private reply(status: number, body: unknown): SyncResponse {
    return { status, text: JSON.stringify(body) };
  }

  async request(req: SyncRequest): Promise<SyncResponse> {
    this.requests.push(req);
    if (this.dropNext > 0) {
      this.dropNext -= 1;
      throw new Error('ECONNRESET');
    }
    if (req.url.endsWith('/api/app-tokens/login')) {
      const login = JSON.parse(String(req.body)) as Record<string, string>;
      if (login.username !== 'nick' || login.password !== this.password) return this.reply(401, { error: 'invalid_credentials' });
      this.loginBodies.push(login);
      this.tokenValid = true;
      return this.reply(200, { token: TOKEN, token_type: 'Bearer', item: { id: '0123456789ab' }, user: { username: 'nick', role: this.role } });
    }
    if (req.headers.Authorization !== `Bearer ${TOKEN}` || !this.tokenValid) return this.reply(401, { error: 'unauthorized' });
    if (req.url.endsWith('/api/app-tokens/self/revoke')) {
      this.revoked += 1;
      return this.reply(200, { status: 'revoked' });
    }
    const url = new URL(req.url);
    const path = url.pathname.replace('/newhorizons', '');
    const body = typeof req.body === 'string' ? (JSON.parse(req.body) as Record<string, any>) : null;
    if (path === '/api/auth/me') return this.reply(200, { authenticated: true, username: 'app:0123456789ab', role: this.role, client_type: 'studio' });
    if (path === '/api/sync/recordings' && req.method === 'POST') {
      const id = body!.recording_id as string;
      const existing = this.uploads.get(id);
      const same = existing && JSON.stringify(existing.files) === JSON.stringify(body!.files);
      if (existing?.complete) return same ? this.reply(200, { status: 'complete', recording_id: id, path: existing.path }) : this.reply(409, { error: 'recording_id_conflict' });
      const upload = same ? existing! : { files: body!.files, received: new Map(), complete: false, path: '' };
      this.uploads.set(id, upload);
      return this.reply(200, { status: 'uploading', recording_id: id, max_chunk_bytes: 8 * 1024 * 1024, files: upload.files.map((f: { role: string; size: number }) => ({ role: f.role, size: f.size, received: upload.received.get(f.role)?.length ?? 0 })) });
    }
    let m = /^\/api\/sync\/recordings\/([^/]+)\/files\/(\w+)$/.exec(path);
    if (m && req.method === 'PUT') {
      this.puts += 1;
      if (this.puts > this.failPutsAfter) {
        this.failPutsAfter = Infinity;
        throw new Error('connection lost');
      }
      const upload = this.uploads.get(decodeURIComponent(m[1]!))!;
      const have = upload.received.get(m[2]!) ?? new Uint8Array(0);
      const offset = Number(url.searchParams.get('offset'));
      if (offset !== have.length) return this.reply(409, { error: 'offset_mismatch', role: m[2], received: have.length });
      const chunk = req.body as Uint8Array;
      const next = new Uint8Array(have.length + chunk.length);
      next.set(have);
      next.set(chunk, have.length);
      upload.received.set(m[2]!, next);
      return this.reply(200, { role: m[2], received: next.length });
    }
    m = /^\/api\/sync\/recordings\/([^/]+)\/complete$/.exec(path);
    if (m) {
      const upload = this.uploads.get(decodeURIComponent(m[1]!))!;
      for (const f of upload.files) {
        const got = upload.received.get(f.role) ?? new Uint8Array(0);
        if (got.length !== f.size) return this.reply(409, { error: 'upload_incomplete' });
        if (sha256Hex(got) !== f.sha256) return this.reply(422, { error: 'checksum_mismatch' });
      }
      upload.complete = true;
      upload.path = `X/${this.uploads.size}`;
      return this.reply(200, { status: 'complete', path: upload.path });
    }
    let dm = /^\/api\/devices\/([^/]+)\/(nickname|group)$/.exec(path);
    if (dm && req.method === 'PUT') {
      if (this.offline) throw new Error('ECONNREFUSED');
      const uid = decodeURIComponent(dm[1]!);
      const cur = this.labels.get(uid) ?? { nickname: '', nickname_updated_ms: 0, group: '', group_updated_ms: 0 };
      (cur as any)[dm[2]!] = body![dm[2]!];
      this.labels.set(uid, cur);
      return this.reply(200, { device_uid: uid, ...cur });
    }
    if (path === '/api/profiles' && req.method === 'GET') return this.reply(200, { items: [...this.profiles].filter(([, p]) => !p.deleted).map(([name]) => ({ name, displayName: name })) });
    dm = /^\/api\/profiles\/([^/]+)$/.exec(path);
    if (dm) {
      if (this.offline) throw new Error('ECONNREFUSED');
      const name = decodeURIComponent(dm[1]!);
      if (req.method === 'GET') {
        const p = this.profiles.get(name);
        return p && !p.deleted ? this.reply(200, p.profile) : this.reply(404, { error: 'profile_not_found' });
      }
      if (req.method === 'POST') {
        this.profiles.set(name, { updated_ms: 1, deleted: false, profile: body! });
        return this.reply(200, { status: 'saved', name });
      }
      if (req.method === 'DELETE') {
        if (!this.profiles.has(name)) return this.reply(404, { error: 'profile_not_found' });
        this.profiles.delete(name);
        return this.reply(200, { status: 'deleted' });
      }
    }
    if (path === '/api/sync/labels' && req.method === 'GET') return this.reply(200, { items: [...this.labels].map(([device_uid, l]) => ({ device_uid, ...l })) });
    if (path === '/api/sync/labels' && req.method === 'PUT') {
      const items = (body!.items as any[]).map((item) => {
        const cur = this.labels.get(item.device_uid) ?? { nickname: '', nickname_updated_ms: 0, group: '', group_updated_ms: 0 };
        const applied: string[] = [];
        for (const f of ['nickname', 'group'] as const) {
          if (item[f] !== undefined && item[`${f}_updated_ms`] > cur[`${f}_updated_ms`]) {
            cur[f] = item[f];
            cur[`${f}_updated_ms`] = item[`${f}_updated_ms`];
            applied.push(f);
          }
        }
        this.labels.set(item.device_uid, cur);
        return { device_uid: item.device_uid, ...cur, applied };
      });
      return this.reply(200, { items });
    }
    if (path === '/api/sync/profiles' && req.method === 'GET') return this.reply(200, { items: [...this.profiles].map(([name, p]) => ({ name, ...p })) });
    if (path === '/api/sync/profiles' && req.method === 'PUT') {
      const items = (body!.items as any[]).map((item) => {
        const cur = this.profiles.get(item.name);
        if (!cur || item.updated_ms > cur.updated_ms) {
          this.profiles.set(item.name, { updated_ms: item.updated_ms, deleted: !!item.deleted, ...(item.deleted ? {} : { profile: item.profile }) });
          return { name: item.name, updated_ms: item.updated_ms, applied: true };
        }
        return { name: item.name, ...cur, applied: false };
      });
      return this.reply(200, { items });
    }
    return this.reply(404, {});
  }
}

class FakeHost implements SyncHost {
  readonly clientType = 'studio' as const;
  config: Record<string, unknown> = { target_mode: 'local', manual_url: '' };
  policy: HostSettings['syncPolicy'] = 'manual';
  list: RecordingSummary[] = [];
  states = new Map<string, RecordingSummary['syncState']>();
  nicknames: Record<string, string> = {};
  groups: Record<string, string> = {};
  settings(): HostSettings {
    return { pocketId: 'studio-abcd1234', displayName: 'NH Studio', serverTarget: 'local', manualUrl: '', relayEnabled: true, offerPolicy: 'managed', syncPolicy: this.policy, theme: 'auto', locale: 'en' };
  }
  recordings() {
    return this.list.map((r) => ({ ...r, syncState: r.inProgress ? 'local' : (this.states.get(r.id) ?? 'local') }));
  }
  refreshRecordings() {}
  setRecordingSyncStates(states: ReadonlyMap<string, RecordingSummary['syncState']>) {
    this.states = new Map(states);
  }
  async appConfig() {
    return { ...this.config };
  }
  async saveAppConfig(patch: Record<string, unknown>) {
    Object.assign(this.config, patch);
  }
  readLabels() {
    return { nicknames: { ...this.nicknames }, groups: { ...this.groups } };
  }
  async setNickname(uid: string, value: string) {
    if (value) this.nicknames[uid] = value;
    else delete this.nicknames[uid];
  }
  async setGroup(uid: string, value: string) {
    if (value) this.groups[uid] = value;
    else delete this.groups[uid];
  }
}

const NOW = 1_800_000_000_000;

class MemoryCredentials implements CredentialStore {
  saved: Credentials | null = null;
  async load(): Promise<Credentials | null> {
    return this.saved;
  }
  async save(credentials: Credentials | null): Promise<void> {
    this.saved = credentials;
  }
}

function setup(options: { chunkBytes?: number; credentials?: CredentialStore } = {}) {
  const native = new FakeNative();
  const host = new FakeHost();
  const server = new FakeServer();
  const clock = { t: NOW };
  const logs: string[] = [];
  const timers = { now: () => clock.t, setTimeout: () => 0, clearTimeout: () => undefined };
  const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const client = new SyncClient({
    host,
    files: native,
    http: server,
    timers,
    logger,
    chunkBytes: options.chunkBytes ?? 1000,
    backoff: { baseMs: 1000, maxMs: 8000 },
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });
  return { native, host, server, clock, logs, client };
}

function addRecording(native: FakeNative, host: FakeHost, folder: string, size: number, inProgress = false) {
  const id = `3CDC7545CCD0/20261110/${folder}`;
  const dir = `recordings/${id}`;
  native.writeAtomic(`${dir}/${folder}.data.csv`, 'x'.repeat(size));
  native.writeAtomic(`${dir}/${folder}.events.csv`, 'at_ms,label\n');
  native.writeAtomic(`${dir}/${folder}.meta.json`, JSON.stringify({ recording: { started_at: '2026-11-10T06:27:56.120Z' } }));
  host.list.push({ id, uid: '3CDC7545CCD0', deviceName: 'pad', startedAtMs: NOW - 10_000, durationMs: 1, frames: 1, bytes: size, inProgress, syncState: 'local' });
  return id;
}

async function started(ctx: ReturnType<typeof setup>) {
  await ctx.client.start();
  await ctx.client.setToken(TOKEN);
  return ctx;
}

describe('sync config', () => {
  it('derives the base URL from the server choice', () => {
    expect(syncBaseUrl({ serverTarget: 'production', manualUrl: '' })).toBe('https://isensing-s1.u-aizu.ac.jp/newhorizons');
    expect(syncBaseUrl({ serverTarget: 'local', manualUrl: '' })).toBe(BASE);
    expect(syncBaseUrl({ serverTarget: 'manual', manualUrl: 'wss://lab.example:8443/newhorizons/gateway/ws' })).toBe('https://lab.example:8443/newhorizons');
    expect(syncBaseUrl({ serverTarget: 'manual', manualUrl: 'nonsense' })).toBe('');
  });
  it('hashes like sha256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });
});

describe('SyncClient recordings', () => {
  it('uploads a finished recording in chunks on demand (manual) and never an in-progress one', async () => {
    const ctx = await started(setup());
    const id = addRecording(ctx.native, ctx.host, '100000', 2500);
    addRecording(ctx.native, ctx.host, '110000', 10, true);
    await ctx.client.tick();
    expect(ctx.server.uploads.size).toBe(0); // manual policy: nothing by itself
    await ctx.client.uploadNow();
    await ctx.client.tick();
    expect(ctx.server.uploads.size).toBe(1);
    expect(ctx.client.status().recordings.find((r) => r.id === id)!.state).toBe('synced');
    expect(ctx.host.states.get(id)).toBe('synced');
    expect(ctx.server.puts).toBeGreaterThanOrEqual(3);
    const index = JSON.parse(ctx.native.text(SYNC_PATHS.recordings)!);
    expect(index.items[id].state).toBe('synced');
    expect(index.items[id].recording_id).toBe('studio-abcd1234:3CDC7545CCD0.20261110.100000');
  });

  it('resumes after an interruption from what the server holds', async () => {
    const ctx = await started(setup());
    ctx.host.policy = 'auto';
    const id = addRecording(ctx.native, ctx.host, '100000', 3500);
    ctx.server.failPutsAfter = 2;
    await ctx.client.tick();
    expect(ctx.client.status().recordings[0]!.state).toBe('failed');
    expect(ctx.client.status().recordings[0]!.error).toBe('network');
    const before = ctx.server.puts;
    ctx.clock.t += 1500; // past the first backoff
    await ctx.client.tick();
    expect(ctx.client.status().recordings.find((r) => r.id === id)!.state).toBe('synced');
    expect(ctx.server.puts - before).toBe(4); // data at 2000 and 3000, events, meta: the first 2000 bytes are not sent again
    const offsets = ctx.server.requests.filter((r) => r.method === 'PUT' && r.url.includes('/files/data')).map((r) => new URL(r.url).searchParams.get('offset'));
    expect(offsets).toEqual(['0', '1000', '2000', '2000', '3000']) // the lost chunk once more, nothing before it;
  });

  it('is idempotent: re-upload of a completed recording sends nothing', async () => {
    const ctx = await started(setup());
    const id = addRecording(ctx.native, ctx.host, '100000', 100);
    await ctx.client.uploadNow(id);
    await ctx.client.tick();
    const puts = ctx.server.puts;
    ctx.native.deletePath(SYNC_PATHS.recordings); // state lost
    await ctx.client.reload();
    await ctx.client.uploadNow(id);
    await ctx.client.tick();
    expect(ctx.server.puts).toBe(puts);
    expect(ctx.server.uploads.size).toBe(1);
    expect(ctx.client.status().recordings[0]!.state).toBe('synced');
  });

  it('backs off exponentially and gates by policy', async () => {
    const ctx = await started(setup());
    ctx.host.policy = 'auto';
    addRecording(ctx.native, ctx.host, '100000', 10);
    ctx.server.dropNext = 1000;
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      await ctx.client.tick();
      const r = ctx.client.status().recordings[0]!;
      delays.push(r.nextAttemptMs - ctx.clock.t);
      ctx.clock.t = r.nextAttemptMs;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000]);
    ctx.server.dropNext = 0;
    // wifi_only on a metered network: no automatic upload.
    const metered = setup();
    const client = new SyncClient({ host: metered.host, files: metered.native, http: metered.server, timers: { now: () => NOW, setTimeout: () => 0, clearTimeout: () => undefined }, network: () => ({ online: true, metered: true }) });
    await client.start();
    await client.setToken(TOKEN);
    metered.host.policy = 'wifi_only';
    addRecording(metered.native, metered.host, '100000', 10);
    await client.tick();
    expect(metered.server.uploads.size).toBe(0);
    expect(client.status().autoAllowed).toBe(false);
    await client.uploadNow();
    await client.tick();
    expect(metered.server.uploads.size).toBe(1);
  });

  it('stops on a bad token without retrying, and never logs the token', async () => {
    const ctx = setup();
    await ctx.client.start();
    const wrong = 'nhapp_0123456789ab_WRONGwrongWRONGwrong0123456789';
    const result = await ctx.client.setToken(wrong);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unauthorized');
    expect(ctx.client.status().tokenMasked).toBe('nhapp_0123456789ab_…6789');
    await ctx.client.setToken(TOKEN);
    ctx.host.policy = 'auto';
    addRecording(ctx.native, ctx.host, '100000', 10);
    ctx.server.dropNext = 1;
    await ctx.client.tick();
    expect(ctx.logs.join('\n')).not.toContain('SECRET');
    expect(ctx.logs.join('\n')).not.toContain('WRONG');
    expect(JSON.stringify(ctx.client.status())).not.toContain('SECRET');
    expect(ctx.host.config[SYNC_KEYS.tokenServer]).toBe(BASE);
  });
});

describe('SyncClient sign-in', () => {
  it('exchanges a Desktop account for a token, keeps no password in the config, and signs out by revoking it', async () => {
    const { client, server, host, logs } = setup();
    host.config.gateway_id = 'studio-0a1b2c3d';
    await client.reload();
    await expect(client.login('nick', 'wrong')).rejects.toMatchObject({ code: 'invalid_credentials' });
    const result = await client.login(' nick ', 'pw', 'Lab Mac');
    expect(result.ok).toBe(true);
    expect(server.loginBodies).toEqual([{ username: 'nick', password: 'pw', client_type: 'studio', device_name: 'Lab Mac', relay_id: 'studio-0a1b2c3d' }]);
    expect(client.status()).toMatchObject({ configured: true, account: 'nick' });
    expect(JSON.stringify(host.config)).not.toContain('pw"');
    expect(host.config.sync_account).toBe('nick');
    expect(logs.join('\n')).not.toContain(TOKEN);
    await client.logout();
    expect(server.revoked).toBe(1);
    expect(client.status()).toMatchObject({ configured: false, account: '' });
    expect(host.config.sync_app_token).toBe('');
  });

  it('remembers the account, signs in again on every start, and forgets it on sign-out', async () => {
    const credentials = new MemoryCredentials();
    const first = setup({ credentials });
    await first.client.start();
    await first.client.login('nick', 'pw');
    expect(credentials.saved).toEqual({ username: 'nick', password: 'pw' });
    expect(first.client.status().remembered).toBe(true);
    await first.client.stop();

    // Next start (same config and secure store): a fresh sign-in, no user involved.
    const next = setup({ credentials });
    next.host.config = { ...first.host.config };
    await next.client.start();
    await next.client.tick();
    expect(next.server.loginBodies).toHaveLength(1);
    expect(next.client.status()).toMatchObject({ configured: true, account: 'nick', tokenRejected: false });
    await next.client.tick();
    expect(next.server.loginBodies).toHaveLength(1); // once per start, not every pass

    await next.client.logout();
    expect(credentials.saved).toBeNull();
    expect(next.client.status().remembered).toBe(false);
  });

  it('gets a new token by itself when the server ends the old one', async () => {
    const ctx = setup({ credentials: new MemoryCredentials() });
    await ctx.client.start();
    await ctx.client.login('nick', 'pw');
    ctx.server.tokenValid = false;
    ctx.clock.t += 3 * 60_000; // metadata sync is due: it gets the 401
    await ctx.client.tick();
    expect(ctx.client.status().tokenRejected).toBe(false); // not the user's problem yet
    await ctx.client.tick();
    expect(ctx.server.loginBodies).toHaveLength(2);
    expect(ctx.server.tokenValid).toBe(true);
    expect(ctx.client.status()).toMatchObject({ configured: true, tokenRejected: false });
  });

  it('asks the user only when the remembered password no longer works', async () => {
    const ctx = setup({ credentials: new MemoryCredentials() });
    await ctx.client.start();
    await ctx.client.login('nick', 'pw');
    ctx.server.password = 'changed';
    ctx.server.tokenValid = false;
    ctx.clock.t += 3 * 60_000;
    await ctx.client.tick();
    await ctx.client.tick();
    expect(ctx.client.status().tokenRejected).toBe(true);
    const attempts = ctx.server.requests.filter((r) => r.url.endsWith('/api/app-tokens/login')).length;
    ctx.clock.t += 10 * 60_000;
    await ctx.client.tick();
    expect(ctx.server.requests.filter((r) => r.url.endsWith('/api/app-tokens/login')).length).toBe(attempts); // no more tries
    await ctx.client.login('nick', 'changed');
    expect(ctx.client.status().tokenRejected).toBe(false);
  });

  it('a refused relay link signs in again, but not right after a sign-in', async () => {
    const ctx = setup({ credentials: new MemoryCredentials() });
    await ctx.client.start();
    await ctx.client.login('nick', 'pw');
    ctx.client.relayRefused();
    await ctx.client.autoLogin();
    expect(ctx.server.loginBodies).toHaveLength(1);
    ctx.clock.t += AUTO_LOGIN_RETRY_MS + 1;
    ctx.client.relayRefused();
    await ctx.client.autoLogin();
    expect(ctx.server.loginBodies).toHaveLength(2);
  });
});

describe('SyncClient labels and profiles', () => {
  it('labels: the server copy wins and is the one edited', async () => {
    const ctx = await started(setup());
    ctx.host.nicknames = { AAAAAAAAAAAA: 'local nick', CCCCCCCCCCCC: 'gone' };
    ctx.server.labels.set('AAAAAAAAAAAA', { nickname: 'server nick', nickname_updated_ms: 500, group: 'lab', group_updated_ms: 600 });
    ctx.server.labels.set('BBBBBBBBBBBB', { nickname: 'b', nickname_updated_ms: 10, group: '', group_updated_ms: 0 });
    expect((await ctx.client.syncLabelsNow()).ok).toBe(true);
    expect(ctx.host.nicknames).toEqual({ AAAAAAAAAAAA: 'server nick', BBBBBBBBBBBB: 'b' });
    expect(ctx.host.groups).toEqual({ AAAAAAAAAAAA: 'lab' });
    // An edit goes to the server, then into the mirror.
    await ctx.client.setLabel('AAAAAAAAAAAA', { nickname: 'edited', group: 'bench' });
    expect(ctx.server.labels.get('AAAAAAAAAAAA')).toMatchObject({ nickname: 'edited', group: 'bench' });
    expect(ctx.host.nicknames.AAAAAAAAAAAA).toBe('edited');
    // Unreachable server: nothing changes locally.
    ctx.server.offline = true;
    await expect(ctx.client.setLabel('AAAAAAAAAAAA', { nickname: 'offline edit' })).rejects.toMatchObject({ code: 'server_unavailable' });
    expect(ctx.host.nicknames.AAAAAAAAAAAA).toBe('edited');
  });

  it('profiles: mirrored from the server, edited and deleted there', async () => {
    const ctx = await started(setup());
    ctx.native.writeAtomic('profiles/stale.json', '{"rows":2}');
    ctx.server.profiles.set('theirs', { updated_ms: 100, deleted: false, profile: { rows: 3 } });
    expect((await ctx.client.syncProfilesNow()).ok).toBe(true);
    expect(JSON.parse(ctx.native.text('profiles/theirs.json')!)).toEqual({ rows: 3 });
    expect(ctx.native.text('profiles/stale.json')).toBeNull();
    await ctx.client.saveProfile('mine', { rows: 5 });
    expect(ctx.server.profiles.get('mine')!.profile).toEqual({ rows: 5 });
    expect(JSON.parse(ctx.native.text('profiles/mine.json')!)).toEqual({ rows: 5 });
    await ctx.client.deleteProfile('theirs');
    expect(ctx.server.profiles.has('theirs')).toBe(false);
    expect(ctx.native.text('profiles/theirs.json')).toBeNull();
    ctx.server.offline = true;
    await expect(ctx.client.saveProfile('mine', { rows: 6 })).rejects.toMatchObject({ code: 'server_unavailable' });
    expect(JSON.parse(ctx.native.text('profiles/mine.json')!)).toEqual({ rows: 5 });
  });
});

describe('SyncClient failures and changes', () => {
  it('a 401 mid-round ends the round: the other recordings wait, not fail, until a new sign-in', async () => {
    const ctx = await started(setup());
    ctx.host.policy = 'auto';
    const first = addRecording(ctx.native, ctx.host, '100000', 10);
    const second = addRecording(ctx.native, ctx.host, '110000', 10);
    const third = addRecording(ctx.native, ctx.host, '120000', 10);
    const real = ctx.server.request.bind(ctx.server);
    let revoked = false;
    let completes = 0;
    ctx.server.request = async (req) => {
      if (revoked) return { status: 401, text: JSON.stringify({ error: 'unauthorized' }) };
      const response = await real(req);
      if (req.url.endsWith('/complete') && ++completes === 1) revoked = true; // the token is revoked after the first upload
      return response;
    };
    await ctx.client.tick();
    const states = () => Object.fromEntries(ctx.client.status().recordings.map((r) => [r.id, [r.state, r.error]]));
    expect(states()[first]).toEqual(['synced', '']);
    expect(states()[second]![0]).not.toBe('failed');
    expect(states()[third]![0]).not.toBe('failed');
    expect(ctx.client.status().tokenRejected).toBe(true);
    expect(ctx.client.status().connection?.error).toBe('unauthorized');
    // Nothing more is sent with the refused token.
    const sent = ctx.server.requests.length;
    await ctx.client.tick();
    expect(ctx.server.requests.length).toBe(sent);
    // A new sign-in clears it and the rest go up.
    revoked = false;
    await ctx.client.setToken(TOKEN);
    await ctx.client.tick();
    expect(ctx.client.status().tokenRejected).toBe(false);
    expect(states()[second]![0]).toBe('synced');
    expect(states()[third]![0]).toBe('synced');
  });

  it('an upload whose offset does not move fails instead of looping', async () => {
    const ctx = await started(setup());
    const id = addRecording(ctx.native, ctx.host, '100000', 2500);
    const real = ctx.server.request.bind(ctx.server);
    ctx.server.request = async (req) => {
      if (req.method === 'PUT') {
        ctx.server.puts += 1;
        return { status: 200, text: JSON.stringify({ received: Number(new URL(req.url).searchParams.get('offset')) }) };
      }
      return real(req);
    };
    await ctx.client.uploadNow(id);
    await ctx.client.tick();
    expect(ctx.server.puts).toBe(1);
    const entry = ctx.client.status().recordings[0]!;
    expect([entry.state, entry.error]).toEqual(['failed', 'upload_stalled']);
  });

  it('a synced recording whose files changed is uploaded again under a new id; one only touched is not', async () => {
    const ctx = await started(setup());
    const id = addRecording(ctx.native, ctx.host, '100000', 100);
    await ctx.client.uploadNow(id);
    await ctx.client.tick();
    expect(ctx.server.uploads.size).toBe(1);
    const dataPath = `recordings/${id}/100000.data.csv`;
    // Rewritten with the same bytes (a new mtime): nothing to send.
    ctx.native.writeAtomic(dataPath, 'x'.repeat(100));
    await ctx.client.uploadNow();
    await ctx.client.tick();
    expect(ctx.server.uploads.size).toBe(1);
    expect(ctx.client.status().recordings[0]!.state).toBe('synced');
    // Different content: a second upload, as revision 2.
    ctx.native.writeAtomic(dataPath, 'y'.repeat(120));
    await ctx.client.uploadNow();
    await ctx.client.tick();
    expect([...ctx.server.uploads.keys()]).toEqual(['studio-abcd1234:3CDC7545CCD0.20261110.100000', 'studio-abcd1234:3CDC7545CCD0.20261110.100000:r2']);
    expect(ctx.client.status().recordings[0]!.state).toBe('synced');
    // And it stays synced afterwards.
    await ctx.client.uploadNow();
    await ctx.client.tick();
    expect(ctx.server.uploads.size).toBe(2);
  });

  it('hashing a large file lets timers run between chunks', async () => {
    const ctx = await started(setup({ chunkBytes: 4 << 20 }));
    const id = addRecording(ctx.native, ctx.host, '100000', 3 * (1 << 20) + 5);
    let fired = false;
    let firedBeforeFirstRequest: boolean | null = null;
    const real = ctx.server.request.bind(ctx.server);
    ctx.server.request = async (req) => {
      if (req.url.endsWith('/api/sync/recordings') && firedBeforeFirstRequest === null) firedBeforeFirstRequest = fired;
      return real(req);
    };
    await ctx.client.uploadNow(id);
    setTimeout(() => {
      fired = true;
    }, 0);
    await ctx.client.tick();
    expect(firedBeforeFirstRequest).toBe(true);
    expect(ctx.client.status().recordings[0]!.state).toBe('synced');
  });
});
