// The Gateway runtime (main.py's run()) as a class the host drives. It owns
// no socket, timer or file: the host binds the UDP sockets and hands every
// datagram to onUdpPacket / onFindmePacket, calls tick() every 0.5 s (Python's
// main loop period), and gets told through GatewayHostHooks which services
// should be running. The upstream link, the updater and the auto-applier are
// built by injected factories against the interfaces in contracts.ts.
import type { GatewayConfig, GatewayConfigStore } from '../config';
import type { AutoApplier, Json, UpdateControl, UpstreamCallbacks, UpstreamLink } from '../contracts';
import type { Address, Clock, Logger, UdpSocket } from '../ports';
import { silentLogger } from '../ports';
import { decodeJsonLine, isHeartbeatPacket, isStreamPacket, looseDeviceUid, normalizeDeviceUid } from '../protocol';
import { isPlainObject, pyInt, pyStr, pyTruthy } from '../py';
import { RESULT_CHUNK_TYPE, ResultChunkReassembler } from '../resultChunks';
import { parseJsonKeepFloats } from '../floatJson';
import { buildTimeResponse, isTimeRequest } from '../time';
import { PROTOCOL } from '../wire';
import { DiscoveryResponder, NON_OWNER_OFFER_DELAY_MS } from './discovery';
import { GatewayOperations } from './operations';
import { type Dict, dictOr, looksLikeJson, pyGet, pyOr, setDefault, strOr } from './pyCompat';
import { GatewayCommandHandler } from './remoteCommands';
import { GatewayState } from './state';
import { UdpCommandDispatcher } from './udpCommands';

export type HostPlatform = 'darwin' | 'win32' | 'linux' | 'android';

/** main.py's loop period; hosts call tick() at this rate. */
export const TICK_INTERVAL_MS = 500;
export const GATEWAY_STATUS_INTERVAL_MS = 5000;
/** The update check never runs more often than this, whatever the updater says. */
export const MIN_UPDATE_CHECK_INTERVAL_MS = 60_000;

/** Device JSON control frames the Gateway relays upstream as device_<type>. */
const RELAYED_CONTROL_TYPES = ['hello', 'status', 'update_progress', 'result'];

/** What the upstream factory needs to build a link (Python's UpstreamWSSClient constructor). */
export interface UpstreamParams {
  serverUrl: string;
  gatewayId: string;
  updateChannel: string;
}

/** Which host services should be running (Python started/stopped these in apply_runtime_config). */
export interface ServiceSet {
  /** The stream/control socket (listen_udp_host:listen_udp_port, 13250). */
  udp: boolean;
  /** The FindMe socket (listen_discovery_host:listen_discovery_port, 22346); always false when discovery is disabled. */
  discovery: boolean;
}

export interface GatewayHostHooks {
  /**
   * Bind or close the UDP sockets. Called when the Gateway is enabled or
   * disabled (and on stop()); the runtime starts/stops the upstream link
   * itself. While a service is off the runtime ignores its datagrams.
   */
  setServicesRunning?(services: ServiceSet): void | Promise<void>;
  /** The actually bound ports (the config may say 0); default: the configured ones. */
  boundUdpPort?(): number;
  boundDiscoveryPort?(): number;
  /**
   * The updater asked for a restart (soft restart, or switching to a staged
   * update). The host stops this runtime and starts the next one; Python's
   * main() did that by re-running run().
   */
  requestRestart?(): void;
  /** Python wrote this to .run/console-status.json for the console/TUI; same fields. */
  publishConsoleStatus?(status: Json): void;
}

/** How the runtime treated a binary datagram (GatewayRuntimeObserver.onDevicePacket). */
export interface DevicePacketInfo {
  kind: 'stream' | 'heartbeat' | 'other';
  /** The device's session/roster was updated from it (it is attached here). */
  attached: boolean;
  /** It was relayed upstream. */
  forwarded: boolean;
}

/**
 * Lets an engine built on the runtime (NH Studio / NH Pocket's device
 * service) see what the runtime handles, and take over Backend commands.
 * Every method is optional and called after the runtime did its own work;
 * a throwing observer is logged, never breaks the runtime.
 */
