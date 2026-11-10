// The device half of the Desktop service (service.py, datagram_ingest.py,
// gateway_ws.py's time push) for an app that is its own server: NH Studio
// and NH Pocket manage the devices on their LAN directly, on top of the core
// GatewayRuntime (FindMe, sessions, UDP command delivery, upstream relay).
//
//   devices --UDP--> GatewayRuntime --observer--> DeviceService --events--> UI
//   UI --sendCommand--> gating --> runtime.udpCommands --UDP--> device
//   server --command--> runtime --onUpstreamCommand--> same gating/dispatch
//
// Results always travel upstream too (the runtime relays every device frame),
// so a setting changed here, on the server, or on another app shows up on all
// of them. Nothing here touches a socket, a timer or a file: the host binds
// the runtime, calls tick() (every 0.5 s is fine) and injects the stores.
import {
  type Address,
  type Clock,
  type DevicePacketInfo,
  type GatewayRuntime,
  type GatewayRuntimeObserver,
  type Logger,
  ResultChunkReassembler,
  isHeartbeatPacket,
  silentLogger,
  utf8Decode,
} from '@nhgw/core';

import { extensionSensorCount, PacketParseError, parseBinaryPacket, parsedPacketToPy, type ParsedPacket } from '../parse/packetParser';
import { parsePyJson } from '../parse/pyJson';
import { DeviceRecorder, type DrainToken } from '../recording/deviceRecorder';
import type { DeviceKnowledge } from '../recording/meta';
import type { RecordingFileSink } from '../recording/sink';

import { clockIsSynced, TimePushThrottle } from './clockPush';
import { CommandCatalogStore } from './commandCatalog';
import { CommandGating, commandModeError } from './commandGating';
import { validateDeviceCommandPayload } from './commandTables';
import { DeviceTable, STALE_DEVICE_CHECK_INTERVAL_MS, type DeviceTableHooks, type ParsedFrame, type RecordingState } from './deviceTable';
import { type DeviceEventListener, DeviceEventEmitter } from './events';
import { deviceUidFromPayload } from './identity';
import { DeviceLabels, type DeviceLabelsOptions } from './labels';
import { type Dict, dictOr, has, isDict, randomHex32, setDefault, strOr, truthy } from './py';

/** service.COMMAND_TTL_MS: a command not delivered within this is dropped (expires_at_ms). */
export const COMMAND_TTL_MS = 15_000;
/** How often a streaming device's presence is recorded as a status (ARDUINO_STREAM_STATUS_INTERVAL_SEC). */
export const STREAM_STATUS_INTERVAL_MS = 5_000;
/** The Backend kept partial chunked results 30 s (its result_chunks.py); the Gateway 10 s. */
export const RESULT_CHUNK_TTL_MS = 30_000;
export const PROTOCOL_NAME = 'NHO/Arduino/1';

export const DEVICE_CONTROL_UNAVAILABLE = 'device_control_unavailable';
export const DEVICE_BOOTING = 'device_booting';
/** What the Gateway answers the Backend for a device it cannot reach; the Backend knows it is no status. */
export const UPSTREAM_UNREACHABLE_MESSAGE = 'device_not_connected_to_gateway';

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  [DEVICE_BOOTING]: 'Device is rebooting; control will resume when it comes back online.',
  [DEVICE_CONTROL_UNAVAILABLE]: 'Device control is reconnecting; try again in a few seconds.',
};

/** service_constants.command_error_message: a user-facing sentence for the retryable codes, else the code. */
export function commandErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? code;
}

/** A command was not sent. `code`: wrong_mode, maintenance_required, unknown_command, device_booting, device_control_unavailable. */
export class CommandError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CommandError';
  }
}

/** Where commands go: the runtime's UdpCommandDispatcher, or a fake. */
export interface CommandTransport {
  /** false when the device has no live session. */
  sendCommand(deviceUid: string, payload: Dict): boolean;
  /** The device's session address, when known (lets a missing route fail before anything is recorded). */
  sessionAddress?(deviceUid: string): Address | undefined;
}

/** The upstream link as far as remote commands need it. */
export interface UpstreamResultSink {
  sendDeviceMessage(msgType: string, payload: Dict): void;
}

export interface QueuedCommand {
  status: 'queued';
  transport: 'udp';
  device_uid: string;
  payload: Dict;
  request_id: string;
  peer: string;
}

