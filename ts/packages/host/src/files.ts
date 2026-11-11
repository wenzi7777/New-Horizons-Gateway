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

/** How the last NativeJsonStore.load() went. */
export type JsonLoadOutcome =
  /** No file: `defaults` (first run). */
  | 'missing'
  /** Read and parsed. */
  | 'ok'
  /** Unreadable or not JSON: backed up, and `recover` rebuilt a value from what was left. */
  | 'recovered'
  /** Unreadable or not JSON: backed up, `defaults` returned (nothing could be recovered). */
  | 'reset';

export interface NativeJsonStoreOptions<T> {
  /**
   * Rebuilds a value from a file that would not load (its text, or null when
   * it could not be read at all); null when nothing is recoverable. The
   * caller should save what load() returned as soon as it can.
   */
  recover?: (text: string | null) => T | null;
  /** Told about an unreadable file and its backup. */
  warn?: (message: string) => void;
  /** Read attempts before a file counts as unreadable (default 3). */
  readAttempts?: number;
  /** Pause between attempts (default 50 ms). */
  retryDelayMs?: number;
  /** Wall clock for the backup's name (default Date.now). */
  now?: () => number;
}

/** `20261111T031500Z` for a backup name. */
function backupStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * A JSON document in one file, replaced atomically on save. `defaults` is
 * what load() returns when there is no file yet (first run). A file that
 * exists but will not read or parse (after a few tries: a read can fail
 * transiently) is moved aside to `<path>.corrupt-<time>` and loads as what
 * `recover` makes of it, else as the defaults; `lastLoad` says which, so a
 * caller can save the result at once. A damaged file never bricks the app.
 */
export class NativeJsonStore<T> implements JsonStore<T> {
  /** How the last load() went (null before the first). */
  lastLoad: JsonLoadOutcome | null = null;
  /** Where the last unreadable file was moved ('' when it was not / could not be). */
  lastBackup = '';

  constructor(
    private readonly native: HostFiles,
    private readonly path: string,
    private readonly defaults: (() => T) | null = null,
    private readonly options: NativeJsonStoreOptions<T> = {},
  ) {}

  async load(): Promise<T | null> {
    this.lastBackup = '';
    let exists: boolean;
    try {
      exists = this.native.fileExists(this.path);
    } catch {
      exists = true; // cannot tell: treat as present, so a read is tried
    }
    if (!exists) {
      this.lastLoad = 'missing';
      return this.defaults ? this.defaults() : null;
    }
    const attempts = Math.max(1, this.options.readAttempts ?? 3);
    let text: string | null = null;
    let problem = '';
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? 50));
      try {
        text = this.native.readText(this.path);
      } catch (error) {
        text = null;
        problem = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (text === null) {
        // Gone between the check and the read: a first run after all.
        if (!this.safeExists()) {
          this.lastLoad = 'missing';
          return this.defaults ? this.defaults() : null;
        }
        problem = 'unreadable';
        continue;
      }
      try {
        const value = JSON.parse(text) as T;
        this.lastLoad = 'ok';
        return value;
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
    }
    this.backup();
    const warn = this.options.warn;
    const recovered = this.options.recover ? this.options.recover(text) : null;
    warn?.(`${this.path} would not load (${problem}); ${this.lastBackup ? `kept as ${this.lastBackup}` : 'could not back it up'}`);
    if (recovered !== null) {
      this.lastLoad = 'recovered';
      return recovered;
    }
    this.lastLoad = 'reset';
    return this.defaults ? this.defaults() : null;
  }

  async save(value: T): Promise<void> {
    this.native.writeAtomic(this.path, `${JSON.stringify(value, null, 2)}\n`);
  }

  private safeExists(): boolean {
    try {
      return this.native.fileExists(this.path);
    } catch {
      return false;
    }
  }

  /** Moves the bad file aside so the next save does not overwrite the only copy. */
  private backup(): void {
    const target = `${this.path}.corrupt-${backupStamp((this.options.now ?? Date.now)())}`;
    try {
      if (this.native.movePath(this.path, target)) this.lastBackup = target;
    } catch {
      this.lastBackup = '';
    }
  }
}