export interface GatewayRuntimeObserver {
  /** A device JSON frame (hello/status/update_progress/result, chunks joined) as relayed upstream as device_<type>. */
  onDeviceMessage?(messageType: string, data: Json, from: Address): void;
  /**
   * Every JSON datagram on the stream port from a device that is not denied
   * (result_chunk pieces and acks included), byte for byte, after the runtime
   * handled it: an engine re-reads it with Python's float semantics.
   * `deviceUid` is the frame's own (for a chunk, the piece's).
   */
  onControlDatagram?(deviceUid: string, datagram: Uint8Array, from: Address): void;
  /** A binary datagram on the stream port from a (non-denied) device. */
  onDevicePacket?(deviceUid: string, packet: Uint8Array, from: Address, info: DevicePacketInfo): void;
  /** A FindMe discover request and what was decided (after the state recorded it). */
  onFindmeRequest?(request: Json, from: Address, accepted: boolean, reason: string): void;
  /**
   * A not-yet-expired `command` from the Backend. Return true when handled:
   * the runtime then sends nothing itself (the observer answers upstream).
   */
  onUpstreamCommand?(deviceUid: string, payload: Json): boolean;
  /** A command the device never acked (after the runtime reported it upstream). */
  onDeliveryTimeout?(deviceUid: string, payload: Json): void;
}

