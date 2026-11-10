// Fakes for the runtime tests: a hand-advanced clock, recording sockets, an
// in-memory config store and stand-ins for the upstream link and updater
// (whose real implementations live in src/upstream and src/update).
import { utf8Decode, utf8Encode } from '../../src/bytes';
import { GatewayConfigStore, type RawConfig } from '../../src/config';
import type { AutoApplier, Json, UpdateControl, UpstreamCallbacks, UpstreamLink } from '../../src/contracts';
import type { Address, Clock, JsonStore, UdpSocket } from '../../src/ports';
import { GatewayRuntime, type GatewayHostHooks, type ServiceSet, type UpstreamParams } from '../../src/runtime';

export const UID = '3CDC7545CCD0';

export class FakeClock implements Clock {
  /** Wall clock, ms since the epoch (2026-11-09). */
  wallMs = 1_794_000_000_000;
  mono = 1_000_000;
  nowMs() {
    return this.wallMs;
  }
  nowEpochUs() {
    return this.wallMs * 1000;
  }
  monotonicMs() {
    return this.mono;
  }
  advance(seconds: number) {
    this.wallMs += seconds * 1000;
    this.mono += seconds * 1000;
  }
}

export class FakeSocket implements UdpSocket {
  sent: { data: Uint8Array; to: Address }[] = [];
  broadcasts: { data: Uint8Array; port: number }[] = [];
  fail: string | null = null;
  send(data: Uint8Array, to: Address) {
    if (this.fail) throw new Error(this.fail);
    this.sent.push({ data, to });
  }
  broadcast(data: Uint8Array, port: number) {
    if (this.fail) throw new Error(this.fail);
    this.broadcasts.push({ data, port });
  }
  json(i = -1): Json {
    return JSON.parse(utf8Decode(this.sent.at(i)!.data)) as Json;
  }
}

export class MemoryStore implements JsonStore<RawConfig> {
  constructor(public value: RawConfig | null = null) {}
  async load() {
    return this.value === null ? null : structuredClone(this.value);
  }
  async save(value: RawConfig) {
    this.value = structuredClone(value);
  }
}

export async function configStore(initial: RawConfig = {}): Promise<GatewayConfigStore> {
  return GatewayConfigStore.load(new MemoryStore(initial));
}

export class FakeUpstream implements UpstreamLink {
  connected = true;
  started = 0;
  stopped = 0;
  serverUrl: string;
  channel: string;
  deviceMessages: [string, Json][] = [];
  statuses: Json[] = [];
  commandResults: [string, Json][] = [];
  claims: [string, string, number][] = [];
  packets: Uint8Array[] = [];
  serverUpdates: string[] = [];
  events: string[];

  constructor(
    readonly gatewayId: string,
    params: Partial<UpstreamParams> = {},
    readonly callbacks: UpstreamCallbacks | null = null,
    events: string[] = [],
  ) {
    this.serverUrl = params.serverUrl ?? '';
    this.channel = params.updateChannel ?? '';
    this.events = events;
  }
  start() {
    this.started++;
    this.events.push(`start:${this.gatewayId}`);
  }
  stop() {
    this.stopped++;
    this.events.push(`stop:${this.gatewayId}`);
  }
  isConnected() {
    return this.connected;
  }
  status(): Json {
    return { server_url: this.serverUrl, connected: this.connected, last_error: '' };
  }
  sendDeviceMessage(msgType: string, payload: Json) {
    this.deviceMessages.push([msgType, payload]);
  }
  sendGatewayStatus(payload: Json) {
    this.statuses.push(payload);
  }
  sendGatewayCommandResult(requestId: string, result: Json) {
    this.events.push('reply');
    this.commandResults.push([requestId, result]);
  }
  sendClaimRequest(deviceUid: string, claimId: string, ttlMs: number) {
    this.claims.push([deviceUid, claimId, ttlMs]);
  }
  sendPacket(packet: Uint8Array) {
    this.packets.push(packet);
  }
  setUpdateChannel(channel: string) {
    this.channel = channel;
  }
  updateServer(serverUrl: string) {
    this.serverUrl = serverUrl;
    this.serverUpdates.push(serverUrl);
  }
}

/** Just enough of update_manager for the runtime: required_update from hello_ack, channel, busy. */
export class FakeUpdateControl implements UpdateControl {
  currentVersion = 'v2.0.0';
  channel = 'stable';
  latest = '';
  required = false;
  busy = false;
  phase = 'idle';
  checks = 0;
  starts = 0;
  restarts = 0;
  checkResult: Json | null = null;
  autoCheckIntervalMs = 3_600_000;
  restartCallback: (() => void) | null = null;

