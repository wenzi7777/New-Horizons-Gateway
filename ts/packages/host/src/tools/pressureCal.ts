// Port of the Desktop's pressure_cal_client.py / pressure_cal_settings.py and
// the /api/pressure-cal/* route checks (api.py): a proxy to the lab Raspberry
// Pi's Pressure Calibration API. Platform-independent: the caller supplies
// fetch and where settings live. The token is never returned or logged.

export const PRESSURE_CAL_MAX_KPA = 28.0;
export const PRESSURE_CAL_TIMEOUT_MS = 5000;

/**
 * Built-in presets (pressure_cal_settings.BUILTIN_PRESETS). The Desktop ships
 * the lab token in source; Studio does not, so the preset carries only the
 * URL and its token is entered once and kept in userData.
 */
export const PRESSURE_CAL_PRESETS: Readonly<Record<string, { label: string; url: string }>> = {
  lab_pi: { label: 'Lab Pi Server', url: 'https://pressure-cal.1205.moe' },
};

export interface PressureCalStored {
  preset: string;
  url: string;
  token: string;
  /** Tokens entered for built-in presets, by preset id. */
  presetTokens?: Record<string, string>;
}

export type PressureCalOutcome<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; error: string; status?: number };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class PressureCalError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

/** load_settings(): defaults to lab_pi; migrates the old {url, token} shape. */
export function normalizePressureSettings(raw: unknown): PressureCalStored {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { preset: 'lab_pi', url: '', token: '' };
  const data = raw as Record<string, unknown>;
  const presetTokens: Record<string, string> = {};
  if (data.presetTokens && typeof data.presetTokens === 'object') {
    for (const [k, v] of Object.entries(data.presetTokens as Record<string, unknown>)) if (typeof v === 'string') presetTokens[k] = v;
  }
  if ('url' in data && !('preset' in data)) return { preset: 'custom', url: String(data.url ?? ''), token: String(data.token ?? ''), presetTokens };
  return { preset: String(data.preset ?? 'lab_pi'), url: String(data.url ?? ''), token: String(data.token ?? ''), presetTokens };
}

/** resolve_credentials(). */
export function resolvePressureCredentials(s: PressureCalStored): { url: string; token: string } {
  const preset = PRESSURE_CAL_PRESETS[s.preset];
  if (preset) return { url: preset.url, token: s.presetTokens?.[s.preset] ?? '' };
  return { url: s.url, token: s.token };
}

export function pressureSettingsView(s: PressureCalStored) {
  const { url, token } = resolvePressureCredentials(s);
  return {
    preset: s.preset,
    url: s.url,
    tokenHint: token ? `${token.slice(0, 8)}...` : '',
    configured: Boolean(url.trim() && token.trim()),
    presets: Object.entries(PRESSURE_CAL_PRESETS).map(([id, p]) => ({ id, label: p.label, url: p.url })),
  };
}

/** pressure_cal_settings_save(): returns the new stored settings or an error code. */
export function applyPressureSettings(current: PressureCalStored, input: { preset?: unknown; url?: unknown; token?: unknown }): PressureCalStored | { error: string } {
  const preset = String(input.preset || 'custom').trim();
  const url = String(input.url ?? '').trim();
  const token = String(input.token ?? '').trim();
  if (PRESSURE_CAL_PRESETS[preset]) {
    const presetTokens = { ...(current.presetTokens ?? {}) };
    if (token) presetTokens[preset] = token;
    return { ...current, preset, presetTokens };
  }
  const keptToken = token || (current.preset === 'custom' ? current.token : '');
  if (!url || !keptToken) return { error: 'url_and_token_required_for_custom' };
  if (!/^https?:\/\//i.test(url)) return { error: 'url_scheme_must_be_http_or_https' };
  return { ...current, preset: 'custom', url, token: keptToken };
}

/** api.py's target checks; null when the target may be sent. */
export function pressureTargetError(value: unknown): string | null {
  if (value === null || value === undefined || typeof value !== 'number' || !Number.isFinite(value)) return 'target_kpa_required';
  if (value > PRESSURE_CAL_MAX_KPA) return 'target_kpa_exceeds_safety_limit';
  if (value < 0) return 'target_kpa_must_be_non_negative';
  return null;
}

export class PressureCalClient {
  private readonly base: string;
  constructor(url: string, private readonly token: string, private readonly fetchFn: FetchLike, private readonly timeoutMs = PRESSURE_CAL_TIMEOUT_MS) {
    this.base = url.replace(/\/+$/, '');
  }

  private async request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = this.base + path;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: 'application/json', 'User-Agent': 'NH-Studio/2' };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchFn(url, { method, headers, body: payload, signal: controller.signal });
    } catch (error) {
      throw new PressureCalError(`Network error contacting ${url}: ${error instanceof Error ? error.message : String(error)}`, 0);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new PressureCalError(`HTTP ${response.status} from ${url}: ${text}`, response.status);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      throw new PressureCalError(`Invalid JSON response from ${url}: ${error instanceof Error ? error.message : String(error)}`, 0);
    }
  }

  health() { return this.request('GET', '/api/v1/health'); }
  readings() { return this.request('GET', '/api/v1/readings/all'); }
  setTarget(kpa: number) {
    // Defence in depth: the route checks too, but the client never sends above the cap.
    const error = pressureTargetError(kpa);
    if (error) return Promise.reject(new PressureCalError(error, 422));
    return this.request('POST', '/api/v1/pressure/target', { target_kpa: kpa });
  }
  stop() { return this.request('POST', '/api/v1/pressure/stop'); }
}

/** get_client(): null when not configured. */
export function pressureClientFor(s: PressureCalStored, fetchFn: FetchLike): PressureCalClient | null {
  const { url, token } = resolvePressureCredentials(s);
  if (!url.trim() || !token.trim() || !/^https?:\/\//i.test(url.trim())) return null;
  return new PressureCalClient(url.trim(), token.trim(), fetchFn);
}

/** Runs one route the way api.py does: not configured / client error / result. */
export async function runPressureCall<T = Record<string, unknown>>(client: PressureCalClient | null, call: (c: PressureCalClient) => Promise<Record<string, unknown>>): Promise<PressureCalOutcome<T>> {
  if (!client) return { ok: false, error: 'pressure_cal_not_configured' };
  try {
    return { ok: true, data: (await call(client)) as T };
  } catch (error) {
    if (error instanceof PressureCalError) return { ok: false, error: error.message, status: error.status };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