export interface GatewayRuntimeOptions {
  configStore: GatewayConfigStore;
  clock: Clock;
  /** The 13250 socket: time replies and device commands go out on it. */
  streamSocket: UdpSocket;
  /** The 22346 socket: FindMe offers and the probe broadcast go out on it. */
  findmeSocket: UdpSocket;
  /** Builds the upstream link; called again when the Gateway ID changes (UpstreamLink.gatewayId is read-only). */
  createUpstream(params: UpstreamParams, callbacks: UpstreamCallbacks): UpstreamLink;
  updateControl: UpdateControl;
  /** `isIdle` is true while no device is being served. */
  createAutoApplier(isIdle: () => boolean): AutoApplier;
  /** Reported upstream in gateway_status.platform. */
  platform: HostPlatform;
  host?: GatewayHostHooks;
  logger?: Logger;
  /** Claim IDs (uuid4 hex by default). */
  newClaimId?: () => string;
  /** See GatewayRuntimeObserver; also settable later with setObserver(). */
  observer?: GatewayRuntimeObserver;
  /** How long a partial chunked result is kept (default 10 s, the Gateway's; the Desktop Backend used 30 s). */
  resultChunkTtlMs?: number;
  /** FindMe: how much later a host the device does not stream to answers (default NON_OWNER_OFFER_DELAY_MS; 0 = at once). */
  findmeNonOwnerDelayMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GatewayRuntime {
  readonly configStore: GatewayConfigStore;
  readonly clock: Clock;
  readonly state: GatewayState;
  readonly udpCommands: UdpCommandDispatcher;
  readonly resultChunks: ResultChunkReassembler;
  /** null when discovery_enabled was off at construction (Python decided this once, at startup). */
  readonly discovery: DiscoveryResponder | null;
  readonly commandHandler: GatewayCommandHandler;
  readonly autoApplier: AutoApplier;
  readonly updateControl: UpdateControl;
  readonly platform: HostPlatform;
  /** Set when the updater asked for a restart; the host acts on it. */
  restartRequested = false;

  private upstreamLink: UpstreamLink;
  private readonly options: GatewayRuntimeOptions;
  private readonly host: GatewayHostHooks;
  private readonly logger: Logger;
  private readonly streamSocket: UdpSocket;
  private readonly upstreamCallbacks: UpstreamCallbacks;
  /** device uid -> IP of its last accepted stream/heartbeat packet. */
  private readonly arduinoHosts = new Map<string, string>();
  private runtimeStarted = false;
  private stopped = false;
  private lastGatewayStatusAt: number | null = null;
  private lastUpdateCheckAt: number | null = null;
  private updateCheck: Promise<void> | null = null;
  private observer: GatewayRuntimeObserver;

  constructor(options: GatewayRuntimeOptions) {
    this.options = options;
    this.configStore = options.configStore;
    this.clock = options.clock;
    this.host = options.host ?? {};
    this.logger = options.logger ?? silentLogger;
    this.platform = options.platform;
    this.updateControl = options.updateControl;
    this.streamSocket = options.streamSocket;
    this.observer = options.observer ?? {};
    const config = this.configStore.snapshot();

    this.state = new GatewayState({
      clock: this.clock,
      controlStaleSec: Number(pyGet(config, 'control_stale_sec', 16.0)),
      ...(options.newClaimId ? { newClaimId: options.newClaimId } : {}),
    });
    this.resultChunks = new ResultChunkReassembler({
      nowMs: () => this.clock.monotonicMs(),
      parse: parseJsonKeepFloats,
      ...(options.resultChunkTtlMs !== undefined ? { ttlMs: options.resultChunkTtlMs } : {}),
    });
    this.upstreamCallbacks = {
      onCommand: (deviceUid, payload) => this.onCommand(deviceUid, payload),
      onMessage: (message) => this.onUpstreamMessage(message),
    };
    this.upstreamLink = options.createUpstream(
      {
        serverUrl: pyStr(config.server_url),
        gatewayId: pyStr(config.gateway_id),
        updateChannel: strOr(config.update_channel) || 'stable',
      },
      this.upstreamCallbacks,
    );
    this.udpCommands = new UdpCommandDispatcher({
      send: (data, to) => this.streamSocket.send(data, to),
      clock: this.clock,
      onDeliveryTimeout: (uid, payload) => this.onUdpDeliveryTimeout(uid, payload),
    });
    this.discovery = pyTruthy(config.discovery_enabled)
      ? new DiscoveryResponder({
          socket: options.findmeSocket,
          clock: this.clock,
          gatewayId: pyStr(config.gateway_id),
          gatewayName: pyStr(config.gateway_name),
          priority: pyInt(config.discovery_priority),
          udpPort: () => this.boundUdpPort(),
          discoveryPort: pyInt(config.listen_discovery_port),
          upstreamStatus: () => (this.upstreamLink.isConnected() ? 'online' : 'offline'),
          isDenied: (uid) => this.configStore.isDenied(uid),
          activeClaim: (uid) => this.state.activeClaimFor(uid),
          onRequest: (payload, addr, accepted, reason) => {
            this.state.recordFindmeRequest(payload, addr, accepted, reason);
            this.notify('findme', (o) => o.onFindmeRequest?.(payload, addr, accepted, reason));
          },
          offerPolicy: () => this.configStore.offerPolicy(),
          isManaged: (uid) => this.configStore.isManaged(uid),
          isReleased: (uid) => this.configStore.isReleased(uid),
          // The host the device streams to answers first and keeps it (see NON_OWNER_OFFER_DELAY_MS).
          isServing: (uid) => this.state.isServing(uid),
          nonOwnerDelayMs: options.findmeNonOwnerDelayMs ?? NON_OWNER_OFFER_DELAY_MS,
        })
      : null;

    this.updateControl.setRestartCallback(() => {
      // Ends this run; the host decides how to come back (Python's restart_event).
      this.restartRequested = true;
      this.host.requestRestart?.();
    });
    this.autoApplier = options.createAutoApplier(() => this.state.servingCount() === 0);
    this.commandHandler = new GatewayCommandHandler({
      operations: () => this.operations(),
      sendResult: (requestId, result) => this.upstreamLink.sendGatewayCommandResult(requestId, result),
      restart: () => this.updateControl.restart(),
      updateBlock: () => this.updateBlock(),
      afterCommand: () => this.pushStatusSoon(),
      clock: this.clock,
      logger: this.logger,
    });
  }

  /** Replaces the observer (an engine attaches after building on the runtime). */
  setObserver(observer: GatewayRuntimeObserver | null): void {
    this.observer = observer ?? {};
  }

  private notify(what: string, fn: (observer: GatewayRuntimeObserver) => void): void {
    this.guard(`observer ${what}`, () => fn(this.observer));
  }

  /** The current upstream link (replaced when the Gateway ID changes). */
  get upstream(): UpstreamLink {
    return this.upstreamLink;
  }

  /** Whether the Gateway is enabled and its services are up. */
  get running(): boolean {
    return this.runtimeStarted;
  }

  /** Operations for the host's web UI; the same ones remote commands use. */
  operations(): GatewayOperations {
    return new GatewayOperations({
      configStore: this.configStore,
      state: this.state,
      upstream: this.upstreamLink,
      udpControl: this.udpCommands,
      discovery: this.discovery,
      updateControl: this.updateControl,
      onConfigSaved: (config) => this.applyRuntimeConfig(config),
    });
  }

  /** Applies the saved config and starts the services if enabled. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.applyRuntimeConfig(this.configStore.snapshot());
  }

  /** Stops every service (Python's finally block). The host then drops this runtime. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.discovery !== null) this.discovery.started = false;
    this.runtimeStarted = false;
    await this.host.setServicesRunning?.({ udp: false, discovery: false });
    this.upstreamLink.stop();
  }

  /** apply_runtime_config: called at start and after every config save. */
  async applyRuntimeConfig(config: GatewayConfig): Promise<void> {
    const gatewayId = strOr(config.gateway_id);
    const channel = strOr(config.update_channel) || 'stable';
    let startNewLink = false;
    if (gatewayId !== this.upstreamLink.gatewayId) {
      // Python assigned upstream.gateway_id and reconnected (update_server);
      // with a read-only gatewayId the link is rebuilt instead.
      const wasRunning = this.runtimeStarted;
      if (wasRunning) this.upstreamLink.stop();
      this.upstreamLink = this.options.createUpstream(
        { serverUrl: pyStr(config.server_url), gatewayId, updateChannel: channel },
        this.upstreamCallbacks,
      );
      startNewLink = wasRunning;
    }
    this.updateControl.setChannel(channel);
    this.upstreamLink.setUpdateChannel(channel);
    this.upstreamLink.updateServer(pyStr(config.server_url));
    if (this.discovery !== null) {
      this.discovery.gatewayId = gatewayId;
      this.discovery.gatewayName = strOr(config.gateway_name) || 'NH Gateway';
      this.discovery.priority = pyInt(pyGet(config, 'discovery_priority', 100));
    }
    const shouldRun = pyTruthy(config.enabled) && !this.stopped;
    if (shouldRun && !this.runtimeStarted) {
      this.upstreamLink.start();
      await this.host.setServicesRunning?.({ udp: true, discovery: this.discovery !== null });
      if (this.discovery !== null) this.discovery.started = true;
      this.runtimeStarted = true;
    } else if (!shouldRun && this.runtimeStarted) {
      if (this.discovery !== null) this.discovery.started = false;
      await this.host.setServicesRunning?.({ udp: false, discovery: false });
      this.upstreamLink.stop();
      this.runtimeStarted = false;
    } else if (startNewLink) {
      this.upstreamLink.start();
    }
    this.publishConsoleStatus(config);
  }

  // -- the main loop ---------------------------------------------------------

  /** One pass of main.py's loop; the host calls it every TICK_INTERVAL_MS. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.clock.monotonicMs();
    if (this.lastGatewayStatusAt === null || now - this.lastGatewayStatusAt >= GATEWAY_STATUS_INTERVAL_MS) {
      this.lastGatewayStatusAt = now;
      const config = this.configStore.snapshot();
      this.guard('gateway_status', () => this.upstreamLink.sendGatewayStatus(this.gatewayStatus(config)));
      this.publishConsoleStatus(config);
    }
    const checkInterval = Math.max(MIN_UPDATE_CHECK_INTERVAL_MS, this.updateControl.autoCheckIntervalMs);
    if (this.lastUpdateCheckAt === null || now - this.lastUpdateCheckAt >= checkInterval) {
      this.lastUpdateCheckAt = now;
      this.startUpdateCheck();
    }
    this.guard('auto_applier', () => this.autoApplier.service());
    // Python let an exception here (e.g. from the timeout callback's upstream
    // send) escape and end the main loop; one bad tick must not stop the Gateway.
    this.guard('udp_commands', () => this.udpCommands.service());
    this.resultChunks.purge();
    await this.commandHandler.service();
  }

  /** Resolves when started remote commands have replied and a running update check is done (tests, shutdown). */
  async idle(): Promise<void> {
    await this.commandHandler.idle();
    if (this.updateCheck !== null) await this.updateCheck;
  }

  /**
   * Python ran check() inline, blocking the loop -- and with it command
   * resends and status pushes -- for up to the 12 s manifest timeout. Here it
   * runs in the background, at most one at a time.
   */
  private startUpdateCheck(): void {
    if (this.updateCheck !== null) return;
    this.updateCheck = (async () => {
      try {
        await this.updateControl.check(true);
      } catch (error) {
        this.logger.warn(`update check failed: ${errorMessage(error)}`);
      } finally {
        this.updateCheck = null;
      }
    })();
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.error(`${what}: ${errorMessage(error)}`);
    }
  }

