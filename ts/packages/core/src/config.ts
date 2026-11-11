// Gateway admin config (config_store.py). Key names, defaults and coercions
// are the Python ones exactly: the TS Gateway reads an existing config.json
// unchanged, and anything it writes must still load in the Python Gateway.
// Unknown keys are kept, as Python's dict.update kept them.
import type { JsonStore } from './ports';
import { isPlainObject, pyCompareStr, pyFloat, pyInt, pyStr, pyStrip, pyTruthy } from './py';
import { normalizeChannel, type UpdateChannel } from './versioning';

export const PRODUCTION_URL = 'wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws';
export const LOCAL_URL = 'ws://127.0.0.1:5051/newhorizons/gateway/ws';
export const GATEWAY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export type TargetMode = 'production' | 'local' | 'manual';

/**
 * Which devices FindMe offers to. "all" (the Gateway's behaviour): every
 * device that asks. "managed" (NH Studio / NH Pocket): only the devices in
 * managed_devices, at MANAGED_OFFER_PRIORITY; others are noted as nearby.
 */
export type OfferPolicy = 'all' | 'managed';
export const OFFER_POLICIES: readonly OfferPolicy[] = ['all', 'managed'];

export interface GatewayConfig {
  enabled: boolean;
  gateway_name: string;
  gateway_id: string;
  target_mode: TargetMode;
  manual_url: string;
  server_url: string;
  listen_udp_host: string;
  listen_udp_port: number;
  listen_discovery_host: string;
  listen_discovery_port: number;
  listen_web_host: string;
  listen_web_port: number;
  discovery_enabled: boolean;
  discovery_priority: number;
  control_stale_sec: number;
  denied_devices: string[];
  /** "stable" (gateway-latest.json) or "beta" (gateway-beta.json). */
  update_channel: UpdateChannel;
  /** Accept gateway_command from the Desktop; only the local WebUI may change it. */
  remote_management: boolean;
  /**
   * New (TS only), absent unless set: a Gateway that never uses them writes
   * the same config.json as before. Missing means "all" / [].
   */
  offer_policy?: OfferPolicy;
  /** UIDs this host manages (offer_policy "managed"); normalized, sorted. */
  managed_devices?: string[];
  /** UIDs released by this host: FindMe declines them (device_released) until adopted again. */
  released_devices?: string[];
  /**
   * Ids this host went by before (newest last), recorded when gateway_id
   * changes under offer_policy "managed": a device still attached to one of
   * them is attached to this host, not adopted elsewhere.
   */
  previous_gateway_ids?: string[];
  [key: string]: unknown;
}

/** Raw, not-yet-normalized config (a loaded file, a patch, env overrides applied). */
export type RawConfig = Record<string, unknown>;

export function defaultConfig(): GatewayConfig {
  return {
    enabled: false,
    gateway_name: 'NH Gateway',
    gateway_id: '',
    target_mode: 'production',
    manual_url: '',
    server_url: PRODUCTION_URL,
    listen_udp_host: '0.0.0.0',
    listen_udp_port: 13250,
    listen_discovery_host: '0.0.0.0',
    listen_discovery_port: 22346,
    listen_web_host: '0.0.0.0',
    listen_web_port: 5052,
    discovery_enabled: true,
    discovery_priority: 100,
    control_stale_sec: 16.0,
    denied_devices: [],
    update_channel: 'stable',
    remote_management: true,
  };
}

export const DEFAULT_CONFIG: Readonly<GatewayConfig> = Object.freeze(defaultConfig());

export function parseBool(value: unknown, fallback = false): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off', ''].includes(pyStrip(pyStr(value)).toLowerCase());
}

/** `str(uid).strip()`, separators (`:`, `-`, space) removed, upper case: how managed/released lists key a device. */
export function normalizeListUid(value: unknown): string {
  return pyStrip(pyStr(value)).replace(/[:\- ]/g, '').toUpperCase();
}

function normalizeUidList(value: unknown): string[] {
  const items = Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [];
  return [...new Set(items.map(normalizeListUid).filter(Boolean))].sort(pyCompareStr);
}