export interface DeviceServiceOptions {
  clock: Clock;
  /** Nickname and group stores (Python's two JSON files). */
  labels?: DeviceLabelsOptions;
  logger?: Logger;
  /**
   * Where recordings go (`<dataRoot>/<UID>/<YYYYMMDD>/<HHMMSS>/...`). Absent:
   * recording is unavailable (setRecording throws recording_unavailable).
   */
  recording?: RecordingOptions;
  /**
   * A status was recorded for a device whose recording switch is on: what the
   * meta is built from changed. A host capturing `.nhraw` (NH Pocket) writes
   * this as a `knowledge` event (status_update true), so convertRaw() sees
   * the same knowledge the live recorder did.
   */
  onRecordingKnowledge?: (deviceUid: string, event: Dict) => void;
  /** This host's id, written as the meta's transport.relay_id. Default: the runtime's gateway_id. */
  relayId?: () => string;
  /** Extra table hooks. Catalog and recording hooks are the service's own. */
  tableHooks?: Pick<DeviceTableHooks, 'beforeParsed' | 'afterStatus'>;
  /** Whether this host's wall clock is trustworthy; set_time is only pushed then. Default: always. */
  hostClockSynced?: () => boolean;
  /** This host's kind, stamped on device entries as client_type. Default "studio". */
  clientType?: string;
  /** Request IDs for commands without one (uuid4 hex by default). */
  newRequestId?: () => string;
  /** Called for every binary datagram the runtime saw from a device (the parse module hooks in here). */
  onDevicePacket?: GatewayRuntimeObserver['onDevicePacket'];
}

export interface RecordingOptions {
  sink: RecordingFileSink;
  dataRoot: string;
  /** meta server_time_zone ("+09:00"); default the host's offset. */
  serverTimeZone?: string;
}

export interface SetRecordingResult {
  device_uid: string;
  enabled: boolean;
  finishing: boolean;
}

/**
 * A `.nhraw` `knowledge` event (NHRAW.md) for what the recording meta is
 * built from now: a host capturing raw writes one before the first frame and,
 * with statusUpdate, after each status that arrives mid-recording.
 */
export function recordingKnowledgeEvent(knowledge: DeviceKnowledge, statusUpdate = false): Dict {
  return {
    type: 'knowledge',
    device: knowledge.device,
    status: knowledge.status,
    nickname: knowledge.nickname ?? '',
    group: knowledge.group ?? '',
    relay_client_type: knowledge.relayClientType ?? '',
    local_relay: knowledge.localRelay ?? null,
    local_relay_id: knowledge.localRelayId ?? null,
    status_update: statusUpdate,
  };
}

export interface SendCommandOptions {
  /** Check the payload as the Desktop's WebSocket/REST layer did (allowlist + catalog, payload rules). Default true. */
  validate?: boolean;
}

export class DeviceService {
  readonly events = new DeviceEventEmitter();
  readonly gating: CommandGating;
  readonly catalogs: CommandCatalogStore;
  readonly labels: DeviceLabels;
  readonly table: DeviceTable;
  /** Direct-path chunked results (ingestControlFrame); the runtime path arrives already joined. */
  readonly resultChunks: ResultChunkReassembler;

  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly hostClockSynced: () => boolean;
  private readonly clientType: string;
  private readonly newRequestId: () => string;
  private readonly onDevicePacketHook: DeviceServiceOptions['onDevicePacket'];
  private readonly timePush = new TimePushThrottle();
  private readonly streamStatusAt = new Map<string, number>();
  private transport: CommandTransport | null = null;
  private runtime: GatewayRuntime | null = null;
  private lastPeriodicAt: number | null = null;
  private readonly recordingOptions: RecordingOptions | null;
  private readonly relayIdFn: (() => string) | null;
  readonly recorders = new Map<string, DeviceRecorder>();
  private drains: { deviceUid: string; atMono: number; token: DrainToken }[] = [];

