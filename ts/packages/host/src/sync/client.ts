// SyncClient: NH Studio / NH Pocket ⇄ the Desktop server's sync API
// (New-Horizons-Desktop docs/studio-sync-api.md). Platform-independent: the
// host (AppHost), its data-folder file API, an HTTP port and timers are
// injected.
//
// - Recordings: finished ones (never in progress) are uploaded in chunks;
//   an upload resumes from what the server already holds, a finished one is
//   recognized (same recording_id + files), failures retry with exponential
//   backoff. Policy: manual (only "upload now"), auto, wifi_only (not on a
//   network the host says is metered; unknown counts as allowed).
// - Labels (nickname, group): last writer wins per field.
// - Profiles (<data>/profiles/<name>.json): last writer wins per profile.
//
// State lives in the data folder, beside the recordings:
//   .nhsync/recordings.json   per-recording upload state (see RecordingIndex)
//   .nhsync/labels.json       last known label values + their times
//   .nhsync/profiles.json     last known profile hashes + their times
// The app token is in the host config (SYNC_KEYS), never in logs or events.
import type { Logger } from '@nhgw/core';

import type { HostClientType, HostSettings, RecordingSummary } from '../contract';
import type { HostFiles } from '../nativeApi';
import { realTimers, type TimerPort } from '../throttle';
import { maskToken, redact, SYNC_KEYS, syncBaseUrl, TOKEN_PATTERN } from './config';
import type { SyncHttp, SyncMethod } from './http';
import { Sha256, sha256Hex } from './sha256';

export const SYNC_DIR = '.nhsync';
export const SYNC_PATHS = {
  recordings: `${SYNC_DIR}/recordings.json`,
  labels: `${SYNC_DIR}/labels.json`,
  profiles: `${SYNC_DIR}/profiles.json`,
  profilesDir: 'profiles',
  dataRoot: 'recordings',
} as const;

/** What the client needs from the host (AppHost implements all of it). */
export interface SyncHost {
  readonly clientType: HostClientType;
  settings(): HostSettings;
  recordings(): RecordingSummary[];
  refreshRecordings(): void;
  setRecordingSyncStates(states: ReadonlyMap<string, RecordingSummary['syncState']>): void;
  appConfig(): Promise<Record<string, unknown>>;
  saveAppConfig(patch: Record<string, unknown>): Promise<void>;
  readLabels(): { nicknames: Record<string, string>; groups: Record<string, string> };
  setNickname(uid: string, nickname: string): Promise<void>;
  setGroup(uid: string, group: string): Promise<void>;
}

export type NetworkInfo = { online: boolean; metered: boolean | null };

export interface SyncClientOptions {
  host: SyncHost;
  /** The data folder (recordings/, profiles/, .nhsync/). */
  files: HostFiles;
  http: SyncHttp;
  timers?: TimerPort;
  logger?: Logger;
  /** Whether the network is up / metered (Pocket: NetInfo). Default: online, not metered (Studio: wired + Wi-Fi). */
  network?: () => NetworkInfo;
  /** How often the queue is looked at (default 15 s). */
  tickMs?: number;
  /** Labels and profiles are synced this often while a token is set (default 2 min). */
  metadataIntervalMs?: number;
  /** Upload chunk size (default 4 MiB; the server takes up to max_chunk_bytes). */
  chunkBytes?: number;
  backoff?: { baseMs: number; maxMs: number };
  requestTimeoutMs?: number;
}

export type UploadState = 'local' | 'queued' | 'uploading' | 'synced' | 'failed';

export interface RecordingSyncEntry {
  id: string;
  uid: string;
  deviceName: string;
  startedAtMs: number;
  bytes: number;
  state: UploadState;
  sentBytes: number;
  totalBytes: number;
  /** Plain error code ('' when fine): network, unauthorized, forbidden, server_error, recording_id_conflict, … */
  error: string;
  attempts: number;
  nextAttemptMs: number;
  syncedAtMs: number;
  serverPath: string;
}

export interface ConnectionResult {
  ok: boolean;
  /** '' | no_token | no_server | network | unauthorized | forbidden | not_admin | server_error | unexpected */
  error: string;
  checkedAtMs: number;
  username: string;
  role: string;
  clientType: string;
}

export interface MetadataResult {
  ok: boolean;
  error: string;
  atMs: number;
  pushed: number;
  pulled: number;
}

export interface SyncStatus {
  configured: boolean;
  tokenMasked: string;
  /** The Desktop account signed in with ('' for a pasted token or none). */
  account: string;
  baseUrl: string;
  policy: HostSettings['syncPolicy'];
  paused: boolean;
  /** The policy and network allow automatic uploads now. */
  autoAllowed: boolean;
  network: NetworkInfo;
  connection: ConnectionResult | null;
  recordings: RecordingSyncEntry[];
  counts: Record<UploadState, number>;
  current: { id: string; sentBytes: number; totalBytes: number } | null;
  lastUploadMs: number;
  labels: MetadataResult | null;
  profiles: MetadataResult | null;
}

export type SyncEvent =
  | { type: 'progress'; id: string; sentBytes: number; totalBytes: number }
  | { type: 'state' };

