// NH Studio's host side, without Electron: the shared app host (@nhgw/host
// AppHost, clientType 'studio') on the Node HostNative, Studio's own
// preferences (the data folder), and the StudioSnapshot the renderer reads.
//
// Files:
//   <userData>/config/studio.json             the host config (relay id, server, managed devices …)
//   <userData>/config/device_nicknames.json   labels
//   <userData>/config/device_groups.json
//   <userData>/studio-prefs.json              { dataFolder }
//   <userData>/logs/studio.log
//   <dataFolder>/recordings/<UID>/<YYYYMMDD>/<HHMMSS>/...   (and recordings/.raw for .nhraw captures)
// Config and labels stay in userData so the data folder can move.
import { isAbsolute, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { rename, copyFile, rm } from 'node:fs/promises';

import type { HostPlatform, Logger, WsConnector } from '@nhgw/core';
import { AppHost, NativeJsonStore, recordingDirectory, type HostSettings, type LiveFrame } from '@nhgw/host';

import type { StudioSettings, StudioSnapshot } from '../shared/contract';
import { NodeFiles } from './nodeFiles';
import { NodeNative, type NodeNativeOptions } from './nodeNative';

export type StudioPrefs = { dataFolder: string };

export const PREFS_FILE = 'studio-prefs.json';

export interface StudioControllerOptions {
  /** Electron's userData folder. */
  userDataDir: string;
  /** Used when the prefs name none (~/Documents/NH Studio). */
  defaultDataFolder: string;
  /** Where exports are zipped before they are moved to the chosen file. */
  tempDir: string;
  version: string;
  platform: HostPlatform;
  /** e.g. "darwin-arm64". */
  upstreamPlatform: string;
  logger: Logger;
  connector?: WsConnector;
  /** Tests: ephemeral ports, a fake clock. */
  native?: Partial<Pick<NodeNativeOptions, 'ports' | 'host' | 'clock' | 'bindRetryMs'>>;
  tickIntervalMs?: number;
}

type LiveSub = { uid: string; listener: (frame: LiveFrame) => void; off: () => void };

export class StudioController {
  private readonly documents: NodeFiles;
  private readonly prefsStore: NativeJsonStore<StudioPrefs>;
  private prefs: StudioPrefs;
  private native_: NodeNative;
  private host_: AppHost;
  private hostOff: () => void;
  private readonly listeners = new Set<() => void>();
  private readonly live = new Set<LiveSub>();
  private switching: Promise<void> = Promise.resolve();
  private started = false;
  private prefsLoaded = false;

  constructor(private readonly options: StudioControllerOptions) {
    this.documents = new NodeFiles(options.userDataDir, options.tempDir);
    this.prefsStore = new NativeJsonStore<StudioPrefs>(this.documents, PREFS_FILE);
    this.prefs = { dataFolder: options.defaultDataFolder };
    const { native, host } = this.build(this.prefs.dataFolder);
    this.native_ = native;
    this.host_ = host;
    this.hostOff = host.subscribe(() => this.emit());
  }

  get host(): AppHost {
    return this.host_;
  }

  get native(): NodeNative {
    return this.native_;
  }

  private build(dataFolder: string): { native: NodeNative; host: AppHost } {
    let host: AppHost | null = null;
    const native = new NodeNative({
      root: dataFolder,
      exportDir: join(this.options.tempDir, 'export'),
      logger: this.options.logger,
      // Sockets bind asynchronously (and retry after a conflict): the host's status must follow.
      onStateChange: () => host?.invalidate(),
      ...this.options.native,
    });
    host = new AppHost({
      native,
      clientType: 'studio',
      platform: this.options.platform,
      upstreamPlatform: this.options.upstreamPlatform,
      version: this.options.version,
      documents: {
        files: this.documents,
        config: 'config/studio.json',
        nicknames: 'config/device_nicknames.json',
        groups: 'config/device_groups.json',
      },
      logger: this.options.logger,
      ...(this.options.connector ? { connector: this.options.connector } : {}),
      ...(this.options.tickIntervalMs ? { tickIntervalMs: this.options.tickIntervalMs } : {}),
    });
    return { native, host };
  }

  /** Reads the prefs (the data folder) once; start() calls it too (the splash runs it as its own step). */
  async loadPrefs(): Promise<void> {
    if (this.prefsLoaded) return;
    const saved = await this.prefsStore.load();
    const folder = typeof saved?.dataFolder === 'string' && isAbsolute(saved.dataFolder) ? saved.dataFolder : this.options.defaultDataFolder;
    if (folder !== this.prefs.dataFolder) await this.swap(folder);
    this.prefs = { dataFolder: folder };
    this.prefsLoaded = true;
  }

  /** Left-over .nhraw captures of a run that died (the host recovers them on start). */
  pendingRecoveries(): number {
    try {
      return readdirSync(join(this.prefs.dataFolder, 'recordings', '.raw')).filter((name) => name.endsWith('.nhraw')).length;
    } catch {
      return 0;
    }
  }

  /** Loads the prefs and starts the host (binding UDP; a port conflict shows in the status, it does not throw). */
  async start(): Promise<void> {
    await this.loadPrefs();
    this.started = true;
    await this.host_.start();
    this.emit();
  }

  /** Stops the host: recordings end as server_stopped, sockets close, files are flushed. */
  async stop(): Promise<void> {
    this.started = false;
    await this.switching.catch(() => undefined);
    await this.host_.stop();
    await this.native_.stopServiceAndWait();
    this.native_.closeAllFiles();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.options.logger.warn(`snapshot listener: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  settings(): StudioSettings {
    return { ...this.host_.settings(), dataFolder: this.prefs.dataFolder };
  }

  snapshot(): StudioSnapshot {
    return {
      status: this.host_.status(),
      settings: this.settings(),
      devices: this.host_.devices(),
      nearby: this.host_.nearby(),
      recordings: this.host_.recordings(),
      deviceDetails: this.host_.deviceDetails(),
      version: this.options.version,
    };
  }

  /** Devices recording now (quit asks first when there are any). */
  recordingCount(): number {
    return this.host_.devices().filter((device) => device.recording.enabled || device.recording.finishing).length;
  }

  async updateSettings(patch: Partial<StudioSettings>): Promise<void> {
    const { dataFolder, ...rest } = patch;
    if (dataFolder !== undefined && dataFolder !== this.prefs.dataFolder) await this.setDataFolder(dataFolder);
    if (Object.keys(rest).length > 0) await this.host_.updateSettings(rest as Partial<HostSettings>);
    this.emit();
  }

  /**
   * Moves where recordings go: the host is stopped and started again on the
   * new folder (existing recordings stay where they are). Refused while
   * recording.
   */
  async setDataFolder(folder: string): Promise<void> {
    if (!isAbsolute(folder)) throw new Error('invalid_data_folder');
    if (this.recordingCount() > 0) throw new Error('recording_in_progress');
    const next = this.switching.then(async () => {
      if (folder === this.prefs.dataFolder) return;
      await this.swap(folder);
      this.prefs = { dataFolder: folder };
      await this.prefsStore.save(this.prefs);
    });
    this.switching = next.catch(() => undefined);
    await next;
    this.emit();
  }

  private async swap(folder: string): Promise<void> {
    const wasRunning = this.started;
    await this.host_.stop();
    await this.native_.stopServiceAndWait();
    this.native_.closeAllFiles();
    this.hostOff();
    const { native, host } = this.build(folder);
    this.native_ = native;
    this.host_ = host;
    this.hostOff = host.subscribe(() => this.emit());
    for (const sub of this.live) sub.off = host.subscribeLive(sub.uid, sub.listener);
    if (wasRunning) await host.start();
  }

  /** Live frames for one device; survives a data-folder switch. */
  subscribeLive(uid: string, listener: (frame: LiveFrame) => void): () => void {
    const sub: LiveSub = { uid, listener, off: this.host_.subscribeLive(uid, listener) };
    this.live.add(sub);
    return () => {
      sub.off();
      this.live.delete(sub);
    };
  }

  /** Absolute folder of a recording (validated id). */
  recordingPath(recordingId: string): string {
    return this.native_.resolve(recordingDirectory(recordingId));
  }

  /** `<UID>_<YYYYMMDD>_<HHMMSS>.zip` for a recording id. */
  static zipName(recordingId: string): string {
    recordingDirectory(recordingId);
    return `${recordingId.split('/').join('_')}.zip`;
  }

  /** Zips the recording and moves the zip to `destination`. */
  async exportTo(recordingId: string, destination: string): Promise<string> {
    const zip = await this.host_.exportZip(recordingId);
    try {
      await rename(zip.path, destination);
    } catch {
      // Another volume: copy, then drop the temp zip.
      await copyFile(zip.path, destination);
      await rm(zip.path, { force: true });
    }
    return destination;
  }
}