  constructor(options: DeviceServiceOptions) {
    this.clock = options.clock;
    this.logger = options.logger ?? silentLogger;
    this.hostClockSynced = options.hostClockSynced ?? (() => true);
    this.clientType = options.clientType ?? 'studio';
    this.newRequestId = options.newRequestId ?? randomHex32;
    this.onDevicePacketHook = options.onDevicePacket;
    this.recordingOptions = options.recording ?? null;
    this.relayIdFn = options.relayId ?? null;
    const mono = () => this.clock.monotonicMs();
    this.gating = new CommandGating(mono);
    this.catalogs = new CommandCatalogStore(mono);
    this.labels = new DeviceLabels(options.labels ?? {});
    // Joined result text read as Python reads it (1.0 stays a float).
    this.resultChunks = new ResultChunkReassembler({ nowMs: mono, ttlMs: RESULT_CHUNK_TTL_MS, parse: parsePyJson });
    this.table = new DeviceTable({
      clock: this.clock,
      events: this.events,
      gating: this.gating,
      labels: this.labels,
      recordingState: (uid): RecordingState => {
        const recorder = this.recorders.get(uid);
        return { enabled: recorder?.enabled ?? false, error: recorder?.error ?? '' };
      },
      hooks: {
        beforeResult: (uid, payload) => this.beforeResult(uid, payload),
        afterResult: (uid, payload, isSnapshot) => this.afterResult(uid, payload, isSnapshot),
        afterStatus: (uid, payload) => {
          // service._record_status: a recording's meta fills in from every status.
          const recorder = this.recorders.get(uid);
          if (recorder?.active) options.onRecordingKnowledge?.(uid, recordingKnowledgeEvent(this.recordingKnowledge(uid), true));
          recorder?.onDeviceStatus();
          options.tableHooks?.afterStatus?.(uid, payload);
        },
        ...(options.tableHooks?.beforeParsed ? { beforeParsed: options.tableHooks.beforeParsed } : {}),
      },
    });
  }

  /** Loads the nickname/group stores. */
  async load(): Promise<void> {
    await this.labels.load();
  }

  on(listener: DeviceEventListener): () => void {
    return this.events.on(listener);
  }

  // -- wiring -----------------------------------------------------------------

  /** Without a runtime (tests, a host with its own UDP): where commands go. */
  setTransport(transport: CommandTransport | null): void {
    this.transport = transport;
  }

  /**
   * Builds on a GatewayRuntime: commands go out through its UdpCommandDispatcher,
   * its frames come in through its observer, Backend commands for the devices
   * this host manages go through this service's gating, and its FindMe roster
   * feeds the entries' findme / gateway_state blocks.
   */
  bindRuntime(runtime: GatewayRuntime): void {
    this.runtime = runtime;
    this.transport = {
      sendCommand: (uid, payload) => runtime.udpCommands.sendCommand(uid, payload),
      sessionAddress: (uid) => runtime.udpCommands.sessions.get(uid),
    };
    runtime.setObserver(this.observer());
  }

  /** The runtime observer (bindRuntime installs it). */
  observer(): GatewayRuntimeObserver {
    return {
      // Device JSON is re-read from the datagram with Python's float semantics
      // (onDeviceMessage's data went through JSON.parse-level values).
      onControlDatagram: (uid, datagram, from) => {
        if (this.isOurs(uid)) this.ingestControlDatagram(datagram, from);
      },
      onDevicePacket: (uid, packet, from, info) => this.onDevicePacket(uid, packet, from, info),
      onFindmeRequest: () => this.events.emit({ type: 'nearby_update', items: this.nearby() }),
      onUpstreamCommand: (uid, payload) => this.handleUpstreamCommand(uid, { ...payload }),
      onDeliveryTimeout: (uid, payload) => {
        // What the Backend records when a Gateway reports it (gateway_ws device_result).
        this.table.recordResult(uid, {
          device_uid: uid,
          request_id: strOr(payload.request_id),
          command: strOr(payload.command),
          status: 'error',
          message: 'command_delivery_timeout',
          transport_path: 'arduino_udp',
        });
      },
    };
  }

  /** Under "managed", a device not managed here (or released) is only "nearby": nothing of it is ingested. */
  private isOurs(deviceUid: string): boolean {
    const store = this.runtime?.configStore;
    if (store === undefined || store.offerPolicy() !== 'managed') return true;
    return store.isManaged(deviceUid) && !store.isReleased(deviceUid);
  }

  /** Whether a Backend command for this device is this service's to gate and send. */
  private isManaged(deviceUid: string): boolean {
    const store = this.runtime?.configStore;
    if (store === undefined) return true;
    return store.offerPolicy() === 'all' || store.isManaged(deviceUid);
  }

  private udpPort(): number {
    return this.runtime?.boundUdpPort() ?? 13250;
  }

  private gatewayId(): string {
    return strOr(this.runtime?.configStore.snapshot().gateway_id);
  }

  // -- reads ------------------------------------------------------------------

  listDevices(): Dict[] {
    return this.table.list();
  }

  getDevice(deviceUid: unknown): Dict | null {
    return this.table.get(deviceUid);
  }

