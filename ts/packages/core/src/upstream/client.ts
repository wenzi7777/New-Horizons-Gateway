// The Gateway's upstream WebSocket link to the Desktop Backend
// (upstream_wss.py + queueing.py).
//
// Python ran a connect/receive thread and a send thread that blocked on the
// socket. Here there are no threads and no timers: the host's WsConnector
// delivers open/message/close events, and the host calls service() from its
// main loop (Python's loop ticks every 0.5 s) to retry connections and resume
// a stalled drain. What the Backend sees is kept identical:
//
//  - hello is the first frame on every connection;
//  - queued control messages always go out before any queued sensor packet;
//  - while disconnected, sensor packets drop oldest beyond 32 and control
//    messages drop oldest beyond 512, with only the newest gateway_status kept;
//  - a failed control send puts that message back and reconnects, a failed
//    packet send drops the packet and reconnects;
//  - reconnects back off 1 s, 2 s, 4 s, 8 s, 10 s, 10 s ... and reset once a
//    connection opens.
//
// Sending: every enqueue is followed by drain(), which sends while the link
// is open. JS WebSocket.send never blocks, so in the normal case the queues are
// empty and messages go straight through in call order. Python's natural
// backpressure (a blocking send while the data queue keeps dropping oldest) is
// reproduced when the connection exposes `bufferedAmount` (browser/RN
// WebSocket and the `ws` package all do): above `maxBufferedBytes` the drain
// pauses, the queues fill and drop as in Python, and service() resumes it.
import { bytesToBase64, utf8Decode, utf8Encode } from '../bytes';
import { stringifyKeepFloats } from '../floatJson';
import type { Json, UpstreamCallbacks, UpstreamLink } from '../contracts';
import type { Clock, Logger, WsConnection, WsConnector } from '../ports';
import { silentLogger } from '../ports';
import { isPlainObject, pyInt, pyStr, pyStrip, pyTruthy } from '../py';
import { pyIsoUtcFromEpochUs } from './pyIso';
import { ControlQueue, DropOldestQueue } from './queues';

export const PACKET_TEXT_PREFIX = 'NHPKT1:';
import { CAPABILITIES } from '../contracts';
export { CAPABILITIES };
export const DEFAULT_DATA_QUEUE_SIZE = 32;
export const DEFAULT_CONTROL_QUEUE_SIZE = 512;
export const RECONNECT_BACKOFF_INITIAL_MS = 1_000;
export const RECONNECT_BACKOFF_MAX_MS = 10_000;
/** websocket.create_connection(timeout=10): a handshake that never finishes counts as a failure. */
export const CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const RATE_WINDOW_MS = 1_000;

const DEVICE_MESSAGE_TYPES: Record<string, string> = {
  hello: 'device_hello',
  status: 'device_status',
  update_progress: 'device_update_progress',
  result: 'device_result',
};

export interface UpstreamClientOptions {
  serverUrl: string;
  gatewayId: string;
  /** Gateway version announced in hello (Python's __version__). */
  version: string;
  /** Host platform announced in hello, e.g. "darwin-arm64" or "android" (new in the TS Gateway). */
  platform: string;
  connector: WsConnector;
  clock: Clock;
  callbacks: UpstreamCallbacks;
  /**
   * Sent as "Authorization: Bearer <token>" when non-empty (an NH Studio app
   * token). A function is read at every connection attempt, so a token that
   * belongs to one server follows the config without extra calls.
   */
  authToken?: string | (() => string);
  updateChannel?: string;
  dataQueueSize?: number;
  controlQueueSize?: number;
  /** Pause draining while the connection's bufferedAmount exceeds this. */
  maxBufferedBytes?: number;
  logger?: Logger;
  /** hello's client_type: "gateway" (default), "studio" or "pocket". */
  clientType?: string;
}

type ControlMessage = Json & { type: string };

/** One connection attempt; stale events from an earlier attempt are ignored by identity. */
interface Attempt {
  ws: WsConnection | null;
  startedAtMs: number;
  opened: boolean;
  /** onOpen fired synchronously inside connect(), before `ws` was known. */
  openPending: boolean;
}

export class UpstreamClient implements UpstreamLink {
  serverUrl: string;
  gatewayId: string;
  private authTokenSource: () => string;
  /** Sent in hello so the Backend answers with this channel's latest version (gateway_hello_ack). */
  updateChannel: string;
  lastError = '';
  private loggedConnectError = '';
  lastConnectedAt = '';

