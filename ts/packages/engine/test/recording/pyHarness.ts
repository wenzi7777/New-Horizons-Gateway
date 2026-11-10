// Runs test/recording/py/harness.py (the Desktop backend's real Python code)
// on the same inputs the TS tests feed the engine. Tests skip when the
// Desktop checkout or python3 is missing.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const HARNESS = resolve(here, 'py/harness.py');
export const DESKTOP_BACKEND = resolve(here, '../../../../../../New-Horizons-Desktop/backend');
export const OS_REPO = resolve(here, '../../../../../../NewHorizonsOS-OTA');

function pythonWorks(): boolean {
  try {
    return spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)']).status === 0;
  } catch {
    return false;
  }
}

export const hasPython = existsSync(join(DESKTOP_BACKEND, 'newhorizons_backend', 'packet_parser.py')) && pythonWorks();
export const hasFixtures = existsSync(join(OS_REPO, 'spec/fixtures/packets.json'));

export function tempDir(prefix = 'nhrec-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Runs one harness mode; returns its parsed JSON output. */
export function runPython<T = unknown>(mode: string, spec: unknown, options: { outdir?: string; tz?: string } = {}): T {
  const dir = tempDir('nhpy-');
  const input = join(dir, 'input.json');
  writeFileSync(input, JSON.stringify(spec));
  const args = [HARNESS, mode, input, ...(options.outdir ? [options.outdir] : [])];
  const stdout = execFileSync('python3', args, {
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NH_DESKTOP_BACKEND: DESKTOP_BACKEND, ...(options.tz ? { NH_HARNESS_TZ: options.tz } : {}) },
  });
  return JSON.parse(stdout) as T;
}

/** IEEE-754 bits of a double, big-endian hex (how floats travel to the harness). */
export function bits(x: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  let out = '';
  for (let i = 0; i < 8; i++) out += view.getUint8(i).toString(16).padStart(2, '0');
  return out;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
