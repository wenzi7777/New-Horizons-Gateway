// NH Pocket's in-app update. Reads releases/pocket-latest.json (or
// pocket-beta.json) -- the same manifest shape as Studio's and the headless
// build's, with one asset under "android" -- compares versions, then the
// native module downloads the APK, checks its size / sha256 / package name
// and opens Android's installer, where the user confirms. Platform ports are
// injected so this file is tested without a phone.
import { isNewerVersion, manifestUrlFor, parseBinManifest, type PlatformAsset } from '@nhgw/core';

export const POCKET_MANIFEST_BASE = 'https://raw.githubusercontent.com/wenzi7777/New-Horizons-Gateway/main/releases/pocket';
export const POCKET_PLATFORM_KEY = 'android';
/** Host config key of the chosen channel. */
export const CHANNEL_KEY = 'pocket_update_channel';

export type UpdateChannel = 'stable' | 'beta';

/** How often the timer looks, and how old the last check may be before it checks again. */
export const UPDATE_POLL_MS = 15 * 60_000;
export const UPDATE_RECHECK_MS = 3 * 60 * 60_000;

/** Whether to read the manifest again: not mid-download or install, and only when the last check is old. */
export function shouldRecheckUpdate(phase: string, checkedAtMs: number, nowMs: number): boolean {
  if (!['idle', 'none', 'upToDate', 'available', 'error'].includes(phase)) return false;
  return !checkedAtMs || nowMs - checkedAtMs >= UPDATE_RECHECK_MS;
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  /** No release published for this channel yet (manifest 404). */
  | 'none'
  | 'upToDate'
  | 'available'
  | 'downloading'
  /** Android must first allow this app to install apps (a Settings switch). */
  | 'needsPermission'
  /** The installer is open; the user finishes there. */
  | 'installing'
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  channel: UpdateChannel;
  currentVersion: string;
  latestVersion: string;
  notesUrl: string;
  receivedBytes: number;
  totalBytes: number;
  /** '' or a plain code (network, sha256_mismatch, invalid_manifest, no_asset, …). */
  error: string;
  checkedAtMs: number;
}

export interface UpdaterPorts {
  currentVersion: string;
  fetchText(url: string): Promise<{ status: number; text: string }>;
  download(asset: PlatformAsset, onProgress: (received: number, total: number) => void): Promise<string>;
  canInstall(): boolean;
  openInstallSettings(): void;
  install(path: string): void;
  loadChannel(): Promise<string>;
  saveChannel(channel: UpdateChannel): Promise<void>;
  now?: () => number;
}

/** The error code in whatever a port threw (native errors carry it at the end of the message). */
export function updateErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /([a-z][a-z0-9_]*)\s*$/.exec(message);
  return match ? match[1]! : 'update_failed';
}

export class PocketUpdater {
  private state: UpdateState;
  private asset: PlatformAsset | null = null;
  private downloaded: string | null = null;
  private readonly listeners = new Set<() => void>();
  private busy: Promise<unknown> | null = null;

  constructor(private readonly ports: UpdaterPorts) {
    this.state = {
      phase: 'idle',
      channel: 'stable',
      currentVersion: ports.currentVersion,
      latestVersion: '',
      notesUrl: '',
      receivedBytes: 0,
      totalBytes: 0,
      error: '',
      checkedAtMs: 0,
    };
  }

  snapshot(): UpdateState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  async loadChannel(): Promise<void> {
    const channel = (await this.ports.loadChannel().catch(() => '')) === 'beta' ? 'beta' : 'stable';
    this.set({ channel });
  }

  async setChannel(channel: UpdateChannel): Promise<UpdateState> {
    await this.ports.saveChannel(channel);
    this.set({ channel, phase: 'idle', latestVersion: '', error: '' });
    return this.check();
  }

  async check(): Promise<UpdateState> {
    if (this.state.phase === 'downloading') return this.state;
    this.set({ phase: 'checking', error: '' });
    const now = (this.ports.now ?? Date.now)();
    try {
      const response = await this.ports.fetchText(`${manifestUrlFor(this.state.channel, POCKET_MANIFEST_BASE)}?t=${now}`);
      if (response.status === 404) {
        this.asset = null;
        this.set({ phase: 'none', latestVersion: '', checkedAtMs: now });
        return this.state;
      }
      if (response.status !== 200) throw new Error(`http_${response.status}`);
      const manifest = parseBinManifest(response.text, POCKET_PLATFORM_KEY);
      this.asset = manifest.asset;
      const newer = isNewerVersion(manifest.version, this.state.currentVersion);
      if (newer && !manifest.asset) throw new Error('no_asset');
      if (this.downloaded && !newer) this.downloaded = null;
      this.set({ phase: newer ? 'available' : 'upToDate', latestVersion: manifest.version, notesUrl: manifest.notesUrl, checkedAtMs: now });
    } catch (error) {
      this.set({ phase: 'error', error: updateErrorCode(error), checkedAtMs: now });
    }
    return this.state;
  }

  /** Downloads (once) and opens the installer; stops at needsPermission until the user allows it. */
  async install(): Promise<UpdateState> {
    if (this.busy) {
      await this.busy;
      return this.state;
    }
    const run = this.installNow();
    this.busy = run;
    try {
      return await run;
    } finally {
      this.busy = null;
    }
  }

  private async installNow(): Promise<UpdateState> {
    const asset = this.asset;
    if (!asset || !['available', 'needsPermission', 'error', 'installing'].includes(this.state.phase)) return this.state;
    try {
      if (!this.downloaded) {
        this.set({ phase: 'downloading', receivedBytes: 0, totalBytes: asset.size, error: '' });
        this.downloaded = await this.ports.download(asset, (received, total) => this.set({ receivedBytes: received, totalBytes: total }));
      }
      if (!this.ports.canInstall()) {
        this.set({ phase: 'needsPermission' });
        return this.state;
      }
      this.ports.install(this.downloaded);
      this.set({ phase: 'installing' });
    } catch (error) {
      this.set({ phase: 'error', error: updateErrorCode(error) });
    }
    return this.state;
  }

  openInstallSettings(): void {
    this.ports.openInstallSettings();
  }
}