/** How many earlier relay ids previous_gateway_ids keeps. */
export const MAX_PREVIOUS_GATEWAY_IDS = 16;

/** Valid ids, once each (the last occurrence kept), never the current one, the newest MAX_PREVIOUS_GATEWAY_IDS. */
function normalizePreviousIds(value: unknown, current: string): string[] {
  const items = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of items) {
    const id = pyStrip(pyTruthy(item) ? pyStr(item) : '');
    if (!id || id === current || !GATEWAY_ID_PATTERN.test(id)) continue;
    const at = out.indexOf(id);
    if (at >= 0) out.splice(at, 1);
    out.push(id);
  }
  return out.slice(-MAX_PREVIOUS_GATEWAY_IDS);
}

export function normalizeOfferPolicy(value: unknown): OfferPolicy {
  const policy = pyStrip(pyTruthy(value) ? pyStr(value) : '').toLowerCase();
  return (OFFER_POLICIES as readonly string[]).includes(policy) ? (policy as OfferPolicy) : 'all';
}

/** Throws Error('gateway_id_required' | 'gateway_id_invalid'). */
export function validateGatewayId(value: unknown): string {
  const gatewayId = pyStrip(pyTruthy(value) ? pyStr(value) : '');
  if (!gatewayId) throw new Error('gateway_id_required');
  if (!GATEWAY_ID_PATTERN.test(gatewayId)) throw new Error('gateway_id_invalid');
  return gatewayId;
}

export function resolveServerUrl(config: RawConfig): string {
  const mode = pyTruthy(config.target_mode) ? pyStr(config.target_mode) : 'production';
  if (mode === 'local') return LOCAL_URL;
  if (mode === 'manual') return pyStrip(pyTruthy(config.manual_url) ? pyStr(config.manual_url) : '') || LOCAL_URL;
  return PRODUCTION_URL;
}

export const ENV_CONFIG_KEYS: Readonly<Record<string, string>> = Object.freeze({
  NEWHORIZONS_GATEWAY_TARGET_MODE: 'target_mode',
  NEWHORIZONS_GATEWAY_MANUAL_URL: 'manual_url',
  NEWHORIZONS_GATEWAY_UDP_HOST: 'listen_udp_host',
  NEWHORIZONS_GATEWAY_UDP_PORT: 'listen_udp_port',
  NEWHORIZONS_GATEWAY_DISCOVERY_HOST: 'listen_discovery_host',
  NEWHORIZONS_GATEWAY_DISCOVERY_PORT: 'listen_discovery_port',
  NEWHORIZONS_GATEWAY_WEB_HOST: 'listen_web_host',
  NEWHORIZONS_GATEWAY_WEB_PORT: 'listen_web_port',
  NEWHORIZONS_GATEWAY_DISCOVERY_ENABLED: 'discovery_enabled',
  NEWHORIZONS_GATEWAY_DISCOVERY_PRIORITY: 'discovery_priority',
  NEWHORIZONS_GATEWAY_ID: 'gateway_id',
  NEWHORIZONS_GATEWAY_ENABLED: 'enabled',
  NEWHORIZONS_GATEWAY_NAME: 'gateway_name',
  NEWHORIZONS_GATEWAY_UPDATE_CHANNEL: 'update_channel',
});

/**
 * GatewayConfigStore._apply_env as a pure function: returns a copy with the
 * non-empty NEWHORIZONS_GATEWAY_* overrides applied (as strings; normalize()
 * coerces them). NEWHORIZONS_GATEWAY_SERVER_URL forces manual mode unless a
 * target mode is also given. NEWHORIZONS_GATEWAY_CONFIG (the file path) is the host's.
 */
export function applyEnvOverrides(config: RawConfig, env: Record<string, string | undefined>): RawConfig {
  const out: RawConfig = { ...config };
  for (const [envName, key] of Object.entries(ENV_CONFIG_KEYS)) {
    const value = env[envName];
    if (value !== undefined && value !== '') out[key] = value;
  }
  const serverUrl = env.NEWHORIZONS_GATEWAY_SERVER_URL;
  if (serverUrl) {
    out.target_mode = env.NEWHORIZONS_GATEWAY_TARGET_MODE || 'manual';
    out.manual_url = serverUrl;
  }
  return out;
}

