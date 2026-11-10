// The host's file API (HostFiles) on node:fs, rooted at one folder -- the
// same rules as NH Pocket's NhFiles.kt: paths are '/'-separated and relative
// to the root; an absolute path, a backslash or a ".." segment is refused.
// Every call is synchronous (the engine's RecordingFileSink is); appends are
// buffered per handle (64 KiB) and reach the disk on flush() or when the
// buffer fills.
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

import type { HostFiles, NativeFileInfo } from '@nhgw/host';

import { writeZip, type ZipEntrySource } from './zip';

export const FILE_BUFFER_BYTES = 64 * 1024;
/** Exports older than this are deleted when the next one is made. */
const EXPORT_TTL_MS = 3_600_000;

/** A relative '/'-path under root, or throws `invalid_path`. */
export function resolveUnder(root: string, path: string): string {
  if (path === '') return root;
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path) || path.split('/').some((part) => part === '..')) {
    throw new Error(`invalid_path: ${path}`);
  }
  return join(root, ...path.split('/').filter((part) => part !== '' && part !== '.'));
}

function describe(name: string, info: Stats): NativeFileInfo {
  return { name, isDirectory: info.isDirectory(), size: info.isFile() ? info.size : 0, mtimeMs: info.mtimeMs };
}

type OpenFile = { fd: number; pending: Buffer[]; pendingBytes: number };

export class NodeFiles implements HostFiles {
  private readonly handles = new Map<number, OpenFile>();
  protected nextHandle = 1;

  /**
   * @param root the folder all paths are relative to (created on demand)
   * @param exportDir where zipDir() writes (a temp folder)
   */
  constructor(
    readonly root: string,
    readonly exportDir: string,
  ) {}

  resolve(path: string): string {
    return resolveUnder(this.root, path);
  }

  fileExists(path: string): boolean {
    return existsSync(this.resolve(path));
  }

  mkdirp(path: string): void {
    mkdirSync(this.resolve(path), { recursive: true });
  }

  fileSize(path: string): number {
    try {
      const info = statSync(this.resolve(path));
      return info.isFile() ? info.size : -1;
    } catch {
      return -1;
    }
  }

  fileOpen(path: string): number {
    const full = this.resolve(path);
    mkdirSync(join(full, '..'), { recursive: true });
    const fd = openSync(full, 'a');
    const handle = this.nextHandle++;
    this.handles.set(handle, { fd, pending: [], pendingBytes: 0 });
    return handle;
  }

  private file(handle: number): OpenFile {
    const file = this.handles.get(handle);
    if (file === undefined) throw new Error('I/O operation on closed file.');
    return file;
  }

  fileAppend(handle: number, text: string): void {
    const file = this.file(handle);
    const bytes = Buffer.from(text, 'utf8');
    file.pending.push(bytes);
    file.pendingBytes += bytes.length;
    if (file.pendingBytes >= FILE_BUFFER_BYTES) this.drain(file);
  }

  private drain(file: OpenFile): void {
    if (file.pendingBytes === 0) return;
    const bytes = file.pending.length === 1 ? file.pending[0]! : Buffer.concat(file.pending, file.pendingBytes);
    file.pending = [];
    file.pendingBytes = 0;
    let done = 0;
    while (done < bytes.length) done += writeSync(file.fd, bytes, done, bytes.length - done);
  }

  fileFlush(handle: number): void {
    this.drain(this.file(handle));
  }

  fileClose(handle: number): void {
    const file = this.handles.get(handle);
    if (file === undefined) return;
    this.handles.delete(handle);
    try {
      this.drain(file);
    } finally {
      closeSync(file.fd);
    }
  }

  /** Flushes and closes every open file (quit). */
  closeAll(): void {
    for (const handle of [...this.handles.keys()]) {
      try {
        this.fileClose(handle);
      } catch {
        // best effort
      }
    }
  }

