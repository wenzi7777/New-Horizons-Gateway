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
// - Labels (nickname, group) and profiles (<data>/profiles/<name>.json): the
//   server's copy is the one edited; the app mirrors it read-only and sends
//   every edit to the server (none while it is unreachable).
//
// State lives in the data folder, beside the recordings:
//   .nhsync/recordings.json   per-recording upload state (see RecordingIndex)
//   .nhsync/labels.json       last known label values + their times
//   .nhsync/profiles.json     last known profile hashes + their times
// Signing in: the account (username + password) is kept in the platform's
// secure store (CredentialStore) and the app signs in again on every start,
// when the server changes and when the server refuses the token. The app
// token from the latest sign-in is in the host config (SYNC_KEYS: the relay
// link reads it there), never in logs or events.
import type { Logger } from '@nhgw/core';

import type { HostClientType, HostSettings, RecordingSummary } from '../contract';
import type { HostFiles } from '../nativeApi';
import { realTimers, type TimerPort } from '../throttle';
import { maskToken, redact, SYNC_KEYS, syncBaseUrl, TOKEN_PATTERN } from './config';
import type { SyncHttp, SyncMethod } from './http';
import { Sha256, sha256Hex } from './sha256';
import { runLinkBench, type LinkBenchResult } from '../tools/relayBench';

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

export interface Credentials {
  username: string;
  password: string;
}

/**
 * Where the account is remembered: encrypted by the platform (Studio: the OS
 * keychain via Electron safeStorage; Pocket: Android Keystore). Without one
 * the app still signs in, but has to be signed in again by hand.
 */
export interface CredentialStore {
  load(): Promise<Credentials | null>;
  /** null forgets them. */
  save(credentials: Credentials | null): Promise<void>;
}

/** After a sign-in that failed for a network/server reason, the next automatic try waits this long. */
export const AUTO_LOGIN_RETRY_MS = 60_000;

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
  /** Remembers the account for the automatic sign-in (absent: nothing is remembered). */
  credentials?: CredentialStore;
  /** The name the server lists the sign-in under (e.g. the computer's name). */
  deviceName?: () => string;
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
  /** Labels and profiles can be edited now (they are edited on the server only). */
  editable: boolean;
  /** The server refused the token (401/403) and the remembered account could not sign in again: the user has to. */
  tokenRejected: boolean;
  /** An account is remembered: the app signs in by itself. */
  remembered: boolean;
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
  /** The folder's file listing (name, size, mtime) when it was synced: a change re-checks it. */
  listing?: string;
  /** Upload of changed files under a new recording_id (`…:r<revision>`); absent = the first. */
  revision?: number;
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