  manifestUrl() {
    return `https://example.invalid/gateway-${this.channel}.json`;
  }
  setChannel(channel: string) {
    if (channel !== this.channel) {
      this.channel = channel;
      this.latest = '';
      this.required = false;
    }
    return this.state();
  }
  state(): Json {
    return {
      phase: this.phase,
      current_version: this.currentVersion,
      latest_gateway_version: this.latest,
      latest_version: '',
      required_update: this.required,
      update_available: this.required,
      update_channel: this.channel,
      busy: this.busy,
    };
  }
  updateBlock(autoApply = ''): Json {
    return {
      channel: this.channel,
      required_update: this.required,
      latest_gateway_version: this.latest,
      auto_apply: this.required ? autoApply : '',
      version: this.latest,
      current_version: this.currentVersion,
      busy: this.busy,
    };
  }
  setServerLatestVersion(version: string) {
    if (!version.trim()) return this.state();
    this.latest = version.trim();
    this.required = version.trim() > this.currentVersion; // good enough for vX.0.0 test values
    return this.state();
  }
  async maybeRefresh() {
    return this.state();
  }
  async check() {
    this.checks++;
    if (this.checkResult) Object.assign(this, this.checkResult);
    return this.state();
  }
  async startUpdate() {
    this.starts++;
    this.busy = true;
    return this.state();
  }
  restart() {
    this.restarts++;
    this.restartCallback?.();
    return this.state();
  }
  get requiredUpdate() {
    return this.required;
  }
  setRestartCallback(callback: () => void) {
    this.restartCallback = callback;
  }
}

export class FakeAutoApplier implements AutoApplier {
  services = 0;
  constructor(readonly isIdle: () => boolean) {}
  status() {
    return 'waiting_for_idle';
  }
  service() {
    this.services++;
  }
}

export function v5Packet(uid = UID, payloadLen = 8, flags = 0, extra = payloadLen): Uint8Array {
  const packet = new Uint8Array(24 + extra);
  const view = new DataView(packet.buffer);
  view.setUint16(0, 0xa55a, true);
  packet[2] = 5;
  packet[3] = flags;
  for (let i = 0; i < 6; i++) packet[4 + i] = parseInt(uid.slice(i * 2, i * 2 + 2), 16);
  view.setUint32(10, 1, true);
  view.setBigUint64(14, 0n, true);
  view.setUint16(22, payloadLen, true);
  return packet;
}

export function heartbeatPacket(uid = UID): Uint8Array {
  return v5Packet(uid, 0, 0x80);
}

export function timeRequest(seq: number, t1: bigint): Uint8Array {
  const out = new Uint8Array(12);
  out[0] = 0xe8;
  out[1] = 1;
  out[2] = seq;
  new DataView(out.buffer).setBigInt64(4, t1, true);
  return out;
}

export function jsonFrame(value: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(value));
}

export interface Harness {
  runtime: GatewayRuntime;
  clock: FakeClock;
  stream: FakeSocket;
  findme: FakeSocket;
  updates: FakeUpdateControl;
  upstreams: FakeUpstream[];
  upstream: () => FakeUpstream;
  services: ServiceSet[];
  console: Json[];
  restartRequests: number;
  applier: () => FakeAutoApplier;
  events: string[];
}

export async function makeRuntime(
  config: RawConfig = {},
  hooks: Partial<GatewayHostHooks> = {},
): Promise<Harness> {
  const store = await configStore({ gateway_id: 'gw-a', enabled: true, target_mode: 'local', ...config });
  const clock = new FakeClock();
  const stream = new FakeSocket();
  const findme = new FakeSocket();
  const updates = new FakeUpdateControl();
  const upstreams: FakeUpstream[] = [];
  const services: ServiceSet[] = [];
  const consoleOut: Json[] = [];
  const events: string[] = [];
  let applier: FakeAutoApplier | null = null;
  let claimSeq = 0;
  const harness = {} as Harness;
  const runtime = new GatewayRuntime({
    findmeNonOwnerDelayMs: 0,
    configStore: store,
    clock,
    streamSocket: stream,
    findmeSocket: findme,
    createUpstream: (params, callbacks) => {
      const link = new FakeUpstream(params.gatewayId, params, callbacks, events);
      upstreams.push(link);
      return link;
    },
    updateControl: updates,
    createAutoApplier: (isIdle) => (applier = new FakeAutoApplier(isIdle)),
    platform: 'android',
    newClaimId: () => `claim-${++claimSeq}`,
    host: {
      setServicesRunning: (s) => {
        services.push(s);
      },
      publishConsoleStatus: (s) => {
        consoleOut.push(s);
      },
      requestRestart: () => {
        harness.restartRequests++;
      },
      ...hooks,
    },
  });
  Object.assign(harness, {
    runtime,
    clock,
    stream,
    findme,
    updates,
    upstreams,
    upstream: () => upstreams.at(-1)!,
    services,
    console: consoleOut,
    restartRequests: 0,
    applier: () => applier!,
    events,
  });
  return harness;
}

export const DEVICE_ADDR: Address = { ip: '192.168.1.152', port: 43309 };