  /** `<name>.<random>.tmp` written, fsynced and renamed over `path`. */
  writeAtomic(path: string, text: string): void {
    const full = this.resolve(path);
    mkdirSync(join(full, '..'), { recursive: true });
    const tmp = `${full}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      const fd = openSync(tmp, 'w');
      try {
        const bytes = Buffer.from(text, 'utf8');
        let done = 0;
        while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, full);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  readText(path: string): string | null {
    const full = this.resolve(path);
    try {
      if (!statSync(full).isFile()) return null;
      return readFileSync(full, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  readBytes(path: string, offset: number, length: number): Uint8Array {
    const fd = openSync(this.resolve(path), 'r');
    try {
      const size = statSync(this.resolve(path)).size;
      const n = Math.max(0, Math.min(length, size - offset));
      const out = Buffer.alloc(n);
      let done = 0;
      while (done < n) {
        const read = readSync(fd, out, done, n - done, offset + done);
        if (read === 0) break;
        done += read;
      }
      return new Uint8Array(out.buffer, out.byteOffset, done);
    } finally {
      closeSync(fd);
    }
  }

  stat(path: string): NativeFileInfo | null {
    const full = this.resolve(path);
    try {
      return describe(path.slice(path.lastIndexOf('/') + 1) || full.split(sep).pop() || '', statSync(full));
    } catch {
      return null;
    }
  }

  listDir(path: string): NativeFileInfo[] {
    const full = this.resolve(path);
    const out: NativeFileInfo[] = [];
    for (const name of readdirSync(full).sort()) {
      try {
        out.push(describe(name, statSync(join(full, name))));
      } catch {
        // vanished meanwhile
      }
    }
    return out;
  }

  deletePath(path: string): boolean {
    const full = this.resolve(path);
    if (!existsSync(full)) return false;
    rmSync(full, { recursive: true, force: true });
    return true;
  }

  movePath(from: string, to: string): boolean {
    const target = this.resolve(to);
    try {
      mkdirSync(join(target, '..'), { recursive: true });
      renameSync(this.resolve(from), target);
      return true;
    } catch {
      return false;
    }
  }

  treeSize(path: string): number {
    const walk = (full: string): number => {
      let info: Stats;
      try {
        info = statSync(full);
      } catch {
        return 0;
      }
      if (info.isFile()) return info.size;
      if (!info.isDirectory()) return 0;
      let total = 0;
      for (const name of readdirSync(full)) total += walk(join(full, name));
      return total;
    };
    return walk(this.resolve(path));
  }

  freeBytes(): number {
    // The root may not exist yet: ask about the nearest existing parent.
    let dir = this.root;
    while (!existsSync(dir)) {
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    const info = statfsSync(dir);
    return Number(info.bavail) * Number(info.bsize);
  }

  /**
   * Zips the folder at `path` (entries `<folder>/<relative path>`, as
   * NhFiles.zipDir) into `<exportDir>/<zipName>`, skipping `skipSuffix`
   * (the raw capture) and `.tmp` files; resolves with the zip's absolute path.
   */
  async zipDir(path: string, zipName: string, skipSuffix: string): Promise<string> {
    const dir = this.resolve(path);
    if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new Error(`not_a_directory: ${path}`);
    if (!zipName || zipName.includes('/') || zipName.includes('\\') || zipName.includes('..')) throw new Error('invalid_zip_name');
    await mkdir(this.exportDir, { recursive: true });
    const now = Date.now();
    for (const name of await readdir(this.exportDir)) {
      const info = await stat(join(this.exportDir, name)).catch(() => null);
      if (info && now - info.mtimeMs > EXPORT_TTL_MS) await rm(join(this.exportDir, name), { force: true, recursive: true });
    }
    const base = path.split('/').filter(Boolean).pop() ?? 'recording';
    const entries: ZipEntrySource[] = [];
    const walk = async (full: string, rel: string) => {
      for (const entry of (await readdir(full, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const child = join(full, entry.name);
        const name = `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(child, name);
        else if (entry.isFile()) {
          if (skipSuffix && entry.name.endsWith(skipSuffix)) continue;
          if (entry.name.endsWith('.tmp')) continue;
          entries.push({ name, path: child });
        }
      }
    };
    await walk(dir, base);
    const zipPath = join(this.exportDir, zipName);
    try {
      await writeZip(zipPath, entries);
    } catch (error) {
      await rm(zipPath, { force: true });
      throw error;
    }
    return zipPath;
  }
}
