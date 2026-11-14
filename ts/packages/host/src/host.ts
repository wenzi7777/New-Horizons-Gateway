// The app host of NH Studio and NH Pocket: the engine (DeviceService on
// core's GatewayRuntime) wired to the platform (HostNative: Studio's Node
// sockets and files, Pocket's Android module), the server link and the app's
// files, behind the HostStore interface the UIs use. Structure follows the desktop host
// (ts/packages/node/src/host.ts): load config, build adapters and runtime,
// bind sockets through the runtime's host hooks, tick every 500 ms.
//
// Recording: the engine writes the live CSV/meta through the native file API
// while native captures the same device's datagrams to `.nhraw`
// (rawCaptures.ts); a capture is deleted once its live recording finished
// cleanly, kept and converted (recovery.ts) when it did not.
import {
  base64ToBytes,
  defaultConfig,
  GATEWAY_ID_PATTERN,
  GatewayConfigStore,
  GatewayRuntime,
  type HostPlatform,
  type Logger,
  normalizeConfig,
  normalizeListUid,
  type RawConfig,
  TICK_INTERVAL_MS,
  type WsConnector,
} from '@nhgw/core';
import { CommandError, DeviceService, type DeviceEvent, recordingKnowledgeEvent, type StringMap } from '@nhgw/engine';

import type {
  CommandOutcome,
  ConnectionState,
  DeviceDetail,
  DeviceView,
  ExportedZip,
  HostClientType,
  HostSettings,
  HostStatus,
  HostStore,
  LiveFrame,
  NearbyDeviceView,
  QuickCommand,
  RecordingSummary,
  RecordingAnalysisInfo,
  RecordingChunk,
  RecordingTimeline,
} from './contract';
import { HostClock, NativeUdpSocket, NoUpdateControl, RelayUpstream, RnWsConnector, noAutoApplier } from './adapters';
import { quickCommandPayload } from './commands';
import { NativeJsonStore, NativeRecordingSink, NHRAW_SUFFIX, PATHS } from './files';
import type { DatagramEvent, HostFiles, HostNative, NativeSubscription, NetworkInterfaceInfo } from './nativeApi';
import { dict, plainJson, str } from './plainJson';
import { RawCaptures } from './rawCaptures';
import { RecordingCatalog, recordingDirectory, recordingIdOf } from './recordings';
import { recoverCaptures } from './recovery';
import { relayToken } from './sync/config';
import { LatestThrottle } from './throttle';
import {
  configPatchFromSettings,
  deviceView,
  isNearbyFresh,
  isolationSuspected,
  liveFrame,
  APP_KEYS,
  hostDefaultConfig,
  matrixOf,
  nearbyView,
  newRelayId,
  productName,
  settingsFromConfig,
  withOwnership,
} from './views';

/** Reported upstream when the app passes no version. */
export const DEFAULT_VERSION = 'v2.0.0';
export const STREAM_PORT = 13250;
export const DISCOVERY_PORT = 22346;
/** How long run() waits for the device's reply (the command TTL is 15 s, resends included). */
export const COMMAND_RESULT_TIMEOUT_MS = 20_000;
/**
 * How long to wait for a command's reply. Most answer at once; the v2.0.F Rfb measurement
 * (seven passes, ~1.5 s) and Vref sweep (the device is busy for settle + capture at every
 * step, up to 120 s) legitimately take longer. Same rule as the Desktop backend's.
 */
export function commandTimeoutMs(payload: Record<string, unknown>): number {
  const command = str(payload.command);
  if (command === 'rfb_measure') return 30_000;
  if (command === 'vref_sweep') {
    const start = Number(payload.start_mv ?? 100);
    const stop = Number(payload.stop_mv ?? 800);
    const step = Math.max(10, Number(payload.step_mv ?? 100));
    const settle = Number(payload.settle_ms ?? 150);
    const capture = Number(payload.duration_ms ?? 300);
    if (![start, stop, step, settle, capture].every(Number.isFinite)) return 60_000;
    const steps = Math.max(1, (stop - start) / step + 1);
    return Math.min(120_000, steps * (settle + capture + 150) + 5_000);
  }
  return COMMAND_RESULT_TIMEOUT_MS;
}
/** Recordings, addresses and storage are re-read this often (and on every recording change). */
const SLOW_REFRESH_MS = 5_000;
/** Listeners hear about changes at most this often. */
const NOTIFY_INTERVAL_MS = 250;
/**
 * The relay id a damaged config file still shows (`"gateway_id": "…"`), so a
 * config that will not parse keeps the id the Backend and devices know.
 */
export function salvageGatewayId(text: string | null): string {
  if (!text) return '';
  const match = /"gateway_id"\s*:\s*"([^"\\]{1,64})"/.exec(text);
  const id = match?.[1]?.trim() ?? '';
  return GATEWAY_ID_PATTERN.test(id) ? id : '';
}

/** Where the app's config and label documents live, when not beside the recordings. */
export interface HostDocuments {
  files: HostFiles;
  /** Paths within `files`. */
  config: string;
  nicknames: string;
  groups: string;
}

