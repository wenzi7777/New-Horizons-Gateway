// Main-process handlers of the "app" area (see ../../shared/areas/app.ts):
// Studio-only prefs, self-update, the splash's state, diagnostics and
// maintenance. The Electron pieces (dialogs, shell, login items, HTTP,
// installing) arrive as AppAreaDeps from main.ts (configureAppArea) so
// AppService is testable with fakes.
import { readFileSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AppInfo,
  AppPrefs,
  ConnectionInfo,
  PruneResult,
  SplashAnswer,
  SplashState,
} from '../../shared/areas/app';
import type { StudioSettings } from '../../shared/contract';
import { StartupSequence } from '../app/startup';
import { StudioUpdater, type HttpGet } from '../app/updater';
import { writeZip, type ZipEntrySource } from '../zip';
import type { AreaContext, AreaHandlers, AreaModule } from './registry';

export const APP_PREFS_FILE = 'app-prefs.json';
export const STREAM_PORT = 13250;
export const DISCOVERY_PORT = 22346;
const DAY_MS = 86_400_000;

export interface AppAreaDeps {
  platform: string;
  arch: string;
  versions: { electron: string; node: string; chrome: string };
  osRelease: string;
  packaged: boolean;
  loginItem: { get(): boolean; set(openAtLogin: boolean): void };
  openPath(path: string): Promise<void> | void;
  showItemInFolder(path: string): void;
  openExternal(url: string): Promise<void> | void;
  /** Save dialog for the diagnostics zip; null = cancelled. */
  saveDialog(defaultName: string): Promise<string | null>;
  http: HttpGet;
  /** Opens the dmg / runs the installer, then quits the app. */
  install(file: string): Promise<void>;
  now?: () => number;
}

export function defaultPrefs(platform: string): AppPrefs {
  return { updateChannel: 'stable', checkUpdatesOnStart: true, openAtLogin: false, keepRunningInBackground: platform === 'darwin', onboardingDone: false };
}

export function normalizePrefs(raw: unknown, platform: string): AppPrefs {
  const base = defaultPrefs(platform);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const value = raw as Record<string, unknown>;
  return {
    updateChannel: value.updateChannel === 'beta' ? 'beta' : 'stable',
    checkUpdatesOnStart: typeof value.checkUpdatesOnStart === 'boolean' ? value.checkUpdatesOnStart : base.checkUpdatesOnStart,
    openAtLogin: typeof value.openAtLogin === 'boolean' ? value.openAtLogin : base.openAtLogin,
    keepRunningInBackground: typeof value.keepRunningInBackground === 'boolean' ? value.keepRunningInBackground : base.keepRunningInBackground,
    onboardingDone: value.onboardingDone === true,
  };
}

/** Keys whose values never leave the computer in a diagnostics zip. */
const SECRET_KEY = /token|secret|password|passwd|credential|api[_-]?key|private|cookie|auth/i;

/** A deep copy of `value` with every secret-looking key's value replaced. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : redactSecrets(item);
    }
    return out;
  }
  return value;
}

/** The host's settings a reset returns to (relay id, name, managed devices and the data folder stay). */
export const RESET_SETTINGS: Partial<StudioSettings> = {
  serverTarget: 'production',
  manualUrl: '',
  relayEnabled: true,
  offerPolicy: 'managed',
  syncPolicy: 'manual',
  theme: 'auto',
  locale: 'system',
};

export type AppController = Pick<AreaContext['controller'], 'settings' | 'snapshot' | 'updateSettings' | 'host' | 'native'>;

/** How often the timer looks, and how old the last check may be before it checks again. */
export const UPDATE_POLL_MS = 15 * 60_000;
export const UPDATE_RECHECK_MS = 3 * 60 * 60_000;

/** Whether the periodic timer should read the manifest again: not mid-download, and only when the last check is old. */
export function shouldRecheckUpdate(phase: string, checkedAtMs: number | null, nowMs: number): boolean {
  if (!['idle', 'none', 'current', 'available', 'error'].includes(phase)) return false;
  return checkedAtMs === null || nowMs - checkedAtMs >= UPDATE_RECHECK_MS;
}

