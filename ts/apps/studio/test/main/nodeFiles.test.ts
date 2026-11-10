// The file API on node:fs (NhFiles.kt's rules) and the zip writer.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { NativeJsonStore, NativeRecordingSink } from '@nhgw/host';

import { FILE_BUFFER_BYTES, NodeFiles, resolveUnder } from '../../src/main/nodeFiles';
import { crc32, readCentralDirectory, writeZip } from '../../src/main/zip';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function files(): NodeFiles {
  const root = mkdtempSync(join(tmpdir(), 'nh-studio-files-'));
  dirs.push(root);
  return new NodeFiles(join(root, 'data'), join(root, 'export'));
}

describe('NodeFiles', () => {
  it('refuses absolute paths, backslashes and ".." segments', () => {
    expect(() => resolveUnder('/r', '/etc/passwd')).toThrow('invalid_path');
    expect(() => resolveUnder('/r', 'a/../../b')).toThrow('invalid_path');
    expect(() => resolveUnder('/r', 'a\\b')).toThrow('invalid_path');
    expect(() => resolveUnder('/r', 'C:/x')).toThrow('invalid_path');
    expect(resolveUnder('/r', 'a/b.txt')).toBe(join('/r', 'a', 'b.txt'));
    expect(resolveUnder('/r', '')).toBe('/r');
  });

  it('appends through a buffer that reaches the disk on flush, close or when full', () => {
    const fs = files();
    expect(fs.fileSize('rec/a.csv')).toBe(-1);
    const handle = fs.fileOpen('rec/a.csv');
    fs.fileAppend(handle, 'x,y\r\n');
    expect(fs.readText('rec/a.csv')).toBe('');
    fs.fileFlush(handle);
    expect(fs.readText('rec/a.csv')).toBe('x,y\r\n');
    fs.fileAppend(handle, 'z'.repeat(FILE_BUFFER_BYTES));
    expect(fs.fileSize('rec/a.csv')).toBe(5 + FILE_BUFFER_BYTES);
    fs.fileAppend(handle, 'é');
    fs.fileClose(handle);
    fs.fileClose(handle); // twice is fine
    expect(fs.fileSize('rec/a.csv')).toBe(5 + FILE_BUFFER_BYTES + 2);
    expect(() => fs.fileAppend(handle, 'x')).toThrow('I/O operation on closed file.');
    // reopening appends
    const again = fs.fileOpen('rec/a.csv');
    fs.fileAppend(again, '!');
    fs.fileClose(again);
    expect(fs.readText('rec/a.csv')!.endsWith('é!')).toBe(true);
  });

  it('writes atomically (no temp file left) and reads, stats, lists, moves and deletes', () => {
    const fs = files();
    fs.writeAtomic('config/studio.json', '{"a":1}');
    fs.writeAtomic('config/studio.json', '{"a":2}');
    expect(fs.readText('config/studio.json')).toBe('{"a":2}');
    expect(readdirSync(join(fs.root, 'config'))).toEqual(['studio.json']);
    expect(fs.readText('config/missing.json')).toBeNull();
    expect(fs.readText('config')).toBeNull();
    expect(fs.readBytes('config/studio.json', 2, 100)).toEqual(new TextEncoder().encode('a":2}'));
    expect(fs.readBytes('config/studio.json', 100, 10)).toEqual(new Uint8Array(0));
    expect(fs.stat('config/studio.json')).toMatchObject({ name: 'studio.json', isDirectory: false, size: 7 });
    expect(fs.stat('config')).toMatchObject({ name: 'config', isDirectory: true, size: 0 });
    expect(fs.stat('nope')).toBeNull();
    fs.mkdirp('config/sub');
    expect(fs.listDir('config').map((item) => item.name)).toEqual(['studio.json', 'sub']);
    expect(fs.movePath('config/studio.json', 'config/sub/moved.json')).toBe(true);
    expect(fs.fileExists('config/studio.json')).toBe(false);
    expect(fs.treeSize('config')).toBe(7);
    expect(fs.treeSize('nothing')).toBe(0);
    expect(fs.deletePath('config')).toBe(true);
    expect(fs.deletePath('config')).toBe(false);
    expect(fs.freeBytes()).toBeGreaterThan(0);
  });

  it('serves the host’s recording sink and JSON store', async () => {
    const fs = files();
    const sink = new NativeRecordingSink(fs);
    sink.mkdirp('recordings/X');
    const file = sink.open('recordings/X/a.csv');
    expect(file.size).toBe(0);
    file.append('1\r\n');
    file.close();
    expect(sink.open('recordings/X/a.csv').size).toBe(3);
    const store = new NativeJsonStore<{ v: number }>(fs, 'config/x.json', () => ({ v: 0 }));
    expect(await store.load()).toEqual({ v: 0 });
    await store.save({ v: 5 });
    expect(await store.load()).toEqual({ v: 5 });
    writeFileSync(join(fs.root, 'config', 'x.json'), '{broken');
    expect(await store.load()).toEqual({ v: 0 }); // a damaged file loads as the defaults
  });

  it('zips a recording folder (folder/name entries, raw capture and temp files left out) into a valid archive', async () => {
    const fs = files();
    const dir = 'recordings/3CDC7545CCD0/20261110/120000';
    fs.writeAtomic(`${dir}/120000.data.csv`, 'a,b\r\n'.repeat(5000));
    fs.writeAtomic(`${dir}/120000.meta.json`, '{"format":1,"名前":"センサ"}');
    fs.writeAtomic(`${dir}/120000.nhraw`, 'raw');
    fs.writeAtomic(`${dir}/sub/empty.txt`, '');
    writeFileSync(join(fs.resolve(dir), 'x.json.tmp'), 'tmp');
    const zip = await fs.zipDir(dir, '3CDC7545CCD0_20261110_120000.zip', '.nhraw');
    expect(zip).toBe(join(fs.exportDir, '3CDC7545CCD0_20261110_120000.zip'));
    const bytes = new Uint8Array(readFileSync(zip));
    const entries = readCentralDirectory(bytes);
    expect(entries.map((entry) => entry.name)).toEqual(['120000/120000.data.csv', '120000/120000.meta.json', '120000/sub/empty.txt']);
    for (const entry of entries) {
      // Local header (30 + name) then the deflated data.
      const view = Buffer.from(bytes);
      const nameLength = view.readUInt16LE(entry.offset + 26);
      const start = entry.offset + 30 + nameLength + view.readUInt16LE(entry.offset + 28);
      const data = inflateRawSync(view.subarray(start, start + entry.compressed));
      expect(data.length).toBe(entry.size);
      expect(crc32(data)).toBe(entry.crc);
    }
    const unzip = spawnSync('unzip', ['-t', zip], { encoding: 'utf8' });
    if (unzip.error === undefined) {
      expect(unzip.status, unzip.stdout + unzip.stderr).toBe(0);
      expect(unzip.stdout).toMatch(/No errors detected/);
    }
    await expect(fs.zipDir('recordings/missing', 'a.zip', '')).rejects.toThrow('not_a_directory');
    await expect(fs.zipDir(dir, '../a.zip', '')).rejects.toThrow('invalid_zip_name');
  });
});

describe('zip', () => {
  it('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('writes an empty archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nh-studio-zip-'));
    dirs.push(root);
    const path = join(root, 'empty.zip');
    expect(await writeZip(path, [])).toBe(22);
    expect(readCentralDirectory(new Uint8Array(readFileSync(path)))).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });
});
