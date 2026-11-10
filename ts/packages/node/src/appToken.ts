// The NH Studio app token on the headless host: the same config keys and
// rules as the Studio app (packages/host/src/sync/config.ts). A token is
// stored with the server it was entered for and sent on the relay link only
// while the config still points at that server; it never appears in
// /api/status, logs or replies (only `nhapp_<id>_…<last 4>`).
import { hostname } from 'node:os';

import type { GatewayConfigStore } from '@nhgw/core';

import { maskToken, relayToken, serverChoiceOf, SYNC_KEYS, syncBaseUrl, TOKEN_PATTERN } from '../../host/src/sync/config';

export { relayToken };

/** Config keys that must never leave this process. */
export const SECRET_CONFIG_KEYS: readonly string[] = [SYNC_KEYS.token];

export interface AppTokenStatus {
  /** A token is stored. */
  set: boolean;
  masked: string;
  /** The server base it was entered for. */
  server: string;
  /** It is sent now: the config still points at that server. */
  active: boolean;
  /** The Desktop account it was signed in with ('' for a pasted token). */
  account: string;
}

export function appTokenStatus(config: Record<string, unknown>): AppTokenStatus {
  const token = typeof config[SYNC_KEYS.token] === 'string' ? (config[SYNC_KEYS.token] as string) : '';
  const server = typeof config[SYNC_KEYS.tokenServer] === 'string' ? (config[SYNC_KEYS.tokenServer] as string) : '';
  const account = token && typeof config[SYNC_KEYS.account] === 'string' ? (config[SYNC_KEYS.account] as string) : '';
  return { set: Boolean(token), masked: maskToken(token), server, active: Boolean(relayToken(config)), account };
}

/** The config without its secrets (what the web UI and its API may see). */
export function withoutSecrets<T extends Record<string, unknown>>(config: T): T {
  const copy: Record<string, unknown> = { ...config };
  for (const key of SECRET_CONFIG_KEYS) delete copy[key];
  return copy as T;
}

/** Stores a token for the server the config points at now. Throws 'invalid_app_token' / 'no_server'. */
export async function saveAppToken(store: GatewayConfigStore, raw: string): Promise<AppTokenStatus> {
  const token = raw.trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error('invalid_app_token');
  const server = syncBaseUrl(serverChoiceOf(store.snapshot() as unknown as Record<string, unknown>));
  if (!server) throw new Error('no_server');
  const config = await store.save({ [SYNC_KEYS.token]: token, [SYNC_KEYS.tokenServer]: server, [SYNC_KEYS.account]: '' });
  return appTokenStatus(config as unknown as Record<string, unknown>);
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

const LOGIN_TIMEOUT_MS = 20_000;

async function post(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    let json: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await response.text()) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      // not JSON
    }
    return { status: response.status, json };
  } catch {
    throw new Error('network');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Signs in with a New Horizons Desktop account (POST /api/app-tokens/login):
 * the password goes to the server once and only the app token it returns is
 * stored. Throws invalid_credentials / network / no_server / sync_unsupported.
 */
export async function loginAppToken(
  store: GatewayConfigStore,
  username: string,
  password: string,
  options: { deviceName?: string; fetch?: FetchLike } = {},
): Promise<AppTokenStatus> {
  const user = username.trim();
  if (!user || !password) throw new Error('username_and_password_required');
  const server = syncBaseUrl(serverChoiceOf(store.snapshot() as unknown as Record<string, unknown>));
  if (!server) throw new Error('no_server');
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const deviceName = options.deviceName ?? `${hostname().replace(/\.local$/, '')} (headless)`;
  const { status, json } = await post(fetchImpl, `${server}/api/app-tokens/login`, {}, { username: user, password, client_type: 'studio', device_name: deviceName });
  if (status === 401) throw new Error('invalid_credentials');
  if (status === 404) throw new Error('sync_unsupported');
  const token = typeof json.token === 'string' ? json.token : '';
  if (status !== 200 || !TOKEN_PATTERN.test(token)) throw new Error(typeof json.error === 'string' && json.error ? json.error : `http_${status}`);
  const account = json.user && typeof json.user === 'object' && typeof (json.user as Record<string, unknown>).username === 'string' ? ((json.user as Record<string, unknown>).username as string) : user;
  const config = await store.save({ [SYNC_KEYS.token]: token, [SYNC_KEYS.tokenServer]: server, [SYNC_KEYS.account]: account });
  return appTokenStatus(config as unknown as Record<string, unknown>);
}

/** Signs out: asks the server to revoke this token (best effort), then forgets it. */
export async function logoutAppToken(store: GatewayConfigStore, options: { fetch?: FetchLike } = {}): Promise<AppTokenStatus> {
  const config = store.snapshot() as unknown as Record<string, unknown>;
  const token = relayToken(config);
  if (token) {
    const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    try {
      await post(fetchImpl, `${config[SYNC_KEYS.tokenServer] as string}/api/app-tokens/self/revoke`, { Authorization: `Bearer ${token}` });
    } catch {
      // offline: an admin can still revoke it on the Relays page
    }
  }
  return clearAppToken(store);
}

export async function clearAppToken(store: GatewayConfigStore): Promise<AppTokenStatus> {
  const config = await store.save({ [SYNC_KEYS.token]: '', [SYNC_KEYS.tokenServer]: '', [SYNC_KEYS.account]: '' });
  return appTokenStatus(config as unknown as Record<string, unknown>);
}
