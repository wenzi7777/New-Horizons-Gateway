// What the Gateway knows about devices (state.py): the device roster, the
// FindMe request log, which devices it is serving, and FindMe claims (an
// operator asking a nearby device to switch to this Gateway). Field names are
// Python's exactly: the whole snapshot travels upstream inside gateway_status
// and the Desktop and the web UI read it.
//
// Two clocks, as in Python: liveness/staleness use a seconds clock (`*_monotonic`
// fields), claim expiry uses the wall clock in ms (claims carry expires_at_ms,
// which the device and the Backend compare against their own wall clocks).
import type { Address, Clock } from '../ports';
import { isPlainObject, pyCompareStr, pyInt, pyStr, pyStrip, pyTruthy } from '../py';
import { type Dict, dictOr, pyGet, pyOr, randomHex32, strOr, upperUid, utcIsoFormat } from './pyCompat';

export const DEFAULT_CONTROL_STALE_SEC = 16.0;
export const DEFAULT_FINDME_ATTACH_WINDOW_SEC = 20.0;
export const DEFAULT_PRUNE_AFTER_SEC = 300.0;
export const FINDME_REQUEST_LOG_MAX = 120;
export const DEFAULT_CLAIM_TTL_MS = 30000;

export type DeviceRecord = Dict;
export type ClaimRecord = Dict & {
  claim_id: string;
  device_uid: string;
  state: string;
  ttl_ms: number;
  expires_at_ms: number;
  last_error: string;
};

export interface GatewayStateSnapshot {
  devices: DeviceRecord[];
  denied_devices: string[];
  findme_requests: Dict[];
  nearby_devices: Dict[];
  claims: ClaimRecord[];
}

export interface GatewayStateOptions {
  clock: Clock;
  /**
   * Seconds clock for liveness. Python used time.time(); the port defaults to
   * the monotonic clock so a wall-clock step cannot flip every device offline.
   */
  now?: () => number;
  controlStaleSec?: number | null;
  findmeAttachWindowSec?: number | null;
  pruneAfterSec?: number | null;
  /** uuid4().hex by default; tests inject a predictable one. */
  newClaimId?: () => string;
}

/** `str(device_uid).strip().upper()` (no `or ""`: Python's str(None) is "None"). */
function uidStr(value: unknown): string {
  return pyStrip(pyStr(value)).toUpperCase();
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value) || 0;
}

export class GatewayState {
  readonly controlStaleSec: number;
  readonly findmeAttachWindowSec: number;
  readonly pruneAfterSec: number;
  readonly devices = new Map<string, DeviceRecord>();
  /** Newest first (Python's deque.appendleft, maxlen 120). */
  readonly findmeRequests: Dict[] = [];
  readonly claims = new Map<string, ClaimRecord>();

  private readonly clock: Clock;
  private readonly now: () => number;
  private readonly newClaimId: () => string;

  constructor(options: GatewayStateOptions) {
    this.clock = options.clock;
    this.now = options.now ?? (() => options.clock.monotonicMs() / 1000);
    this.newClaimId = options.newClaimId ?? randomHex32;
    // 16 s = ~3 missed 5 s heartbeats (firmware kHeartbeatIntervalMs=5000) plus
    // jitter slack: one or two lost heartbeats keep a live device connected, a
    // powered-off one is dropped within ~16-21 s. `?? ` (not `||`) so an
    // explicit small value is never bumped back up.
    this.controlStaleSec = Math.max(1.0, options.controlStaleSec ?? DEFAULT_CONTROL_STALE_SEC);
    this.findmeAttachWindowSec = Math.max(1.0, options.findmeAttachWindowSec || DEFAULT_FINDME_ATTACH_WINDOW_SEC);
    // A device not heard from (control or FindMe) for this long is dropped from
    // the roster, not just flagged disconnected; otherwise a device that moved to
    // another Gateway/Hub keeps being re-asserted in every gateway_status and the
    // Desktop's presence display flips back to this Gateway. Floored at
    // control_stale_sec so it never fires before the connected flag flips.
    this.pruneAfterSec = Math.max(this.controlStaleSec, options.pruneAfterSec ?? DEFAULT_PRUNE_AFTER_SEC);
  }

  private utcNow(): string {
    return utcIsoFormat(this.clock.nowMs());
  }

  private nowMsInt(): number {
    return Math.floor(this.clock.nowMs());
  }

  private deviceFor(uid: string): DeviceRecord {
    let device = this.devices.get(uid);
    if (device === undefined) {
      device = { device_uid: uid, udp_packets: 0, udp_bytes: 0 };
      this.devices.set(uid, device);
    }
    return device;
  }