export class AppService {
  private prefs_: AppPrefs;
  readonly updater: StudioUpdater;
  splash: StartupSequence | null = null;
  private updateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly context: Omit<AreaContext, 'controller'> & { controller: AppController },
    private readonly deps: AppAreaDeps,
  ) {
    let saved: unknown = null;
    try {
      saved = JSON.parse(readFileSync(this.prefsPath, 'utf8'));
    } catch {
      saved = null;
    }
    this.prefs_ = normalizePrefs(saved, deps.platform);
    try {
      this.prefs_.openAtLogin = deps.loginItem.get();
    } catch {
      // Not supported here (Linux dev): keep the saved value.
    }
    this.updater = new StudioUpdater(
      {
        currentVersion: context.version,
        platformKey: `${deps.platform}-${deps.arch}`,
        downloadDir: join(context.userDataDir, 'updates'),
        http: deps.http,
        install: (file) => deps.install(file),
        onChange: (state) => {
          context.emit('update', state);
          if (this.splash) this.splash.patch({ update: state });
        },
        ...(deps.now ? { now: deps.now } : {}),
      },
      this.prefs_.updateChannel,
    );
    // A Studio left open for days would never hear of a release (it was checked at start-up only).
    this.updateTimer = setInterval(() => this.periodicUpdateCheck(), UPDATE_POLL_MS);
    this.updateTimer.unref?.();
  }

  /** Re-reads the manifest when the last check is old; never while a download or install is under way. */
  periodicUpdateCheck(): void {
    if (!this.prefs_.checkUpdatesOnStart) return;
    const state = this.updater.state;
    if (shouldRecheckUpdate(state.phase, state.checkedAtMs, (this.deps.now ?? Date.now)())) void this.updater.check();
  }

  stopUpdateChecks(): void {
    if (this.updateTimer !== null) clearInterval(this.updateTimer);
    this.updateTimer = null;
  }

  private get prefsPath(): string {
    return join(this.context.userDataDir, APP_PREFS_FILE);
  }

  get logDir(): string {
    return join(this.context.userDataDir, 'logs');
  }

  prefs(): AppPrefs {
    return { ...this.prefs_ };
  }

  async setPrefs(patch: Partial<AppPrefs>): Promise<AppPrefs> {
    const next = normalizePrefs({ ...this.prefs_, ...(patch && typeof patch === 'object' ? patch : {}) }, this.deps.platform);
    if (next.openAtLogin !== this.prefs_.openAtLogin) this.deps.loginItem.set(next.openAtLogin);
    if (next.updateChannel !== this.prefs_.updateChannel) this.updater.setChannel(next.updateChannel);
    this.prefs_ = next;
    await mkdir(this.context.userDataDir, { recursive: true });
    await writeFile(this.prefsPath, `${JSON.stringify(next, null, 2)}\n`);
    this.context.emit('prefs', this.prefs());
    return this.prefs();
  }

  info(): AppInfo {
    return {
      version: this.context.version,
      electron: this.deps.versions.electron,
      node: this.deps.versions.node,
      chrome: this.deps.versions.chrome,
      platform: this.deps.platform,
      arch: this.deps.arch,
      osRelease: this.deps.osRelease,
      userDataDir: this.context.userDataDir,
      logDir: this.logDir,
      dataFolder: this.context.controller.settings().dataFolder,
      packaged: this.deps.packaged,
    };
  }

  connectionInfo(): ConnectionInfo {
    const { controller } = this.context;
    const status = controller.snapshot().status;
    let bound: { stream: number | null; discovery: number | null } = { stream: null, discovery: null };
    try {
      bound = controller.native.boundPorts();
    } catch {
      // keep nulls
    }
    return {
      lastError: upstreamLastError(controller.host),
      ports: { stream: STREAM_PORT, discovery: DISCOVERY_PORT, boundStream: bound.stream, boundDiscovery: bound.discovery },
      serviceRunning: status.serviceRunning,
      serviceError: status.serviceError,
    };
  }

  async exportDiagnostics(): Promise<string | null> {
    const stamp = new Date((this.deps.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const destination = await this.deps.saveDialog(`nh-studio-diagnostics-${stamp}.zip`);
    if (!destination) return null;
    const work = join(this.context.userDataDir, 'diagnostics-tmp');
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    try {
      const entries = await this.diagnosticsEntries(work);
      await writeZip(destination, entries);
      return destination;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** The files a diagnostics zip holds (written to `work` where generated). */
  async diagnosticsEntries(work: string): Promise<ZipEntrySource[]> {
    const { controller } = this.context;
    const snapshot = controller.snapshot();
    const entries: ZipEntrySource[] = [];
    const add = async (name: string, data: unknown) => {
      const path = join(work, name);
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
      entries.push({ name, path });
    };
    await add('versions.json', this.info());
    await add('settings.json', redactSecrets({ settings: snapshot.settings, prefs: this.prefs_ }));
    await add('status.json', redactSecrets({ status: snapshot.status, connection: this.connectionInfo(), update: this.updater.state }));
    await add(
      'devices.json',
      snapshot.devices.map((device) => ({ uid: device.uid, model: device.hardwareModel, firmware: device.firmwareVersion, online: device.online, mode: device.mode })),
    );
    try {
      for (const name of await readdir(this.logDir)) {
        const path = join(this.logDir, name);
        if ((await stat(path)).isFile()) entries.push({ name: `logs/${name}`, path });
      }
    } catch {
      // no logs yet
    }
    return entries;
  }

  async resetSettings(): Promise<void> {
    await this.setPrefs(defaultPrefs(this.deps.platform));
    await this.context.controller.updateSettings(RESET_SETTINGS);
  }

  async pruneRecordings(olderThanDays: number, dryRun: boolean): Promise<PruneResult> {
    const days = Number(olderThanDays);
    if (!Number.isFinite(days) || days < 1) throw new Error('invalid_days');
    const cutoff = (this.deps.now ?? Date.now)() - days * DAY_MS;
    const victims = this.context.controller.snapshot().recordings.filter((item) => !item.inProgress && item.startedAtMs < cutoff);
    const result: PruneResult = { count: victims.length, bytes: victims.reduce((sum, item) => sum + item.bytes, 0), failed: 0 };
    if (dryRun) return result;
    for (const item of victims) {
      try {
        await this.context.controller.host.deleteRecording(item.id);
      } catch (error) {
        result.failed += 1;
        this.context.logger.warn(`prune ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    result.count -= result.failed;
    return result;
  }

  handlers(): AreaHandlers {
    return {
      getPrefs: () => this.prefs(),
      setPrefs: (patch: Partial<AppPrefs>) => this.setPrefs(patch),
      info: () => this.info(),
      connectionInfo: () => this.connectionInfo(),
      updateState: () => this.updater.state,
      checkForUpdate: () => this.updater.check(),
      installUpdate: () => this.updater.install(),
      openReleaseNotes: () => {
        const url = this.updater.state.notesUrl;
        if (/^https:\/\//.test(url)) return this.deps.openExternal(url);
        return undefined;
      },
      openLogFolder: async () => {
        await mkdir(this.logDir, { recursive: true });
        await this.deps.openPath(this.logDir);
      },
      revealDataFolder: async () => {
        const folder = this.context.controller.settings().dataFolder;
        await mkdir(folder, { recursive: true });
        await this.deps.openPath(folder);
      },
      exportDiagnostics: () => this.exportDiagnostics(),
      resetSettings: () => this.resetSettings(),
      pruneRecordings: (days: number, dryRun: boolean) => this.pruneRecordings(days, dryRun !== false),
      splashState: (): SplashState | null => this.splash?.state ?? null,
      splashAnswer: (answer: SplashAnswer) => {
        if (['continue', 'retry', 'quit', 'install', 'later'].includes(answer)) this.splash?.answer(answer);
      },
    };
  }
}

/** The server link's last error, read defensively from the host (it has no public accessor yet). */
export function upstreamLastError(host: unknown): string {
  try {
    const run = (host as { run_?: { runtime?: { upstream?: { lastError?: unknown } } } | null }).run_;
    const value = run?.runtime?.upstream?.lastError;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

let configured: AppAreaDeps | null = null;
let service: AppService | null = null;

/** main.ts: the Electron side of the area, before the registry adds it. */
export function configureAppArea(deps: AppAreaDeps): void {
  configured = deps;
}

/** The running AppService (main.ts: splash, background behaviour). */
export function appService(): AppService | null {
  return service;
}

export const appArea: AreaModule = {
  area: 'app',
  register(context) {
    if (!configured) {
      context.logger.warn('app area: not configured; its methods are unavailable');
      return {};
    }
    service = new AppService(context, configured);
    return service.handlers();
  },
  dispose() {
    service?.stopUpdateChecks();
    service = null;
  },
};
