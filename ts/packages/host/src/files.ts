// The engine's file ports on the native file API: the recording sink
// (RecordingFileSink) and JSON documents (core's JsonStore).
import type { JsonStore } from '@nhgw/core';
import type { RecordingFileHandle, RecordingFileSink } from '@nhgw/engine';

import type { HostFiles } from './nativeApi';

/** Where things live, relative to the native files root. */
export const PATHS = {
  /** `<UID>/<YYYYMMDD>/<HHMMSS>/...`, as on the Desktop. */
  dataRoot: 'recordings',
  /** `.nhraw` captures in progress (and their sidecars) until the recording is finished. */
  rawDir: 'recordings/.raw',
  config: 'config/pocket.json',
  nicknames: 'config/device_nicknames.json',
  groups: 'config/device_groups.json',
} as const;

export const NHRAW_SUFFIX = '.nhraw';

/**
 * RecordingFileSink on the native module. Every call is synchronous, as the
 * engine expects; native buffers appends (64 KiB) until flush().
 */
export class NativeRecordingSink implements RecordingFileSink {
  constructor(private readonly native: HostFiles) {}

  exists(path: string): boolean {
    return this.native.fileExists(path);
  }

  mkdirp(path: string): void {
    this.native.mkdirp(path);
  }

  open(path: string): RecordingFileHandle {
    const native = this.native;
    const size = Math.max(0, native.fileSize(path));
    const handle = native.fileOpen(path);
    let closed = false;
    return {
      size,
      append(text: string) {
        if (closed) throw new Error('I/O operation on closed file.');
        native.fileAppend(handle, text);
      },
      flush() {
        if (!closed) native.fileFlush(handle);
      },
      close() {
        if (closed) return;
        closed = true;
        native.fileClose(handle);
      },
    };
  }

  writeAtomic(path: string, text: string): void {
    this.native.writeAtomic(path, text);
  }
}

/**
 * A JSON document in one file, replaced atomically on save. `defaults` is
 * what load() returns when there is no file yet (first run); an unreadable
 * file also loads as the defaults, so a damaged config never bricks the app.
 */
export class NativeJsonStore<T> implements JsonStore<T> {
  constructor(
    private readonly native: HostFiles,
    private readonly path: string,
    private readonly defaults: (() => T) | null = null,
  ) {}

  async load(): Promise<T | null> {
    let text: string | null = null;
    try {
      text = this.native.readText(this.path);
    } catch {
      text = null;
    }
    if (text !== null) {
      try {
        return JSON.parse(text) as T;
      } catch {
        // fall through to the defaults
      }
    }
    return this.defaults ? this.defaults() : null;
  }

  async save(value: T): Promise<void> {
    this.native.writeAtomic(this.path, `${JSON.stringify(value, null, 2)}\n`);
  }
}