  /** Sends gateway_status on the next tick (after a remote command). */
  pushStatusSoon(): void {
    this.lastGatewayStatusAt = null;
  }

  updateBlock(): Json {
    return this.updateControl.updateBlock(this.autoApplier.status());
  }

  boundUdpPort(): number {
    return pyInt(this.host.boundUdpPort?.() ?? this.configStore.snapshot().listen_udp_port);
  }

  private listenDiscoveryPort(config: GatewayConfig): number {
    if (this.discovery !== null) return pyInt(this.host.boundDiscoveryPort?.() ?? this.discovery.discoveryPort);
    return pyInt(pyGet(config, 'listen_discovery_port', 22346));
  }

  /** The gateway_status payload; field names are what the Backend and the Desktop read. */
  gatewayStatus(config: GatewayConfig = this.configStore.snapshot()): Json {
    return {
      gateway_name: pyGet(config, 'gateway_name', 'NH Gateway'),
      gateway_id: pyGet(config, 'gateway_id', ''),
      enabled: pyTruthy(config.enabled),
      version: pyGet(this.updateControl.state(), 'current_version', ''),
      update_channel: pyGet(config, 'update_channel', 'stable'),
      target_mode: pyGet(config, 'target_mode', ''),
      server_url: pyGet(config, 'server_url', ''),
      listen_udp_port: this.boundUdpPort(),
      listen_discovery_port: this.listenDiscoveryPort(config),
      upstream: this.upstreamLink.status(),
      udp_control: this.udpCommands.snapshot(),
      state: this.state.snapshot((pyGet(config, 'denied_devices', []) as unknown[]) ?? []),
      update: this.updateBlock(),
      // Off: the Desktop shows the Gateway read-only.
      remote_management: pyTruthy(pyGet(config, 'remote_management', true)),
      // New in the TS Gateway: which host it runs on (the phone hotspot reports "android").
      platform: this.platform,
    };
  }

