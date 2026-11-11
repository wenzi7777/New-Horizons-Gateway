// A CSV picked from disk (a Desktop export) brings its events sidecar and meta file along.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { siblingFilesOf } from '../../src/main/areas/tools';

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'nh-siblings-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe('siblingFilesOf', () => {
  it('finds <base>.events.csv and <base>.meta.json beside <base>.data.csv', async () => {
    const dir = folder({ '062756.data.csv': 'x', '062756.events.csv': 'e', '062756.meta.json': '{"format":1,"device":{"hardware_model":"TIA-CTL v2.0.F 2026.10"}}' });
    const found = await siblingFilesOf(join(dir, '062756.data.csv'));
    expect(found.events).toBe(join(dir, '062756.events.csv'));
    expect(found.meta?.format).toBe(1);
  });

  it('works for a pre-v0.27 <base>.csv and ignores other recordings in the folder', async () => {
    const dir = folder({ '010101.csv': 'x', '010101.events.csv': 'e', '020202.events.csv': 'other', '020202.meta.json': '{"format":1}' });
    const found = await siblingFilesOf(join(dir, '010101.csv'));
    expect(found.events).toBe(join(dir, '010101.events.csv'));
    expect(found.meta).toBeNull();
  });

  it('follows meta.files.data when the files were renamed', async () => {
    const dir = folder({ 'run-a.data.csv': 'x', 'whatever.meta.json': '{"format":1,"files":{"data":"run-a.data.csv"}}' });
    const found = await siblingFilesOf(join(dir, 'run-a.data.csv'));
    expect(found.events).toBeNull();
    expect(found.meta?.files).toEqual({ data: 'run-a.data.csv' });
  });

  it('is empty for a lone CSV and for a folder that cannot be read', async () => {
    const dir = folder({ 'only.data.csv': 'x' });
    expect(await siblingFilesOf(join(dir, 'only.data.csv'))).toEqual({ events: null, meta: null });
    expect(await siblingFilesOf(join(dir, 'missing', 'a.csv'))).toEqual({ events: null, meta: null });
  });
});