/**
 * GatewayConfigStore._normalize, returning a new object. Throws, as Python
 * did, when a port or discovery_priority is not an integer.
 */
export function normalizeConfig(raw: RawConfig): GatewayConfig {
  const config: RawConfig = { ...raw };
  for (const key of ['listen_udp_port', 'listen_discovery_port', 'listen_web_port', 'discovery_priority']) {
    config[key] = pyInt(config[key]);
  }
  config.enabled = parseBool(config.enabled, false);
  config.discovery_enabled = parseBool(config.discovery_enabled, true);
  config.remote_management = parseBool(config.remote_management, true);
  config.gateway_id = pyStrip(pyTruthy(config.gateway_id) ? pyStr(config.gateway_id) : '');
  // An invalid id cannot register upstream, so it is cleared and the Gateway disabled rather than refused.
  if (config.gateway_id && !GATEWAY_ID_PATTERN.test(config.gateway_id as string)) {
    config.gateway_id = '';
    config.enabled = false;
  }
  config.update_channel = normalizeChannel(config.update_channel);
  config.target_mode = pyTruthy(config.target_mode) ? pyStr(config.target_mode) : 'production';
  if (!['production', 'local', 'manual'].includes(config.target_mode as string)) config.target_mode = 'production';
  let staleSec: number;
  try {
    // config.get("control_stale_sec", 16.0): only a missing key defaults; null fails float() -> 16.
    staleSec = pyFloat('control_stale_sec' in config ? config.control_stale_sec : 16.0);
    // Python's max(1.0, nan) is 1.0.
    staleSec = Number.isNaN(staleSec) ? 1.0 : Math.max(1.0, staleSec);
  } catch {
    staleSec = 16.0;
  }
  config.control_stale_sec = staleSec;
  // Pre-WSS-auth configs carried a token; it is no longer used and must not be written back.
  delete config.auth_token;
  const denied = Array.isArray(config.denied_devices) ? config.denied_devices : [];
  config.denied_devices = [...new Set(denied.map((uid) => pyStrip(pyStr(uid))).filter(Boolean).map((uid) => uid.toUpperCase()))].sort(
    pyCompareStr,
  );
  // Only when present, so a config that never used them is written unchanged.
  if ('offer_policy' in config) config.offer_policy = normalizeOfferPolicy(config.offer_policy);
  if ('managed_devices' in config) config.managed_devices = normalizeUidList(config.managed_devices);
  if ('released_devices' in config) config.released_devices = normalizeUidList(config.released_devices);
  if ('previous_gateway_ids' in config) config.previous_gateway_ids = normalizePreviousIds(config.previous_gateway_ids, config.gateway_id as string);
  config.server_url = resolveServerUrl(config);
  return config as GatewayConfig;
}

/** The value written to disk: keys sorted, as Python's json.dump(sort_keys=True) wrote them. */
function sortedForDisk(config: GatewayConfig): GatewayConfig {
  const out: RawConfig = {};
  for (const key of Object.keys(config).sort(pyCompareStr)) out[key] = config[key];
  return out as GatewayConfig;
}

/**
 * Host-only admin config. Persists through a JsonStore (atomic writes are the
 * host's job). Environment overrides apply at load only; like Python, a later
 * save() writes them into the file.
 */
export class GatewayConfigStore {
  private constructor(
    private readonly store: JsonStore<RawConfig>,
    private config: GatewayConfig,
  ) {}

  static async load(store: JsonStore<RawConfig>, env: Record<string, string | undefined> = {}): Promise<GatewayConfigStore> {
    let config: RawConfig = { ...defaultConfig() };
    const data = await store.load();
    if (isPlainObject(data)) config = { ...config, ...data };
    return new GatewayConfigStore(store, normalizeConfig(applyEnvOverrides(config, env)));
  }