  recordFindmeRequest(payload: Dict, addr: Address, accepted: boolean, reason = ''): void {
    const uid = upperUid(payload.device_uid);
    const now = this.utcNow();
    const item: Dict = {
      device_uid: uid,
      device_name: pyGet(payload, 'device_name', ''),
      mode: pyGet(payload, 'mode', ''),
      firmware_version: pyGet(payload, 'firmware_version', ''),
      hardware_model: pyGet(payload, 'hardware_model', ''),
      protocol: pyGet(payload, 'protocol', ''),
      wifi_rssi: pyGet(payload, 'wifi_rssi', null),
      addr: addr.ip,
      addr_port: pyInt(addr.port),
      accepted,
      reason,
      received_at: now,
      received_monotonic: this.now(),
    };
    this.findmeRequests.unshift(item);
    if (this.findmeRequests.length > FINDME_REQUEST_LOG_MAX) this.findmeRequests.length = FINDME_REQUEST_LOG_MAX;
    if (!uid) return;
    const device = this.deviceFor(uid);
    Object.assign(device, {
      device_name: pyOr(payload.device_name, pyGet(device, 'device_name', '')),
      mode: pyOr(payload.mode, pyGet(device, 'mode', '')),
      firmware_version: pyOr(payload.firmware_version, pyGet(device, 'firmware_version', '')),
      hardware_model: pyOr(payload.hardware_model, pyGet(device, 'hardware_model', '')),
      protocol: pyOr(payload.protocol, pyGet(device, 'protocol', '')),
      wifi_rssi: pyGet(payload, 'wifi_rssi', pyGet(device, 'wifi_rssi', null)),
      last_findme_at: now,
      last_findme_addr: addr.ip,
      last_findme_monotonic: item.received_monotonic,
      findme_accepted: accepted,
      findme_reason: reason,
      findme_state: accepted ? 'offered' : 'rejected',
    });
  }

  recordControl(
    deviceUid: unknown,
    msgType: string,
    payload: Dict,
    peer: Address,
    connected = true,
    gatewayId = '',
  ): void {
    const uid = uidStr(deviceUid);
    if (!uid) return;
    const now = this.utcNow();
    const device = this.deviceFor(uid);
    const nested = dictOr(payload.payload);
    const data = dictOr(payload.data);
    let mode = pyOr(payload.mode, nested.mode, data.mode);
    if (!pyTruthy(mode) && msgType === 'result') {
      // Mirrors the Backend's _maintenance_mode_from_result: the firmware's
      // enter/exit_maintenance acks carry no mode, so derive it from the
      // command/message to keep the cached mode right before the next FindMe.
      const ok = payload.ok !== false && strOr(payload.status) !== 'error';
      if (ok) {
        const cmd = strOr(pyOr(payload.command, payload.cmd));
        const msg = strOr(payload.message);
        if (cmd === 'enter_maintenance' || msg === 'maintenance_entered') mode = 'maintenance';
        else if (cmd === 'exit_maintenance' || msg === 'maintenance_exited') mode = 'normal';
      }
    }
    if (!pyTruthy(mode)) mode = pyGet(device, 'mode', '');
    const command = strOr(pyOr(payload.command, payload.cmd));
    const switchStarted = msgType === 'result' && command === 'findme_switch_gateway';
    const firmwareVersion = pyOr(
      payload.firmware_version,
      nested.firmware_version,
      data.firmware_version,
      pyGet(device, 'firmware_version', ''),
    );
    // A command result answers whichever Gateway sent the command (the device
    // answers anyone) while streams and heartbeats go only to the Gateway its
    // FindMe picked. Taking every result as "attached here" let a second
    // Gateway on the LAN claim the device for its 16 s window, the Desktop
    // then routed the next status poll through it, the reply renewed the
    // claim, and the device flipped between the two forever. So a result only
    // says where the device is attached when it carries the device's own
    // FindMe block (a status reply), and is never liveness by itself.
    let keepConnection = switchStarted;
    let attachment: boolean | null = null;
    if (msgType === 'result' && connected && !switchStarted) {
      attachment = GatewayState.replyAttachment(data, gatewayId);
      if (attachment === null) keepConnection = true;
      else connected = attachment;
    }
    const update: Dict = {
      last_seen: now,
      last_control_type: msgType,
      device_name: pyOr(payload.device_name, pyGet(device, 'device_name', '')),
      mode,
      firmware_version: pyOr(firmwareVersion, pyGet(device, 'firmware_version', '')),
      protocol: pyOr(payload.protocol, nested.protocol, data.protocol, pyGet(device, 'protocol', '')),
      hardware_model: pyOr(payload.hardware_model, nested.hardware_model, data.hardware_model, pyGet(device, 'hardware_model', '')),
      transport_path: pyOr(payload.transport_path, nested.transport_path, data.transport_path, pyGet(device, 'transport_path', '')),
    };
    if (msgType !== 'result' || attachment) update.last_seen_monotonic = this.now();
    if (!keepConnection) {
      update.connected = connected;
      update.peer = `${peer.ip}:${peer.port}`;
      update.findme_state = connected ? 'attached' : 'disconnected';
    }
    Object.assign(device, update);
    if (connected && !keepConnection) this.attachActiveClaim(uid, device, now);
  }

