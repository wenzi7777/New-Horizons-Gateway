// The desktop host (main.py's run() + the bootloader's file layout): wires the
// core's GatewayRuntime to Node I/O, serves the web UI, ticks the runtime
// every 500 ms and tells the CLI how the run ended.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

import {
  type Clock,
  GatewayConfigStore,
  GatewayRuntime,
  GatewayUpdateManager,
  type HostPlatform,
  type Http,
  type Json,
  RequiredUpdateAutoApplier,
  type Sha256,
  TICK_INTERVAL_MS,
  type UpdateInstaller,
  UpstreamClient,
  type WsConnector,
} from '@nhgw/core';

import { NodeClock } from './adapters/clock';
import { FetchHttp } from './adapters/http';
import { JsonFileStore, serializeJson, writeFileAtomicSync } from './adapters/jsonStore';
import { HostLogger } from './adapters/logger';
import { nodeSha256 } from './adapters/sha256';
import { NodeUdpSocket, PortInUseError } from './adapters/udp';
import { NodeWsConnector } from './adapters/ws';
import {
  type ConsoleStatus,
  type GatewayHostHandle,
  type HealthRecord,
  type InstallerFactory,
  type LogLine,
  platformKey,
  type RuntimePaths,
} from './hostApi';
import { relayToken } from './appToken';
import { importLegacyConfig, type LegacyImportRecord, readLegacyImportRecord } from './legacyImport';
import { consoleStatusFile, resolveRuntimePaths } from './paths';
import { CONFIG_FLOAT_KEYS } from './pyJson';
import { GATEWAY_VERSION } from './version';
import { GatewayWebServer } from './web/server';

/** local_device.py recvfrom(8192) on the stream port; discovery.py recvfrom(1024) on FindMe. */
export const STREAM_DATAGRAM_BYTES = 8192;
export const FINDME_DATAGRAM_BYTES = 1024;

export interface RunGatewayOptions {
  /** Where the files live; default resolveRuntimePaths({root, configFile}). */
  paths?: RuntimePaths;
  root?: string;
  configFile?: string;
  /** Reported everywhere (hello, gateway_status, web UI, update checks). Default GATEWAY_VERSION. */
  version?: string;
  /** Builds the self-update installer (src/installer.ts). Without one, updates are refused: a dev run never replaces anything. */
  installerFactory?: InstallerFactory;
  /** The running executable, for the installer. Default process.execPath. */
  executable?: string;
  /** NEWHORIZONS_GATEWAY_* overrides (config_store._apply_env, update manifest/interval). Default process.env. */
  env?: Record<string, string | undefined>;
  /** Also searched for an old Python config (gateway_config.json lived in the working directory). Default process.cwd(). */
  cwd?: string;
  /** Reuse one logger across in-process restarts so the terminal UI keeps its history. Default: a new HostLogger on paths.logFile. */
  logger?: HostLogger;
  /** Without a terminal UI: echo each log line to stderr. */
  echoLogs?: boolean;
  /** SIGINT/SIGTERM (and SIGHUP off Windows) end the run with `exit`. Default true. */
  handleSignals?: boolean;
  tickIntervalMs?: number;
  /** Test seams. */
  clock?: Clock;
  connector?: WsConnector;
  http?: Http;
  sha256?: Sha256;
}

/** What runGateway returns: the hostApi handle plus what the CLI and tests need to see. */
export interface NodeGatewayHost extends GatewayHostHandle {
  readonly runtime: GatewayRuntime;
  readonly updateManager: GatewayUpdateManager;
  readonly logger: HostLogger;
  /** The web UI's bound port. */
  readonly webPort: number;
  /** Bound UDP ports, null while the Gateway is disabled. */
  udpPort(): number | null;
  discoveryPort(): number | null;
  /** Settings taken over from the Python Gateway (this start or an earlier one), else null. */
  readonly legacyImport: LegacyImportRecord | null;
  /** True when that happened on this start. */
  readonly legacyImportedNow: boolean;
}