  readonly dataQueue: DropOldestQueue<Uint8Array>;
  readonly controlQueue: ControlQueue<ControlMessage>;

  private readonly version: string;
  private readonly platform: string;
  private readonly connector: WsConnector;
  private readonly clock: Clock;
  private readonly callbacks: UpstreamCallbacks;
  private readonly maxBufferedBytes: number;
  private readonly logger: Logger;
  private readonly clientType: string;

  private running = false;
  private connected = false;
  private attempt: Attempt | null = null;
  private backoffMs = RECONNECT_BACKOFF_INITIAL_MS;
  private reconnectAtMs: number | null = null;
  private draining = false;

  private dataEnqueued = 0;
  private dataSent = 0;
  private dataEnqueueWindow: number[] = [];
  private dataSentWindow: number[] = [];

  constructor(options: UpstreamClientOptions) {
    this.serverUrl = options.serverUrl;
    this.gatewayId = options.gatewayId;
    const token = options.authToken ?? '';
    this.authTokenSource = typeof token === 'function' ? token : () => token;
    this.updateChannel = options.updateChannel ?? 'stable';
    this.version = options.version;
    this.platform = options.platform;
    this.connector = options.connector;
    this.clock = options.clock;
    this.callbacks = options.callbacks;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.logger = options.logger ?? silentLogger;
    this.clientType = options.clientType ?? 'gateway';
    this.dataQueue = new DropOldestQueue(options.dataQueueSize ?? DEFAULT_DATA_QUEUE_SIZE);
    this.controlQueue = new ControlQueue(options.controlQueueSize ?? DEFAULT_CONTROL_QUEUE_SIZE);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    // A fresh run starts its backoff over, as Python's new _run thread did.
    this.backoffMs = RECONNECT_BACKOFF_INITIAL_MS;
    this.reconnectAtMs = null;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.reconnectAtMs = null;
    this.endAttempt(null);
  }