  /** null: the reply says nothing about attachment; else whether it names this Gateway as attached. */
  static replyAttachment(data: Dict, gatewayId: string): boolean | null {
    const findme = isPlainObject(data.findme) ? data.findme : null;
    const reported = strOr((findme ?? {}).gateway_id);
    if (!gatewayId || !reported) return null;
    return reported === gatewayId && strOr(findme!.state) === 'attached';
  }

  recordHeartbeat(deviceUid: unknown, payload: Dict | null, peer: Address): void {
    const uid = uidStr(deviceUid);
    if (!uid) return;
    const now = this.utcNow();
    const p: Dict = { ...(payload ?? {}) };
    const device = this.deviceFor(uid);
    Object.assign(device, {
      connected: true,
      peer: `${peer.ip}:${peer.port}`,
      last_seen: now,
      last_seen_monotonic: this.now(),
      last_control_type: 'heartbeat',
      last_heartbeat_at: now,
      findme_state: 'attached',
      device_name: pyOr(p.device_name, pyGet(device, 'device_name', '')),
      // A binary heartbeat is only a liveness signal and does not carry the
      // device's authoritative mode (FindMe and JSON status do). Never let it
      // overwrite a known mode, or the WebUI flickers maintenance/normal.
      mode: pyOr(device.mode, 'normal'),
      protocol: pyOr(p.protocol, pyGet(device, 'protocol', 'NHO/Arduino/1')),
      hardware_model: pyOr(p.hardware_model, pyGet(device, 'hardware_model', '')),
      firmware_version: pyOr(p.firmware_version, pyGet(device, 'firmware_version', '')),
      transport_path: pyOr(p.transport_path, 'arduino_heartbeat'),
    });
    this.attachActiveClaim(uid, device, now);
  }

  recordDisconnect(deviceUid: unknown): void {
    const uid = uidStr(deviceUid);
    if (!uid) return;
    const device = this.deviceFor(uid);
    device.connected = false;
    device.disconnected_at = this.utcNow();
    device.findme_state = 'disconnected';
  }

  recordUdpPacket(deviceUid: unknown, byteCount: number, forwarded: boolean): void {
    const uid = uidStr(deviceUid);
    if (!uid) return;
    const device = this.deviceFor(uid);
    device.udp_packets = pyInt(pyGet(device, 'udp_packets', 0)) + 1;
    device.udp_bytes = pyInt(pyGet(device, 'udp_bytes', 0)) + pyInt(byteCount);
    if (forwarded) {
      device.udp_forwarded = pyInt(pyGet(device, 'udp_forwarded', 0)) + 1;
      // A forwarded stream packet proves the device is alive, so a busy
      // streamer never flaps offline over one missed heartbeat. Only forwarded
      // packets count: a denied device's raw packets must not look connected.
      device.last_seen_monotonic = this.now();
    } else {
      device.udp_dropped = pyInt(pyGet(device, 'udp_dropped', 0)) + 1;
    }
    device.last_udp_at = this.utcNow();
  }

  isServing(deviceUid: unknown): boolean {
    const uid = uidStr(deviceUid);
    this.markStaleControl();
    return pyTruthy(this.devices.get(uid)?.connected);
  }

  /** Devices this Gateway is serving right now (stale ones excluded). */
  servingCount(): number {
    this.markStaleControl();
    let count = 0;
    for (const device of this.devices.values()) if (pyTruthy(device.connected)) count++;
    return count;
  }

