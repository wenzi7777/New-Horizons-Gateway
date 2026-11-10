// A small streaming zip writer (no npm dependencies): each file is deflated
// with node:zlib's raw deflate while its CRC-32 is computed, written with a
// data descriptor (general purpose bit 3) so nothing is read twice or held in
// memory, then the central directory. Plain zip, not zip64: an archive or a
// file of 4 GiB or more is refused (`zip_too_large`), which is ~20 hours of a
// 112-sensor recording at 60 fps.
import { createReadStream } from 'node:fs';
import { open, type FileHandle, stat } from 'node:fs/promises';
import { createDeflateRaw } from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const VERSION_NEEDED = 20; // deflate
const VERSION_MADE_BY = (3 << 8) | 20; // Unix, 2.0 (keeps names as given)
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_DEFLATE = 8;
const LIMIT = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (zip / PNG polynomial), continued from `crc` (0 to start). */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date of a local time (zip's timestamps; 2 s resolution, 1980..2107). */
export function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipEntrySource {
  /** Name inside the archive, '/'-separated. */
  name: string;
  /** Absolute path of the file on disk. */
  path: string;
}

type Written = { name: Uint8Array; crc: number; compressed: number; size: number; offset: number; time: number; date: number };

class Output {
  position = 0;
  constructor(private readonly handle: FileHandle) {}
  async write(bytes: Uint8Array): Promise<void> {
    let done = 0;
    while (done < bytes.length) {
      const { bytesWritten } = await this.handle.write(bytes, done, bytes.length - done, this.position);
      done += bytesWritten;
      this.position += bytesWritten;
    }
  }
}

async function writeEntry(out: Output, entry: ZipEntrySource): Promise<Written> {
  const info = await stat(entry.path);
  const name = new TextEncoder().encode(entry.name);
  const { time, date } = dosDateTime(info.mtime);
  const offset = out.position;
  if (offset > LIMIT) throw new Error('zip_too_large');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_HEADER, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 6);
  header.writeUInt16LE(METHOD_DEFLATE, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  // crc, sizes: 0 here, in the data descriptor
  header.writeUInt16LE(name.length, 26);
  await out.write(header);
  await out.write(name);

  let crc = 0;
  let size = 0;
  let compressed = 0;
  const deflate = createDeflateRaw({ level: 6 });
  const pump = (async () => {
    for await (const chunk of deflate as AsyncIterable<Buffer>) {
      compressed += chunk.length;
      await out.write(chunk);
    }
  })();
  try {
    for await (const chunk of createReadStream(entry.path) as AsyncIterable<Buffer>) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      if (!deflate.write(chunk)) await new Promise<void>((resolve) => deflate.once('drain', () => resolve()));
    }
    deflate.end();
    await pump;
  } catch (error) {
    deflate.destroy();
    await pump.catch(() => undefined);
    throw error;
  }
  if (size > LIMIT || compressed > LIMIT) throw new Error('zip_too_large');

  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressed, 8);
  descriptor.writeUInt32LE(size, 12);
  await out.write(descriptor);
  return { name, crc, compressed, size, offset, time, date };
}

/** Writes `entries` (in order) as a zip at `zipPath`, replacing it. Returns the archive's size. */
export async function writeZip(zipPath: string, entries: readonly ZipEntrySource[]): Promise<number> {
  if (entries.length > 0xffff) throw new Error('zip_too_many_entries');
  const handle = await open(zipPath, 'w');
  try {
    const out = new Output(handle);
    const written: Written[] = [];
    for (const entry of entries) written.push(await writeEntry(out, entry));
    const centralStart = out.position;
    for (const item of written) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_HEADER, 0);
      header.writeUInt16LE(VERSION_MADE_BY, 4);
      header.writeUInt16LE(VERSION_NEEDED, 6);
      header.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 8);
      header.writeUInt16LE(METHOD_DEFLATE, 10);
      header.writeUInt16LE(item.time, 12);
      header.writeUInt16LE(item.date, 14);
      header.writeUInt32LE(item.crc, 16);
      header.writeUInt32LE(item.compressed, 20);
      header.writeUInt32LE(item.size, 24);
      header.writeUInt16LE(item.name.length, 28);
      // extra 30, comment 32, disk 34, internal attrs 36: 0
      header.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
      header.writeUInt32LE(item.offset, 42);
      await out.write(header);
      await out.write(item.name);
    }
    const centralSize = out.position - centralStart;
    if (centralStart > LIMIT || out.position > LIMIT) throw new Error('zip_too_large');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL, 0);
    end.writeUInt16LE(written.length, 8);
    end.writeUInt16LE(written.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    await out.write(end);
    return out.position;
  } finally {
    await handle.close();
  }
}

/** The entries of a zip's central directory (name, sizes, crc), read back (tests, and a check after export). */
export function readCentralDirectory(zip: Uint8Array): { name: string; crc: number; compressed: number; size: number; offset: number }[] {
  const view = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = view.length - 22; i >= Math.max(0, view.length - 22 - 0xffff); i--) {
    if (view.readUInt32LE(i) === END_OF_CENTRAL) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('zip: no end of central directory');
  const count = view.readUInt16LE(end + 10);
  let at = view.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (view.readUInt32LE(at) !== CENTRAL_HEADER) throw new Error('zip: bad central header');
    const nameLength = view.readUInt16LE(at + 28);
    const extra = view.readUInt16LE(at + 30);
    const comment = view.readUInt16LE(at + 32);
    out.push({
      name: view.toString('utf8', at + 46, at + 46 + nameLength),
      crc: view.readUInt32LE(at + 16),
      compressed: view.readUInt32LE(at + 20),
      size: view.readUInt32LE(at + 24),
      offset: view.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}
