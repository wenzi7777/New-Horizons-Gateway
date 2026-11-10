// FindMe (discovery.py). A device broadcasts `findme_discover` on port 22346;
// every Gateway that hears it answers with a `findme_offer` and the device
// picks the best one (highest priority, then its own rules). This module only
// decides the answer: the host owns the socket, hands each datagram to
// DiscoveryResponder.handleDatagram, and the reply goes out through the
// injected UdpSocket.
import { utf8Encode } from '../bytes';
import type { OfferPolicy } from '../config';
import type { Address, Clock, UdpSocket } from '../ports';
import { decodeJsonLine } from '../protocol';
import { isPlainObject, pyInt, pyTruthy } from '../py';
import { type Dict, pyJsonDumpsCompact, strOr, upperUid } from './pyCompat';

export const FINDME_DISCOVER_TYPE = 'findme_discover';
export const FINDME_OFFER_TYPE = 'findme_offer';
export const FINDME_PROBE_TYPE = 'findme_probe';
/** Python read with recvfrom(1024): a longer datagram was cut there (and then failed to parse). */
export const FINDME_RECV_BYTES = 1024;
/** A claimed device's offer outranks every unclaimed offer. */
export const CLAIM_PRIORITY_BOOST = 10000;
export const DENIED_COOLDOWN_MS = 30000;
export const OFFER_TTL_MS = 10000;
/**
 * Under offer_policy "managed", the floor for a managed device's offer: above
 * the Desktop server's own FindMe responder (100), so the App that manages a
 * device wins it over the server. A claim adds CLAIM_PRIORITY_BOOST on top.
 */
export const MANAGED_OFFER_PRIORITY = 200;
/** A device this host released: declined (with a cooldown) until it is adopted again. */
export const DEVICE_RELEASED_REASON = 'device_released';
/** Under "managed", a device not in the managed list: no offer, only noted as nearby. */
export const DEVICE_UNMANAGED_REASON = 'device_unmanaged';

export type FindmeRequestRecorder = (payload: Dict, addr: Address, accepted: boolean, reason: string) => void;

/** Everything an offer depends on, read fresh for each request. */
export interface FindmeContext {
  gatewayId: string;
  gatewayName: string;
  priority: number;
  /** The bound stream (13250) port the device should stream to. */
  udpPort: number;
  /** "online" / "offline". */
  upstreamStatus: string;
  isDenied(deviceUid: string): boolean;
  activeClaim(deviceUid: string): Dict | null;
  /** Wall clock ms, for `server_time`. */
  nowMs: number;
  /** Absent: "all" (every device is offered, as the Gateway always did). */
  offerPolicy?: OfferPolicy;
  isManaged?(deviceUid: string): boolean;
  isReleased?(deviceUid: string): boolean;
}

export interface FindmeDecision {
  /** What to record in the request log (on_request), or null for nothing. */
  record: { accepted: boolean; reason: string } | null;
  /** The offer/decline to send back, or null to stay silent. */
  reply: Dict | null;
}

/** _decode_request: the discover payload without its `type`, or null if it is not one. */
export function decodeFindmeRequest(data: Uint8Array): Dict | null {
  let decoded: unknown;
  try {
    decoded = decodeJsonLine(data.subarray(0, FINDME_RECV_BYTES), false);
  } catch {
    return null;
  }
  if (!isPlainObject(decoded) || decoded.type !== FINDME_DISCOVER_TYPE) return null;
  const payload: Dict = { ...decoded };
  delete payload.type;
  if (!pyTruthy(payload.device_uid)) return null;
  return payload;
}

function offerPayload(ctx: FindmeContext, denied: boolean, claimId: string, priority = ctx.priority): Dict {
  return {
    version: 1,
    gateway_name: ctx.gatewayName,
    gateway_id: ctx.gatewayId,
    udp_port: pyInt(ctx.udpPort),
    priority: priority + (claimId ? CLAIM_PRIORITY_BOOST : 0),
    accept: !denied,
    upstream_status: ctx.upstreamStatus,
    ttl_ms: OFFER_TTL_MS,
    server_time: Math.floor(ctx.nowMs),
  };
}

