import { describe, expect, it } from 'vitest';

import {
  fitProfileRect, isLegacyProfile, nearestSensorIndex, normalizeLegacyProfile, normalizeProfile, parseAssignments, profilePlane, profilePoints,
  profilePointToScreen, profilePointToWorld, ProfileStore, sanitizeProfileName, stringifyProfile, zoomStageAt, type ProfileFs,
} from '../src/profiles';

// Ported from the Desktop's profileLayout behaviour.
describe('profile layout', () => {
  it('fits a wide container by height and centres', () => {
    const r = fitProfileRect(400, 200, 1);
    expect(r).toMatchObject({ drawWidth: 200, drawHeight: 200, offsetX: 100, offsetY: 0 });
  });
  it('fits a tall container by width', () => {
    const r = fitProfileRect(200, 400, 2);
    expect(r).toMatchObject({ drawWidth: 200, drawHeight: 100, offsetX: 0, offsetY: 150 });
  });
  it('handles an empty container and a bad aspect', () => {
    expect(fitProfileRect(0, 100, 1)).toMatchObject({ drawWidth: 0, drawHeight: 0 });
    expect(fitProfileRect(100, 100, 0).aspectRatio).toBe(1);
  });
  it('maps ratios to screen and world, clamped', () => {
    const r = fitProfileRect(400, 200, 1);
    expect(profilePointToScreen(0.5, 0.5, r)).toEqual({ left: 200, top: 100 });
    expect(profilePointToScreen(2, -1, r)).toEqual({ left: 300, top: 0 });
    expect(profilePointToScreen(NaN, 0, r).left).toBe(200);
    expect(profilePointToWorld(1, 0, 10, 4)).toEqual({ worldX: 5, worldZ: -2 });
  });
  it('finds the nearest sensor within the radius', () => {
    const s = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }];
    expect(nearestSensorIndex(s, 0.52, 0.5)).toBe(1);
    expect(nearestSensorIndex(s, 0.9, 0.9)).toBe(-1);
  });
  it('zooms around a point', () => {
    const v = zoomStageAt({ zoom: 1, panX: 0, panY: 0 }, 100, 50, 2);
    expect(v).toEqual({ zoom: 2, panX: -100, panY: -50 });
    expect(zoomStageAt({ zoom: 12, panX: 0, panY: 0 }, 0, 0, 2).zoom).toBe(12);
  });
  it('builds live points from enabled sensors present in the frame', () => {
    const p = normalizeProfile({ sensors: [{ index: 0, x: 0.2, y: 0.3 }, { index: 5, x: 0, y: 0 }, { index: 1, enabled: false }] });
    expect(profilePoints(p, [7, 8])).toEqual([{ index: 0, value: 7, xRatio: 0.2, yRatio: 0.3, label: 'P1' }]);
    expect(profilePoints(null, [1])).toEqual([]);
    expect(profilePlane(5, 7, 0.5)).toEqual({ planeWidth: 2, planeHeight: 4 });
  });
});

describe('profile format', () => {
  it('normalizes with Desktop defaults and keeps unknown fields', () => {
    const p = normalizeProfile({ future: 1, matrix: { rows: '3', extra: true }, sensors: [{ x: 2, tag: 'a' }], display: { pressure_min: 50, pressureMax: 10 } });
    expect(p.future).toBe(1);
    expect(p.matrix).toEqual({ rows: 3, cols: 21, extra: true });
    expect(p.sensors[0]).toEqual({ index: 0, x: 1, y: 0.5, label: 'P1', enabled: true, tag: 'a' });
    expect(p.display).toMatchObject({ mode: '3d', pressureMin: 50, pressureMax: 51, dotSize: 1 });
  });
  it('writes sorted, indented, ASCII-only JSON with rounded ratios', () => {
    const text = stringifyProfile(normalizeProfile({ name: 'Glöve', sensors: [{ x: 0.1234567891, y: 0.5 }] }));
    expect(text).toContain('"name": "Gl\\u00f6ve"');
    expect(text).toContain('"x": 0.123457');
    expect(text.indexOf('"activeCols"')).toBeLessThan(text.indexOf('"version"'));
  });
  it('sanitizes names like the backend', () => {
    expect(sanitizeProfileName(' a b/c ')).toBe('a_b_c');
    expect(sanitizeProfileName('')).toBe('profile');
  });
  it('converts legacy profiles (profile_import.py)', () => {
    const legacy = { sensors: [{ x: 0.2, y: 0.3 }], display: { mode: '2d', dot_size: 9 } };
    expect(isLegacyProfile(legacy)).toBe(true);
    const p = normalizeLegacyProfile(legacy, 'LeftInsole_5_7');
    expect(p).toMatchObject({ name: 'LeftInsole_5_7', deviceType: 'insole', matrix: { rows: 5, cols: 7 }, display: { mode: '2d', dotSize: 4 } });
  });
  it('parses assignments, dropping bad entries', () => {
    expect(parseAssignments({ assignments: { 'ab:cd': 'x', EF: '../bad' } })).toEqual({ ABCD: 'x' });
  });
});

export function memoryFs(): ProfileFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    list: (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    readText: (p) => {
      const t = files.get(p);
      if (t === undefined) throw new Error('ENOENT');
      return t;
    },
    writeAtomic: (p, t) => void files.set(p, t),
    remove: (p) => void files.delete(p),
    exists: (p) => files.has(p),
    mtimeMs: () => 1,
    join: (...parts) => parts.join('/'),
  };
}

describe('ProfileStore', () => {
  it('round-trips and preserves unknown fields of the file on disk', () => {
    const fs = memoryFs();
    const store = new ProfileStore(fs, () => '/data');
    fs.files.set('/data/profiles/a.json', JSON.stringify({ name: 'a', serverOnly: { k: 1 }, sensors: [{ index: 2, x: 0.1, y: 0.2, label: 'P3', enabled: true, color: 'red' }] }));
    const p = store.get('a');
    p.sensors[0]!.x = 0.4;
    delete (p as Record<string, unknown>).serverOnly;
    store.save('a', p);
    const back = JSON.parse(fs.files.get('/data/profiles/a.json')!);
    expect(back.serverOnly).toEqual({ k: 1 });
    expect(back.sensors[0]).toMatchObject({ x: 0.4, color: 'red' });
    expect(store.get('a')).toEqual(normalizeProfile(back));
    expect(store.list()).toMatchObject([{ name: 'a', sensorCount: 1, rows: 10, cols: 21 }]);
  });
  it('duplicates, renames, imports, removes; refuses path names', () => {
    const store = new ProfileStore(memoryFs(), () => '/d');
    store.save('x', normalizeProfile({ name: 'x' }));
    expect(store.duplicate('x')).toBe('x_copy');
    expect(store.duplicate('x')).toBe('x_copy_2');
    expect(store.rename('x_copy', 'y')).toBe('y');
    expect(store.get('y').name).toBe('y');
    expect(() => store.rename('y', 'x')).toThrow('profile_exists');
    expect(store.importText(JSON.stringify({ sensors: [] }), 'Right_5_5.json')).toBe('Right_5_5');
    expect(store.get('Right_5_5').matrix).toMatchObject({ rows: 5, cols: 5 });
    store.remove('y');
    expect(store.has('y')).toBe(false);
    expect(() => store.get('../etc')).toThrow('invalid_profile_name');
  });
});
