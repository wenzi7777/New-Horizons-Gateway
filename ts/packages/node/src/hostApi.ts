// The seam between the desktop host (src/host.ts, src/cli.ts, src/web/*:
// sockets, files, HTTP API) and the pieces built beside it (src/tui/*,
// src/installer.ts, scripts/build-sea.mjs). Written first so both sides can
// be built in parallel; change it only together with both.

import type { Json, Logger, UpdateInstaller } from '@nhgw/core';

/** Where a running Gateway keeps its files. Python's layout under .run/ is kept so old installs migrate in place. */
export interface RuntimePaths {
  /** The directory that holds .run/ (beside the executable for a packaged build, else the working directory). */
  root: string;
  /** <root>/.run */
  runDir: string;
  /** <root>/.run/config/config.json (Python bootloader layout). */
  configFile: string;
  /** <root>/.run/logs/gateway.log */
  logFile: string;
  /** <root>/.run/health.json: written once the web UI port accepts connections; read by the update supervisor. */
  healthFile: string;
  /** <root>/.run/gateway.pid */
  pidFile: string;
  /** <root>/.run/downloads/ */
  downloadsDir: string;
}

/** Python console_runtime / GatewayRuntime.consoleStatus() fields: what the terminal UI shows. */
export type ConsoleStatus = Json & {
  enabled?: boolean;
  gateway_id?: string;
  gateway_name?: string;
  server_url?: string;
  target_mode?: string;
  web_ui_url?: string;
  listen_udp_port?: number;
  listen_discovery_port?: number;
  upstream_connected?: boolean;
  required_update?: boolean;
  latest_gateway_version?: string;
  current_version?: string;
};

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogLine {
  at: number;
  level: LogLevel;
  message: string;
}

/** What a running host exposes to the terminal UI and the CLI. */
export interface GatewayHostHandle {
  readonly version: string;
  readonly paths: RuntimePaths;
  /** Latest console status (also pushed through onStatus). */
  status(): ConsoleStatus;
  onStatus(listener: (status: ConsoleStatus) => void): () => void;
  /** Recent log lines, newest last, and a subscription for new ones. */
  recentLogs(): readonly LogLine[];
  onLog(listener: (line: LogLine) => void): () => void;
  /** Serving device count and upstream rate, for the status panel. */
  stats(): { devices: number; serving: number; udpInFps: number; upstreamSentFps: number };
  /** Stops sockets, upstream and the web server; resolves when ports are released. */
  stop(): Promise<void>;
  /**
   * Resolves when this run is over:
   *  - `restart`: run again in-process (soft restart, settings that need it);
   *  - `switch`: a staged update was activated; the CLI launches the new
   *    binary, waits for its health file and exits, or rolls back and runs
   *    again (src/installer.ts superviseSwitch, Python's await_pending_health);
   *  - `exit`: quit (signal, or stop()).
   */
  readonly done: Promise<'restart' | 'switch' | 'exit'>;
}

/** Written to RuntimePaths.healthFile once the web UI port accepts connections. */
export interface HealthRecord {
  pid: number;
  version: string;
  web_port: number;
  ready: true;
  updated_at: string;
}

/** Builds the UpdateInstaller for this host (src/installer.ts). */
export type InstallerFactory = (options: { paths: RuntimePaths; executable: string; logger: Logger }) => UpdateInstaller;

/** The platform key of manifest assets ("darwin-arm64", "win32-x64", "linux-x64", …). */
export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}