  findmeAllowsStream(deviceUid: unknown, peer: Address | null): boolean {
    const uid = uidStr(deviceUid);
    const host = peer ? pyStr(peer.ip) : '';
    const now = this.now();
    const device = this.devices.get(uid) ?? {};
    if (
      pyTruthy(device.findme_accepted) &&
      device.last_findme_addr === host &&
      now - num(pyOr(device.last_findme_monotonic, 0.0)) <= this.findmeAttachWindowSec
    ) {
      return true;
    }
    // Only the newest request from this device at this address decides.
    for (const request of this.findmeRequests) {
      if (upperUid(request.device_uid) !== uid) continue;
      if (!pyTruthy(request.accepted)) continue;
      if (strOr(request.addr) !== host) continue;
      return now - num(pyOr(request.received_monotonic, 0.0)) <= this.findmeAttachWindowSec;
    }
    return false;
  }

  createClaim(deviceUid: unknown, ttlMs: unknown = DEFAULT_CLAIM_TTL_MS): ClaimRecord {
    const uid = uidStr(deviceUid);
    const ttl = Math.max(1000, pyInt(pyOr(ttlMs, DEFAULT_CLAIM_TTL_MS)));
    const now = this.utcNow();
    const claim: ClaimRecord = {
      claim_id: this.newClaimId(),
      device_uid: uid,
      state: 'created',
      requested_at: now,
      updated_at: now,
      ttl_ms: ttl,
      expires_at_ms: this.nowMsInt() + ttl,
      last_error: '',
    };
    this.claims.set(claim.claim_id, claim);
    return { ...claim };
  }

  updateClaim(claimId: unknown, patch: Dict): ClaimRecord | null {
    const claim = this.claims.get(strOr(claimId));
    if (claim === undefined) return null;
    Object.assign(claim, patch);
    claim.updated_at = this.utcNow();
    return { ...claim };
  }

  failClaimDelivery(claimId: unknown, error: unknown): ClaimRecord | null {
    const claim = this.claims.get(strOr(claimId));
    if (claim === undefined) return null;
    // The device may have switched and heartbeated before the switch command's ack was lost.
    if (claim.state === 'attached') return { ...claim };
    claim.state = 'failed';
    claim.last_error = strOr(error) || 'switch_command_delivery_timeout';
    claim.updated_at = this.utcNow();
    return { ...claim };
  }

  activeClaimFor(deviceUid: unknown): ClaimRecord | null {
    const claim = this.activeClaim(uidStr(deviceUid), this.nowMsInt());
    return claim === null ? null : { ...claim };
  }

  lastFindmeAddr(deviceUid: unknown): string | null {
    const addr = this.devices.get(uidStr(deviceUid))?.last_findme_addr;
    return pyTruthy(addr) ? pyStr(addr) : null;
  }

  pendingClaims(): ClaimRecord[] {
    const nowMs = this.nowMsInt();
    const result: ClaimRecord[] = [];
    for (const claim of this.claims.values()) {
      if (pyInt(pyOr(claim.expires_at_ms, 0)) <= nowMs) continue;
      if (['attached', 'failed', 'timeout'].includes(claim.state)) continue;
      result.push({ ...claim });
    }
    return result;
  }

  snapshot(deniedDevices: readonly unknown[]): GatewayStateSnapshot {
    const denied = new Set(deniedDevices.map((uid) => uidStr(uid)));
    this.markStaleControl();
    const devices: DeviceRecord[] = [];
    for (const [uid, device] of this.devices) devices.push({ ...device, denied: denied.has(uid) });
    devices.sort(
      (a, b) =>
        Number(!pyTruthy(a.connected)) - Number(!pyTruthy(b.connected)) ||
        pyCompareStr(pyStr(pyGet(a, 'device_uid', '')), pyStr(pyGet(b, 'device_uid', ''))),
    );
    const nearby = this.nearbyDevices(denied);
    // sorted(reverse=True) keeps equal keys in their original order; so does a stable sort on the negated key.
    const claims = [...this.claims.values()]
      .map((claim) => ({ ...claim }))
      .sort((a, b) => pyCompareStr(pyStr(pyGet(b, 'updated_at', '')), pyStr(pyGet(a, 'updated_at', ''))));
    return {
      devices,
      denied_devices: [...denied].sort(pyCompareStr),
      findme_requests: this.findmeRequests.map((item) => ({ ...item })),
      nearby_devices: nearby,
      claims,
    };
  }