  /** Host tick: retries a due reconnect, times out a stuck handshake, resumes a paused drain. */
  service(): void {
    if (!this.running) return;
    const now = this.clock.monotonicMs();
    const attempt = this.attempt;
    if (attempt && !attempt.opened && now - attempt.startedAtMs >= CONNECT_TIMEOUT_MS) {
      this.endAttempt('timed out');
      return;
    }
    if (!attempt && this.reconnectAtMs !== null && now >= this.reconnectAtMs) {
      this.reconnectAtMs = null;
      this.connect();
      return;
    }
    this.drain();
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** main.apply_runtime_config assigns upstream.gateway_id; UpstreamLink only exposes it read-only. */
  setGatewayId(gatewayId: string): void {
    this.gatewayId = gatewayId;
  }

  updateServer(serverUrl: string, authToken?: string): void {
    this.serverUrl = serverUrl;
    if (authToken !== undefined) this.authTokenSource = () => authToken;
    this.disconnectCurrent();
  }

  setUpdateChannel(channel: string): void {
    if (channel === this.updateChannel) return;
    this.updateChannel = channel;
    try {
      this.sendJson(this.helloPayload());
    } catch {
      // Not connected: the next connection's hello carries it.
    }
  }

  // ── outgoing ───────────────────────────────────────────────────────────

  sendDeviceMessage(msgType: string, payload: Json): void {
    this.putControl({
      type: DEVICE_MESSAGE_TYPES[msgType] ?? 'device_status',
      gateway_id: this.gatewayId,
      device_uid: 'device_uid' in payload ? payload.device_uid : '',
      payload,
    });
  }

  sendGatewayStatus(payload: Json): void {
    this.putControl({ type: 'gateway_status', gateway_id: this.gatewayId, payload }, 'gateway_status');
  }

  sendGatewayCommandResult(requestId: string, result: Json): void {
    this.putControl({
      type: 'gateway_command_result',
      gateway_id: this.gatewayId,
      request_id: pyTruthy(requestId) ? pyStr(requestId) : '',
      result: { ...result },
    });
  }

  sendClaimRequest(deviceUid: string, claimId: string, ttlMs: number): void {
    this.putControl({
      type: 'gateway_claim_request',
      gateway_id: this.gatewayId,
      device_uid: pyStrip(pyTruthy(deviceUid) ? pyStr(deviceUid) : '').toUpperCase(),
      claim_id: pyTruthy(claimId) ? pyStr(claimId) : '',
      ttl_ms: pyInt(pyTruthy(ttlMs) ? ttlMs : 30000),
    });
  }

  sendPacket(packet: Uint8Array): void {
    this.dataQueue.put(packet);
    this.noteDataEnqueued();
    this.drain();
  }

  status(): Json {
    const now = this.clock.monotonicMs();
    purgeRateWindow(this.dataEnqueueWindow, now);
    purgeRateWindow(this.dataSentWindow, now);
    return {
      server_url: this.serverUrl,
      connected: this.isConnected(),
      last_error: this.lastError,
      last_connected_at: this.lastConnectedAt,
      data_queue_size: this.dataQueue.qsize(),
      data_queue_dropped: this.dataQueue.dropped,
      data_packets_enqueued: this.dataEnqueued,
      data_packets_sent: this.dataSent,
      udp_in_fps: this.dataEnqueueWindow.length,
      upstream_sent_fps: this.dataSentWindow.length,
      control_queue_size: this.controlQueue.qsize(),
    };
  }

  helloPayload(): Json {
    return {
      type: 'hello',
      gateway_id: this.gatewayId,
      version: this.version,
      update_channel: this.updateChannel,
      // Tells the Backend what kind of relay this is ("gateway"; a Hub sends
      // "hub", NH Studio / NH Pocket their own) and that it takes Desktop
      // management commands.
      client_type: this.clientType,
      capabilities: [...CAPABILITIES],
      connected_at: pyIsoUtcFromEpochUs(this.clock.nowEpochUs()),
      platform: this.platform,
    };
  }

  private putControl(message: ControlMessage, coalesceType = ''): void {
    if (!('gateway_id' in message)) message.gateway_id = this.gatewayId;
    this.controlQueue.put(message, coalesceType);
    this.drain();
  }

  /** _send_loop without the thread: control first, then data, until empty, closed or congested. */
  private drain(): void {
    if (this.draining) return; // re-entered from a callback; the outer loop picks new items up
    this.draining = true;
    try {
      while (this.connected && !this.congested()) {
        const control = this.controlQueue.get();
        if (control !== undefined) {
          try {
            this.sendJson(control);
          } catch (exc) {
            this.lastError = errorText(exc);
            this.controlQueue.put(control);
            this.disconnectCurrent();
            break;
          }
          continue;
        }
        const packet = this.dataQueue.get();
        if (packet === undefined) break;
        try {
          this.sendPacketText(packet);
          this.noteDataSent();
        } catch (exc) {
          // Sensor data is lossy by design: drop this packet and reconnect.
          this.lastError = errorText(exc);
          this.disconnectCurrent();
          break;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private congested(): boolean {
    const buffered = (this.attempt?.ws as { bufferedAmount?: unknown } | null | undefined)?.bufferedAmount;
    return typeof buffered === 'number' && buffered > this.maxBufferedBytes;
  }

  private sendJson(payload: Json): void {
    const ws = this.connected ? this.attempt?.ws : null;
    if (!ws) throw new Error('upstream_not_connected');
    // Device floats (JsonFloat) go out as Python's json.dumps wrote them.
    ws.send(stringifyKeepFloats(payload));
  }

  private sendPacketText(packet: Uint8Array): void {
    const ws = this.connected ? this.attempt?.ws : null;
    if (!ws) throw new Error('upstream_not_connected');
    ws.send(PACKET_TEXT_PREFIX + bytesToBase64(packet));
  }

  // ── connection ─────────────────────────────────────────────────────────

  private connect(): void {
    const headers: Record<string, string> = {};
    const authToken = this.authTokenSource();
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const attempt: Attempt = { ws: null, startedAtMs: this.clock.monotonicMs(), opened: false, openPending: false };
    this.attempt = attempt;
    let ws: WsConnection;
    try {
      ws = this.connector.connect(this.serverUrl, headers, {
        onOpen: () => {
          if (this.attempt !== attempt) return;
          if (attempt.ws === null) attempt.openPending = true;
          else this.handleOpen(attempt);
        },
        onMessage: (data) => {
          if (this.attempt === attempt && attempt.opened) this.handleIncoming(data);
        },
        onClose: (reason) => {
          if (this.attempt === attempt) this.endAttempt(reason || 'connection_closed');
        },
        onError: (message) => {
          if (this.attempt === attempt) this.endAttempt(message || 'connection_error');
        },
      });
    } catch (exc) {
      if (this.attempt === attempt) this.endAttempt(errorText(exc));
      return;
    }
    if (this.attempt !== attempt) {
      // Failed synchronously inside connect(); nothing else holds this socket.
      safeClose(ws);
      return;
    }
    attempt.ws = ws;
    if (attempt.openPending) this.handleOpen(attempt);
  }

  private handleOpen(attempt: Attempt): void {
    attempt.opened = true;
    this.connected = true;
    this.lastError = '';
    this.loggedConnectError = '';
    this.lastConnectedAt = pyIsoUtcFromEpochUs(this.clock.nowEpochUs());
    this.backoffMs = RECONNECT_BACKOFF_INITIAL_MS;
    try {
      this.sendJson(this.helloPayload());
    } catch (exc) {
      this.endAttempt(errorText(exc));
      return;
    }
    this.logger.info(`upstream connected: ${this.serverUrl}`);
    this.notifyConnection(true);
    this.drain();
  }

  /** _receive_loop body: `command` goes to onCommand, every other JSON object to onMessage. */
  private handleIncoming(raw: string | Uint8Array): void {
    let message: unknown;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : strictUtf8Decode(raw));
    } catch {
      return;
    }
    if (!isPlainObject(message)) return;
    try {
      if (message.type === 'command') {
        const payload = isPlainObject(message.payload) ? message.payload : {};
        const uidSource = pyTruthy(message.device_uid) ? message.device_uid : payload.device_uid;
        const deviceUid = pyTruthy(uidSource) ? pyStr(uidSource) : '';
        this.callbacks.onCommand(deviceUid, { ...payload });
        return;
      }
      this.callbacks.onMessage({ ...message });
    } catch (exc) {
      // Python let a callback exception escape the receive loop, which ended
      // the connection and reconnected; kept so the failure stays visible.
      this.logger.error(`upstream message handler failed: ${errorText(exc)}`);
      this.endAttempt(errorText(exc));
    }
  }

  /** Python's _disconnect_current(): close now; the reconnect follows the usual backoff. */
  private disconnectCurrent(): void {
    if (this.attempt) this.endAttempt(null);
  }

  /** The `finally` of Python's _run plus its backoff sleep, as a scheduled reconnect. */
  private endAttempt(error: string | null): void {
    const attempt = this.attempt;
    const wasConnected = this.connected;
    this.attempt = null;
    this.connected = false;
    if (error !== null) this.lastError = error;
    if (attempt?.ws) safeClose(attempt.ws);
    if (attempt && this.running) {
      this.reconnectAtMs = this.clock.monotonicMs() + this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
    }
    if (wasConnected) {
      this.logger.warn(`upstream disconnected${error ? `: ${error}` : ''}`);
      this.notifyConnection(false);
    } else if (error && error !== this.loggedConnectError) {
      // Failed attempts used to show up only in status().last_error; log each
      // distinct reason once (retries every 1-10 s would flood the log).
      this.loggedConnectError = error;
      this.logger.warn(`upstream connect failed: ${error}`);
    }
  }

  private notifyConnection(connected: boolean): void {
    try {
      this.callbacks.onConnectionChange?.(connected);
    } catch (exc) {
      this.logger.error(`onConnectionChange failed: ${errorText(exc)}`);
    }
  }

  // ── rates ──────────────────────────────────────────────────────────────

  private noteDataEnqueued(): void {
    const now = this.clock.monotonicMs();
    this.dataEnqueued += 1;
    this.dataEnqueueWindow.push(now);
    purgeRateWindow(this.dataEnqueueWindow, now);
  }

  private noteDataSent(): void {
    const now = this.clock.monotonicMs();
    this.dataSent += 1;
    this.dataSentWindow.push(now);
    purgeRateWindow(this.dataSentWindow, now);
  }
}

/** Entries older than one second fall out, so the window length is the per-second rate. */
function purgeRateWindow(window: number[], now: number): void {
  const cutoff = now - RATE_WINDOW_MS;
  let drop = 0;
  while (drop < window.length && window[drop]! < cutoff) drop++;
  if (drop) window.splice(0, drop);
}

/** bytes.decode("utf-8") raised on invalid input, so such a frame was skipped, not mangled. */
function strictUtf8Decode(bytes: Uint8Array): string {
  const text = utf8Decode(bytes);
  if (text.includes('�')) {
    const roundTrip = utf8Encode(text);
    if (roundTrip.length !== bytes.length || roundTrip.some((b, i) => b !== bytes[i])) throw new Error('invalid utf-8');
  }
  return text;
}

function safeClose(ws: WsConnection): void {
  try {
    ws.close();
  } catch {
    // Already closed or never opened.
  }
}

function errorText(exc: unknown): string {
  return exc instanceof Error ? exc.message : pyStr(exc);
}
