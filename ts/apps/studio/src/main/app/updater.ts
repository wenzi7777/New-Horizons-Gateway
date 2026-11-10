// Studio's self-update, without Electron: reads releases/studio-latest.json or
// studio-beta.json (the gateway-bin manifest shape, parsed by @nhgw/core's
// parseBinManifest), compares versions with core's compareVersions, downloads
// this platform's asset with progress and verifies its size and sha256.
// Installing (opening the dmg / running the NSIS installer) is the caller's
// `install` port, so this file is testable with a fake HTTP.
//
// A missing manifest (404, today) is phase 'none' -- "no release yet", never
// an error dialog.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { isNewerVersion, manifestUrlFor, parseBinManifest, type PlatformAsset } from '@nhgw/core';

import type { UpdateChannelPref, UpdateState } from '../../shared/areas/app';

export const STUDIO_MANIFEST_BASE = 'https://raw.githubusercontent.com/wenzi7777/New-Horizons-Gateway/main/releases/studio';

export function studioManifestUrl(channel: UpdateChannelPref, base = STUDIO_MANIFEST_BASE): string {
  return manifestUrlFor(channel, base);
}

export interface HttpResponseLike {
  status: number;
  text(): Promise<string>;
  /** Streamed body (download). */
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null;
}

export type HttpGet = (url: string, signal?: AbortSignal) => Promise<HttpResponseLike>;

export interface UpdaterOptions {
  currentVersion: string;
  platformKey: string;
  downloadDir: string;
  http: HttpGet;
  install: (file: string) => Promise<void>;
  onChange?: (state: UpdateState) => void;
  manifestBase?: string;
  checkTimeoutMs?: number;
  now?: () => number;
}

export function initialUpdateState(currentVersion: string, platformKey: string, channel: UpdateChannelPref): UpdateState {
  return {
    phase: 'idle',
    channel,
    currentVersion,
    latestVersion: '',
    notesUrl: '',
    noAssetForPlatform: false,
    platformKey,
    downloadedBytes: 0,
    totalBytes: 0,
    error: '',
    checkedAtMs: null,
  };
}

async function* chunksOf(body: HttpResponseLike['body']): AsyncIterable<Uint8Array> {
  if (!body) return;
  if (Symbol.asyncIterator in (body as object)) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) yield value;
  }
}

const errorCode = (error: unknown) => (error instanceof Error ? error.message : String(error)) || 'unknown';

export class StudioUpdater {
  private state_: UpdateState;
  private asset: PlatformAsset | null = null;
  private file: string | null = null;
  private busy: Promise<UpdateState> | null = null;

  constructor(private readonly options: UpdaterOptions, channel: UpdateChannelPref = 'stable') {
    this.state_ = initialUpdateState(options.currentVersion, options.platformKey, channel);
  }

  get state(): UpdateState {
    return { ...this.state_ };
  }

  setChannel(channel: UpdateChannelPref): void {
    if (channel === this.state_.channel) return;
    if (this.state_.phase === 'downloading' || this.state_.phase === 'verifying' || this.state_.phase === 'installing') return;
    this.asset = null;
    this.set({ ...initialUpdateState(this.options.currentVersion, this.options.platformKey, channel) });
  }

  private set(patch: Partial<UpdateState>): void {
    this.state_ = { ...this.state_, ...patch };
    this.options.onChange?.(this.state);
  }

  /** Reads the manifest; never throws (errors land in the state). */
  check(): Promise<UpdateState> {
    if (this.busy) return this.busy;
    const run = this.doCheck().finally(() => {
      this.busy = null;
    });
    this.busy = run;
    return run;
  }

  private async doCheck(): Promise<UpdateState> {
    const now = this.options.now ?? Date.now;
    this.set({ phase: 'checking', error: '' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.checkTimeoutMs ?? 10_000);
    try {
      const url = studioManifestUrl(this.state_.channel, this.options.manifestBase);
      const response = await this.options.http(url, controller.signal);
      if (response.status === 404) {
        this.asset = null;
        this.set({ phase: 'none', latestVersion: '', notesUrl: '', noAssetForPlatform: false, checkedAtMs: now() });
        return this.state;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`http_${response.status}`);
      const manifest = parseBinManifest(await response.text(), this.options.platformKey);
      const newer = isNewerVersion(manifest.version, this.options.currentVersion);
      this.asset = newer ? manifest.asset : null;
      this.set({
        phase: newer && manifest.asset ? 'available' : 'current',
        latestVersion: manifest.version,
        notesUrl: manifest.notesUrl,
        noAssetForPlatform: newer && !manifest.asset,
        totalBytes: manifest.asset?.size ?? 0,
        downloadedBytes: 0,
        checkedAtMs: now(),
      });
    } catch (error) {
      this.set({ phase: 'error', error: controller.signal.aborted ? 'timeout' : errorCode(error), checkedAtMs: now() });
    } finally {
      clearTimeout(timer);
    }
    return this.state;
  }

  /** Downloads + verifies the asset found by check(), then hands it to the install port. */
  install(): Promise<UpdateState> {
    if (this.busy) return this.busy;
    const run = this.doInstall().finally(() => {
      this.busy = null;
    });
    this.busy = run;
    return run;
  }

  private async doInstall(): Promise<UpdateState> {
    const asset = this.asset;
    if (!asset || (this.state_.phase !== 'available' && this.state_.phase !== 'error' && this.state_.phase !== 'ready')) {
      return this.state;
    }
    try {
      if (this.state_.phase !== 'ready' || !this.file) this.file = await this.download(asset);
      this.set({ phase: 'installing' });
      await this.options.install(this.file);
    } catch (error) {
      this.set({ phase: 'error', error: errorCode(error) });
    }
    return this.state;
  }

  private async download(asset: PlatformAsset): Promise<string> {
    await mkdir(this.options.downloadDir, { recursive: true });
    const name = basename(new URL(asset.url).pathname) || `nh-studio-${this.state_.latestVersion}`;
    const target = join(this.options.downloadDir, name.replace(/[^A-Za-z0-9._-]/g, '_'));
    this.set({ phase: 'downloading', downloadedBytes: 0, totalBytes: asset.size, error: '' });
    const response = await this.options.http(asset.url);
    if (response.status < 200 || response.status >= 300) throw new Error(`http_${response.status}`);
    const hash = createHash('sha256');
    const out = createWriteStream(target);
    let received = 0;
    let lastEmit = 0;
    try {
      for await (const chunk of chunksOf(response.body)) {
        received += chunk.length;
        if (received > asset.size) throw new Error('size_mismatch');
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        if (received - lastEmit >= 256 * 1024 || received === asset.size) {
          lastEmit = received;
          this.set({ downloadedBytes: received });
        }
      }
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    } catch (error) {
      out.destroy();
      await rm(target, { force: true });
      throw error;
    }
    this.set({ phase: 'verifying', downloadedBytes: received });
    if (received !== asset.size) {
      await rm(target, { force: true });
      throw new Error('size_mismatch');
    }
    if (hash.digest('hex') !== asset.sha256.toLowerCase()) {
      await rm(target, { force: true });
      throw new Error('sha256_mismatch');
    }
    this.set({ phase: 'ready' });
    return target;
  }
}

/** The release asset key of this computer, e.g. "darwin-arm64". */
export function platformKeyOf(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}