export interface AppHostOptions {
  /** The platform: UDP, files rooted at the data folder (recordings/ lives there), `.nhraw` capture. */
  native: HostNative;
  /** 'pocket' (default) or 'studio': client_type upstream, recordings' local relay, the relay id prefix and default name. */
  clientType?: HostClientType;
  /** Reported upstream in gateway_status.platform (default 'android'). */
  platform?: HostPlatform;
  /** Announced in the upstream hello (default: `platform`), e.g. "darwin-arm64". */
  upstreamPlatform?: string;
  /** Short name for logs and the default display name (default by clientType: NH Studio / NH Pocket). */
  productName?: string;
  /**
   * Config and label documents. Default: in `native`'s files at
   * config/<clientType>.json, config/device_nicknames.json and
   * config/device_groups.json (NH Pocket's layout). Studio keeps them in its
   * user-data folder so the data folder can move.
   */
  documents?: HostDocuments;
  /** Opens the share sheet for a local file (Pocket: expo-sharing's shareAsync). Without it exportRecording() fails; exportZip() still works. */
  share?: (fileUri: string, options: { mimeType: string; dialogTitle?: string }) => Promise<void>;
  logger?: Logger;
  /** WebSocket constructor override (tests). */
  connector?: WsConnector;
  tickIntervalMs?: number;
  /** Version reported upstream (hello / gateway_status). */
  version?: string;
}

/** Console logger that keeps the last 200 lines (for a future diagnostics screen). */
export class RingLogger implements Logger {
  readonly lines: string[] = [];
  constructor(private readonly tag = 'host') {}
  private push(level: string, message: string) {
    this.lines.push(`${new Date().toISOString().slice(11, 19)} ${level} ${message}`);
    if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200);
  }
  info(message: string) {
    this.push('I', message);
  }
  warn(message: string) {
    this.push('W', message);
    console.warn(`[${this.tag}] ${message}`);
  }
  error(message: string) {
    this.push('E', message);
    console.error(`[${this.tag}] ${message}`);
  }
}

function errorText(error: unknown): string {
  if (error instanceof CommandError) return error.code;
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string, data: unknown = null): CommandOutcome {
  return { ok: false, message, data };
}

/** A device result as an outcome: ok unless it says status "error" / ok false. */
export function resultOutcome(result: Record<string, unknown>): CommandOutcome {
  const ok = result.ok !== false && str(result.status).toLowerCase() !== 'error';
  return {
    ok,
    message: str(result.message) || str(result.error) || (ok ? 'ok' : 'error'),
    data: plainJson(result.data !== undefined ? result.data : result),
  };
}

type Running = {
  configStore: GatewayConfigStore;
  runtime: GatewayRuntime;
  service: DeviceService;
  upstream: () => RelayUpstream | null;
  startedAtMono: number;
  timer: ReturnType<typeof setInterval>;
  subscriptions: (NativeSubscription | (() => void))[];
};

export class AppHost implements HostStore {
  readonly clientType: HostClientType;
  readonly productName: string;
  private readonly native: HostNative;
  private readonly documents: HostDocuments;
  private readonly logger: Logger;
  private readonly clock: HostClock;
  private readonly sink: NativeRecordingSink;
  private readonly captures: RawCaptures;
  private readonly catalog: RecordingCatalog;
  private readonly listeners = new Set<() => void>();
  private readonly live = new Map<string, Set<LatestThrottle<Record<string, unknown>>>>();
  private run_: Running | null = null;
  private starting: Promise<void> | null = null;
  private configStore: GatewayConfigStore | null = null;
  /** The one config load in flight (appConfig / saveAppConfig / updateSettings / start share it). */
  private configLoading: Promise<GatewayConfigStore> | null = null;

  // Cached views: getters return the same object until something changed
  // (useSyncExternalStore needs stable snapshots).
  private dirty = true;
  private cache: {
    status: HostStatus;
    settings: HostSettings;
    devices: DeviceView[];
    nearby: NearbyDeviceView[];
    json: { status: string; settings: string; devices: string; nearby: string };
  } | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSlowRefresh = Number.NEGATIVE_INFINITY;
  private addresses: NetworkInterfaceInfo[] = [];
  private batteryIgnored: boolean | null = null;
  private freeBytes = 0;
  private findmeRequests = 0;
  private recovery: Promise<void> = Promise.resolve();
  /** Recording id -> upload state, set by the sync client (sync/); absent = 'local'. */
  private syncStates: ReadonlyMap<string, RecordingSummary['syncState']> = new Map();
  private syncedList: { source: RecordingSummary[]; states: ReadonlyMap<string, RecordingSummary['syncState']>; out: RecordingSummary[] } | null = null;