  /**
   * Devices FindMe has heard (the runtime's nearby list), each marked
   * `managed` / `released` for this host: the UI's "mine / nearby / elsewhere".
   */
  nearby(): Dict[] {
    if (this.runtime === null) return [];
    const store = this.runtime.configStore;
    return this.runtime.state.snapshot(store.snapshot().denied_devices).nearby_devices.map((item) => ({
      ...item,
      managed: store.offerPolicy() === 'all' ? !truthy(item.denied) : store.isManaged(item.device_uid),
      released: store.isReleased(item.device_uid),
    }));
  }

  /** device_command_names(): the commands a user may send per the device's catalog; null without one. */
  deviceCommandNames(deviceUid: unknown): Set<string> | null {
    return this.catalogs.publicNames(this.table.resolveKnownDeviceUid(deviceUid));
  }

  /**
   * device_command_catalog(): the device's catalog without its internal
   * commands, or null -- in which case one is fetched (or, with the firmware
   * unknown, a `capabilities` probe is sent) so a later ask finds it.
   */
  deviceCommandCatalog(deviceUid: unknown): Dict | null {
    const uid = this.table.resolveKnownDeviceUid(deviceUid);
    const catalog = this.catalogs.get(uid);
    if (catalog === null) {
      if (this.deviceFirmwareVersion(uid, {})) this.maybeFetchCommandCatalog(uid, {});
      else if (this.catalogs.needsProbe(uid)) this.probeFirmwareVersion(uid);
      return null;
    }
    const result = catalog.asJson();
    return { ...result, commands: result.commands.filter((item) => !item.internal) };
  }

  setNickname(deviceUid: unknown, nickname: unknown): Promise<Dict> {
    return this.table.setNickname(deviceUid, nickname);
  }

  setGroup(deviceUid: unknown, group: unknown): Promise<Dict> {
    return this.table.setGroup(deviceUid, group);
  }

  // -- commands ---------------------------------------------------------------

  /**
   * A command from this host's UI (the Desktop's ws `command` / REST
   * command): validated, then publishCommand(). Throws InvalidCommandError or
   * CommandError; the result arrives later as a `command_result` event.
   */
  sendCommand(deviceUid: unknown, payload: Dict, options: SendCommandOptions = {}): QueuedCommand {
    let checked = payload;
    if (options.validate ?? true) checked = validateDeviceCommandPayload(payload, this.deviceCommandNames(deviceUid));
    return this.publishCommand(deviceUid, checked);
  }