/** The FindMe answer to one decoded discover request. Pure. */
export function decideFindme(request: Dict, ctx: FindmeContext): FindmeDecision {
  const deviceUid = upperUid(request.device_uid);

  // Attached to another Gateway (a probe response): note it as nearby but do
  // not offer -- an offer here would steal the device.
  const currentGw = strOr(request.current_gateway_id);
  if (currentGw && currentGw !== ctx.gatewayId) {
    return { record: { accepted: false, reason: 'device_attached_elsewhere' }, reply: null };
  }

  const preferredGw = strOr(request.preferred_gateway_id);
  const discoverClaimId = strOr(request.claim_id);
  if (preferredGw && preferredGw !== ctx.gatewayId) {
    const reason = 'device_switching_gateway';
    return {
      record: { accepted: false, reason },
      reply: { type: FINDME_OFFER_TYPE, device_uid: deviceUid, gateway_id: ctx.gatewayId, accept: false, reason },
    };
  }

  const denied = Boolean(deviceUid && ctx.isDenied(deviceUid));
  if (!denied && deviceUid && ctx.isReleased?.(deviceUid)) {
    // Released here: say so (accept:false, like a denied device) so the
    // device stops coming back to this host and picks another.
    const released = offerPayload(ctx, true, '');
    Object.assign(released, { reason: DEVICE_RELEASED_REASON, cooldown_ms: DENIED_COOLDOWN_MS });
    released.type = FINDME_OFFER_TYPE;
    released.device_uid = deviceUid;
    return { record: { accepted: false, reason: DEVICE_RELEASED_REASON }, reply: released };
  }
  const managedPolicy = ctx.offerPolicy === 'managed';
  if (managedPolicy && !denied && !(deviceUid && ctx.isManaged?.(deviceUid))) {
    // Not ours to take: remembered as nearby (the UI offers to adopt it), never offered.
    return { record: { accepted: false, reason: DEVICE_UNMANAGED_REASON }, reply: null };
  }
  const priority = managedPolicy ? Math.max(ctx.priority, MANAGED_OFFER_PRIORITY) : ctx.priority;
  const reason = denied ? 'device_rejected' : '';
  const claim = deviceUid && !denied ? ctx.activeClaim(deviceUid) : null;
  let claimId = strOr((claim ?? {}).claim_id);
  // As the preferred Gateway, mirror the device's own claim_id even when our
  // claim record is gone or the Backend marked it failed: the firmware only
  // completes the switch when offer.claim_id equals the claim it is following.
  if (!claimId && preferredGw === ctx.gatewayId && discoverClaimId && !denied) claimId = discoverClaimId;
  const reply = offerPayload(ctx, denied, claimId, priority);
  if (claimId) reply.claim_id = claimId;
  if (denied) Object.assign(reply, { reason, cooldown_ms: DENIED_COOLDOWN_MS });
  reply.type = FINDME_OFFER_TYPE;
  reply.device_uid = deviceUid;
  return { record: { accepted: !denied, reason }, reply };
}

export interface DiscoveryResponderOptions {
  socket: UdpSocket;
  clock: Clock;
  gatewayId: string;
  gatewayName?: string;
  priority?: number;
  /** The bound stream port, or a getter for it (the host may bind port 0). */
  udpPort: number | (() => number);
  /** The configured FindMe port the probe is broadcast to (Python's self.port). */
  discoveryPort: number;
  upstreamStatus?: () => string;
  isDenied?: (deviceUid: string) => boolean;
  activeClaim?: (deviceUid: string) => Dict | null;
  onRequest?: FindmeRequestRecorder;
  /** Read per request (the policy can change at run time). Default: "all". */
  offerPolicy?: () => OfferPolicy;
  isManaged?: (deviceUid: string) => boolean;
  isReleased?: (deviceUid: string) => boolean;
}

