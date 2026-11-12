// Gateway management operations shared by the local web UI and the Desktop
// (operations.py). Both the host's web routes and remoteCommands.ts (the
// Desktop's `gateway_command`) call these, so the two front ends cannot drift
// apart. Each returns an OpResult: ok, an error code when not ok, an HTTP-ish
// status for the web UI, and data to merge into the reply.
import { DEFAULT_CONFIG, type GatewayConfig, type GatewayConfigStore, validateGatewayId } from '../config';
import type { Json, UpdateControl, UpstreamLink } from '../contracts';
import { pyInt, pyStr, pyStrip, pyTruthy } from '../py';
import { UPDATE_CHANNELS } from '../versioning';
import { pyGet, randomHex32, strOr, upperUid } from './pyCompat';
import type { GatewayState } from './state';
import type { UdpCommandDispatcher } from './udpCommands';

/** Where a device listens for commands (its stream port). */
export const DEVICE_CONTROL_PORT = 13250;

/** Kept across a factory reset: they describe the host, and the Gateway could not come back up without them. */
export const FACTORY_RESET_KEEP = [
  'listen_udp_host',
  'listen_udp_port',
  'listen_discovery_host',
  'listen_discovery_port',
  'listen_web_host',
  'listen_web_port',
] as const;

export interface OpResult {
  ok: boolean;
  error: string;
  status: number;
  data: Json;
}

export function opOk(data: Json = {}): OpResult {
  return { ok: true, error: '', status: 200, data };
}

export function opFail(error: string, status = 400, data: Json = {}): OpResult {
  return { ok: false, error, status, data };
}

/** Called with the saved config; the runtime applies it (reconnects, toggles services). */
export type ConfigCallback = (config: GatewayConfig) => void | Promise<void>;

export interface ProbeSender {
  sendProbe(): void;
}

