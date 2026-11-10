// The JS side of the native `.nhraw` capture (engine NHRAW.md): one capture
// per recording device, from the moment its recording switch is turned on
// until its live recording has finished. Native appends the stream
// datagrams; this class adds the host's records (knowledge / start / stop /
// shutdown / app_events_request events and control replies) and keeps a
// sidecar `<name>.json` naming the live recording's folder, which recovery
// needs if the app dies before the live recording finished.
//
//   recordings/.raw/<UID>-<startEpochUs>.nhraw
//   recordings/.raw/<UID>-<startEpochUs>.json   {"format":1,"uid":...,"start_epoch_us":...,"live_directory":null|"recordings/<UID>/<day>/<HHMMSS>"}
import { encodeNhrawEvent } from '@nhgw/engine';
import type { Logger } from '@nhgw/core';

import { RAW_SOURCE } from './nativeApi';
import { NHRAW_SUFFIX, PATHS } from './files';
import type { HostFiles, HostRaw } from './nativeApi';

export type RawSidecar = {
  format: 1;
  uid: string;
  start_epoch_us: number;
  live_directory: string | null;
};

type Capture = {
  uid: string;
  handle: number;
  rawPath: string;
  sidecarPath: string;
  sidecar: RawSidecar;
};

export function rawPaths(uid: string, startEpochUs: number): { raw: string; sidecar: string } {
  const stem = `${PATHS.rawDir}/${uid}-${Math.trunc(startEpochUs)}`;
  return { raw: `${stem}${NHRAW_SUFFIX}`, sidecar: `${stem}.json` };
}

export class RawCaptures {
  private readonly captures = new Map<string, Capture>();

  constructor(
    private readonly native: HostRaw & HostFiles,
    private readonly logger: Logger,
  ) {}

  has(uid: string): boolean {
    return this.captures.has(uid.toUpperCase());
  }

  uids(): string[] {
    return [...this.captures.keys()];
  }

  /** Starts capturing `uid`, with `knowledge` (recordingKnowledgeEvent) as the first record. */
  start(uid: string, startEpochUs: number, knowledge: Record<string, unknown>): void {
    const key = uid.toUpperCase();
    if (this.captures.has(key)) return;
    const paths = rawPaths(key, startEpochUs);
    this.native.mkdirp(PATHS.rawDir);
    const sidecar: RawSidecar = { format: 1, uid: key, start_epoch_us: Math.trunc(startEpochUs), live_directory: null };
    this.native.writeAtomic(paths.sidecar, JSON.stringify(sidecar));
    const handle = this.native.rawStart(key, paths.raw, Math.trunc(startEpochUs), encodeNhrawEvent(knowledge));
    this.captures.set(key, { uid: key, handle, rawPath: paths.raw, sidecarPath: paths.sidecar, sidecar });
  }

  /** An event record (NHRAW.md), stamped now by native. */
  event(uid: string, event: Record<string, unknown>): void {
    const capture = this.captures.get(uid.toUpperCase());
    if (capture === undefined) return;
    try {
      this.native.rawAppend(capture.handle, RAW_SOURCE.event, encodeNhrawEvent(event));
    } catch (error) {
      this.logger.warn(`nhraw ${capture.uid}: ${errorText(error)}`);
    }
  }

  /** A control datagram from the device (app_events replies, joined on conversion). */
  control(uid: string, datagram: Uint8Array): void {
    const capture = this.captures.get(uid.toUpperCase());
    if (capture === undefined) return;
    try {
      this.native.rawAppend(capture.handle, RAW_SOURCE.control, datagram);
    } catch (error) {
      this.logger.warn(`nhraw ${capture.uid}: ${errorText(error)}`);
    }
  }

  /** The live recording's folder became known (its first frame): remembered for recovery. */
  noteLiveDirectory(uid: string, directory: string): void {
    const capture = this.captures.get(uid.toUpperCase());
    if (capture === undefined || capture.sidecar.live_directory === directory) return;
    capture.sidecar = { ...capture.sidecar, live_directory: directory };
    try {
      this.native.writeAtomic(capture.sidecarPath, JSON.stringify(capture.sidecar));
    } catch (error) {
      this.logger.warn(`nhraw sidecar ${capture.uid}: ${errorText(error)}`);
    }
  }

  liveDirectory(uid: string): string | null {
    return this.captures.get(uid.toUpperCase())?.sidecar.live_directory ?? null;
  }

  /**
   * Ends the capture. keepRaw false (the live recording finished cleanly):
   * the capture and its sidecar are deleted. keepRaw true: both stay for
   * recovery, which is returned the raw's path.
   */
  finish(uid: string, keepRaw: boolean): string | null {
    const key = uid.toUpperCase();
    const capture = this.captures.get(key);
    if (capture === undefined) return null;
    this.captures.delete(key);
    try {
      this.native.rawStop(capture.handle);
    } catch (error) {
      this.logger.warn(`nhraw ${key}: ${errorText(error)}`);
    }
    if (keepRaw) return capture.rawPath;
    try {
      this.native.deletePath(capture.rawPath);
      this.native.deletePath(capture.sidecarPath);
    } catch (error) {
      this.logger.warn(`nhraw cleanup ${key}: ${errorText(error)}`);
    }
    return null;
  }

  flushAll(): void {
    if (this.captures.size === 0) return;
    try {
      this.native.rawFlushAll();
    } catch {
      // reported by rawStats
    }
  }

  /** Write errors native hit (disk full …), by UID. */
  errors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const capture of this.captures.values()) {
      const error = this.native.rawStats(capture.handle)?.error;
      if (error) out[capture.uid] = error;
    }
    return out;
  }

  /** Raw paths being written now (recovery leaves these alone). */
  openRawPaths(): Set<string> {
    return new Set([...this.captures.values()].map((capture) => capture.rawPath));
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