/** Lets timers, I/O and the UI run (a real macrotask, whatever timer port the client uses). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
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
  /** The token the server last refused (401/403); nothing is uploaded with it again. */
  private rejectedToken = '';
  private readonly credentialStore: CredentialStore | null;
  private readonly deviceNameOf: () => string;
  private remembered: Credentials | null = null;
  /** The base the remembered account last signed in to in this run ('' = not yet: sign in on start). */
  private autoLoginBase = '';
  private nextAutoLoginMs = 0;
  /** The remembered account was refused (wrong password now, account gone): no more automatic tries. */
  private credentialsRefused = false;
  private autoLoginBusy: Promise<void> | null = null;
  private lastSignInMs = Number.NEGATIVE_INFINITY;

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
    this.credentialStore = options.credentials ?? null;
    this.deviceNameOf = options.deviceName ?? (() => '');
  }

  // -- lifecycle --------------------------------------------------------------

  /** Loads the persisted state and the token, publishes the recordings' states, starts the queue timer. */
  async start(): Promise<void> {
    await this.reload();
    try {
      this.remembered = (await this.credentialStore?.load()) ?? null;
    } catch (error) {
      this.log('warn', `credentials: ${error instanceof Error ? error.message : String(error)}`);
      this.remembered = null;
    }
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

  /** Takes a token the server just issued: stored for this server, failures it may fix are retried. */
  private async applyToken(value: string): Promise<void> {
    if (!TOKEN_PATTERN.test(value)) throw new SyncError('token_invalid', false);
    const base = this.baseUrl();
    if (!base) throw new SyncError('no_server', false);
    await this.host.saveAppConfig({ [SYNC_KEYS.token]: value, [SYNC_KEYS.tokenServer]: base });
    this.token = value;
    this.tokenServer = base;
    this.rejectedToken = '';
    // A new token may fix what the old one could not.
    for (const item of Object.values(this.index.items)) {
      if (item.state === 'failed' && !item.retryable) Object.assign(item, { state: 'queued', retryable: true, next_attempt_ms: 0, attempts: 0, error: '' });
    }
    this.saveIndex();
    this.log('info', `token set (${maskToken(value)}) for ${base}`);
  }

  /** Uses a token as is (tests, tools); the apps sign in with an account instead. */
  async setToken(token: string): Promise<ConnectionResult> {
    await this.applyToken(token.trim());
    const result = await this.testConnection();
    this.schedule(0);
    return result;
  }

  /**
   * Signs in with a Desktop account (POST /api/app-tokens/login) and
   * remembers it, so the app signs in again by itself from now on.
   */
  async login(username: string, password: string, deviceName = ''): Promise<ConnectionResult> {
    const user = username.trim();
    if (!user || !password) throw new SyncError('username_and_password_required', false);
    await this.signIn(user, password, deviceName || this.deviceNameOf());
    const credentials = { username: user, password };
    this.remembered = credentials;
    this.credentialsRefused = false;
    this.autoLoginBase = this.baseUrl();
    try {
      await this.credentialStore?.save(credentials);
    } catch (error) {
      this.log('warn', `credentials: ${error instanceof Error ? error.message : String(error)}`);
    }
    const result = await this.testConnection();
    this.schedule(0);
    return result;
  }

  /** One sign-in: a fresh token for this install (it replaces the install's last one on the server). */
  private async signIn(user: string, password: string, deviceName: string): Promise<void> {
    const base = this.baseUrl();
    if (!base) throw new SyncError('no_server', false);
    // This install's relay id: the server ends the install's previous token, so they never pile up.
    const relayId = text((await this.host.appConfig()).gateway_id);
    let response;
    try {
      response = await this.http.request({
        method: 'POST',
        url: `${base}/api/app-tokens/login`,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: user, password, client_type: this.host.clientType, device_name: deviceName, relay_id: relayId }),
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
    this.lastSignInMs = this.timers.now();
    await this.applyToken(json.token);
  }

  /**
   * Signs in with the remembered account when it is due: once per run (on
   * start), when the server changed, and when the server refused the token.
   * A wrong password stops further tries until the user signs in by hand.
   */
  async autoLogin(force = false): Promise<void> {
    if (this.autoLoginBusy) return this.autoLoginBusy;
    const credentials = this.remembered;
    const base = this.baseUrl();
    if (!credentials || !base || this.credentialsRefused) return;
    const due = force || this.autoLoginBase !== base || !this.activeToken() || this.tokenRejected();
    if (!due || this.timers.now() < this.nextAutoLoginMs) return;
    this.autoLoginBusy = (async () => {
      try {
        await this.signIn(credentials.username, credentials.password, this.deviceNameOf());
        this.autoLoginBase = base;
        this.nextAutoLoginMs = 0;
        await this.testConnection();
      } catch (error) {
        const code = error instanceof SyncError ? error.code : 'unexpected';
        if (code === 'invalid_credentials' || code === 'forbidden') {
          // The account no longer signs in: the user has to (ReauthDialog).
          this.credentialsRefused = true;
          if (this.activeToken()) this.rejectedToken = this.activeToken();
          this.connection = { ok: false, error: code, checkedAtMs: this.timers.now(), username: '', role: '', clientType: '' };
          this.log('warn', `automatic sign-in refused (${code}); sign in again`);
        } else {
          this.nextAutoLoginMs = this.timers.now() + AUTO_LOGIN_RETRY_MS;
          this.log('warn', `automatic sign-in failed (${code}); trying again later`);
        }
        this.emit({ type: 'state' });
      }
    })().finally(() => {
      this.autoLoginBusy = null;
    });
    return this.autoLoginBusy;
  }

  /**
   * The relay link was refused (its token ended on the server): with a
   * remembered account, sign in again. Not for a token just issued (a
   * refusal then is not about the token; no sign-in loop).
   */
  relayRefused(): void {
    const token = this.activeToken();
    if (!token || this.remembered === null || this.credentialsRefused) return;
    if (this.timers.now() - this.lastSignInMs < AUTO_LOGIN_RETRY_MS) return;
    this.rejectedToken = token;
    void this.autoLogin();
  }

  /** Signs out: the server ends this install's token (best effort), the account is forgotten here. */
  async logout(): Promise<void> {
    if (this.activeToken()) {
      try {
        await this.call('POST', '/api/app-tokens/self/revoke');
      } catch {
        // Offline: forgotten here anyway; an unused token ends by itself on the server.
      }
    }
    this.remembered = null;
    this.credentialsRefused = false;
    this.autoLoginBase = '';
    try {
      await this.credentialStore?.save(null);
    } catch (error) {
      this.log('warn', `credentials: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.clearToken();
  }

  private async clearToken(): Promise<void> {
    await this.host.saveAppConfig({ [SYNC_KEYS.token]: '', [SYNC_KEYS.tokenServer]: '', [SYNC_KEYS.account]: '' });
    this.token = '';
    this.tokenServer = '';
    this.account = '';
    this.rejectedToken = '';
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
        this.rejectedToken = '';
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
      editable: this.serverEditable(),
      // With a remembered account the app signs in again by itself; only ask the user when that cannot work.
      tokenRejected: this.tokenRejected() && (this.remembered === null || this.credentialsRefused),
      remembered: this.remembered !== null,
      labels: this.labelState.server === this.baseUrl() ? this.labelState.last : null,
      profiles: this.profileState.server === this.baseUrl() ? this.profileState.last : null,
    };
  }

  private tokenRejected(): boolean {
    const token = this.activeToken();
    return token !== '' && this.rejectedToken === token;
  }

  /** The code of a 401/403 failure ('' for anything else). */
  private static authFailure(error: unknown): string {
    return error instanceof SyncError && (error.code === 'unauthorized' || error.code === 'forbidden') ? error.code : '';
  }

  /** The server refused the token: stop using it until a new one is set or a check passes. */
  private noteTokenRejected(code: string): void {
    if (!this.tokenRejected()) this.log('warn', `the server refused the token (${code}); sign in again`);
    this.rejectedToken = this.activeToken();
    this.connection = { ok: false, error: code, checkedAtMs: this.timers.now(), username: '', role: '', clientType: '' };
    this.emit({ type: 'state' });
    // A remembered account gets a new token at once (e.g. this one idled out on the server).
    if (this.remembered !== null && !this.credentialsRefused) this.schedule(0);
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
      if (item?.state === 'synced' && !this.changedSinceSync(summary.id, item)) continue;
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
      // A synced recording whose files changed since is uploaded again (as a new revision).
      if (mine?.state === 'synced' && !this.changedSinceSync(summary.id, mine)) {
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
    await this.autoLogin();
    const now = this.timers.now();
    if (!this.activeToken() || this.tokenRejected()) return;
    if (!this.paused && now - this.lastMetadataMs >= this.metadataIntervalMs) {
      this.lastMetadataMs = now;
      for (const sync of [() => this.syncLabelsNow(), () => this.syncProfilesNow()]) {
        try {
          // These report failures in their result rather than throwing.
          const result = await sync();
          if (result.error === 'unauthorized' || result.error === 'forbidden') throw new SyncError(result.error, false);
        } catch (error) {
          const code = SyncClient.authFailure(error);
          if (code) {
            this.noteTokenRejected(code);
            return;
          }
        }
      }
    }
    this.host.refreshRecordings();
    const tried = new Set<string>();
    for (;;) {
      // A refused token ends the whole round: the other recordings are not tried (or failed) with it.
      if (this.paused || !this.running || !this.activeToken() || this.tokenRejected()) return;
      const next = this.nextCandidate(this.timers.now(), tried);
      if (next === null) return;
      tried.add(next.id);
      await this.uploadRecording(next);
    }
  }

  /** The recording folder's files as (name, size, mtime), '' when unreadable. */
  private listingOf(id: string): string {
    try {
      const entries = this.files
        .listDir(`${SYNC_PATHS.dataRoot}/${id}`)
        .filter((entry) => !entry.isDirectory)
        .map((entry) => [entry.name, entry.size, entry.mtimeMs] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return JSON.stringify(entries);
    } catch {
      return '';
    }
  }

  /**
   * Whether a synced recording's files changed since (by listing). An item
   * synced before listings were kept takes the current one as its baseline.
   */
  private changedSinceSync(id: string, item: IndexItem): boolean {
    const listing = this.listingOf(id);
    if (!listing) return false;
    if (item.listing === undefined) {
      item.listing = listing;
      return false;
    }
    return item.listing !== listing;
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

  /** SHA-256 of a file, a chunk at a time, letting the event loop run between chunks (an hour of data is hundreds of MB). */
  private async hashFile(file: LocalFile): Promise<string> {
    const hash = new Sha256();
    for (let offset = 0; offset < file.size; offset += HASH_CHUNK) {
      if (offset > 0) {
        await yieldToEventLoop();
        if (!this.running) throw new SyncError('paused', true);
      }
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
    const wasSynced = item.state === 'synced';
    try {
      const files = this.localFiles(id);
      if (files.some((file) => now - file.mtimeMs < SETTLE_MS)) return; // still being written; the next tick takes it
      const fingerprint = JSON.stringify(files.map((file) => [file.role, file.size, file.mtimeMs]));
      const syncedHashes = { ...item.hashes };
      if (item.fingerprint !== fingerprint || Object.keys(item.hashes).length !== files.length) {
        const hashes: Record<string, string> = {};
        for (const file of files) hashes[file.role] = await this.hashFile(file);
        item.hashes = hashes;
        item.fingerprint = fingerprint;
      }
      if (wasSynced) {
        const same = Object.keys(syncedHashes).length === files.length && files.every((file) => syncedHashes[file.role] === item.hashes[file.role]);
        item.listing = this.listingOf(id);
        if (same) return; // only touched: still what the server holds
        // The server keeps the first upload under its id (a different one is recording_id_conflict).
        item.revision = (item.revision ?? 1) + 1;
        const suffix = `:r${item.revision}`;
        item.recording_id = `${this.recordingIdFor(summary).slice(0, 128 - suffix.length)}${suffix}`;
        Object.assign(item, { state: 'queued', attempts: 0, error: '', retryable: true, next_attempt_ms: 0 });
        this.log('info', `${id} changed since it was uploaded; uploading it again as ${item.recording_id}`);
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
        listing: this.listingOf(id),
      });
      this.index.last_upload_ms = this.timers.now();
      this.requested.delete(id);
      this.log('info', `uploaded ${id} -> ${text(result.path)}`);
    } catch (error) {
      const failure = error instanceof SyncError ? error : new SyncError('unexpected', true);
      if (failure.code === 'paused') {
        if (!wasSynced || item.state !== 'synced') item.state = 'queued';
      } else if (SyncClient.authFailure(failure)) {
        // Not this recording's fault: it waits (still asked for) until the user signs in again.
        Object.assign(item, { state: 'queued', error: '', next_attempt_ms: 0, updated_ms: this.timers.now() });
        this.noteTokenRejected(failure.code);
      } else {
        item.attempts += 1;
        const delay = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** Math.max(0, item.attempts - 1));
        Object.assign(item, { state: 'failed', error: failure.code, retryable: failure.retryable, next_attempt_ms: this.timers.now() + delay, updated_ms: this.timers.now() });
        this.requested.delete(id);
        this.log('warn', `upload ${id} failed: ${failure.code}${failure.retryable ? ` (retry in ${Math.round(delay / 1000)} s)` : ''}`);
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
          let next: number;
          if (put.status === 200) next = num(put.json.received);
          else if (put.status === 409 && put.json.error === 'offset_mismatch') next = num(put.json.received);
          else throw this.failure(put.status, put.json);
          // The server must take something (or name where it is): the same offset again would loop forever.
          if (put.status === 200 && next <= offset) throw new SyncError('upload_stalled', true, put.status, put.json);
          if (put.status === 409 && next === offset) throw new SyncError('upload_stalled', true, put.status, put.json);
          if (next > file.size) throw new SyncError('upload_offset_invalid', true, put.status, put.json);
          offset = next;
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

  // -- relay performance test ---------------------------------------------------------

  /** The server-link half of the relay test (tools/relayBench): round trip, and the upload when signed in. */
  async benchLink(): Promise<LinkBenchResult> {
    const token = this.activeToken();
    return runLinkBench(
      {
        baseUrl: this.baseUrl(),
        request: async (method, url, body) => {
          const headers: Record<string, string> = { Accept: 'application/json' };
          if (token) headers.Authorization = `Bearer ${token}`;
          if (body) headers['Content-Type'] = 'application/octet-stream';
          const response = await this.http.request({ method, url, headers, ...(body ? { body } : {}), timeoutMs: this.timeoutMs });
          return { status: response.status };
        },
      },
      { upload: token !== '' },
    );
  }

  // -- labels and profiles: the server's copy is the only one edited -----------------
  //
  // Nicknames, groups and profiles live on the server. The app keeps a mirror
  // (the host's label documents, <data>/profiles/*.json) refreshed from the
  // server, and every edit goes to the server first; without a reachable
  // server they cannot be edited (SyncError 'server_unavailable').

  /** Whether edits can go to the server now (signed in for this server, last check fine). */
  serverEditable(): boolean {
    return this.activeToken() !== '' && this.connection?.ok === true;
  }

  private async serverCall(method: SyncMethod, path: string, body?: unknown): Promise<Record<string, unknown>> {
    if (!this.activeToken()) throw new SyncError('server_unavailable', false);
    let response;
    try {
      response = await this.call(method, path, body);
    } catch (error) {
      if (error instanceof SyncError && (error.code === 'network' || error.code === 'no_token' || error.code === 'no_server')) {
        throw new SyncError('server_unavailable', true);
      }
      throw error;
    }
    if (response.status < 200 || response.status >= 300) throw this.failure(response.status, response.json);
    return response.json;
  }

  /** Sets a device's nickname and/or group on the server, then in the local mirror. */
  async setLabel(uid: string, patch: { nickname?: string; group?: string }): Promise<void> {
    const id = encodeURIComponent(uid.trim().toUpperCase());
    if (patch.nickname !== undefined) {
      await this.serverCall('PUT', `/api/devices/${id}/nickname`, { nickname: patch.nickname });
      await this.host.setNickname(uid, patch.nickname);
    }
    if (patch.group !== undefined) {
      await this.serverCall('PUT', `/api/devices/${id}/group`, { group: patch.group });
      await this.host.setGroup(uid, patch.group);
    }
    this.emit({ type: 'state' });
  }

  /** Saves a profile on the server, then mirrors it. */
  async saveProfile(name: string, profile: Record<string, unknown>): Promise<void> {
    if (!PROFILE_NAME.test(name)) throw new SyncError('invalid_profile_name', false);
    await this.serverCall('POST', `/api/profiles/${encodeURIComponent(name)}`, profile);
    this.mirrorProfile(name, profile);
    this.emit({ type: 'state' });
  }

  /** Deletes a profile on the server, then from the mirror. */
  async deleteProfile(name: string): Promise<void> {
    if (!PROFILE_NAME.test(name)) throw new SyncError('invalid_profile_name', false);
    try {
      await this.serverCall('DELETE', `/api/profiles/${encodeURIComponent(name)}`);
    } catch (error) {
      // Already gone there: still drop the mirror.
      if (!(error instanceof SyncError && error.status === 404)) throw error;
    }
    const path = `${SYNC_PATHS.profilesDir}/${name}.json`;
    if (this.files.fileExists(path)) this.files.deletePath(path);
    this.emit({ type: 'state' });
  }

  private mirrorProfile(name: string, profile: unknown): boolean {
    if (!PROFILE_NAME.test(name) || !isObject(profile)) return false;
    const path = `${SYNC_PATHS.profilesDir}/${name}.json`;
    const body = `${JSON.stringify(profile, null, 2)}\n`;
    if (this.files.readText(path) === body) return false;
    this.files.mkdirp(SYNC_PATHS.profilesDir);
    this.files.writeAtomic(path, body);
    return true;
  }

  /** Refreshes the local label mirror from the server (the server wins; labels it does not have are cleared). */
  async syncLabelsNow(): Promise<MetadataResult> {
    const run = async (): Promise<MetadataResult> => {
      const result: MetadataResult = { ok: false, error: '', atMs: this.timers.now(), pushed: 0, pulled: 0 };
      try {
        const remote = await this.serverCall('GET', '/api/sync/labels?since_ms=0');
        const local = this.host.readLabels();
        const nicknames = new Map<string, string>();
        const groups = new Map<string, string>();
        for (const raw of Array.isArray(remote.items) ? remote.items : []) {
          if (!isObject(raw) || !text(raw.device_uid)) continue;
          nicknames.set(text(raw.device_uid), text(raw.nickname));
          groups.set(text(raw.device_uid), text(raw.group));
        }
        for (const uid of new Set([...nicknames.keys(), ...Object.keys(local.nicknames)])) {
          const want = nicknames.get(uid) ?? '';
          if ((local.nicknames[uid] ?? '') !== want) {
            await this.host.setNickname(uid, want);
            result.pulled += 1;
          }
        }
        for (const uid of new Set([...groups.keys(), ...Object.keys(local.groups)])) {
          const want = groups.get(uid) ?? '';
          if ((local.groups[uid] ?? '') !== want) {
            await this.host.setGroup(uid, want);
            result.pulled += 1;
          }
        }
        result.ok = true;
      } catch (error) {
        result.error = error instanceof SyncError ? error.code : 'unexpected';
        this.log('warn', `labels: ${result.error}`);
      }
      this.labelState = { version: 1, server: this.baseUrl(), items: {}, last: result };
      this.writeState(SYNC_PATHS.labels, this.labelState);
      this.emit({ type: 'state' });
      return result;
    };
    return this.serialMetadata(run);
  }

  /** Refreshes the local profile mirror from the server (profiles the server does not have are removed). */
  async syncProfilesNow(): Promise<MetadataResult> {
    const run = async (): Promise<MetadataResult> => {
      const result: MetadataResult = { ok: false, error: '', atMs: this.timers.now(), pushed: 0, pulled: 0 };
      try {
        const listing = await this.serverCall('GET', '/api/profiles');
        const names = new Set<string>();
        for (const raw of Array.isArray(listing.items) ? listing.items : []) {
          const name = isObject(raw) ? text(raw.name) : '';
          if (!PROFILE_NAME.test(name)) continue;
          names.add(name);
          const profile = await this.serverCall('GET', `/api/profiles/${encodeURIComponent(name)}`);
          if (this.mirrorProfile(name, profile)) result.pulled += 1;
        }
        let local: ReturnType<HostFiles['listDir']> = [];
        try {
          local = this.files.listDir(SYNC_PATHS.profilesDir);
        } catch {
          local = [];
        }
        for (const entry of local) {
          if (entry.isDirectory || !entry.name.endsWith('.json')) continue;
          if (!names.has(entry.name.slice(0, -5))) {
            this.files.deletePath(`${SYNC_PATHS.profilesDir}/${entry.name}`);
            result.pulled += 1;
          }
        }
        result.ok = true;
      } catch (error) {
        result.error = error instanceof SyncError ? error.code : 'unexpected';
        this.log('warn', `profiles: ${result.error}`);
      }
      this.profileState = { version: 1, server: this.baseUrl(), items: {}, last: result };
      this.writeState(SYNC_PATHS.profiles, this.profileState);
      this.emit({ type: 'state' });
      return result;
    };
    return this.serialMetadata(run);
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

