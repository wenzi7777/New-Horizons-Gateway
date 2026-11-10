// The NH Studio app token on the headless host: the same config keys and
// rules as the Studio app (packages/host/src/sync/config.ts). A token is
// stored with the server it was entered for and sent on the relay link only
// while the config still points at that server; it never appears in
// /api/status, logs or replies (only `nhapp_<id>_…<last 4>`).
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
}

export function appTokenStatus(config: Record<string, unknown>): AppTokenStatus {
  const token = typeof config[SYNC_KEYS.token] === 'string' ? (config[SYNC_KEYS.token] as string) : '';
  const server = typeof config[SYNC_KEYS.tokenServer] === 'string' ? (config[SYNC_KEYS.tokenServer] as string) : '';
  return { set: Boolean(token), masked: maskToken(token), server, active: Boolean(relayToken(config)) };
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
  const config = await store.save({ [SYNC_KEYS.token]: token, [SYNC_KEYS.tokenServer]: server });
  return appTokenStatus(config as unknown as Record<string, unknown>);
}

export async function clearAppToken(store: GatewayConfigStore): Promise<AppTokenStatus> {
  const config = await store.save({ [SYNC_KEYS.token]: '', [SYNC_KEYS.tokenServer]: '' });
  return appTokenStatus(config as unknown as Record<string, unknown>);
}