  private nearbyDevices(denied: Set<string>): Dict[] {
    const byUid = new Map<string, Dict>();
    // Oldest to newest, so the newest request per device wins.
    for (let i = this.findmeRequests.length - 1; i >= 0; i--) {
      const request = this.findmeRequests[i]!;
      const uid = upperUid(request.device_uid);
      if (!uid) continue;
      const item: Dict = {
        device_uid: uid,
        device_name: pyGet(request, 'device_name', ''),
        mode: pyGet(request, 'mode', ''),
        wifi_rssi: pyGet(request, 'wifi_rssi', null),
        addr: pyGet(request, 'addr', ''),
        last_findme_at: pyGet(request, 'received_at', ''),
        findme_accepted: pyTruthy(request.accepted),
        findme_reason: pyGet(request, 'reason', ''),
      };
      // Like a dict, Map.set on an existing key keeps its original position.
      byUid.set(uid, item);
    }
    for (const [uid, device] of this.devices) {
      let item = byUid.get(uid);
      if (item === undefined) {
        item = { device_uid: uid };
        byUid.set(uid, item);
      }
      Object.assign(item, {
        device_name: pyOr(device.device_name, pyGet(item, 'device_name', '')),
        mode: pyOr(device.mode, pyGet(item, 'mode', '')),
        wifi_rssi: pyGet(device, 'wifi_rssi', pyGet(item, 'wifi_rssi', null)),
        addr: pyOr(device.last_findme_addr, pyGet(item, 'addr', '')),
        last_findme_at: pyOr(device.last_findme_at, pyGet(item, 'last_findme_at', '')),
        serving: pyTruthy(device.connected),
        connected: pyTruthy(device.connected),
        peer: pyGet(device, 'peer', ''),
        findme_state: pyOr(device.findme_state, pyGet(item, 'findme_state', '')),
        claim_id: pyGet(device, 'claim_id', ''),
      });
    }
    for (const [uid, item] of byUid) {
      item.denied = denied.has(uid);
      if (!('serving' in item)) item.serving = false;
      if (!('connected' in item)) item.connected = false;
      const claim = this.activeClaimFor(uid);
      if (claim !== null) {
        item.claim_id = pyGet(claim, 'claim_id', '');
        item.claim_state = pyGet(claim, 'state', '');
      }
    }
    return [...byUid.values()].sort(
      (a, b) =>
        Number(!pyTruthy(a.serving)) - Number(!pyTruthy(b.serving)) ||
        Number(pyTruthy(a.denied)) - Number(pyTruthy(b.denied)) ||
        pyCompareStr(pyStr(pyGet(a, 'device_uid', '')), pyStr(pyGet(b, 'device_uid', ''))),
    );
  }

  private markStaleControl(): void {
    const now = this.now();
    const staleUids: string[] = [];
    for (const [uid, device] of this.devices) {
      if (pyTruthy(device.connected)) {
        const seenAt = device.last_seen_monotonic;
        if (seenAt !== undefined && seenAt !== null && now - num(pyOr(seenAt, 0.0)) > this.controlStaleSec) {
          device.connected = false;
          device.disconnected_at = this.utcNow();
          device.findme_state = 'disconnected';
        }
      }
      // Prune on whichever activity stamp is newer: a device only ever seen in
      // a denied/rejected FindMe never gets last_seen_monotonic, and would
      // otherwise never be pruned.
      const candidates = [device.last_seen_monotonic, device.last_findme_monotonic].filter(
        (t) => t !== undefined && t !== null,
      );
      if (candidates.length && now - Math.max(...candidates.map(num)) > this.pruneAfterSec) staleUids.push(uid);
    }
    for (const uid of staleUids) this.devices.delete(uid);
  }

  /** The first live claim for the device; expired ones are marked timeout on the way. */
  private activeClaim(uid: string, nowMs: number = this.nowMsInt()): ClaimRecord | null {
    for (const claim of this.claims.values()) {
      if (strOr(claim.device_uid).toUpperCase() !== uid) continue;
      if (pyInt(pyOr(claim.expires_at_ms, 0)) <= nowMs) {
        if (!['attached', 'timeout', 'failed'].includes(claim.state)) {
          claim.state = 'timeout';
          claim.last_error = 'claim_timeout';
          claim.updated_at = this.utcNow();
        }
        continue;
      }
      if (claim.state === 'failed' || claim.state === 'timeout') continue;
      return claim;
    }
    return null;
  }

  private attachActiveClaim(uid: string, device: DeviceRecord, now: string): void {
    const claim = this.activeClaim(uid);
    if (claim === null) return;
    claim.state = 'attached';
    claim.attached_at = now;
    claim.updated_at = now;
    claim.last_error = '';
    device.claim_id = pyGet(claim, 'claim_id', '');
  }
}
