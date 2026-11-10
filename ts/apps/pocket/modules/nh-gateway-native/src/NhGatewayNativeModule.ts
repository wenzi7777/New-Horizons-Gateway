import { NativeModule, requireOptionalNativeModule } from 'expo';

import type { NativeFileInfo, NativeStats, NetworkInterfaceInfo, NhGatewayNativeEvents, RawCaptureStats } from './NhGatewayNative.types';

declare class NhGatewayNativeModule extends NativeModule<NhGatewayNativeEvents> {
  startService(): boolean;
  stopService(): boolean;
  isRunning(): boolean;
  send(localPort: number, ip: string, dstPort: number, base64: string): void;
  nowEpochUs(): number;
  stats(): NativeStats;
  networkInterfaces(): NetworkInterfaceInfo[];
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): boolean;

  // In-app update (ApkUpdater.kt). updateDownload rejects with a code in the
  // message: insecure_url, bad_size, http_<n>, network, size_mismatch,
  // sha256_mismatch, wrong_package, write_failed.
  /** Downloads and verifies a release APK; resolves to its path (cache dir). */
  updateDownload(url: string, sha256: string, size: number): Promise<string>;
  /** Whether Android allows this app to open the installer ("install unknown apps"). */
  updateCanInstall(): boolean;
  /** Opens that switch in Settings. */
  updateOpenInstallSettings(): boolean;
  /** Opens the package installer on a path updateDownload returned. */
  updateInstall(path: string): boolean;
  installedVersion(): { versionName: string; versionCode: number };

  // Files: '/'-separated paths relative to the app's external files dir
  // (filesRoot()); absolute paths and '..' are refused. All synchronous
  // except zipDir; failures throw.
  filesRoot(): string;
  fileExists(path: string): boolean;
  mkdirp(path: string): void;
  /** Bytes, or -1 when there is no such file. */
  fileSize(path: string): number;
  /** Opens for appending (created if missing); returns a handle. */
  fileOpen(path: string): number;
  fileAppend(handle: number, text: string): void;
  fileFlush(handle: number): void;
  fileClose(handle: number): void;
  /** `<path>.tmp`, fsync, rename. */
  writeAtomic(path: string, text: string): void;
  readText(path: string): string | null;
  readBytes(path: string, offset: number, length: number): Uint8Array;
  stat(path: string): NativeFileInfo | null;
  listDir(path: string): NativeFileInfo[];
  /** Recursive; false when nothing was there. */
  deletePath(path: string): boolean;
  movePath(from: string, to: string): boolean;
  treeSize(path: string): number;
  freeBytes(): number;
  /** Zips a folder into the cache dir (leaving out files ending in skipSuffix); resolves to the zip's absolute path. */
  zipDir(path: string, zipName: string, skipSuffix: string): Promise<string>;

  // .nhraw capture (NHRAW.md): rawStart writes the header (+ firstEvent) and
  // from then on the UDP thread appends every stream datagram of `uid`.
  rawStart(uid: string, path: string, startEpochUs: number, firstEvent: Uint8Array | null): number;
  /** A record stamped now (never before the last one); returns the stamp. */
  rawAppend(handle: number, source: number, payload: Uint8Array): number;
  rawFlush(handle: number): void;
  rawFlushAll(): void;
  rawStop(handle: number): void;
  rawStats(handle: number): RawCaptureStats | null;
}

export type NhGatewayNativeApi = NhGatewayNativeModule;

// null in Expo Go (and on iOS): it only carries Expo's own native modules,
// so the app falls back to an upstream-only check there.
export default requireOptionalNativeModule<NhGatewayNativeModule>('NhGatewayNative');
