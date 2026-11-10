import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createProfilesArea } from '../../src/main/areas/profiles';
import type { AreaContext } from '../../src/main/areas';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'nh-profiles-'));
  const data = join(root, 'data');
  const user = join(root, 'user');
  const events: [string, unknown][] = [];
  const picked = { json: null as string | null, save: null as string | null };
  const area = createProfilesArea({
    dialogs: { openJson: async () => picked.json, saveJson: async () => picked.save, openImage: async () => null },
  });
  const ctx = {
    controller: { settings: () => ({ dataFolder: data }), subscribe: () => () => undefined } as unknown as AreaContext['controller'],
    emit: (e: string, p?: unknown) => void events.push([e, p]),
    logger: { info() {}, warn() {}, error() {} },
    userDataDir: user,
    version: 'v0',
  };
  const h = area.register(ctx) as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
  return { root, data, user, events, picked, h };
}

describe('profiles area', () => {
  it('creates, saves, lists and emits changes', async () => {
    const { h, data, events } = setup();
    const name = await h.create!('My Glove');
    expect(name).toBe('My_Glove');
    const p = await h.get!(name);
    p.sensors.push({ index: 0, x: 0.5, y: 0.5, label: 'P1', enabled: true });
    await h.save!(name, p);
    expect((await h.list!())[0]).toMatchObject({ name, sensorCount: 1 });
    expect(JSON.parse(readFileSync(join(data, 'profiles', 'My_Glove.json'), 'utf8')).sensors).toHaveLength(1);
    expect(readdirSync(join(data, 'profiles'))).toEqual(['My_Glove.json']); // no temp files left
    expect(events.filter(([e]) => e === 'changed').length).toBe(2);
  });

  it('keeps assignments across rename and clears them on delete', async () => {
    const { h, user } = setup();
    await h.create!('a');
    expect(await h.assign!('3c:84:aa', 'a')).toEqual({ '3C84AA': 'a' });
    await h.rename!('a', 'b');
    expect(await h.assignments!()).toEqual({ '3C84AA': 'b' });
    expect(JSON.parse(readFileSync(join(user, 'profile-assignments.json'), 'utf8')).assignments).toEqual({ '3C84AA': 'b' });
    await h.remove!('b');
    expect(await h.assignments!()).toEqual({});
    await expect(h.assign!('3C', '../x')).rejects.toThrow('invalid_profile_name');
  });

  it('imports and exports through the dialogs', async () => {
    const { h, root, picked } = setup();
    const src = join(root, 'LeftInsole_5_7.json');
    writeFileSync(src, JSON.stringify({ sensors: [{ x: 0.1, y: 0.2 }] }));
    picked.json = src;
    const name = await h.importFile!();
    expect(name).toBe('LeftInsole_5_7');
    expect((await h.get!(name)).matrix).toMatchObject({ rows: 5, cols: 7 });
    mkdirSync(join(root, 'out'));
    picked.save = join(root, 'out', 'x.json');
    expect(await h.exportFile!(name)).toBe(picked.save);
    expect(JSON.parse(readFileSync(picked.save, 'utf8')).name).toBe('LeftInsole_5_7');
    picked.json = null;
    expect(await h.importFile!()).toBeNull();
  });
});