  /** console-status.json contents (console_runtime.write_console_status). */
  consoleStatus(config: GatewayConfig = this.configStore.snapshot()): Json {
    const upstreamState = this.upstreamLink.status();
    const updateState = this.updateControl.state();
    return {
      enabled: pyTruthy(config.enabled),
      gateway_id: strOr(config.gateway_id),
      gateway_name: strOr(config.gateway_name) || 'NH Gateway',
      server_url: strOr(config.server_url),
      target_mode: strOr(config.target_mode),
      web_ui_url: `http://127.0.0.1:${pyInt(pyGet(config, 'listen_web_port', 5052))}`,
      listen_udp_port: this.boundUdpPort(),
      listen_discovery_port: this.listenDiscoveryPort(config),
      upstream_connected: pyTruthy(upstreamState.connected),
      required_update: pyTruthy(updateState.required_update),
      latest_gateway_version: strOr(updateState.latest_gateway_version),
      current_version: strOr(updateState.current_version),
    };
  }

  private publishConsoleStatus(config: GatewayConfig): void {
    if (this.host.publishConsoleStatus === undefined) return;
    this.guard('console_status', () => this.host.publishConsoleStatus!(this.consoleStatus(config)));
  }

  // -- upstream -> devices ---------------------------------------------------

  /** A `command` from the Backend for one device. */
  onCommand(deviceUid: string, payload: Json): void {
    const normalizedUid = normalizeDeviceUid(deviceUid);
    if (this.commandExpired(payload)) {
      this.upstreamLink.sendDeviceMessage('result', {
        device_uid: deviceUid,
        request_id: pyGet(payload, 'request_id', ''),
        command: pyGet(payload, 'command', ''),
        status: 'error',
        message: 'command_expired',
      });
      return;
    }
    let handled = false;
    this.notify('command', (o) => {
      handled = o.onUpstreamCommand?.(normalizedUid, payload) === true;
    });
    if (handled) return;
    if (this.udpCommands.sendCommand(normalizedUid, payload)) return;
    this.upstreamLink.sendDeviceMessage('result', {
      device_uid: normalizedUid,
      request_id: pyGet(payload, 'request_id', ''),
      command: pyGet(payload, 'command', ''),
      status: 'error',
      message: 'device_not_connected_to_gateway',
    });
  }

  private commandExpired(payload: Json): boolean {
    let expiresAtMs = 0;
    try {
      expiresAtMs = pyInt(pyOr(payload.expires_at_ms, 0));
    } catch {
      expiresAtMs = 0;
    }
    return Boolean(expiresAtMs && Math.floor(this.clock.nowMs()) > expiresAtMs);
  }