  /**
   * publish_command(): gate (mode, catalog), stamp expires_at_ms (15 s) and a
   * request_id when missing, remember it as pending, send it through the
   * device's session. Throws CommandError.
   *
   * Deviation: the Desktop also tried TCP 22345 for a directly attached
   * device; NH Pocket has no TCP, so commands always go as UDP JSON through
   * the core dispatcher (which resends until the device acks, where Python
   * sent each datagram three times blind).
   */
  publishCommand(deviceUidIn: unknown, payloadIn: Dict): QueuedCommand {
    const deviceUid = this.table.resolveKnownDeviceUid(deviceUidIn);
    const payload: Dict = { ...payloadIn };
    if (!has(payload, 'expires_at_ms')) payload.expires_at_ms = Math.floor(this.clock.nowMs()) + COMMAND_TTL_MS;
    // Every command carries a request_id (a result is matched by it).
    if (!strOr(payload.request_id)) payload.request_id = this.newRequestId();
    const requestId = strOr(payload.request_id);
    const modeError = commandModeError(this.catalogs, deviceUid, this.table.latestStatus.get(deviceUid) ?? {}, payload);
    if (modeError) throw new CommandError(modeError);
    const transport = this.transport;
    const addr = transport?.sessionAddress?.(deviceUid);
    if (transport === null || (transport.sessionAddress !== undefined && addr === undefined)) {
      throw new CommandError(this.gating.activeBootTransition(deviceUid) ? DEVICE_BOOTING : DEVICE_CONTROL_UNAVAILABLE);
    }
    const transition = this.gating.remember(deviceUid, payload);
    if (transition !== null) {
      const entry = this.table.devices.get(deviceUid);
      if (entry !== undefined && truthy(entry)) {
        Object.assign(entry, { booting: true, boot_target_mode: transition.target_mode, boot_command: transition.command, mode: 'booting' });
      }
    }
    let sent = false;
    try {
      sent = transport.sendCommand(deviceUid, payload);
    } catch (error) {
      this.logger.warn(`command to ${deviceUid}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!sent) {
      this.gating.forget(deviceUid, requestId);
      throw new CommandError(DEVICE_CONTROL_UNAVAILABLE);
    }
    const peerAddr = addr ?? transport.sessionAddress?.(deviceUid);
    return {
      status: 'queued',
      transport: 'udp',
      device_uid: deviceUid,
      payload,
      request_id: requestId,
      peer: peerAddr ? `${peerAddr.ip}:${peerAddr.port}` : '',
    };
  }

  /**
   * A `command` from the server, through the upstream link. For a device this
   * host manages it goes through the same gating and dispatch as a local
   * command; a refusal is answered upstream as the device's result (status
   * "error", message = the code; an unreachable device answers
   * device_not_connected_to_gateway, as the Gateway always did). The
   * device's own reply reaches the server through the runtime's relay.
   * Returns false for a device this host does not manage: the runtime then
   * routes it as a plain Gateway would.
   */
  handleUpstreamCommand(deviceUidIn: string, payload: Dict): boolean {
    const deviceUid = this.table.resolveKnownDeviceUid(deviceUidIn);
    if (!this.isManaged(deviceUid)) return false;
    try {
      this.publishCommand(deviceUid, payload);
    } catch (error) {
      const code = error instanceof CommandError ? error.code : DEVICE_CONTROL_UNAVAILABLE;
      this.runtime?.upstream.sendDeviceMessage('result', {
        device_uid: deviceUid,
        request_id: strOr(payload.request_id),
        command: strOr(payload.command) || strOr(payload.cmd),
        status: 'error',
        message: code === DEVICE_CONTROL_UNAVAILABLE ? UPSTREAM_UNREACHABLE_MESSAGE : code,
      });
    }
    return true;
  }

  // -- ingestion ----------------------------------------------------------------

  /** A device JSON frame the runtime relayed (hello/status/update_progress/result). */
  private onDeviceMessage(messageType: string, data: Dict, _from: Address): void {
    const uid = strOr(data.device_uid);
    if (messageType === 'hello' || messageType === 'status' || messageType === 'update_progress') {
      this.table.recordStatus(uid, data);
      this.maybePushTime(this.table.resolveKnownDeviceUid(uid), data);
    } else if (messageType === 'result') {
      this.table.recordResult(uid, data);
    }
  }

  /** One JSON datagram from a device, read with parsePyJson (Python json.loads). */
  ingestControlDatagram(datagram: Uint8Array, from: Address): void {
    let frame: unknown;
    try {
      frame = parsePyJson(utf8Decode(datagram).trim());
    } catch {
      return;
    }
    if (isDict(frame)) this.ingestControlFrame(frame, from);
  }

  /** A binary datagram the runtime saw from a (non-denied) device. */
  private onDevicePacket(uid: string, packet: Uint8Array, from: Address, info: DevicePacketInfo): void {
    if (info.kind === 'heartbeat') {
      if (info.attached) this.recordHeartbeat(uid, from);
    } else if (info.forwarded) {
      // What the Backend got from a Gateway (record_gateway_packet): presence, then the parsed frame.
      if (info.kind === 'stream') this.recordStreamPresence(uid, from);
      this.ingestStreamPacket(packet);
    } else if (info.attached && info.kind === 'stream') {
      this.recordStreamPresence(uid, from);
    }
    this.onDevicePacketHook?.(uid, packet, from, info);
  }

  /**
   * datagram_ingest._handle_udp_datagram's binary branch: parse (the matrix
   * size of a v5 packet with extensions from the device's entry), record the
   * frame to the device's recording, then as its latest sample.
   */
  ingestStreamPacket(packet: Uint8Array, source = 'udp'): void {
    if (isHeartbeatPacket(packet)) return;
    let parsed: ParsedPacket;
    try {
      parsed = parseBinaryPacket(packet, extensionSensorCount(packet, (uid) => this.table.devices.get(uid) ?? null));
    } catch (error) {
      if (error instanceof PacketParseError) return;
      throw error;
    }
    const deviceUid = deviceUidFromPayload(parsed.device_uid || parsed.dn, parsed as unknown as Dict);
    if (!deviceUid) return;
    parsed = { ...parsed, dn: deviceUid, device_uid: deviceUid, device_id: deviceUid };
    const frame: Dict = parsedPacketToPy(parsed);
    const recorder = this.recorders.get(deviceUid);
    if (recorder !== undefined && recorder.active) {
      const result = recorder.onFrame(parsed);
      if (result.recording_lag_ms !== undefined) frame.recording_lag_ms = result.recording_lag_ms;
    }
    this.table.recordParsed(deviceUid, frame, source);
  }

  // -- recording ----------------------------------------------------------------

  private relayId(): string {
    return this.relayIdFn?.() ?? this.gatewayId();
  }

  /** What the recording meta is built from (service._recording_device_meta's inputs). */
  recordingKnowledge(deviceUid: string): DeviceKnowledge {
    const device = this.table.devices.get(deviceUid) ?? {};
    const local = this.clientType === 'studio' || this.clientType === 'pocket' ? this.clientType : null;
    const ourId = this.relayId();
    return {
      device,
      status: this.table.latestStatus.get(deviceUid) ?? {},
      nickname: this.labels.nickname(deviceUid),
      group: this.labels.group(deviceUid),
      relayClientType: ourId && strOr(device.gateway_id) === ourId ? this.clientType : '',
      localRelay: local,
      localRelayId: local ? ourId || null : null,
    };
  }

  private recorderFor(deviceUid: string): DeviceRecorder {
    let recorder = this.recorders.get(deviceUid);
    if (recorder !== undefined) return recorder;
    const options = this.recordingOptions!;
    recorder = new DeviceRecorder(deviceUid, {
      sink: options.sink,
      dataRoot: options.dataRoot,
      clock: this.clock,
      knowledge: () => this.recordingKnowledge(deviceUid),
      ...(options.serverTimeZone !== undefined ? { serverTimeZone: options.serverTimeZone } : {}),
      publishCommand: (payload) => {
        this.publishCommand(deviceUid, payload);
      },
      newRequestId: this.newRequestId,
      onUpdate: (update) => {
        const entry = this.table.devices.get(deviceUid);
        if (entry !== undefined) {
          entry.recording_enabled = update.enabled;
          entry.recording_finishing = update.finishing ?? false;
          if (update.error !== undefined) entry.recording_error = update.error;
          else delete entry.recording_error;
        }
        this.events.emit({ ...update });
      },
    });
    this.recorders.set(deviceUid, recorder);
    return recorder;
  }

  recordingEnabled(deviceUid: unknown): boolean {
    return this.recorders.get(this.table.resolveKnownDeviceUid(deviceUid))?.enabled ?? false;
  }

  /**
   * set_recording_enabled (ws.py `recording_set`): starts recording on the
   * device's next frame, or stops (draining queued frames first). Emits
   * recording_update. Throws Error('device_uid_required' | 'recording_unavailable').
   */
  setRecording(deviceUidIn: unknown, enabled: boolean): SetRecordingResult {
    const deviceUid = this.table.resolveKnownDeviceUid(deviceUidIn);
    if (!deviceUid) throw new Error('device_uid_required');
    if (this.recordingOptions === null) throw new Error('recording_unavailable');
    const result = this.recorderFor(deviceUid).setEnabled(enabled);
    if (result.drain !== null) {
      this.drains.push({ deviceUid, atMono: this.clock.monotonicMs() + (result.drain.waitSec + 0.5) * 1000, token: result.drain.token });
    }
    if (result.needsStatus) {
      // The meta's hardware model, matrix and calibration come from a full status.
      try {
        this.publishCommand(deviceUid, { command: 'status', quiet: true, request_id: `recmeta-${this.newRequestId()}` });
      } catch {
        // Offline or booting: the meta fills in from the next status.
      }
    }
    return { device_uid: deviceUid, enabled: result.enabled, finishing: result.finishing };
  }

  /** The host is stopping (service.stop()): recordings end as "server_stopped". */
  stop(): void {
    for (const recorder of this.recorders.values()) recorder.shutdown();
    this.drains = [];
  }

  /** app_events polls and drain timers (Python's poller thread and threading.Timer). */
  private serviceRecorders(): void {
    const now = this.clock.monotonicMs();
    const due = this.drains.filter((drain) => now >= drain.atMono);
    if (due.length) {
      this.drains = this.drains.filter((drain) => now < drain.atMono);
      for (const drain of due) this.recorders.get(drain.deviceUid)?.drainTimedOut(drain.token);
    }
    for (const recorder of this.recorders.values()) recorder.pollAppEvents();
  }

  /**
   * datagram_ingest._handle_udp_control_datagram: one JSON frame from a device
   * with no runtime in between (result_chunk pieces joined here, 30 s TTL).
   * With bindRuntime() the runtime does this and the observer records it.
   */
  ingestControlFrame(frameIn: Dict, from: Address): void {
    let frame: Dict = frameIn;
    if (strOr(frame.type) === 'result_chunk') {
      const assembled = this.resultChunks.add(frame);
      if (assembled === null) return;
      frame = { ...assembled, type: 'result' };
    }
    const framePayload = dictOr(frame.payload);
    const deviceUid = deviceUidFromPayload(
      strOr(frame.device_uid) || strOr(framePayload.device_uid) || strOr(framePayload.device_id),
      framePayload,
    );
    if (!deviceUid) return;
    const data: Dict = { ...framePayload };
    setDefault(data, 'device_uid', deviceUid);
    setDefault(data, 'received_at', this.table.nowIso());
    setDefault(data, 'request_id', has(frame, 'request_id') ? frame.request_id : '');
    const messageType = strOr(frame.type);
    setDefault(data, 'received_at_ms', Math.floor(this.clock.nowMs()));
    if (messageType === 'result') {
      // As the Gateway relays it: the firmware's cmd/ok under the Backend's names.
      if (has(data, 'cmd') && !has(data, 'command')) data.command = data.cmd;
      if (has(data, 'ok') && !has(data, 'status')) data.status = truthy(data.ok) ? 'ok' : 'error';
      setDefault(data, 'transport_path', 'arduino_udp');
    }
    this.onDeviceMessage(messageType, data, from);
  }

  /** Name for a heartbeat/stream presence: the factory name only until the device names itself. */
  private presenceName(deviceUid: string): Dict {
    // Deviation: Python's direct path wrote "NHOS-<UID>" on every heartbeat,
    // which renamed a device that reports its own name every 5 s.
    return truthy(this.table.devices.get(deviceUid)?.device_name) ? {} : { device_name: `NHOS-${deviceUid}` };
  }

  /** A binary heartbeat from an attached device (datagram_ingest heartbeat branch). */
  recordHeartbeat(deviceUidIn: string, from: Address): void {
    const deviceUid = this.table.resolveKnownDeviceUid(deviceUidIn);
    if (!deviceUid) return;
    const now = this.table.nowIso();
    this.table.recordStatus(deviceUid, {
      device_uid: deviceUid,
      device_id: deviceUid,
      ...this.presenceName(deviceUid),
      protocol: PROTOCOL_NAME,
      transport_path: 'arduino_heartbeat',
      gateway_connected: true,
      last_heartbeat_at: now,
      findme: { state: 'attached', host: from.ip, udp_port: this.udpPort(), last_success_ms: now, last_error: '' },
      received_at: now,
    });
  }

  /** A stream packet from an attached device: a presence status at most every 5 s (or for a new device). */
  recordStreamPresence(deviceUidIn: string, _from: Address): void {
    const deviceUid = this.table.resolveKnownDeviceUid(deviceUidIn);
    if (!deviceUid) return;
    const now = this.clock.monotonicMs();
    const last = this.streamStatusAt.get(deviceUid);
    if (this.table.devices.has(deviceUid) && last !== undefined && now - last < STREAM_STATUS_INTERVAL_MS) return;
    this.streamStatusAt.set(deviceUid, now);
    this.table.recordStatus(deviceUid, {
      device_uid: deviceUid,
      device_id: deviceUid,
      ...this.presenceName(deviceUid),
      protocol: PROTOCOL_NAME,
      transport_path: 'arduino_udp',
      gateway_connected: true,
    });
  }

  /** A parsed sensor frame (from the parse module). */
  recordParsed(deviceUid: unknown, frame: ParsedFrame | Dict, source = 'udp'): void {
    this.table.recordParsed(deviceUid, frame, source);
  }

  // -- time push ----------------------------------------------------------------

  /** gateway_ws._maybe_push_time: set_time to a device that says its clock is unsynced, once per 600 s. */
  private maybePushTime(deviceUid: string, payload: Dict): void {
    if (!deviceUid || clockIsSynced(payload) !== false) return;
    if (!this.hostClockSynced()) return;
    const mono = this.clock.monotonicMs();
    if (!this.timePush.take(deviceUid, mono)) return;
    try {
      this.publishCommand(deviceUid, {
        command: 'set_time',
        request_id: `clock-sync-${Math.floor(mono)}`,
        epoch_ms: String(Math.floor(this.clock.nowMs())),
        // Nobody clicked anything: no LED ack.
        quiet: true,
      });
    } catch {
      // Booting or briefly unreachable: it gets the time on its next status.
    }
  }

  // -- command catalogs ---------------------------------------------------------

  private static resultData(payload: Dict): Dict {
    return isDict(payload.data) ? payload.data : payload;
  }

  private static resultFailed(payload: Dict): boolean {
    return payload.ok === false || (strOr(payload.status) || 'ok').toLowerCase() === 'error';
  }

  private deviceFirmwareVersion(deviceUid: string, payload: Dict): string {
    const data = DeviceService.resultData(payload);
    for (const source of [data, payload]) {
      const version = strOr(source.firmware_version);
      if (version) return version;
    }
    const status = this.table.latestStatus.get(deviceUid) ?? {};
    const device = this.table.devices.get(deviceUid) ?? {};
    return strOr(status.firmware_version) || strOr(device.firmware_version) || this.catalogs.firmware(deviceUid) || '';
  }

  private beforeResult(deviceUid: string, payload: Dict): void {
    const command = strOr(payload.command);
    if (command === 'commands') {
      if (DeviceService.resultFailed(payload)) {
        // Undelivered (a busy relay, a page timeout): retry after a growing backoff.
        this.catalogs.noteFetchFailed(deviceUid);
        return;
      }
      this.catalogs.record(deviceUid, this.deviceFirmwareVersion(deviceUid, {}), DeviceService.resultData(payload));
    } else if (command === 'capabilities' && DeviceService.resultFailed(payload)) {
      this.catalogs.noteProbeFailed(deviceUid);
    } else if (command === 'app_events') {
      // app_event_capture._capture_app_events.
      this.recorders.get(deviceUid)?.onAppEventsResult(payload);
    }
  }

  private afterResult(deviceUid: string, payload: Dict, isStatusSnapshot: boolean): void {
    if (isStatusSnapshot || strOr(payload.command) === 'capabilities') this.maybeFetchCommandCatalog(deviceUid, payload);
  }

  /** One `commands` per device and firmware version, the first time a status shows it. */
  private maybeFetchCommandCatalog(deviceUid: string, payload: Dict): void {
    const data = DeviceService.resultData(payload);
    if (has(data, 'command_schema_hash')) this.catalogs.invalidateIfHashDiffers(deviceUid, data.command_schema_hash);
    const firmware = this.deviceFirmwareVersion(deviceUid, payload);
    this.catalogs.noteFirmware(deviceUid, firmware);
    if (!this.catalogs.needsFetch(deviceUid, firmware)) return;
    this.catalogs.markRequested(deviceUid, firmware);
    try {
      // quiet: the user did not ask for this, so no LED ack.
      this.publishCommand(deviceUid, { command: 'commands', quiet: true });
    } catch {
      this.catalogs.noteFetchFailed(deviceUid);
    }
  }

  private probeFirmwareVersion(deviceUid: string): void {
    try {
      this.publishCommand(deviceUid, { command: 'capabilities', quiet: true });
    } catch {
      this.catalogs.noteProbeFailed(deviceUid);
    }
  }

  // -- the loop -----------------------------------------------------------------

  /**
   * Every STALE_DEVICE_CHECK_INTERVAL_MS: folds the runtime's FindMe roster
   * into the entries (findme / gateway_state, as the Backend does with a
   * Gateway's gateway_status), then marks devices not genuinely heard from in
   * 12 s offline. With a runtime, a silent device goes offline when the
   * runtime stops serving it (control_stale_sec, 16 s) -- the same timing the
   * Desktop showed behind a Gateway. Also drops expired partial results. Host calls it often
   * (the runtime's 0.5 s tick is fine).
   */
  tick(): void {
    this.resultChunks.purge();
    this.serviceRecorders();
    const now = this.clock.monotonicMs();
    if (this.lastPeriodicAt !== null && now - this.lastPeriodicAt < STALE_DEVICE_CHECK_INTERVAL_MS) return;
    this.lastPeriodicAt = now;
    // Roster first: while the runtime still serves a device (its own 16 s
    // window) the entry stays live; checking staleness first made it flip
    // offline and back within one tick.
    this.syncRelayPresence();
    this.table.checkStale();
  }

  /** gateway_registry.record_gateway_summary's per-device part, from this host's own roster. */
  syncRelayPresence(): void {
    if (this.runtime === null) return;
    const gatewayId = this.gatewayId();
    const seenAt = this.table.nowIso();
    const snapshot = this.runtime.state.snapshot(this.runtime.configStore.snapshot().denied_devices);
    for (const device of snapshot.devices) {
      const uid = this.table.resolveKnownDeviceUid(device.device_uid);
      if (!uid) continue;
      const connected = truthy(device.connected) || strOr(device.findme_state).toLowerCase() === 'attached';
      const item = this.table.recordRelayPresence(uid, gatewayId, device, connected, seenAt, {
        allowDisconnectGrace: true,
        clientType: this.clientType,
      });
      if (item !== null) this.events.emit({ type: 'device_update', item });
    }
  }
}
