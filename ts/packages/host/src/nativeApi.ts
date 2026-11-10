// What the host needs from the platform: UDP sockets on 13250/22346 (with
// TIME_REQ answered natively), a file API rooted at the data folder, and the
// `.nhraw` capture (NHRAW.md). NH Pocket implements it with its Android
// module (apps/pocket/modules/nh-gateway-native), NH Studio on Node
// (apps/studio/src/main/nodeNative.ts); tests use test/fakeNative.ts.
//
// Paths are '/'-separated and relative to the files root; an absolute path
// or one with a ".." segment is refused.

export type DatagramEvent = {
  /** The logical local port: 13250 (stream/control) or 22346 (FindMe). */
  localPort: number;
  ip: string;
  srcPort: number;
  /** base64 of the raw UDP payload */
  data: string;
  /** wall clock (µs since epoch) the moment receive() returned */
  rxEpochUs: number;
};

export type TimeServedEvent = {
  seq: number;
  /** t3 - t2 of the reply, built natively */
  turnaroundUs: number;
};

export type NativeStats = {
  running: boolean;
  datagramsIn: number;
  datagramsOut: number;
  timeRequests: number;
  sendErrors: number;
  lastError: string;
};

export type NetworkInterfaceInfo = { name: string; address: string };

/** A file or folder under the files root (stat / listDir). */
export type NativeFileInfo = {
  name: string;
  isDirectory: boolean;
  /** Bytes (0 for a folder). */
  size: number;
  mtimeMs: number;
};

export type RawCaptureStats = {
  uid: string;
  path: string;
  records: number;
  bytes: number;
  lastEpochUs: number;
  /** Set once a write failed; the capture stops growing. */
  error: string;
};

/** `.nhraw` record sources (NHRAW.md). */
export const RAW_SOURCE = { stream: 0, control: 1, event: 2 } as const;

/** The file half (also all that the recording sink needs). */
export interface HostFiles {
  fileExists(path: string): boolean;
  mkdirp(path: string): void;
  fileSize(path: string): number;
  fileOpen(path: string): number;
  fileAppend(handle: number, text: string): void;
  fileFlush(handle: number): void;
  fileClose(handle: number): void;
  writeAtomic(path: string, text: string): void;
  readText(path: string): string | null;
  readBytes(path: string, offset: number, length: number): Uint8Array;
  stat(path: string): NativeFileInfo | null;
  listDir(path: string): NativeFileInfo[];
  deletePath(path: string): boolean;
  movePath(from: string, to: string): boolean;
  treeSize(path: string): number;
  freeBytes(): number;
  /** Zips the folder (entries `<folder>/<file>`, skipping `skipSuffix` and `.tmp`) to a temp file; resolves with its absolute path. */
  zipDir(path: string, zipName: string, skipSuffix: string): Promise<string>;
}

/** The `.nhraw` capture half. */
export interface HostRaw {
  rawStart(uid: string, path: string, startEpochUs: number, firstEvent: Uint8Array | null): number;
  rawAppend(handle: number, source: number, payload: Uint8Array): number;
  rawFlush(handle: number): void;
  rawFlushAll(): void;
  rawStop(handle: number): void;
  rawStats(handle: number): RawCaptureStats | null;
}

export interface NativeSubscription {
  remove(): void;
}

export interface HostNative extends HostFiles, HostRaw {
  startService(): boolean;
  stopService(): boolean;
  isRunning(): boolean;
  /**
   * Why the sockets are not serving although the service was started (a
   * port held by another Gateway / Studio / Desktop …), '' when fine.
   * Optional: a native without it reports ''.
   */
  serviceError?(): string;
  send(localPort: number, ip: string, dstPort: number, base64: string): void;
  nowEpochUs(): number;
  stats(): NativeStats;
  networkInterfaces(): NetworkInterfaceInfo[];
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): boolean;
  addListener(event: 'onDatagram', listener: (event: DatagramEvent) => void): NativeSubscription;
  addListener(event: 'onTimeServed', listener: (event: TimeServedEvent) => void): NativeSubscription;
}