  private onUdpDeliveryTimeout(deviceUid: string, payload: Dict): void {
    if (strOr(payload.command) === 'findme_switch_gateway') {
      const claimId = strOr(payload.claim_id);
      if (claimId) this.state.failClaimDelivery(claimId, 'switch_command_delivery_timeout');
    }
    this.upstreamLink.sendDeviceMessage('result', {
      device_uid: deviceUid,
      request_id: pyGet(payload, 'request_id', ''),
      command: pyGet(payload, 'command', ''),
      status: 'error',
      message: 'command_delivery_timeout',
    });
    this.notify('delivery_timeout', (o) => o.onDeliveryTimeout?.(deviceUid, payload));
  }

  /** Every other upstream JSON message. */
  onUpstreamMessage(message: Json): void {
    if (this.commandHandler.handleMessage(message)) return;
    if (message.type === 'gateway_hello_ack') {
      this.updateControl.setServerLatestVersion(strOr(message.latest_gateway_version));
    }
    if (message.type === 'gateway_claim_update') {
      const claimId = strOr(message.claim_id);
      if (claimId) {
        this.state.updateClaim(claimId, {
          state: strOr(message.state) || 'updated',
          last_error: strOr(pyOr(message.error, message.message, '')),
        });
      }
    }
  }

  // -- devices -> upstream ---------------------------------------------------

  /** A FindMe datagram (port 22346). */
  onFindmePacket(data: Uint8Array, from: Address): void {
    if (this.discovery === null || !this.discovery.started) return;
    try {
      this.discovery.handleDatagram(data, from);
    } catch (error) {
      this.logger.warn(`findme: ${errorMessage(error)}`);
    }
  }

  /**
   * A datagram on the stream port (13250). `rxEpochUs` is the receive time
   * the host captured as close to recvfrom() as it can (the Android host
   * stamps it natively); it is t2 of a device's time request.
   */
  onUdpPacket(payload: Uint8Array, from: Address, rxEpochUs?: number): void {
    // First thing after the receive: t2 of a time request.
    const rx = rxEpochUs ?? this.clock.nowEpochUs();
    if (!this.runtimeStarted) return;
    try {
      this.demux(payload, from, rx);
    } catch (error) {
      // In Python an exception here ended the UDP receive thread for good
      // (e.g. a non-numeric `ack`); drop the one datagram instead.
      this.logger.warn(`udp packet from ${from.ip}:${from.port}: ${errorMessage(error)}`);
    }
  }

  private demux(payload: Uint8Array, addr: Address, rxEpochUs: number): void {
    if (isTimeRequest(payload)) {
      // Answered here, never forwarded: devices sync their clocks to this Gateway.
      const response = buildTimeResponse(payload, rxEpochUs, () => this.clock.nowEpochUs());
      if (response !== null) {
        try {
          this.streamSocket.send(response, addr);
        } catch {
          // The device times out and asks again.
        }
      }
      return;
    }
    if (looksLikeJson(payload)) {
      this.handleUdpControl(payload, addr);
      return;
    }
    const isArduino = isStreamPacket(payload);
    const isHeartbeat = isHeartbeatPacket(payload);
    // The loose UID (magic + length only), as main.py routed: a truncated or
    // future-version packet still reaches its device's session.
    const deviceUid = looseDeviceUid(payload);
    // Under offer_policy "managed" a device this host does not manage (or
    // released) is neither served nor relayed: it is only "nearby".
    const denied = Boolean(deviceUid && (this.configStore.isDenied(deviceUid) || this.notOurs(deviceUid)));
    const sameArduinoPeer = this.arduinoHosts.get(deviceUid) === addr.ip;
    let attached = false;
    if (isHeartbeat && deviceUid && !denied) {
      attached = true;
      this.arduinoHosts.set(deviceUid, addr.ip);
      this.udpCommands.setSession(deviceUid, addr);
      this.state.recordHeartbeat(
        deviceUid,
        { device_uid: deviceUid, device_name: `NHOS-${deviceUid}`, protocol: PROTOCOL, transport_path: 'arduino_heartbeat' },
        addr,
      );
    } else if (
      isArduino &&
      deviceUid &&
      !denied &&
      (this.state.findmeAllowsStream(deviceUid, addr) || sameArduinoPeer)
    ) {
      attached = true;
      this.arduinoHosts.set(deviceUid, addr.ip);
      this.udpCommands.setSession(deviceUid, addr);
      this.state.recordControl(
        deviceUid,
        'status',
        { device_uid: deviceUid, device_name: `NHOS-${deviceUid}`, protocol: PROTOCOL, transport_path: 'arduino_udp' },
        addr,
        true,
      );
    }
    // A complete stream packet is forwarded with or without a FindMe
    // attachment (a device streaming here picked this Gateway; attachment
    // only gates the session/roster update above). An incomplete one only
    // while the device is being served.
    const serving = Boolean(deviceUid && (isArduino || this.state.isServing(deviceUid)));
    const forwarded = Boolean(deviceUid && !denied && serving && !isHeartbeat);
    if (deviceUid && !isHeartbeat) this.state.recordUdpPacket(deviceUid, payload.length, forwarded);
    if (forwarded) this.upstreamLink.sendPacket(payload);
    if (deviceUid && !this.configStore.isDenied(deviceUid)) {
      const kind = isHeartbeat ? 'heartbeat' : isArduino ? 'stream' : 'other';
      this.notify('packet', (o) => o.onDevicePacket?.(deviceUid, payload, addr, { kind, attached, forwarded }));
    }
  }