export function hostPlatform(platform: string = process.platform): HostPlatform {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

/** Used when no InstallerFactory is given: checks and downloads work, staging is refused. */
export function refusingInstaller(): UpdateInstaller {
  const refuse = async (): Promise<never> => {
    throw new Error('self_update_unavailable');
  };
  return { stage: refuse, staged: () => null, activate: refuse, bootStatus: () => ({ healthReady: true }) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPidFile(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Removes a pid/health file only if it is still this process's. */
function removeOwnFile(file: string, owned: (text: string) => boolean): void {
  try {
    if (owned(readFileSync(file, 'utf8'))) rmSync(file, { force: true });
  } catch {
    // already gone
  }
}

/**
 * Starts the Gateway and resolves once the web UI listens and the enabled
 * services are bound. Rejects (having released everything) when a port is
 * taken (PortInUseError, with a message saying which and what to do) or the
 * config cannot be read.
 */
export async function runGateway(options: RunGatewayOptions = {}): Promise<NodeGatewayHost> {
  const env = options.env ?? process.env;
  const paths = options.paths ?? resolveRuntimePaths({ root: options.root, configFile: options.configFile, env });
  const version = options.version ?? GATEWAY_VERSION;
  for (const dir of [paths.runDir, paths.downloadsDir]) mkdirSync(dir, { recursive: true });

  const logger =
    options.logger ??
    new HostLogger({ file: paths.logFile, echo: options.echoLogs ? (text) => process.stderr.write(`${text}\n`) : undefined });
  const importedNow = await importLegacyConfig(paths, { cwd: options.cwd, logger });
  const legacyImport = importedNow ?? readLegacyImportRecord(paths);
  const configStore = await GatewayConfigStore.load(new JsonFileStore(paths.configFile, { floatKeys: CONFIG_FLOAT_KEYS }), env);
  const config = configStore.snapshot();

  const clock = options.clock ?? new NodeClock();
  const http = options.http ?? new FetchHttp({ userAgent: `NH-Studio/${version}` });
  const connector = options.connector ?? new NodeWsConnector({ logger });
  const executable = options.executable ?? process.execPath;
  const installer = options.installerFactory?.({ paths, executable, logger }) ?? refusingInstaller();
  const intervalSec = Number(env.NEWHORIZONS_GATEWAY_UPDATE_INTERVAL_SEC);
  const updateManager = new GatewayUpdateManager({
    version,
    platformKey: platformKey(),
    http,
    sha256: options.sha256 ?? nodeSha256,
    clock,
    installer,
    channel: config.update_channel,
    ...(env.NEWHORIZONS_GATEWAY_UPDATE_MANIFEST ? { manifestUrl: env.NEWHORIZONS_GATEWAY_UPDATE_MANIFEST } : {}),
    ...(Number.isFinite(intervalSec) && intervalSec > 0 ? { autoCheckIntervalSec: intervalSec } : {}),
    logger,
  });

  // -- sockets ---------------------------------------------------------------
  let runtime: GatewayRuntime | null = null;
  const streamSocket = new NodeUdpSocket({
    purpose: 'device stream/control',
    configKey: 'listen_udp_port',
    clock,
    maxDatagramBytes: STREAM_DATAGRAM_BYTES,
    logger,
    onMessage: (data, from, rxEpochUs) => runtime?.onUdpPacket(data, from, rxEpochUs),
  });
  const findmeSocket = new NodeUdpSocket({
    purpose: 'FindMe discovery',
    configKey: 'listen_discovery_port',
    clock,
    maxDatagramBytes: FINDME_DATAGRAM_BYTES,
    logger,
    onMessage: (data, from) => runtime?.onFindmePacket(data, from),
  });

  let servicesChain: Promise<void> = Promise.resolve();
  const setServices = (udp: boolean, discovery: boolean): Promise<void> => {
    const next = servicesChain.catch(() => undefined).then(async () => {
      const current = configStore.snapshot();
      if (!udp) await streamSocket.close();
      if (!discovery) await findmeSocket.close();
      const boundNow: NodeUdpSocket[] = [];
      try {
        if (udp && !streamSocket.bound) {
          await streamSocket.bind(current.listen_udp_host, current.listen_udp_port);
          boundNow.push(streamSocket);
        }
        if (discovery && !findmeSocket.bound) {
          await findmeSocket.bind(current.listen_discovery_host, current.listen_discovery_port);
          boundNow.push(findmeSocket);
        }
      } catch (error) {
        for (const socket of boundNow) await socket.close();
        // Do not stay connected upstream as a Gateway that cannot hear its devices.
        runtime?.upstream.stop();
        const failure = error instanceof PortInUseError ? error.withConfigFile(paths.configFile) : error;
        logger.error(errorText(failure));
        throw failure;
      }
    });
    servicesChain = next;
    return next;
  };

  // -- status ----------------------------------------------------------------
  let webPort = 0;
  let latestStatus: ConsoleStatus = {};
  let lastStatusText = '';
  const statusListeners = new Set<(status: ConsoleStatus) => void>();
  const decorate = (status: Json): ConsoleStatus => ({
    ...status,
    ...(webPort ? { web_ui_url: `http://127.0.0.1:${webPort}` } : {}),
    legacy_import: legacyImport as unknown as Json | null,
  });
  const publishConsoleStatus = (status: Json): void => {
    latestStatus = decorate(status);
    const text = serializeJson(latestStatus, { indent: 2, sortKeys: true, ensureAscii: true, trailingNewline: false });
    if (text !== lastStatusText) {
      lastStatusText = text;
      try {
        writeFileAtomicSync(consoleStatusFile(paths), text);
      } catch (error) {
        logger.warn(`console status: ${errorText(error)}`);
      }
    }
    for (const listener of statusListeners) {
      try {
        listener(latestStatus);
      } catch {
        // a listener's problem
      }
    }
  };

  // -- runtime ---------------------------------------------------------------
  let restartRequested = false;
  runtime = new GatewayRuntime({
    configStore,
    clock,
    streamSocket,
    findmeSocket,
    createUpstream: (params, callbacks) =>
      new UpstreamClient({
        ...params,
        version,
        platform: platformKey(),
        // NH Studio (headless): the Desktop lists it with the Studio relays.
        clientType: 'studio',
        // Read at every connection attempt: follows a token or server change.
        authToken: () => relayToken(configStore.snapshot() as unknown as Record<string, unknown>),
        connector,
        clock,
        callbacks,
        logger,
      }),
    updateControl: updateManager,
    createAutoApplier: (isIdle) => new RequiredUpdateAutoApplier(updateManager, { isIdle, clock, logger }),
    platform: hostPlatform(),
    logger,
    host: {
      setServicesRunning: ({ udp, discovery }) => setServices(udp, discovery),
      boundUdpPort: () => streamSocket.boundPort ?? configStore.snapshot().listen_udp_port,
      boundDiscoveryPort: () => findmeSocket.boundPort ?? configStore.snapshot().listen_discovery_port,
      // Acted on by the next tick, so the HTTP reply or command result that asked for it goes out first.
      requestRestart: () => {
        restartRequested = true;
      },
      publishConsoleStatus,
    },
  });
  const activeRuntime = runtime;

  const web = new GatewayWebServer({
    host: config.listen_web_host,
    port: config.listen_web_port,
    runtime: () => activeRuntime,
    version,
    logger,
    extraStatus: () => ({ legacy_import: legacyImport as unknown as Json | null }),
  });

  // -- start -----------------------------------------------------------------
  try {
    webPort = await web.start();
  } catch (error) {
    const failure = error instanceof PortInUseError ? error.withConfigFile(paths.configFile) : error;
    logger.error(errorText(failure));
    throw failure;
  }
  try {
    await activeRuntime.start();
  } catch (error) {
    await activeRuntime.stop().catch(() => undefined);
    await web.stop();
    throw error;
  }

  mkdirSync(paths.runDir, { recursive: true });
  writeFileAtomicSync(paths.pidFile, String(process.pid));
  const health: HealthRecord = { pid: process.pid, version, web_port: webPort, ready: true, updated_at: new Date().toISOString() };
  writeFileAtomicSync(paths.healthFile, serializeJson(health, { indent: 2, sortKeys: true, ensureAscii: true, trailingNewline: false }));
  publishConsoleStatus(activeRuntime.consoleStatus());

  const current = configStore.snapshot();
  logger.info(
    `NH Studio (headless) ${version} web=http://127.0.0.1:${webPort} enabled=${current.enabled ? 'True' : 'False'} ` +
      `udp=${current.listen_udp_host}:${streamSocket.boundPort ?? current.listen_udp_port} ` +
      `findme=${current.listen_discovery_host}:${findmeSocket.boundPort ?? current.listen_discovery_port} upstream=${current.server_url}`,
  );
  if (importedNow) logger.info(`settings taken over from the previous Gateway (${importedNow.source})`);

  // -- run -------------------------------------------------------------------
  let resolveDone!: (reason: 'restart' | 'switch' | 'exit') => void;
  const done = new Promise<'restart' | 'switch' | 'exit'>((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  let stopping: Promise<void> | null = null;
  let tickInFlight: Promise<void> | null = null;

  const tickOnce = async (): Promise<void> => {
    const link = activeRuntime.upstream;
    // UpstreamClient retries connections and resumes a paused drain from the host's tick.
    if (link instanceof UpstreamClient) link.service();
    await activeRuntime.tick();
  };
  const timer = setInterval(() => {
    if (stopping !== null) return;
    if (restartRequested) {
      void finish(updateManager.softRestartRequested ? 'restart' : 'switch');
      return;
    }
    if (tickInFlight !== null) return; // a slow tick (a remote command) is still running
    tickInFlight = tickOnce()
      .catch((error: unknown) => logger.error(`tick: ${errorText(error)}`))
      .finally(() => {
        tickInFlight = null;
      });
  }, options.tickIntervalMs ?? TICK_INTERVAL_MS);

  const signalHandlers: [NodeJS.Signals, () => void][] = [];
  if (options.handleSignals ?? true) {
    const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) {
      const handler = () => {
        if (stopping !== null) {
          // Second signal while stopping: give up waiting.
          process.exit(130);
        }
        logger.info(`${signal}: stopping`);
        void finish('exit');
      };
      process.on(signal, handler);
      signalHandlers.push([signal, handler]);
    }
  }

  function finish(reason: 'restart' | 'switch' | 'exit'): Promise<void> {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      clearInterval(timer);
      if (reason !== 'exit') logger.info(reason === 'restart' ? 'Gateway restarting' : 'Gateway switching to the staged update');
      if (tickInFlight !== null) await tickInFlight;
      try {
        await activeRuntime.stop();
      } catch (error) {
        logger.warn(`stop: ${errorText(error)}`);
      }
      await servicesChain.catch(() => undefined);
      await Promise.all([streamSocket.close(), findmeSocket.close(), web.stop()]);
      removeOwnFile(paths.pidFile, (text) => Number.parseInt(text.trim(), 10) === process.pid);
      removeOwnFile(paths.healthFile, (text) => {
        try {
          return (JSON.parse(text) as { pid?: unknown }).pid === process.pid;
        } catch {
          return false;
        }
      });
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      resolveDone(reason);
    })();
    return stopping;
  }

  const handle: NodeGatewayHost = {
    version,
    paths,
    runtime: activeRuntime,
    updateManager,
    logger,
    webPort,
    legacyImport,
    legacyImportedNow: importedNow !== null,
    done,
    status: () => latestStatus,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    recentLogs: (): readonly LogLine[] => logger.recent(),
    onLog: (listener) => logger.onLine(listener),
    stats() {
      const snapshot = activeRuntime.state.snapshot(configStore.snapshot().denied_devices);
      const upstream = activeRuntime.upstream.status();
      return {
        devices: snapshot.devices.length,
        serving: activeRuntime.state.servingCount(),
        udpInFps: Number(upstream.udp_in_fps) || 0,
        upstreamSentFps: Number(upstream.upstream_sent_fps) || 0,
      };
    },
    udpPort: () => streamSocket.boundPort,
    discoveryPort: () => findmeSocket.boundPort,
    stop: () => finish('exit'),
  };
  return handle;
}

/** The pid in a pid file, if any (Python's scripts/stop.py reads the same file). */
export function readGatewayPid(paths: RuntimePaths): number | null {
  return readPidFile(paths.pidFile);
}