/** discovery.DiscoveryResponder without the socket thread. */
export class DiscoveryResponder {
  gatewayId: string;
  gatewayName: string;
  priority: number;
  readonly discoveryPort: number;
  /** Set by the runtime when the host has (un)bound the FindMe socket; probes need it. */
  started = false;
  lastError = '';

  private readonly socket: UdpSocket;
  private readonly clock: Clock;
  private readonly udpPort: number | (() => number);
  private readonly upstreamStatus: () => string;
  private readonly isDenied: (deviceUid: string) => boolean;
  private readonly activeClaim: (deviceUid: string) => Dict | null;
  private readonly onRequest: FindmeRequestRecorder | undefined;
  private readonly offerPolicy: () => OfferPolicy;
  private readonly isManaged: (deviceUid: string) => boolean;
  private readonly isReleased: (deviceUid: string) => boolean;

  constructor(options: DiscoveryResponderOptions) {
    this.socket = options.socket;
    this.clock = options.clock;
    this.gatewayId = options.gatewayId;
    this.gatewayName = options.gatewayName ?? 'NH Gateway';
    this.priority = pyInt(options.priority ?? 100);
    this.udpPort = options.udpPort;
    this.discoveryPort = pyInt(options.discoveryPort);
    this.upstreamStatus = options.upstreamStatus ?? (() => 'online');
    this.isDenied = options.isDenied ?? (() => false);
    this.activeClaim = options.activeClaim ?? (() => null);
    this.onRequest = options.onRequest;
    this.offerPolicy = options.offerPolicy ?? (() => 'all');
    this.isManaged = options.isManaged ?? (() => false);
    this.isReleased = options.isReleased ?? (() => false);
  }

  private currentUdpPort(): number {
    return pyInt(typeof this.udpPort === 'function' ? this.udpPort() : this.udpPort);
  }

  context(): FindmeContext {
    return {
      gatewayId: this.gatewayId,
      gatewayName: this.gatewayName,
      priority: this.priority,
      udpPort: this.currentUdpPort(),
      upstreamStatus: this.upstreamStatus(),
      isDenied: this.isDenied,
      activeClaim: this.activeClaim,
      nowMs: this.clock.nowMs(),
      offerPolicy: this.offerPolicy(),
      isManaged: this.isManaged,
      isReleased: this.isReleased,
    };
  }

  /** One datagram received on the FindMe port. Returns what was decided (null: not a discover request). */
  handleDatagram(data: Uint8Array, from: Address): FindmeDecision | null {
    const request = decodeFindmeRequest(data);
    if (request === null) return null;
    const decision = decideFindme(request, this.context());
    if (decision.record !== null && this.onRequest !== undefined) {
      this.onRequest(request, from, decision.record.accepted, decision.record.reason);
    }
    if (decision.reply !== null) {
      try {
        this.socket.send(utf8Encode(pyJsonDumpsCompact(decision.reply)), from);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return decision;
  }

  /**
   * Broadcast a findme_probe so attached devices announce themselves. Python
   * never set SO_BROADCAST, so its probe failed with EACCES and never left the
   * host; UdpSocket.broadcast has the host enable it.
   */
  sendProbe(): void {
    if (!this.started) return;
    const packet = utf8Encode(
      pyJsonDumpsCompact({
        type: FINDME_PROBE_TYPE,
        gateway_id: this.gatewayId,
        gateway_name: this.gatewayName,
        udp_port: this.currentUdpPort(),
      }),
    );
    try {
      if (this.socket.broadcast) this.socket.broadcast(packet, this.discoveryPort);
      else this.socket.send(packet, { ip: '255.255.255.255', port: this.discoveryPort });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }
}
