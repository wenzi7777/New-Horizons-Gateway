// Where the sync API lives and where the app token is kept.
//
// The REST base is derived from the same server choice as the relay link
// (HostSettings.serverTarget): production and local are fixed, a manual
// ws(s)://host/base/gateway/ws becomes http(s)://host/base. The app token
// (docs/studio-sync-api.md: `nhapp_<id>_<secret>`) is stored in the host
// config together with the base it was entered for, so it is never sent to
// another server (the relay link uses it only while the server matches).

export const PRODUCTION_BASE_URL = 'https://isensing-s1.u-aizu.ac.jp/newhorizons';
export const LOCAL_BASE_URL = 'http://127.0.0.1:5051/newhorizons';

/** Keys in the host config file (GatewayConfigStore keeps unknown keys). */
export const SYNC_KEYS = {
  token: 'sync_app_token',
  /** The base URL the token was entered for. */
  tokenServer: 'sync_app_token_server',
  paused: 'sync_paused',
  /** The Desktop account the token was signed in with (shown, never sent). */
  account: 'sync_account',
} as const;

export interface ServerChoice {
  serverTarget: 'production' | 'local' | 'manual';
  manualUrl: string;
}

/** The sync API's base URL for a server choice ('' when a manual URL is unusable). */
export function syncBaseUrl(choice: ServerChoice): string {
  if (choice.serverTarget === 'production') return PRODUCTION_BASE_URL;
  if (choice.serverTarget === 'local') return LOCAL_BASE_URL;
  const raw = choice.manualUrl.trim();
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  const scheme = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : url.protocol === 'ws:' || url.protocol === 'http:' ? 'http:' : '';
  if (!scheme) return '';
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/gateway\/ws$/, '').replace(/\/ws$/, '').replace(/\/+$/, '');
  return `${scheme}//${url.host}${path}`;
}

/** The server choice stored in a raw host config. */
export function serverChoiceOf(config: Record<string, unknown>): ServerChoice {
  const target = config.target_mode;
  return {
    serverTarget: target === 'local' || target === 'manual' ? target : 'production',
    manualUrl: typeof config.manual_url === 'string' ? config.manual_url : '',
  };
}

/** The stored token if it was entered for the server the config points at now, else ''. */
export function relayToken(config: Record<string, unknown>): string {
  const token = typeof config[SYNC_KEYS.token] === 'string' ? (config[SYNC_KEYS.token] as string) : '';
  if (!token) return '';
  return config[SYNC_KEYS.tokenServer] === syncBaseUrl(serverChoiceOf(config)) ? token : '';
}

export const TOKEN_PATTERN = /^nhapp_[0-9a-f]{12}_[A-Za-z0-9_-]{8,}$/;

/** `nhapp_<id>_…<last 4>`: enough to tell tokens apart, useless to an attacker. */
export function maskToken(token: string): string {
  if (!token) return '';
  const match = /^(nhapp_[0-9a-f]{12})_/.exec(token);
  const tail = token.slice(-4);
  return match ? `${match[1]}_…${tail}` : `…${tail}`;
}

/** Removes a secret from text that might be logged or shown. */
export function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[token]') : text;
}
