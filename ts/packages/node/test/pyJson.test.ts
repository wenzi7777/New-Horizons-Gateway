import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { JsonFileStore, serializeJson } from '../src/adapters/jsonStore';
import { CONFIG_FLOAT_KEYS, compareCodePoints, pyJsonDumps } from '../src/pyJson';
import { flaskJson } from '../src/web/server';
import { tempDir } from './helpers';

// Produced by Python 3: json.dumps(c, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
const PY_CONFIG_TEXT =
  '{\n  "control_stale_sec": 16.0,\n  "denied_devices": [],\n  "emptyd": {},\n  "enabled": false,\n  "gateway_id": "gw-1",\n  "gateway_name": "NH Gateway ü",\n  "listen_udp_port": 13250,\n  "nested": {\n    "a": [\n      1,\n      {\n        "z": null\n      }\n    ],\n    "b": 1\n  }\n}\n';
const CONFIG = {
  enabled: false,
  gateway_name: 'NH Gateway ü',
  gateway_id: 'gw-1',
  control_stale_sec: 16,
  denied_devices: [],
  nested: { b: 1, a: [1, { z: null }] },
  listen_udp_port: 13250,
  emptyd: {},
};

describe('pyJsonDumps', () => {
  it('writes config.json byte for byte as config_store.py did', () => {
    expect(serializeJson(CONFIG, { indent: 2, sortKeys: true, ensureAscii: false, floatKeys: CONFIG_FLOAT_KEYS })).toBe(PY_CONFIG_TEXT);
  });

  it('matches Flask jsonify (compact, sorted, ASCII-only, newline)', () => {
    // Python: json.dumps(value, separators=(',', ':'), sort_keys=True) with the default ensure_ascii
    expect(flaskJson({ k: 'ü\u007f\u2028😀', b: [1.5, true] })).toBe('{"b":[1.5,true],"k":"\\u00fc\\u007f\\u2028\\ud83d\\ude00"}\n');
  });

  it('escapes control characters and quotes like Python', () => {
    expect(pyJsonDumps('a"b\\c\n\u0001', { ensureAscii: false })).toBe('"a\\"b\\\\c\\n\\u0001"');
    expect(pyJsonDumps([Number.NaN, Infinity, -Infinity])).toBe('[NaN,Infinity,-Infinity]');
  });

  it('sorts keys by code point', () => {
    expect(['￿', '\u{1F600}', 'a'].sort(compareCodePoints)).toEqual(['a', '￿', '\u{1F600}']);
  });
});

describe('JsonFileStore', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('returns null for a missing file and round-trips a saved one in Python format', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const file = join(t.dir, 'config', 'config.json');
    const store = new JsonFileStore<Record<string, unknown>>(file, { floatKeys: CONFIG_FLOAT_KEYS });
    expect(await store.load()).toBeNull();
    await store.save(CONFIG);
    expect(readFileSync(file, 'utf8')).toBe(PY_CONFIG_TEXT);
    expect(await store.load()).toEqual(CONFIG);
  });

  it('replaces atomically: concurrent saves end with the last, no temp files left', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const file = join(t.dir, 'config.json');
    const store = new JsonFileStore<{ n: number }>(file);
    await Promise.all(Array.from({ length: 20 }, (_, n) => store.save({ n })));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 19 });
    expect(readdirSync(t.dir)).toEqual(['config.json']);
  });

  it('a failed write leaves the old file untouched', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const file = join(t.dir, 'config.json');
    writeFileSync(file, '{"old": true}\n');
    // The target is a directory now: rename fails after the temp file is written.
    const dirTarget = join(t.dir, 'dir.json');
    mkdirSync(join(dirTarget, 'child'), { recursive: true });
    await expect(new JsonFileStore(dirTarget).save({ x: 1 })).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{"old": true}\n');
    expect(readdirSync(t.dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('names the file when it is not JSON', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const file = join(t.dir, 'config.json');
    writeFileSync(file, '{broken');
    await expect(new JsonFileStore(file).load()).rejects.toThrow(file);
  });
});