  constructor(private readonly deps: AppHostOptions) {
    this.native = deps.native;
    this.clientType = deps.clientType ?? 'pocket';
    this.productName = deps.productName ?? productName(this.clientType);
    this.documents = deps.documents ?? {
      files: deps.native,
      config: this.clientType === 'pocket' ? PATHS.config : `config/${this.clientType}.json`,
      nicknames: PATHS.nicknames,
      groups: PATHS.groups,
    };
    this.logger = deps.logger ?? new RingLogger(this.clientType);
    this.clock = new HostClock(() => this.native.nowEpochUs());
    this.sink = new NativeRecordingSink(this.native);
    this.captures = new RawCaptures(this.native, this.logger);
    this.catalog = new RecordingCatalog(this.native);
  }

  // -- store ------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The platform's state changed outside the host (e.g. a socket bound late): recompute and notify. */
  invalidate(): void {
    this.changed();
  }

  private changed(): void {
    this.dirty = true;
    if (this.notifyTimer !== null) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const listener of [...this.listeners]) {
        try {
          listener();
        } catch (error) {
          this.logger.warn(`listener: ${errorText(error)}`);
        }
      }
    }, NOTIFY_INTERVAL_MS);
  }

  private views() {
    if (this.cache !== null && !this.dirty) return this.cache;
    this.dirty = false;
    const next = {
      status: this.buildStatus(),
      settings: this.buildSettings(),
      devices: this.buildDevices(),
      nearby: this.buildNearby(),
    };
    const json = {
      status: JSON.stringify(next.status),
      settings: JSON.stringify(next.settings),
      devices: JSON.stringify(next.devices),
      nearby: JSON.stringify(next.nearby),
    };
    const old = this.cache;
    this.cache = {
      status: old && old.json.status === json.status ? old.status : next.status,
      settings: old && old.json.settings === json.settings ? old.settings : next.settings,
      devices: old && old.json.devices === json.devices ? old.devices : next.devices,
      nearby: old && old.json.nearby === json.nearby ? old.nearby : next.nearby,
      json,
    };
    return this.cache;
  }

  status(): HostStatus {
    return this.views().status;
  }

  settings(): HostSettings {
    return this.views().settings;
  }

  devices(): DeviceView[] {
    return this.views().devices;
  }

  nearby(): NearbyDeviceView[] {
    return this.views().nearby;
  }

  recordings(): RecordingSummary[] {
    const source = this.catalog.list();
    const cached = this.syncedList;
    if (cached !== null && cached.source === source && cached.states === this.syncStates) return cached.out;
    const states = this.syncStates;
    const out = states.size === 0 ? source : source.map((item) => {
      const state = item.inProgress ? undefined : states.get(item.id);
      return state && state !== item.syncState ? { ...item, syncState: state } : item;
    });
    this.syncedList = { source, states, out };
    return out;
  }

  // -- sync hooks (sync/SyncClient) ----------------------------------------------

  /** The sync client's view of each recording's upload state (ids it does not name read 'local'). */
  setRecordingSyncStates(states: ReadonlyMap<string, RecordingSummary['syncState']>): void {
    this.syncStates = new Map(states);
    this.changed();
  }

  /** Rescans the recordings folder now (e.g. before the sync client picks what to upload). */
  refreshRecordings(): void {
    if (this.catalog.refresh(this.inProgressIds(), Date.now())) this.changed();
  }

  /** Raw values of the host config (the sync client keeps its token and switches there); loads the file if not started. */
  async appConfig(): Promise<Record<string, unknown>> {
    const store = await this.loadConfig();
    return { ...store.snapshot() };
  }

  /** Saves app keys into the host config; a changed sync token re-authenticates the relay link. */
  async saveAppConfig(patch: Record<string, unknown>): Promise<void> {
    const store = await this.loadConfig();
    const before = relayToken(store.snapshot());
    const config = await store.save(patch);
    const run = this.run_;
    const token = relayToken(config);
    if (run !== null && token !== before) run.upstream()?.updateServer(config.server_url, token);
    this.changed();
  }

  /** The label documents as they are on disk (UID -> nickname / group). */
  readLabels(): { nicknames: Record<string, string>; groups: Record<string, string> } {
    const read = (path: string): Record<string, string> => {
      try {
        const parsed = JSON.parse(this.documents.files.readText(path) ?? '{}') as unknown;
        const out: Record<string, string> = {};
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [uid, value] of Object.entries(parsed)) if (typeof value === 'string') out[uid] = value;
        }
        return out;
      } catch {
        return {};
      }
    };
    return { nicknames: read(this.documents.nicknames), groups: read(this.documents.groups) };
  }

  /** The engine's record and last status of each device in devices() (plain JSON, built on each call). */
  deviceDetails(): Record<string, DeviceDetail> {
    const run = this.run_;
    const out: Record<string, DeviceDetail> = {};
    if (run === null) return out;
    for (const entry of run.service.listDevices()) {
      const uid = str(entry.device_uid);
      if (!uid || !this.isMine(uid)) continue;
      out[uid] = { record: dict(plainJson(entry)), status: dict(plainJson(entry.last_status)) };
    }
    return out;
  }

  private buildSettings(): HostSettings {
    const config = this.configStore?.snapshot() ?? normalizeConfig({ ...defaultConfig(), ...hostDefaultConfig('', this.productName) });
    return settingsFromConfig(config);
  }

  private connection(): ConnectionState {
    const run = this.run_;
    if (run === null) return 'offline';
    if (run.runtime.upstream.isConnected()) return 'online';
    const config = run.configStore.snapshot();
    return config.enabled && config[APP_KEYS.relayEnabled] !== false ? 'connecting' : 'offline';
  }

  private buildStatus(): HostStatus {
    const run = this.run_;
    let serviceRunning = false;
    let serviceError = '';
    try {
      serviceRunning = run !== null && this.native.isRunning();
      if (run !== null) serviceError = this.native.serviceError?.() ?? '';
    } catch {
      serviceRunning = false;
    }
    const runningFor = run !== null ? this.clock.monotonicMs() - run.startedAtMono : null;
    return {
      serviceRunning,
      serviceError,
      upstream: this.connection(),
      authRejected: this.run_?.upstream()?.authRejected === true,
      serverUrl: str(this.configStore?.snapshot().server_url),
      addresses: this.addresses.map((item) => ({ name: item.name, address: item.address })),
      batteryOptimizationIgnored: this.batteryIgnored,
      findmeRequests: this.findmeRequests,
      isolationSuspected: isolationSuspected(runningFor, this.addresses, this.findmeRequests),
      storage: { freeBytes: this.freeBytes, recordingsBytes: this.catalog.bytes() },
    };
  }

  /** The config store in use: the running relay's own (one instance, so the UI never disagrees with the offers). */
  private activeStore(): GatewayConfigStore | null {
    return this.run_?.configStore ?? this.configStore;
  }

  private isMine(uid: string): boolean {
    const store = this.activeStore();
    if (store === null || store.offerPolicy() === 'all') return true;
    return store.isManaged(uid);
  }

  private buildDevices(): DeviceView[] {
    const run = this.run_;
    if (run === null) return [];
    const now = this.clock.monotonicMs();
    return run.service
      .listDevices()
      .filter((entry) => this.isMine(str(entry.device_uid)))
      .map((entry) => {
        const view = withOwnership(deviceView(entry, now), {
          isYielded: (uid) => run.runtime.configStore.isYielded(uid),
          attachedTo: (uid) => run.runtime.attachedTo(uid),
        });
        // The table's flag lags a capture that is still draining.
        const recorder = run.service.recorders.get(view.uid);
        return recorder ? { ...view, recording: { ...view.recording, finishing: recorder.finishing } } : view;
      });
  }

  private buildNearby(): NearbyDeviceView[] {
    const run = this.run_;
    if (run === null) return [];
    // Re-run every tick (changed()), so an expired device drops out on its own.
    const now = this.clock.nowMs();
    return run.service
      .nearby()
      .filter((item) => !this.isMine(str(item.device_uid)) || item.released === true)
      .map((item) => nearbyView(item, run.runtime.attachedTo(str(item.device_uid))))
      .filter((view) => isNearbyFresh(view, now));
  }

  subscribeLive(uid: string, listener: (frame: LiveFrame) => void): () => void {
    const key = uid.toUpperCase();
    const throttle = new LatestThrottle<Record<string, unknown>>((data) => {
      const entry = this.run_?.service.table.devices.get(key) ?? {};
      const shape = matrixOf(entry.matrix_shape) ?? matrixOf(dict(entry.last_status).matrix_shape);
      const frame = liveFrame(key, data, shape);
      if (frame !== null) listener(frame);
    });
    let set = this.live.get(key);
    if (set === undefined) {
      set = new Set();
      this.live.set(key, set);
    }
    set.add(throttle);
    return () => {
      throttle.close();
      const current = this.live.get(key);
      current?.delete(throttle);
      if (current?.size === 0) this.live.delete(key);
    };
  }

  // -- lifecycle ----------------------------------------------------------------

  start(): Promise<void> {
    if (this.run_ !== null) return Promise.resolve();
    if (this.starting === null) {
      this.starting = this.doStart().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private newConfig(): RawConfig {
    return hostDefaultConfig(newRelayId(this.clientType), this.productName);
  }

  /**
   * The config store: the one in use, else the file loaded once. Concurrent
   * callers share one load, so a first run (or a damaged file) mints one
   * relay id, not one per caller.
   */
  private loadConfig(): Promise<GatewayConfigStore> {
    const active = this.activeStore();
    if (active !== null) return Promise.resolve(active);
    if (this.configLoading === null) {
      this.configLoading = this.readConfig()
        .then((store) => {
          this.configStore = store;
          return store;
        })
        .finally(() => {
          this.configLoading = null;
        });
    }
    return this.configLoading;
  }

  private async readConfig(): Promise<GatewayConfigStore> {
    const docs = this.documents;
    const file = new NativeJsonStore<RawConfig>(docs.files, docs.config, () => this.newConfig(), {
      // A config that will not parse keeps its relay id when the text still shows it.
      recover: (text) => {
        const id = salvageGatewayId(text);
        return id ? hostDefaultConfig(id, this.productName) : null;
      },
      warn: (message) => this.logger.warn(`config: ${message}`),
    });
    const store = await GatewayConfigStore.load(file);
    const config = store.snapshot();
    const patch: RawConfig = {};
    // An id is required to run; a damaged or hand-edited config may lack one.
    if (!config.gateway_id) patch.gateway_id = newRelayId(this.clientType);
    if (!config.enabled) patch.enabled = true;
    const outcome = file.lastLoad;
    if (outcome === 'reset') this.logger.warn(`config: nothing recoverable; new relay id ${config.gateway_id}`);
    else if (outcome === 'recovered') this.logger.warn(`config: rebuilt with relay id ${config.gateway_id}`);
    // A minted or recovered id is saved at once, so the next load sees the same one.
    if (outcome !== 'ok' || Object.keys(patch).length) await store.save(patch);
    if (patch.gateway_id) this.logger.warn(`config: had no relay id; new relay id ${String(patch.gateway_id)}`);
    return store;
  }

  private async doStart(): Promise<void> {
    const native = this.native;
    const configStore = await this.loadConfig();
    const clock = this.clock;
    const connector = this.deps.connector ?? new RnWsConnector();
    const version = this.deps.version ?? DEFAULT_VERSION;
    const platform = this.deps.platform ?? 'android';
    const clientType = this.clientType;
    const relayOn = () => configStore.snapshot()[APP_KEYS.relayEnabled] !== false;
    let currentUpstream: RelayUpstream | null = null;

    const runtime = new GatewayRuntime({
      configStore,
      clock,
      streamSocket: new NativeUdpSocket(native, STREAM_PORT),
      findmeSocket: new NativeUdpSocket(native, DISCOVERY_PORT),
      createUpstream: (params, callbacks) => {
        currentUpstream = new RelayUpstream(
          {
            ...params,
            version,
            platform: this.deps.upstreamPlatform ?? platform,
            clientType,
            connector,
            clock,
            authToken: relayToken(configStore.snapshot()),
            callbacks: {
              ...callbacks,
              onConnectionChange: (connected) => {
                callbacks.onConnectionChange?.(connected);
                this.changed();
              },
              onAuthRejected: (code) => {
                callbacks.onAuthRejected?.(code);
                this.changed();
              },
            },
            logger: this.logger,
          },
          relayOn,
        );
        return currentUpstream;
      },
      updateControl: new NoUpdateControl(),
      createAutoApplier: () => noAutoApplier,
      platform,
      logger: this.logger,
      // The Desktop backend kept partial chunked results 30 s.
      resultChunkTtlMs: 30_000,
      host: {
        setServicesRunning: ({ udp, discovery }) => {
          if (udp || discovery) native.startService();
          else native.stopService();
        },
        // The apps are updated by their store / installer; a restart request is only logged.
        requestRestart: () => this.logger.warn(`restart requested (ignored on ${this.productName})`),
      },
    });

    const service = new DeviceService({
      clock,
      logger: this.logger,
      clientType,
      labels: {
        nicknames: new NativeJsonStore<StringMap>(this.documents.files, this.documents.nicknames),
        groups: new NativeJsonStore<StringMap>(this.documents.files, this.documents.groups),
      },
      recording: { sink: this.sink, dataRoot: PATHS.dataRoot },
      onRecordingKnowledge: (uid, event) => this.captures.event(uid, event),
      onDevicePacket: (uid) => this.noteLiveDirectory(service, uid),
    });
    const subscriptions: Running['subscriptions'] = [];
    try {
      await service.load();
      service.bindRuntime(runtime);
      this.wrapRuntimeHooks(runtime, service);
      subscriptions.push(
        native.addListener('onDatagram', (event) => this.onDatagram(runtime, event)),
        service.on((event) => this.onServiceEvent(event)),
      );
      await runtime.start();
    } catch (error) {
      // Nothing of this attempt may outlive it: a second start would otherwise
      // open a second upstream link under the same relay id.
      this.removeSubscriptions(subscriptions);
      try {
        await runtime.stop();
      } catch {
        // half started
      }
      try {
        (currentUpstream as RelayUpstream | null)?.stop();
      } catch {
        // never started
      }
      try {
        native.stopService();
      } catch {
        // not running
      }
      this.logger.error(`start: ${errorText(error)}`);
      throw error;
    }
    const tickMs = this.deps.tickIntervalMs ?? TICK_INTERVAL_MS;
    let ticking = false;
    const timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      this.tick()
        .catch((error: unknown) => this.logger.error(`tick: ${errorText(error)}`))
        .finally(() => {
          ticking = false;
        });
    }, tickMs);
    this.run_ = {
      configStore,
      runtime,
      service,
      upstream: () => currentUpstream,
      startedAtMono: clock.monotonicMs(),
      timer,
      subscriptions,
    };
    this.findmeRequests = 0;
    this.slowRefresh(true);
    this.logger.info(`${this.productName} ${version} started as ${configStore.snapshot().gateway_id}`);
    // Captures a killed app left behind; in the background, so the UI is up meanwhile.
    this.recovery = this.recovery
      .then(() => recoverCaptures({ native, logger: this.logger, skip: this.captures.openRawPaths() }))
      .then((outcomes) => {
        if (outcomes.length) this.slowRefresh(true);
      })
      .catch((error: unknown) => this.logger.error(`recovery: ${errorText(error)}`));
    this.changed();
  }

  /** Engine hooks the host adds: the FindMe count, raw capture of control replies and app_events requests. */
  private wrapRuntimeHooks(runtime: GatewayRuntime, service: DeviceService): void {
    const base = service.observer();
    runtime.setObserver({
      ...base,
      onFindmeRequest: (request, from, accepted, reason) => {
        this.findmeRequests += 1;
        base.onFindmeRequest?.(request, from, accepted, reason);
        this.changed();
      },
      // The runtime decides ownership (GatewayRuntime.observeAttachment); the
      // device stays listed, marked taken over, and its recording here ends.
      onTakenOver: (uid, relayId) => {
        base.onTakenOver?.(uid, relayId);
        this.logger.info(`${uid} was taken over by ${relayId}`);
        void (async () => {
          if (this.run_?.service.recordingEnabled(uid)) await this.setRecording(uid, false).catch(() => undefined);
          this.changed();
        })().catch((error: unknown) => this.logger.warn(`taken over ${uid}: ${errorText(error)}`));
      },
      onReclaim: (uid, relayId) => {
        base.onReclaim?.(uid, relayId);
        this.changed();
      },
      onControlDatagram: (uid, datagram, from) => {
        // Before the engine reads it, as the device sent it (app_events replies feed the events file).
        if (this.captures.has(uid)) this.captures.control(uid, datagram);
        base.onControlDatagram?.(uid, datagram, from);
      },
    });
    service.setTransport({
      sendCommand: (uid, payload) => {
        const sent = runtime.udpCommands.sendCommand(uid, payload);
        if (sent && payload.command === 'app_events' && this.captures.has(uid)) {
          // The recorder's poll: conversion needs it to judge the reply's gaps as live did.
          this.captures.event(uid, { type: 'app_events_request', request_id: str(payload.request_id), since: Number(payload.since_seq) || 0 });
        }
        return sent;
      },
      sessionAddress: (uid) => runtime.udpCommands.sessions.get(uid),
    });
  }

  private onDatagram(runtime: GatewayRuntime, event: DatagramEvent): void {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(event.data);
    } catch {
      return;
    }
    const from = { ip: event.ip, port: event.srcPort };
    if (event.localPort === DISCOVERY_PORT) {
      runtime.onFindmePacket(bytes, from);
      return;
    }
    // The engine sees the arrival time native saw (and wrote to `.nhraw`).
    this.clock.withWallUs(event.rxEpochUs, () => runtime.onUdpPacket(bytes, from, event.rxEpochUs));
  }

  private noteLiveDirectory(service: DeviceService, uid: string): void {
    if (!this.captures.has(uid) || this.captures.liveDirectory(uid) !== null) return;
    const directory = service.recorders.get(uid)?.paths?.directory;
    if (directory) this.captures.noteLiveDirectory(uid, directory);
  }

  private onServiceEvent(event: DeviceEvent): void {
    switch (event.type) {
      case 'visualization_update': {
        const subscribers = this.live.get(event.device_uid);
        if (subscribers) for (const throttle of subscribers) throttle.push(event.data);
        return; // per-frame: not a store change
      }
      case 'recording_update': {
        const uid = event.device_uid;
        if (!event.enabled && !event.finishing && this.captures.has(uid)) {
          // The live recording is finished: its capture is only needed if it failed.
          const failed = Boolean(event.error);
          const kept = this.captures.finish(uid, failed);
          if (kept !== null) {
            this.logger.warn(`recording ${uid} failed (${event.error}); converting its raw capture`);
            this.recovery = this.recovery
              .then(() => recoverCaptures({ native: this.native, logger: this.logger, skip: this.captures.openRawPaths() }))
              .then(() => this.slowRefresh(true))
              .catch((error: unknown) => this.logger.error(`recovery: ${errorText(error)}`));
          }
        }
        this.slowRefresh(true);
        break;
      }
      default:
        break;
    }
    this.changed();
  }

  private async tick(): Promise<void> {
    const run = this.run_;
    if (run === null) return;
    run.upstream()?.service();
    await run.runtime.tick();
    run.service.tick();
    this.captures.flushAll();
    this.slowRefresh(false);
    // fps and liveness change with time alone.
    this.changed();
  }

  private inProgressIds(): Set<string> {
    const ids = new Set<string>();
    const run = this.run_;
    if (run === null) return ids;
    for (const recorder of run.service.recorders.values()) {
      const directory = recorder.active ? recorder.paths?.directory : undefined;
      const id = directory ? recordingIdOf(directory) : null;
      if (id) ids.add(id);
    }
    return ids;
  }

  private slowRefresh(force: boolean): void {
    const now = this.clock.monotonicMs();
    if (!force && now - this.lastSlowRefresh < SLOW_REFRESH_MS) return;
    this.lastSlowRefresh = now;
    try {
      this.addresses = this.native.networkInterfaces();
    } catch {
      this.addresses = [];
    }
    try {
      this.batteryIgnored = this.native.isIgnoringBatteryOptimizations();
    } catch {
      this.batteryIgnored = null;
    }
    try {
      this.freeBytes = this.native.freeBytes();
    } catch {
      // keep the last value
    }
    for (const [uid, error] of Object.entries(this.captures.errors())) this.logger.warn(`nhraw ${uid}: ${error}`);
    this.catalog.refresh(this.inProgressIds(), Date.now());
    this.probeForMovedDevices();
    this.changed();
  }

  /**
   * A managed device that went quiet may have been adopted by another host
   * (an attached device no longer broadcasts FindMe, so nothing else would
   * tell us). A probe makes it answer with the relay it is attached to, which
   * the runtime then acts on (a takeover, or a fallback to take back).
   */
  private probeForMovedDevices(): void {
    const run = this.run_;
    if (run === null || this.configStore?.offerPolicy() !== 'managed') return;
    const quiet = run.service.listDevices().some((entry) => {
      const uid = str(entry.device_uid);
      return this.isMine(uid) && entry.gateway_connected !== true;
    });
    if (quiet) run.runtime.operations().discover();
  }

  async stop(): Promise<void> {
    if (this.starting !== null) await this.starting.catch(() => undefined);
    const run = this.run_;
    if (run === null) return;
    this.run_ = null;
    clearInterval(run.timer);
    this.removeSubscriptions(run.subscriptions);
    for (const uid of this.captures.uids()) this.captures.event(uid, { type: 'shutdown' });
    // Recordings end as "server_stopped" (recording_update finishes their captures).
    run.service.stop();
    // A switch that was on but never saw a frame has nothing live to keep.
    for (const uid of this.captures.uids()) this.captures.finish(uid, false);
    try {
      await run.runtime.stop();
    } catch (error) {
      this.logger.warn(`stop: ${errorText(error)}`);
    }
    try {
      this.native.stopService();
    } catch {
      // not running
    }
    for (const set of this.live.values()) for (const throttle of set) throttle.close();
    // A later start builds new subscriptions; the closed throttles must not linger.
    this.live.clear();
    this.slowRefresh(true);
    this.changed();
  }

  private removeSubscriptions(subscriptions: Running['subscriptions']): void {
    for (const sub of subscriptions) {
      try {
        if (typeof sub === 'function') sub();
        else sub.remove();
      } catch {
        // already gone
      }
    }
  }

  // -- settings -------------------------------------------------------------------

  async updateSettings(patch: Partial<HostSettings>): Promise<void> {
    const store = await this.loadConfig();
    const tokenBefore = relayToken(store.snapshot());
    const config = await store.save(configPatchFromSettings(patch, this.productName));
    const run = this.run_;
    if (run !== null) {
      // Server, id and name changes reconnect / re-announce; the relay switch gates the link.
      await run.runtime.applyRuntimeConfig(config);
      // The sync token belongs to one server: a server change drops or restores it.
      const token = relayToken(config);
      if (token !== tokenBefore) run.upstream()?.updateServer(config.server_url, token);
      run.upstream()?.applyRelay();
    }
    this.changed();
  }

  requestIgnoreBatteryOptimizations(): void {
    try {
      this.native.requestIgnoreBatteryOptimizations();
    } catch (error) {
      this.logger.warn(`battery optimizations: ${errorText(error)}`);
    }
  }

  // -- devices ---------------------------------------------------------------------

  async adopt(uid: string): Promise<CommandOutcome> {
    const run = this.run_;
    if (run === null) return fail('not_running');
    const result = await run.runtime.operations().adopt(uid);
    this.changed();
    return { ok: result.ok, message: result.ok ? 'ok' : result.error, data: plainJson(result.data) };
  }

  async discoverNearby(): Promise<CommandOutcome> {
    const run = this.run_;
    if (run === null) return fail('not_running');
    const result = run.runtime.operations().discover();
    this.changed();
    return { ok: result.ok, message: result.ok ? 'ok' : result.error, data: plainJson(result.data) };
  }

  async release(uid: string): Promise<CommandOutcome> {
    const run = this.run_;
    if (run === null) return fail('not_running');
    if (run.service.recordingEnabled(uid)) await this.setRecording(uid, false);
    const result = await run.runtime.operations().release(uid);
    this.changed();
    return { ok: result.ok, message: result.ok ? 'ok' : result.error, data: plainJson(result.data) };
  }

  async setNickname(uid: string, nickname: string): Promise<void> {
    const run = this.run_;
    if (run === null) throw new Error('not_running');
    await run.service.setNickname(uid, nickname);
    this.changed();
  }

  async setGroup(uid: string, group: string): Promise<void> {
    const run = this.run_;
    if (run === null) throw new Error('not_running');
    await run.service.setGroup(uid, group);
    this.changed();
  }

  run(uid: string, command: QuickCommand): Promise<CommandOutcome> {
    return this.sendCommand(uid, quickCommandPayload(command));
  }

  async sendCommand(uid: string, payload: Record<string, unknown>): Promise<CommandOutcome> {
    const run = this.run_;
    if (run === null) return fail('not_running');
    const service = run.service;
    let requestId: string;
    let resolveResult!: (result: Record<string, unknown>) => void;
    const result = new Promise<Record<string, unknown>>((resolve) => {
      resolveResult = resolve;
    });
    const pending = new Map<string, Record<string, unknown>>();
    let wanted: string | null = null;
    // Subscribed before sending: a reply can only arrive later, but stay safe.
    const off = service.on((event) => {
      if (event.type !== 'command_result') return;
      if (wanted === null) pending.set(event.request_id, event.result);
      else if (event.request_id === wanted) resolveResult(event.result);
    });
    try {
      requestId = service.sendCommand(uid, payload).request_id;
    } catch (error) {
      off();
      return fail(errorText(error));
    }
    wanted = requestId;
    const early = pending.get(requestId);
    if (early) resolveResult(early);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), commandTimeoutMs(payload));
    });
    try {
      const reply = await Promise.race([result, timeout]);
      return reply === null ? fail('command_timeout', { request_id: requestId }) : resultOutcome(reply);
    } finally {
      off();
      if (timer !== null) clearTimeout(timer);
    }
  }

  async setRecording(uid: string, on: boolean): Promise<CommandOutcome> {
    const run = this.run_;
    if (run === null) return fail('not_running');
    const service = run.service;
    const key = service.table.resolveKnownDeviceUid(uid) || uid.toUpperCase();
    try {
      if (on) {
        if (this.captures.has(key)) {
          // Still writing the last recording's tail: the same capture goes on.
          this.captures.event(key, { type: 'start' });
        } else {
          this.captures.start(key, this.clock.nowEpochUs(), recordingKnowledgeEvent(service.recordingKnowledge(key)));
        }
      } else if (this.captures.has(key)) {
        this.captures.event(key, { type: 'stop' });
      }
      const result = service.setRecording(key, on);
      this.slowRefresh(true);
      return { ok: true, message: 'ok', data: plainJson(result) };
    } catch (error) {
      if (on && this.captures.has(key) && !service.recordingEnabled(key)) this.captures.finish(key, false);
      return fail(errorText(error));
    } finally {
      this.changed();
    }
  }

  // -- recordings ---------------------------------------------------------------------

  async timeline(recordingId: string): Promise<RecordingTimeline> {
    recordingDirectory(recordingId);
    if (this.catalog.list().every((item) => item.id !== recordingId)) this.catalog.refresh(this.inProgressIds(), Date.now());
    return this.catalog.timeline(recordingId);
  }

  async recordingAnalysisInfo(recordingId: string): Promise<RecordingAnalysisInfo> {
    recordingDirectory(recordingId);
    if (this.catalog.list().every((item) => item.id !== recordingId)) this.catalog.refresh(this.inProgressIds(), Date.now());
    return this.catalog.analysisInfo(recordingId);
  }

  async readRecordingChunk(recordingId: string, file: 'data' | 'events', offset: number, length: number): Promise<RecordingChunk> {
    recordingDirectory(recordingId);
    if (file !== 'data' && file !== 'events') throw new Error('invalid_file');
    // A recording still being written is read up to what is flushed; the capture's buffer is flushed first.
    this.captures.flushAll();
    return this.catalog.readChunk(recordingId, file, offset, length);
  }

  async exportZip(recordingId: string): Promise<ExportedZip> {
    const directory = recordingDirectory(recordingId);
    const [uid, day, folder] = recordingId.split('/');
    // Flush what is buffered so an in-progress recording exports up to now.
    this.captures.flushAll();
    const name = `${uid}_${day}_${folder}.zip`;
    const path = await this.native.zipDir(directory, name, NHRAW_SUFFIX);
    return { path, name };
  }

  async exportRecording(recordingId: string): Promise<void> {
    const share = this.deps.share;
    if (share === undefined) throw new Error('share_unavailable');
    const [uid, day, folder] = recordingId.split('/');
    const { path: zip } = await this.exportZip(recordingId);
    await share(zip.startsWith('file://') ? zip : `file://${zip}`, {
      mimeType: 'application/zip',
      dialogTitle: `${uid} ${day} ${folder}`,
    });
  }

  async deleteRecording(recordingId: string): Promise<void> {
    const directory = recordingDirectory(recordingId);
    if (this.inProgressIds().has(recordingId)) throw new Error('recording_in_progress');
    this.native.deletePath(directory);
    this.slowRefresh(true);
  }
}
