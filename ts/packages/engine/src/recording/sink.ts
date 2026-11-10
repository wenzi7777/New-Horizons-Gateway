// The file system a recording needs, injected: Node implements it with fs,
// the Android host with its native module, tests and convertRaw() with
// MemoryRecordingSink. Paths are '/'-separated strings under the host's data
// root; text is written as UTF-8.
//
// Every method is synchronous and may throw; a throw is what an OSError was
// in Python (a data-file failure ends the recording with
// "write_error: <message>", a meta or events failure is ignored, as there).
// A host whose real I/O is asynchronous may queue the work, as long as it
// keeps the order of calls per path and reports a failure on a later call.

/** An open file, appended to. */
export interface RecordingFileHandle {
  /** Bytes in the file when it was opened (0 for a new file). */
  readonly size: number;
  append(text: string): void;
  /** Push buffered text to storage (called about once a second while recording). */
  flush(): void;
  close(): void;
}

export interface RecordingFileSink {
  /** Whether a file or directory exists at `path`. */
  exists(path: string): boolean;
  /** mkdir -p. */
  mkdirp(path: string): void;
  /** Opens `path` for appending, creating it if missing. */
  open(path: string): RecordingFileHandle;
  /**
   * Replaces `path` with `text` atomically (Python wrote `<path>.tmp` and
   * os.replace()d it), so a reader never sees half a file.
   */
  writeAtomic(path: string, text: string): void;
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** An in-memory file system: tests, and convertRaw() before the files are handed out. */
export class MemoryRecordingSink implements RecordingFileSink {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  exists(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path);
  }

  mkdirp(path: string): void {
    let current = path;
    while (current && !this.dirs.has(current)) {
      this.dirs.add(current);
      current = dirname(current);
    }
  }

  open(path: string): RecordingFileHandle {
    const files = this.files;
    if (!files.has(path)) files.set(path, '');
    let pending = '';
    let closed = false;
    const write = () => {
      if (pending) files.set(path, (files.get(path) ?? '') + pending);
      pending = '';
    };
    return {
      size: utf8Length(files.get(path) ?? ''),
      append(text: string) {
        if (closed) throw new Error('I/O operation on closed file.');
        pending += text;
      },
      flush: write,
      close() {
        write();
        closed = true;
      },
    };
  }

  writeAtomic(path: string, text: string): void {
    this.files.set(path, text);
  }
}

function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}