export interface GatewayOperationsOptions {
  configStore: GatewayConfigStore;
  state: GatewayState;
  upstream: UpstreamLink;
  /** sendCommand (the device's session) is optional: release() falls back to the last FindMe address. */
  udpControl?: (Pick<UdpCommandDispatcher, 'sendCommandTo'> & Partial<Pick<UdpCommandDispatcher, 'sendCommand'>>) | null;
  discovery?: ProbeSender | null;
  updateControl: UpdateControl;
  onConfigSaved?: ConfigCallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GatewayOperations {
  readonly configStore: GatewayConfigStore;
  readonly state: GatewayState;
  readonly upstream: UpstreamLink;
  readonly udpControl: (Pick<UdpCommandDispatcher, 'sendCommandTo'> & Partial<Pick<UdpCommandDispatcher, 'sendCommand'>>) | null;
  readonly discovery: ProbeSender | null;
  readonly updateControl: UpdateControl;
  private readonly onConfigSaved: ConfigCallback | undefined;

  constructor(options: GatewayOperationsOptions) {
    this.configStore = options.configStore;
    this.state = options.state;
    this.upstream = options.upstream;
    this.udpControl = options.udpControl ?? null;
    this.discovery = options.discovery ?? null;
    this.updateControl = options.updateControl;
    this.onConfigSaved = options.onConfigSaved;
  }

  /**
   * A required update locks settings and device management until the Gateway
   * is updated. The channel switch stays open: leaving beta is how an
   * operator gets out of a beta-only lock.
   */
  isLocked(): boolean {
    return pyTruthy(this.updateControl.state().required_update);
  }

  private locked(): OpResult | null {
    if (this.isLocked()) return opFail('update_required', 409, { update_state: this.updateControl.state() });
    return null;
  }

  private async commit(config: GatewayConfig): Promise<void> {
    if (this.onConfigSaved !== undefined) {
      await this.onConfigSaved(config);
    } else {
      // Python also set upstream.gateway_id here; UpstreamLink.gatewayId is
      // read-only, so a changed ID needs onConfigSaved (the runtime rebuilds the link).
      this.upstream.updateServer(pyStr(config.server_url));
    }
  }

  /**
   * `target_mode`, `manual_url`, `gateway_id`, `enabled`, `remote_management`;
   * keys missing from `body` keep their value. With allowEnableChange=false
   * (the remote path) `enabled` and `remote_management` are never touched: a
   * Desktop that disabled the Gateway could never reach it again, and one
   * must not be able to turn its own access back on.
   */
  async saveSettings(body: Json, allowEnableChange = true): Promise<OpResult> {
    const locked = this.locked();
    if (locked !== null) return locked;
    const current = this.configStore.snapshot();
    // str(x) or default: Python's str(None) is "None", which is truthy, and that is kept.
    const patch: Json = {
      target_mode: pyStr(pyGet(body, 'target_mode', pyGet(current, 'target_mode', 'production'))) || 'production',
      manual_url: pyStr(pyGet(body, 'manual_url', pyGet(current, 'manual_url', ''))) || '',
      gateway_id: pyStr(pyGet(body, 'gateway_id', pyGet(current, 'gateway_id', ''))) || '',
    };
    if (!['production', 'local', 'manual'].includes(patch.target_mode as string)) return opFail('invalid_target_mode');
    // Remote only: a bad URL there would cut the Desktop off for good.
    if (!allowEnableChange && patch.target_mode === 'manual' && !isWsUrl(patch.manual_url)) {
      return opFail('invalid_manual_url');
    }
    if (allowEnableChange) {
      patch.enabled = pyTruthy(pyGet(body, 'enabled', pyGet(current, 'enabled', false)));
      // Local only too: a Desktop must not be able to grant itself access.
      if ('remote_management' in body) patch.remote_management = pyTruthy(body.remote_management);
    }
    let config: GatewayConfig;
    try {
      if (pyTruthy(pyGet(patch, 'enabled', current.enabled))) validateGatewayId(patch.gateway_id);
      config = await this.configStore.save(patch);
    } catch (error) {
      return opFail(errorMessage(error));
    }
    await this.commit(config);
    return opOk({ config: { ...config } });
  }

  async setUpdateChannel(channel: unknown): Promise<OpResult> {
    const normalized = pyStrip(strOr(channel)).toLowerCase();
    if (!(UPDATE_CHANNELS as readonly string[]).includes(normalized)) return opFail('invalid_update_channel');
    const config = await this.configStore.save({ update_channel: normalized });
    if (this.onConfigSaved !== undefined) {
      await this.onConfigSaved(config);
    } else {
      this.updateControl.setChannel(normalized);
      this.upstream.setUpdateChannel(normalized);
    }
    return opOk({ config: { ...config }, update_state: this.updateControl.state() });
  }

  /** Back to first-run settings (disabled, no Gateway ID). Installed version untouched; host ports kept. */
  async factoryReset(): Promise<OpResult> {
    const current = this.configStore.snapshot();
    const patch: Json = { ...DEFAULT_CONFIG };
    for (const key of FACTORY_RESET_KEEP) patch[key] = pyGet(current, key, DEFAULT_CONFIG[key]);
    patch.denied_devices = [];
    const config = await this.configStore.save(patch);
    await this.commit(config);
    return opOk({ config: { ...config } });
  }

  discover(): OpResult {
    const locked = this.locked();
    if (locked !== null) return locked;
    this.discovery?.sendProbe();
    return opOk();
  }

  async deny(deviceUid: unknown): Promise<OpResult> {
    const locked = this.locked();
    if (locked !== null) return locked;
    const uid = upperUid(deviceUid);
    if (!uid) return opFail('device_uid_required');
    const config = await this.configStore.deny(uid);
    return opOk({ denied_devices: pyGet(config, 'denied_devices', []) });
  }

  async allow(deviceUid: unknown): Promise<OpResult> {
    const locked = this.locked();
    if (locked !== null) return locked;
    const uid = upperUid(deviceUid);
    if (!uid) return opFail('device_uid_required');
    const config = await this.configStore.allow(uid);
    return opOk({ denied_devices: pyGet(config, 'denied_devices', []) });
  }

  /**
   * Takes a device over (the Relays page's / web UI's "take over"): the same
   * as adopt() -- this relay becomes its owner -- under either offer policy.
   * Before, serve() only claimed the device; under "managed" (NH Studio /
   * NH Pocket) the device was then not offered to, so the claim timed out.
   */
  serve(deviceUid: unknown): Promise<OpResult> {
    return this.adopt(deviceUid);
  }

  /**
   * A claim (gateway_claim_request when the Backend is reachable) plus
   * findme_switch_gateway to the address the device's last FindMe came from.
   * switchSent is false when that address is unknown.
   */
  private claimAndSwitch(uid: string): { claim: Json; switchSent: boolean } {
    const claim = this.state.createClaim(uid);
    this.state.updateClaim(claim.claim_id, { state: 'sent' });
    if (this.upstream.isConnected()) this.upstream.sendClaimRequest(claim.device_uid, claim.claim_id, pyInt(claim.ttl_ms));
    const updated = this.state.updateClaim(claim.claim_id, { state: 'requested' });
    const deviceIp = this.state.lastFindmeAddr(uid);
    let switchSent = false;
    if (deviceIp && this.udpControl !== null) {
      const gwId = strOr(this.configStore.snapshot().gateway_id);
      switchSent = this.udpControl.sendCommandTo(uid, { ip: deviceIp, port: DEVICE_CONTROL_PORT }, {
        command: 'findme_switch_gateway',
        request_id: `findme-claim-${claim.claim_id}`,
        preferred_gateway_id: gwId,
        claim_id: claim.claim_id,
        ttl_ms: pyInt(claim.ttl_ms),
        expires_at_ms: pyInt(claim.expires_at_ms),
      });
    }
    return { claim: updated ?? claim, switchSent };
  }

  // -- offer policy, adopt / release (NH Studio / NH Pocket) ----------------

  /** offer_policy "all" | "managed"; takes effect on the next FindMe request. */
  async setOfferPolicy(policy: unknown): Promise<OpResult> {
    const locked = this.locked();
    if (locked !== null) return locked;
    let config: GatewayConfig;
    try {
      config = await this.configStore.setOfferPolicy(policy);
    } catch (error) {
      return opFail(errorMessage(error));
    }
    return opOk({ offer_policy: this.configStore.offerPolicy(), managed_devices: config.managed_devices ?? [] });
  }

  /**
   * Takes a device on, or over from another relay: it joins managed_devices
   * (persisted; off yielded_devices), then is claimed and asked to switch
   * here. The Backend need not be reachable (NH Pocket adopts offline); the
   * claim is then only local, which is all the device needs -- the preferred
   * host mirrors the device's claim_id in its offer.
   */
  async adopt(deviceUid: unknown): Promise<OpResult> {
    const locked = this.locked();
    if (locked !== null) return locked;
    const uid = upperUid(deviceUid);
    if (!uid) return opFail('device_uid_required');
    if (this.configStore.isDenied(uid)) return opFail('device_denied', 409);
    const config = await this.configStore.manage(uid);
    const { claim, switchSent } = this.claimAndSwitch(uid);
    return opOk({ claim, managed_devices: config.managed_devices ?? [], switch_sent: switchSent });
  }

  /**
   * Lets a device go: it leaves managed_devices and joins released_devices
   * (FindMe now declines it with device_released), any claim in flight is
   * failed, and the device is sent findme_discover so it chooses again.
   */
  async release(deviceUid: unknown): Promise<OpResult> {
    const locked = this.locked();
    if (locked !== null) return locked;
    const uid = upperUid(deviceUid);
    if (!uid) return opFail('device_uid_required');
    const config = await this.configStore.release(uid);
    const claim = this.state.activeClaimFor(uid);
    if (claim !== null) this.state.updateClaim(claim.claim_id, { state: 'failed', last_error: 'device_released' });
    const payload: Json = { command: 'findme_discover', request_id: `findme-release-${randomHex32()}` };
    let discoverSent = false;
    if (this.udpControl !== null) {
      discoverSent = this.udpControl.sendCommand?.(uid, payload) ?? false;
      const deviceIp = discoverSent ? null : this.state.lastFindmeAddr(uid);
      if (deviceIp) discoverSent = this.udpControl.sendCommandTo(uid, { ip: deviceIp, port: DEVICE_CONTROL_PORT }, payload);
    }
    return opOk({
      managed_devices: config.managed_devices ?? [],
      released_devices: config.released_devices ?? [],
      discover_sent: discoverSent,
    });
  }
}

export function isWsUrl(value: unknown): boolean {
  const url = pyStrip(strOr(value)).toLowerCase();
  return url.startsWith('ws://') || url.startsWith('wss://');
}