  /** Under "managed": a device not managed here, or released. Always false under "all". */
  private notOurs(deviceUid: string): boolean {
    return (
      this.configStore.offerPolicy() === 'managed' &&
      (!this.configStore.isManaged(deviceUid) || this.configStore.isReleased(deviceUid))
    );
  }

  /** A JSON control frame from a device (hello/status/update_progress/result/ack/result_chunk). */
  private handleUdpControl(payload: Uint8Array, addr: Address): void {
    let decoded: unknown;
    try {
      // Floats kept (JsonFloat), so the relay sends 1.0 as the Python Gateway did.
      decoded = decodeJsonLine(payload, false, parseJsonKeepFloats);
    } catch {
      return;
    }
    if (!isPlainObject(decoded)) return;
    const pieceUid =
      normalizeDeviceUid(decoded.device_uid) ||
      normalizeDeviceUid(dictOr(decoded.payload).device_uid) ||
      normalizeDeviceUid(dictOr(decoded.payload).device_id);
    try {
      this.relayControl(decoded, addr);
    } finally {
      if (pieceUid && !this.configStore.isDenied(pieceUid)) {
        this.notify('datagram', (o) => o.onControlDatagram?.(pieceUid, payload, addr));
      }
    }
  }

  private relayControl(decoded: Dict, addr: Address): void {
    let frame: Dict = decoded;
    if (strOr(frame.type) === RESULT_CHUNK_TYPE) {
      // Oversized results arrive in chunks; nothing happens until the last one is in.
      const assembled = this.resultChunks.add(frame);
      if (assembled === null) return;
      frame = assembled as unknown as Dict;
    }
    const framePayload = dictOr(frame.payload);
    const deviceUid =
      normalizeDeviceUid(frame.device_uid) ||
      normalizeDeviceUid(framePayload.device_uid) ||
      normalizeDeviceUid(framePayload.device_id);
    if (!deviceUid || this.configStore.isDenied(deviceUid)) return;
    this.udpCommands.setSession(deviceUid, addr);
    const messageType = strOr(frame.type);
    const data: Dict = { ...framePayload };
    setDefault(data, 'device_uid', deviceUid);
    setDefault(data, 'request_id', pyGet(frame, 'request_id', ''));
    setDefault(data, 'received_at_ms', Math.floor(this.clock.nowMs()));
    if (messageType === 'ack') {
      this.udpCommands.handleAck(deviceUid, frame);
      return;
    }
    if (!RELAYED_CONTROL_TYPES.includes(messageType)) return;
    // Under "managed", a device that is not ours is not taken on by its
    // status; only replies (to a command this host sent, e.g. a release's
    // findme_discover) still go through.
    if (messageType !== 'result' && this.notOurs(deviceUid)) return;
    if (messageType === 'result') {
      if ('cmd' in data && !('command' in data)) data.command = data.cmd;
      if ('ok' in data && !('status' in data)) data.status = pyTruthy(data.ok) ? 'ok' : 'error';
      setDefault(data, 'transport_path', 'arduino_udp');
      this.udpCommands.handleResult(deviceUid, data);
    }
    this.state.recordControl(deviceUid, messageType, data, addr, true, this.upstreamLink.gatewayId);
    this.upstreamLink.sendDeviceMessage(messageType, data);
    this.notify('message', (o) => o.onDeviceMessage?.(messageType, data, addr));
  }
}