  snapshot(): GatewayConfig {
    const out: GatewayConfig = { ...this.config, denied_devices: [...this.config.denied_devices] };
    if (this.config.managed_devices) out.managed_devices = [...this.config.managed_devices];
    if (this.config.released_devices) out.released_devices = [...this.config.released_devices];
    if (this.config.previous_gateway_ids) out.previous_gateway_ids = [...this.config.previous_gateway_ids];
    return out;
  }

  /** Merge, normalize, validate, persist. Throws gateway_id_required when enabling without an id. */
  async save(patch: RawConfig): Promise<GatewayConfig> {
    const next = normalizeConfig({ ...this.config, ...patch });
    if (next.gateway_id) next.gateway_id = validateGatewayId(next.gateway_id);
    if (next.enabled) next.gateway_id = validateGatewayId(next.gateway_id);
    const before = this.config.gateway_id;
    if (before && next.gateway_id !== before && normalizeOfferPolicy(next.offer_policy) === 'managed') {
      next.previous_gateway_ids = normalizePreviousIds([...(next.previous_gateway_ids ?? []), before], next.gateway_id);
    }
    // Python assigned before writing, so a failed write still changes the live config.
    this.config = next;
    await this.store.save(sortedForDisk(this.config));
    return this.snapshot();
  }

  isDenied(deviceUid: unknown): boolean {
    return this.config.denied_devices.includes(pyStrip(pyStr(deviceUid)).toUpperCase());
  }

  deny(deviceUid: unknown): Promise<GatewayConfig> {
    const uid = pyStrip(pyStr(deviceUid)).toUpperCase();
    const denied = new Set(this.config.denied_devices);
    if (uid) denied.add(uid);
    return this.save({ denied_devices: [...denied].sort(pyCompareStr) });
  }

  allow(deviceUid: unknown): Promise<GatewayConfig> {
    const uid = pyStrip(pyStr(deviceUid)).toUpperCase();
    return this.save({ denied_devices: this.config.denied_devices.filter((item) => item !== uid).sort(pyCompareStr) });
  }

  // -- FindMe offer policy (NH Studio / NH Pocket) ---------------------------

  offerPolicy(): OfferPolicy {
    return this.config.offer_policy ?? 'all';
  }

  managedDevices(): string[] {
    return [...(this.config.managed_devices ?? [])];
  }

  /** Ids this host went by before (previous_gateway_ids). */
  previousGatewayIds(): string[] {
    return [...(this.config.previous_gateway_ids ?? [])];
  }

  releasedDevices(): string[] {
    return [...(this.config.released_devices ?? [])];
  }

  isManaged(deviceUid: unknown): boolean {
    const uid = normalizeListUid(deviceUid);
    return Boolean(uid) && (this.config.managed_devices ?? []).includes(uid);
  }

  isReleased(deviceUid: unknown): boolean {
    const uid = normalizeListUid(deviceUid);
    return Boolean(uid) && (this.config.released_devices ?? []).includes(uid);
  }

  /** Throws Error('invalid_offer_policy'). */
  setOfferPolicy(policy: unknown): Promise<GatewayConfig> {
    const normalized = pyStrip(pyTruthy(policy) ? pyStr(policy) : '').toLowerCase();
    if (!(OFFER_POLICIES as readonly string[]).includes(normalized)) return Promise.reject(new Error('invalid_offer_policy'));
    return this.save({ offer_policy: normalized });
  }

  /** Adds to managed_devices (and takes it off released_devices). */
  manage(deviceUid: unknown): Promise<GatewayConfig> {
    const uid = normalizeListUid(deviceUid);
    const managed = new Set(this.config.managed_devices ?? []);
    if (uid) managed.add(uid);
    return this.save({
      managed_devices: [...managed],
      released_devices: (this.config.released_devices ?? []).filter((item) => item !== uid),
    });
  }

  /** Removes from managed_devices and adds to released_devices (FindMe declines it from now on). */
  release(deviceUid: unknown): Promise<GatewayConfig> {
    const uid = normalizeListUid(deviceUid);
    const released = new Set(this.config.released_devices ?? []);
    if (uid) released.add(uid);
    return this.save({
      managed_devices: (this.config.managed_devices ?? []).filter((item) => item !== uid),
      released_devices: [...released],
    });
  }
}