/** One recording's persisted upload state (`.nhsync/recordings.json` items[<id>]). */
interface IndexItem {
  server: string;
  recording_id: string;
  state: 'queued' | 'synced' | 'failed';
  fingerprint: string;
  hashes: Record<string, string>;
  attempts: number;
  next_attempt_ms: number;
  error: string;
  retryable: boolean;
  synced_at_ms: number;
  server_path: string;
  updated_ms: number;
}

interface RecordingIndex {
  version: 1;
  last_upload_ms: number;
  items: Record<string, IndexItem>;
}

type LabelKnown = { nickname: string; nickname_ms: number; group: string; group_ms: number };
interface LabelState {
  version: 1;
  server: string;
  items: Record<string, LabelKnown>;
  last: MetadataResult | null;
}

type ProfileKnown = { updated_ms: number; sha256: string; deleted: boolean };
interface ProfileState {
  version: 1;
  server: string;
  items: Record<string, ProfileKnown>;
  last: MetadataResult | null;
}

/** An error with a plain code; `retryable` says whether backoff should try again by itself. */
export class SyncError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly status = 0,
    readonly body: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

type FileRole = 'data' | 'events' | 'meta';
type LocalFile = { role: FileRole; path: string; size: number; mtimeMs: number };

const PROFILE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const RECORDING_ID_UNSAFE = /[^A-Za-z0-9._:-]/g;
const HASH_CHUNK = 1 << 20;
/** A recording whose files changed within this window is still settling (finishing writes). */
const SETTLE_MS = 3_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readJson<T>(files: HostFiles, path: string): T | null {
  try {
    const raw = files.readText(path);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export class SyncClient {
  readonly host: SyncHost;
  readonly files: HostFiles;
  private readonly http: SyncHttp;
  private readonly timers: TimerPort;
  private readonly logger: Logger;
  private readonly network: () => NetworkInfo;
  private readonly tickMs: number;
  private readonly metadataIntervalMs: number;
  private readonly chunkBytes: number;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly timeoutMs: number;
  private readonly listeners = new Set<(event: SyncEvent) => void>();

  private index: RecordingIndex = { version: 1, last_upload_ms: 0, items: {} };
  private labelState: LabelState = { version: 1, server: '', items: {}, last: null };
  private profileState: ProfileState = { version: 1, server: '', items: {}, last: null };
  private token = '';
  private tokenServer = '';
  private account = '';
  private paused = false;
  private connection: ConnectionResult | null = null;
  /** Ids asked for with "upload now" (manual policy; also jumps the queue). */
  private readonly requested = new Set<string>();
  private current: { id: string; sentBytes: number; totalBytes: number } | null = null;
  private timer: unknown = null;
  private running = false;
  private busy: Promise<void> | null = null;
  private lastMetadataMs = Number.NEGATIVE_INFINITY;
  private metadataBusy: Promise<void> | null = null;
  private pushedStates = '';

  constructor(options: SyncClientOptions) {
    this.host = options.host;
    this.files = options.files;
    this.http = options.http;
    this.timers = options.timers ?? realTimers;
    this.logger = options.logger ?? { info() {}, warn() {}, error() {} };
    this.network = options.network ?? (() => ({ online: true, metered: false }));
    this.tickMs = options.tickMs ?? 15_000;
    this.metadataIntervalMs = options.metadataIntervalMs ?? 120_000;
    this.chunkBytes = Math.max(1, options.chunkBytes ?? 4 * 1024 * 1024);
    this.backoff = options.backoff ?? { baseMs: 10_000, maxMs: 30 * 60_000 };
    this.timeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  // -- lifecycle --------------------------------------------------------------

  /** Loads the persisted state and the token, publishes the recordings' states, starts the queue timer. */
  async start(): Promise<void> {
    await this.reload();
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  /** Stops the timer and waits for an upload in flight to stop at its next chunk. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    await this.busy?.catch(() => undefined);
    await this.metadataBusy?.catch(() => undefined);
  }

  /** Re-reads the token and the state files (e.g. after the data folder moved). */
  async reload(): Promise<void> {
    const config = await this.host.appConfig();
    this.token = text(config[SYNC_KEYS.token]);
    this.tokenServer = text(config[SYNC_KEYS.tokenServer]);
    this.account = text(config[SYNC_KEYS.account]);
    this.paused = config[SYNC_KEYS.paused] === true;
    const index = readJson<RecordingIndex>(this.files, SYNC_PATHS.recordings);
    this.index = index && isObject(index.items) ? { version: 1, last_upload_ms: num(index.last_upload_ms), items: index.items } : { version: 1, last_upload_ms: 0, items: {} };
    const labels = readJson<LabelState>(this.files, SYNC_PATHS.labels);
    this.labelState = labels && isObject(labels.items) ? { version: 1, server: text(labels.server), items: labels.items, last: labels.last ?? null } : { version: 1, server: '', items: {}, last: null };
    const profiles = readJson<ProfileState>(this.files, SYNC_PATHS.profiles);
    this.profileState = profiles && isObject(profiles.items) ? { version: 1, server: text(profiles.server), items: profiles.items, last: profiles.last ?? null } : { version: 1, server: '', items: {}, last: null };
    this.publishStates();
    this.emit({ type: 'state' });
  }

  on(listener: (event: SyncEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: SyncEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.log('warn', `listener: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.logger[level](`sync: ${redact(message, this.token)}`);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule(this.tickMs));
    }, ms);
  }

  // -- configuration ------------------------------------------------------------

  baseUrl(): string {
    return syncBaseUrl(this.host.settings());
  }

  /** The token, if it was entered for the server chosen now. */
  private activeToken(): string {
    return this.token && this.tokenServer === this.baseUrl() ? this.token : '';
  }

  async setToken(token: string): Promise<ConnectionResult> {
    const value = token.trim();
    if (!TOKEN_PATTERN.test(value)) throw new SyncError('token_invalid', false);
    const base = this.baseUrl();
    if (!base) throw new SyncError('no_server', false);
    await this.host.saveAppConfig({ [SYNC_KEYS.token]: value, [SYNC_KEYS.tokenServer]: base });
    this.token = value;
    this.tokenServer = base;
    // A new token may fix what the old one could not.
    for (const item of Object.values(this.index.items)) {
      if (item.state === 'failed' && !item.retryable) Object.assign(item, { state: 'queued', retryable: true, next_attempt_ms: 0, attempts: 0, error: '' });
    }
    this.saveIndex();
    this.log('info', `token set (${maskToken(value)}) for ${base}`);
    const result = await this.testConnection();
    this.schedule(0);
    return result;
  }

  /**
   * Signs in with a Desktop account: the server checks the password once and
   * answers with an app token for this install (POST /api/app-tokens/login).
   * The password is not kept; the token and the account name are.
   */
  async login(username: string, password: string, deviceName = ''): Promise<ConnectionResult> {
    const base = this.baseUrl();
    if (!base) throw new SyncError('no_server', false);
    const user = username.trim();
    if (!user || !password) throw new SyncError('username_and_password_required', false);
    let response;
    try {
      response = await this.http.request({
        method: 'POST',
        url: `${base}/api/app-tokens/login`,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: user, password, client_type: this.host.clientType, device_name: deviceName }),
        timeoutMs: this.timeoutMs,
      });
    } catch {
      throw new SyncError('network', true);
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed = response.text ? (JSON.parse(response.text) as unknown) : {};
      if (isObject(parsed)) json = parsed;
    } catch {
      json = {};
    }
    if (response.status === 401) throw new SyncError('invalid_credentials', false, 401, json);
    if (response.status === 404) throw new SyncError('sync_unsupported', false, 404, json);
    if (response.status !== 200 || typeof json.token !== 'string') throw this.failure(response.status, json);
    const account = isObject(json.user) ? text(json.user.username) : user;
    await this.host.saveAppConfig({ [SYNC_KEYS.account]: account });
    this.account = account;
    this.log('info', `signed in as ${account}`);
    return this.setToken(json.token);
  }

  /** Signs out: the server revokes this install's token (best effort), then it is forgotten here. */
  async logout(): Promise<void> {
    if (this.activeToken()) {
      try {
        await this.call('POST', '/api/app-tokens/self/revoke');
      } catch {
        // Offline: the token is forgotten here anyway; an admin can revoke it on the Relays page.
      }
    }
    await this.clearToken();
  }

  async clearToken(): Promise<void> {
    await this.host.saveAppConfig({ [SYNC_KEYS.token]: '', [SYNC_KEYS.tokenServer]: '', [SYNC_KEYS.account]: '' });
    this.token = '';
    this.tokenServer = '';
    this.account = '';
    this.connection = null;
    this.log('info', 'token cleared');
    this.emit({ type: 'state' });
  }

  async pause(): Promise<void> {
    this.paused = true;
    await this.host.saveAppConfig({ [SYNC_KEYS.paused]: true });
    this.emit({ type: 'state' });
  }

  async resume(): Promise<void> {
    this.paused = false;
    await this.host.saveAppConfig({ [SYNC_KEYS.paused]: false });
    this.emit({ type: 'state' });
    this.schedule(0);
  }

  // -- HTTP ----------------------------------------------------------------------

  private async call(method: SyncMethod, path: string, body?: unknown, raw?: Uint8Array): Promise<{ status: number; json: Record<string, unknown> }> {
    const base = this.baseUrl();
    if (!base) throw new SyncError('no_server', false);
    const token = this.activeToken();
    if (!token) throw new SyncError('no_token', false);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let payload: string | Uint8Array | undefined;
    if (raw !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      payload = raw;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response;
    try {
      response = await this.http.request({ method, url: `${base}${path}`, headers, ...(payload !== undefined ? { body: payload } : {}), timeoutMs: this.timeoutMs });
    } catch (error) {
      this.log('warn', `${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      throw new SyncError('network', true);
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed = response.text ? (JSON.parse(response.text) as unknown) : {};
      if (isObject(parsed)) json = parsed;
    } catch {
      json = {};
    }
    return { status: response.status, json };
  }

  /** Throws a SyncError for a non-2xx answer. */
  private failure(status: number, json: Record<string, unknown>): SyncError {
    const code = text(json.error);
    if (status === 401) return new SyncError('unauthorized', false, status, json);
    if (status === 403) return new SyncError('forbidden', false, status, json);
    if (status >= 500 || status === 429 || status === 408) return new SyncError(code || 'server_error', true, status, json);
    if (status === 404 && !code) return new SyncError('sync_unsupported', false, status, json);
    return new SyncError(code || `http_${status}`, false, status, json);
  }

  async testConnection(): Promise<ConnectionResult> {
    const checkedAtMs = this.timers.now();
    const result: ConnectionResult = { ok: false, error: '', checkedAtMs, username: '', role: '', clientType: '' };
    try {
      const me = await this.call('GET', '/api/auth/me');
      if (me.status !== 200) throw this.failure(me.status, me.json);
      result.username = text(me.json.username);
      result.role = text(me.json.role);
      result.clientType = text(me.json.client_type);
      if (me.json.authenticated === false) result.error = 'unauthorized';
      else if (result.role !== 'admin') result.error = 'not_admin';
      else {
        // The sync routes exist (an older server answers 404).
        const labels = await this.call('GET', '/api/sync/labels?since_ms=9007199254740991');
        if (labels.status !== 200) throw this.failure(labels.status, labels.json);
        result.ok = true;
      }
    } catch (error) {
      result.error = error instanceof SyncError ? error.code : 'unexpected';
    }
    this.connection = result;
    this.emit({ type: 'state' });
    return result;
  }

  // -- status ----------------------------------------------------------------------

  private networkInfo(): NetworkInfo {
    try {
      return this.network();
    } catch {
      return { online: true, metered: null };
    }
  }

  private autoAllowed(): boolean {
    const policy = this.host.settings().syncPolicy;
    if (policy === 'manual') return false;
    const network = this.networkInfo();
    if (!network.online) return false;
    return policy === 'auto' || network.metered !== true;
  }

  /** The persisted item for a recording, if it belongs to the server chosen now. */
  private item(id: string): IndexItem | null {
    const item = this.index.items[id];
    return item && item.server === this.baseUrl() ? item : null;
  }

  private entryOf(summary: RecordingSummary): RecordingSyncEntry {
    const item = this.item(summary.id);
    let state: UploadState = 'local';
    if (summary.inProgress) state = 'local';
    else if (this.current?.id === summary.id) state = 'uploading';
    else if (item?.state === 'synced') state = 'synced';
    else if (item?.state === 'failed') state = 'failed';
    else if (item?.state === 'queued' || this.requested.has(summary.id) || this.autoAllowed()) state = 'queued';
    return {
      id: summary.id,
      uid: summary.uid,
      deviceName: summary.deviceName,
      startedAtMs: summary.startedAtMs,
      bytes: summary.bytes,
      state,
      sentBytes: this.current?.id === summary.id ? this.current.sentBytes : state === 'synced' ? summary.bytes : 0,
      totalBytes: this.current?.id === summary.id ? this.current.totalBytes : summary.bytes,
      error: item?.state === 'failed' ? item.error : '',
      attempts: item?.attempts ?? 0,
      nextAttemptMs: item?.state === 'failed' && item.retryable ? item.next_attempt_ms : 0,
      syncedAtMs: item?.state === 'synced' ? item.synced_at_ms : 0,
      serverPath: item?.server_path ?? '',
    };
  }

  status(): SyncStatus {
    const recordings = this.host.recordings().map((summary) => this.entryOf(summary));
    const counts: Record<UploadState, number> = { local: 0, queued: 0, uploading: 0, synced: 0, failed: 0 };
    for (const entry of recordings) counts[entry.state] += 1;
    const token = this.activeToken();
    return {
      configured: token !== '',
      tokenMasked: maskToken(token),
      account: token ? this.account : '',
      baseUrl: this.baseUrl(),
      policy: this.host.settings().syncPolicy,
      paused: this.paused,
      autoAllowed: this.autoAllowed(),
      network: this.networkInfo(),
      connection: this.connection,
      recordings,
      counts,
      current: this.current ? { ...this.current } : null,
      lastUploadMs: this.index.last_upload_ms,
      labels: this.labelState.server === this.baseUrl() ? this.labelState.last : null,
      profiles: this.profileState.server === this.baseUrl() ? this.profileState.last : null,
    };
  }

  /** Pushes 'uploading' / 'synced' to the host so RecordingSummary.syncState shows them (both apps). */
  private publishStates(): void {
    const states = new Map<string, RecordingSummary['syncState']>();
    const base = this.baseUrl();
    for (const [id, item] of Object.entries(this.index.items)) {
      if (item.server !== base) continue;
      if (item.state === 'synced') states.set(id, 'synced');
    }
    if (this.current) states.set(this.current.id, 'uploading');
    const key = JSON.stringify([...states.entries()].sort());
    if (key === this.pushedStates) return;
    this.pushedStates = key;
    this.host.setRecordingSyncStates(states);
  }

  private saveIndex(): void {
    try {
      this.files.mkdirp(SYNC_DIR);
      this.files.writeAtomic(SYNC_PATHS.recordings, `${JSON.stringify(this.index, null, 2)}\n`);
    } catch (error) {
      this.log('error', `save index: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.publishStates();
    this.emit({ type: 'state' });
  }

  // -- queue -------------------------------------------------------------------------

  /** Upload one recording (or every finished one that is not synced) now, whatever the policy; un-pauses. */
  async uploadNow(id?: string): Promise<void> {
    if (this.paused) await this.resume();
    this.host.refreshRecordings();
    const targets = this.host.recordings().filter((item) => !item.inProgress && (id === undefined || item.id === id));
    if (id !== undefined && targets.length === 0) throw new SyncError('recording_not_found', false);
    for (const summary of targets) {
      const item = this.item(summary.id);
      if (item?.state === 'synced') continue;
      this.requested.add(summary.id);
      if (item?.state === 'failed') Object.assign(item, { state: 'queued', next_attempt_ms: 0, error: '', retryable: true });
    }
    this.saveIndex();
    this.schedule(0);
  }

  /** Clears failures (one or all) so they are tried again at once. */
  async retry(id?: string): Promise<void> {
    for (const [key, item] of Object.entries(this.index.items)) {
      if ((id === undefined || key === id) && item.state === 'failed') {
        Object.assign(item, { state: 'queued', next_attempt_ms: 0, error: '', retryable: true, attempts: 0 });
        this.requested.add(key);
      }
    }
    this.saveIndex();
    this.schedule(0);
  }

  /** One pass: metadata when due, then uploads until nothing is eligible (or paused). Exposed for tests. */
  async tick(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.runQueue().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private nextCandidate(now: number, skip: ReadonlySet<string>): RecordingSummary | null {
    const auto = this.autoAllowed();
    const base = this.baseUrl();
    const candidates = this.host
      .recordings()
      .filter((summary) => !summary.inProgress)
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
    let best: RecordingSummary | null = null;
    for (const summary of candidates) {
      if (skip.has(summary.id)) continue;
      const item = this.index.items[summary.id];
      const mine = item && item.server === base ? item : null;
      const wanted = this.requested.has(summary.id);
      if (mine?.state === 'synced') {
        this.requested.delete(summary.id);
        continue;
      }
      if (!wanted && !auto) continue;
      if (mine?.state === 'failed' && (!mine.retryable || mine.next_attempt_ms > now)) continue;
      if (wanted) return summary;
      best ??= summary;
    }
    return best;
  }

  private async runQueue(): Promise<void> {
    const now = this.timers.now();
    if (!this.activeToken()) return;
    if (!this.paused && now - this.lastMetadataMs >= this.metadataIntervalMs) {
      this.lastMetadataMs = now;
      await this.syncLabelsNow().catch(() => undefined);
      await this.syncProfilesNow().catch(() => undefined);
    }
    this.host.refreshRecordings();
    const tried = new Set<string>();
    for (;;) {
      if (this.paused || !this.running || !this.activeToken()) return;
      const next = this.nextCandidate(this.timers.now(), tried);
      if (next === null) return;
      tried.add(next.id);
      await this.uploadRecording(next);
    }
  }

  private recordingIdFor(summary: RecordingSummary): string {
    const relay = this.host.settings().pocketId || this.host.clientType;
    return `${relay}:${summary.id.split('/').join('.')}`.replace(RECORDING_ID_UNSAFE, '_').slice(0, 128);
  }

  private localFiles(id: string): LocalFile[] {
    const directory = `${SYNC_PATHS.dataRoot}/${id}`;
    const listing = this.files.listDir(directory).filter((entry) => !entry.isDirectory);
    const metaFile = listing.find((entry) => entry.name.endsWith('.meta.json'));
    let named: Record<string, unknown> = {};
    if (metaFile) {
      const meta = readJson<Record<string, unknown>>(this.files, `${directory}/${metaFile.name}`);
      if (isObject(meta) && isObject(meta.files)) named = meta.files;
    }
    const base = id.split('/')[2] ?? '';
    const pick = (role: 'data' | 'events', suffix: string) => {
      const name = text(named[role]) || `${base}${suffix}`;
      return listing.find((entry) => entry.name === name) ?? listing.find((entry) => entry.name.endsWith(suffix));
    };
    const out: LocalFile[] = [];
    const data = pick('data', '.data.csv');
    if (!data) throw new SyncError('data_file_missing', false);
    out.push({ role: 'data', path: `${directory}/${data.name}`, size: data.size, mtimeMs: data.mtimeMs });
    const events = pick('events', '.events.csv');
    if (events) out.push({ role: 'events', path: `${directory}/${events.name}`, size: events.size, mtimeMs: events.mtimeMs });
    if (metaFile) out.push({ role: 'meta', path: `${directory}/${metaFile.name}`, size: metaFile.size, mtimeMs: metaFile.mtimeMs });
    return out;
  }

  private hashFile(file: LocalFile): string {
    const hash = new Sha256();
    for (let offset = 0; offset < file.size; offset += HASH_CHUNK) {
      hash.update(this.files.readBytes(file.path, offset, Math.min(HASH_CHUNK, file.size - offset)));
    }
    return hash.hex();
  }

  private startedAt(id: string, files: LocalFile[], summary: RecordingSummary): string {
    const meta = files.find((file) => file.role === 'meta');
    const parsed = meta ? readJson<Record<string, unknown>>(this.files, meta.path) : null;
    const started = isObject(parsed) && isObject(parsed.recording) ? text(parsed.recording.started_at) : '';
    if (started && /(Z|[+-]\d{2}:?\d{2})$/.test(started)) return started;
    if (summary.startedAtMs > 0) return new Date(summary.startedAtMs).toISOString();
    throw new SyncError('started_at_unknown', false, 0, { id });
  }

  private async uploadRecording(summary: RecordingSummary): Promise<void> {
    const id = summary.id;
    const base = this.baseUrl();
    const now = this.timers.now();
    const previous = this.index.items[id];
    const item: IndexItem =
      previous && previous.server === base
        ? previous
        : { server: base, recording_id: '', state: 'queued', fingerprint: '', hashes: {}, attempts: 0, next_attempt_ms: 0, error: '', retryable: true, synced_at_ms: 0, server_path: '', updated_ms: now };
    this.index.items[id] = item;
    if (!item.recording_id) item.recording_id = this.recordingIdFor(summary);
    try {
      const files = this.localFiles(id);
      if (files.some((file) => now - file.mtimeMs < SETTLE_MS)) return; // still being written; the next tick takes it
      const fingerprint = JSON.stringify(files.map((file) => [file.role, file.size, file.mtimeMs]));
      if (item.fingerprint !== fingerprint || Object.keys(item.hashes).length !== files.length) {
        item.hashes = {};
        for (const file of files) item.hashes[file.role] = this.hashFile(file);
        item.fingerprint = fingerprint;
      }
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      this.current = { id, sentBytes: 0, totalBytes };
      this.publishStates();
      this.emit({ type: 'state' });
      const result = await this.transfer(item, files, this.startedAt(id, files, summary), summary.uid);
      Object.assign(item, {
        state: 'synced',
        error: '',
        attempts: 0,
        next_attempt_ms: 0,
        retryable: true,
        synced_at_ms: this.timers.now(),
        server_path: text(result.path),
        updated_ms: this.timers.now(),
      });
      this.index.last_upload_ms = this.timers.now();
      this.requested.delete(id);
      this.log('info', `uploaded ${id} -> ${text(result.path)}`);
    } catch (error) {
      const failure = error instanceof SyncError ? error : new SyncError('unexpected', true);
      if (failure.code === 'paused') {
        item.state = 'queued';
      } else {
        item.attempts += 1;
        const delay = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** Math.max(0, item.attempts - 1));
        Object.assign(item, { state: 'failed', error: failure.code, retryable: failure.retryable, next_attempt_ms: this.timers.now() + delay, updated_ms: this.timers.now() });
        this.requested.delete(id);
        this.log('warn', `upload ${id} failed: ${failure.code}${failure.retryable ? ` (retry in ${Math.round(delay / 1000)} s)` : ''}`);
        if (failure.code === 'unauthorized' || failure.code === 'forbidden') {
          this.connection = { ok: false, error: failure.code, checkedAtMs: this.timers.now(), username: '', role: '', clientType: '' };
        }
      }
    } finally {
      this.current = null;
      this.saveIndex();
    }
  }

  /** Begin (or resume), send what the server lacks, complete; once more after a checksum or completeness complaint. */
  private async transfer(item: IndexItem, files: LocalFile[], startedAt: string, uid: string): Promise<Record<string, unknown>> {
    const rid = encodeURIComponent(item.recording_id);
    const descriptor = {
      recording_id: item.recording_id,
      device_uid: uid,
      started_at: startedAt,
      files: files.map((file) => ({ role: file.role, size: file.size, sha256: item.hashes[file.role] })),
    };
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    for (let round = 0; round < 3; round++) {
      const begin = await this.call('POST', '/api/sync/recordings', descriptor);
      if (begin.status !== 200 && begin.status !== 201) throw this.failure(begin.status, begin.json);
      if (begin.json.status === 'complete') return begin.json;
      const maxChunk = Math.max(1, Math.min(this.chunkBytes, num(begin.json.max_chunk_bytes) || this.chunkBytes));
      const received = new Map<string, number>();
      for (const entry of Array.isArray(begin.json.files) ? begin.json.files : []) {
        if (isObject(entry)) received.set(text(entry.role), num(entry.received));
      }
      const sent = () => files.reduce((sum, file) => sum + Math.min(file.size, received.get(file.role) ?? 0), 0);
      for (const file of files) {
        let offset = received.get(file.role) ?? 0;
        while (offset < file.size) {
          if (this.paused || !this.running) throw new SyncError('paused', true);
          const length = Math.min(maxChunk, file.size - offset);
          const bytes = this.files.readBytes(file.path, offset, length);
          const put = await this.call('PUT', `/api/sync/recordings/${rid}/files/${file.role}?offset=${offset}`, undefined, bytes);
          if (put.status === 200) offset = num(put.json.received);
          else if (put.status === 409 && put.json.error === 'offset_mismatch') offset = num(put.json.received);
          else throw this.failure(put.status, put.json);
          received.set(file.role, offset);
          if (this.current) {
            this.current = { id: this.current.id, sentBytes: sent(), totalBytes };
            this.emit({ type: 'progress', id: this.current.id, sentBytes: this.current.sentBytes, totalBytes });
          }
        }
      }
      const done = await this.call('POST', `/api/sync/recordings/${rid}/complete`, {});
      if (done.status === 200) return done.json;
      const code = text(done.json.error);
      if ((done.status === 422 && code === 'checksum_mismatch') || (done.status === 409 && code === 'upload_incomplete')) continue;
      throw this.failure(done.status, done.json);
    }
    throw new SyncError('upload_incomplete', true);
  }

  // -- labels -----------------------------------------------------------------------------

  /** Two-way label sync, last writer wins per field (nickname, group). */
  async syncLabelsNow(): Promise<MetadataResult> {
    const run = async (): Promise<MetadataResult> => {
      const base = this.baseUrl();
      const now = this.timers.now();
      const result: MetadataResult = { ok: false, error: '', atMs: now, pushed: 0, pulled: 0 };
      if (this.labelState.server !== base) this.labelState = { version: 1, server: base, items: {}, last: null };
      const known = this.labelState.items;
      try {
        const local = this.host.readLabels();
        const uids = new Set([...Object.keys(local.nicknames), ...Object.keys(local.groups), ...Object.keys(known)]);
        // Local edits since the last sync are stamped now; a label never synced counts as very old (time 1).
        for (const uid of uids) {
          const nickname = local.nicknames[uid] ?? '';
          const group = local.groups[uid] ?? '';
          const entry = known[uid];
          if (!entry) {
            known[uid] = { nickname, nickname_ms: nickname ? 1 : 0, group, group_ms: group ? 1 : 0 };
            continue;
          }
          if (entry.nickname !== nickname) Object.assign(entry, { nickname, nickname_ms: Math.max(now, entry.nickname_ms + 1) });
          if (entry.group !== group) Object.assign(entry, { group, group_ms: Math.max(now, entry.group_ms + 1) });
        }
        const remote = await this.call('GET', '/api/sync/labels?since_ms=0');
        if (remote.status !== 200) throw this.failure(remote.status, remote.json);
        const remoteItems = new Map<string, LabelKnown>();
        for (const raw of Array.isArray(remote.json.items) ? remote.json.items : []) {
          if (!isObject(raw) || !text(raw.device_uid)) continue;
          remoteItems.set(text(raw.device_uid), {
            nickname: text(raw.nickname),
            nickname_ms: num(raw.nickname_updated_ms),
            group: text(raw.group),
            group_ms: num(raw.group_updated_ms),
          });
        }
        const push: Record<string, unknown>[] = [];
        for (const uid of new Set([...remoteItems.keys(), ...Object.keys(known)])) {
          const theirs = remoteItems.get(uid) ?? { nickname: '', nickname_ms: 0, group: '', group_ms: 0 };
          const mine = (known[uid] ??= { nickname: '', nickname_ms: 0, group: '', group_ms: 0 });
          result.pulled += await this.takeLabels(uid, mine, theirs, local);
          const item: Record<string, unknown> = { device_uid: uid };
          if (mine.nickname_ms > theirs.nickname_ms) Object.assign(item, { nickname: mine.nickname, nickname_updated_ms: mine.nickname_ms });
          if (mine.group_ms > theirs.group_ms) Object.assign(item, { group: mine.group, group_updated_ms: mine.group_ms });
          if (Object.keys(item).length > 1) push.push(item);
        }
        if (push.length) {
          const put = await this.call('PUT', '/api/sync/labels', { items: push });
          if (put.status !== 200) throw this.failure(put.status, put.json);
          for (const raw of Array.isArray(put.json.items) ? put.json.items : []) {
            if (!isObject(raw)) continue;
            const uid = text(raw.device_uid);
            const mine = known[uid];
            if (!mine) continue;
            const applied = Array.isArray(raw.applied) ? raw.applied : [];
            result.pushed += applied.length;
            const theirs = { nickname: text(raw.nickname), nickname_ms: num(raw.nickname_updated_ms), group: text(raw.group), group_ms: num(raw.group_updated_ms) };
            result.pulled += await this.takeLabels(uid, mine, theirs, local, true);
          }
        }
        result.ok = true;
      } catch (error) {
        result.error = error instanceof SyncError ? error.code : 'unexpected';
        this.log('warn', `labels: ${result.error}`);
      }
      this.labelState.last = result;
      this.writeState(SYNC_PATHS.labels, this.labelState);
      this.emit({ type: 'state' });
      return result;
    };
    return this.serialMetadata(run);
  }

  /** Takes the server's fields that are newer (or equal, after a push: the server's answer is final). Returns fields changed locally. */
  private async takeLabels(uid: string, mine: LabelKnown, theirs: LabelKnown, local: { nicknames: Record<string, string>; groups: Record<string, string> }, orEqual = false): Promise<number> {
    let changed = 0;
    const newer = (a: number, b: number) => (orEqual ? a >= b && a > 0 : a > b);
    if (newer(theirs.nickname_ms, mine.nickname_ms) && (theirs.nickname_ms !== mine.nickname_ms || theirs.nickname !== mine.nickname)) {
      if ((local.nicknames[uid] ?? '') !== theirs.nickname) {
        await this.host.setNickname(uid, theirs.nickname);
        local.nicknames[uid] = theirs.nickname;
        changed += 1;
      }
      Object.assign(mine, { nickname: theirs.nickname, nickname_ms: theirs.nickname_ms });
    }
    if (newer(theirs.group_ms, mine.group_ms) && (theirs.group_ms !== mine.group_ms || theirs.group !== mine.group)) {
      if ((local.groups[uid] ?? '') !== theirs.group) {
        await this.host.setGroup(uid, theirs.group);
        local.groups[uid] = theirs.group;
        changed += 1;
      }
      Object.assign(mine, { group: theirs.group, group_ms: theirs.group_ms });
    }
    return changed;
  }

  // -- profiles ----------------------------------------------------------------------------

  /** Two-way profile sync (<data>/profiles/<name>.json), last writer wins per profile. */
  async syncProfilesNow(): Promise<MetadataResult> {
    const run = async (): Promise<MetadataResult> => {
      const base = this.baseUrl();
      const now = this.timers.now();
      const result: MetadataResult = { ok: false, error: '', atMs: now, pushed: 0, pulled: 0 };
      if (this.profileState.server !== base) this.profileState = { version: 1, server: base, items: {}, last: null };
      const known = this.profileState.items;
      try {
        const local = new Map<string, { text: string; mtimeMs: number }>();
        let listing: ReturnType<HostFiles['listDir']> = [];
        try {
          listing = this.files.listDir(SYNC_PATHS.profilesDir);
        } catch {
          listing = [];
        }
        for (const entry of listing) {
          if (entry.isDirectory || !entry.name.endsWith('.json')) continue;
          const name = entry.name.slice(0, -5);
          if (!PROFILE_NAME.test(name)) continue;
          const body = this.files.readText(`${SYNC_PATHS.profilesDir}/${entry.name}`);
          if (body !== null) local.set(name, { text: body, mtimeMs: entry.mtimeMs });
        }
        for (const [name, file] of local) {
          const sha = sha256Hex(file.text);
          const entry = known[name];
          if (!entry) known[name] = { updated_ms: Math.max(1, Math.floor(file.mtimeMs)), sha256: sha, deleted: false };
          else if (entry.deleted || entry.sha256 !== sha) known[name] = { updated_ms: Math.max(Math.floor(file.mtimeMs), entry.updated_ms + 1), sha256: sha, deleted: false };
        }
        for (const [name, entry] of Object.entries(known)) {
          if (!entry.deleted && !local.has(name)) known[name] = { updated_ms: Math.max(now, entry.updated_ms + 1), sha256: '', deleted: true };
        }
        const remote = await this.call('GET', '/api/sync/profiles?since_ms=0');
        if (remote.status !== 200) throw this.failure(remote.status, remote.json);
        const remoteItems = new Map<string, Record<string, unknown>>();
        for (const raw of Array.isArray(remote.json.items) ? remote.json.items : []) {
          if (isObject(raw) && PROFILE_NAME.test(text(raw.name))) remoteItems.set(text(raw.name), raw);
        }
        const push: Record<string, unknown>[] = [];
        for (const name of new Set([...remoteItems.keys(), ...Object.keys(known)])) {
          const theirs = remoteItems.get(name);
          const mine = known[name];
          const theirsMs = theirs ? num(theirs.updated_ms) : 0;
          if (theirs && (!mine || theirsMs > mine.updated_ms)) {
            if (this.takeProfile(name, theirs)) result.pulled += 1;
            continue;
          }
          if (!mine || mine.updated_ms <= theirsMs) continue;
          if (mine.deleted) {
            if (theirs && theirs.deleted !== true) push.push({ name, updated_ms: mine.updated_ms, deleted: true });
            continue;
          }
          let profile: unknown;
          try {
            profile = JSON.parse(local.get(name)?.text ?? '');
          } catch {
            profile = null;
          }
          if (isObject(profile)) push.push({ name, updated_ms: mine.updated_ms, profile });
        }
        if (push.length) {
          const put = await this.call('PUT', '/api/sync/profiles', { items: push });
          if (put.status !== 200) throw this.failure(put.status, put.json);
          for (const raw of Array.isArray(put.json.items) ? put.json.items : []) {
            if (!isObject(raw)) continue;
            if (raw.applied === true) result.pushed += 1;
            else if (this.takeProfile(text(raw.name), raw)) result.pulled += 1;
          }
        }
        result.ok = true;
      } catch (error) {
        result.error = error instanceof SyncError ? error.code : 'unexpected';
        this.log('warn', `profiles: ${result.error}`);
      }
      this.profileState.last = result;
      this.writeState(SYNC_PATHS.profiles, this.profileState);
      this.emit({ type: 'state' });
      return result;
    };
    return this.serialMetadata(run);
  }

  /** Writes (or deletes) a profile as the server has it; returns whether the local folder changed. */
  private takeProfile(name: string, theirs: Record<string, unknown>): boolean {
    if (!PROFILE_NAME.test(name)) return false;
    const path = `${SYNC_PATHS.profilesDir}/${name}.json`;
    const updated = num(theirs.updated_ms);
    if (theirs.deleted === true) {
      this.profileState.items[name] = { updated_ms: updated, sha256: '', deleted: true };
      return this.files.fileExists(path) ? this.files.deletePath(path) : false;
    }
    if (!isObject(theirs.profile)) return false;
    const body = `${JSON.stringify(theirs.profile, null, 2)}\n`;
    this.files.mkdirp(SYNC_PATHS.profilesDir);
    this.files.writeAtomic(path, body);
    this.profileState.items[name] = { updated_ms: updated, sha256: sha256Hex(body), deleted: false };
    return true;
  }

  private writeState(path: string, value: unknown): void {
    try {
      this.files.mkdirp(SYNC_DIR);
      this.files.writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
    } catch (error) {
      this.log('error', `save ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private serialMetadata<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.metadataBusy ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.metadataBusy = settled;
    void settled.then(() => {
      if (this.metadataBusy === settled) this.metadataBusy = null;
    });
    return next;
  }
}

