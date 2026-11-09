// scripts/build-sea.mjs argument handling and plan (--dry-run): no SEA is built here.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsRoot = resolve(packageDir, '..', '..');
const script = join(packageDir, 'scripts', 'build-sea.mjs');

function runScript(args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: tsRoot });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function plan(args: string[]) {
  const result = runScript(['--dry-run', '--json', ...args]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    entry: string;
    platformKey: string;
    node: string;
    bundle: string;
    output: string;
    removeSignature: boolean;
    adhocSign: boolean;
    postject: { resource: string; sentinelFuse: string; machoSegmentName?: string };
    seaConfig: { main: string; output: string; disableExperimentalSEAWarning: boolean; assets: Record<string, string> };
  };
}

describe('build-sea.mjs', () => {
  it('defaults: src/cli.ts, dist/<platform>-<arch>, this node', () => {
    const p = plan([]);
    expect(p.entry).toBe(join(packageDir, 'src', 'cli.ts'));
    expect(p.platformKey).toBe(`${process.platform}-${process.arch}`);
    expect(p.node).toBe(process.execPath);
    const name = process.platform === 'win32' ? 'nh-gateway.exe' : 'nh-gateway';
    expect(p.output).toBe(join(tsRoot, 'dist', p.platformKey, name));
    expect(p.seaConfig.main).toBe(p.bundle);
    expect(p.seaConfig.disableExperimentalSEAWarning).toBe(true);
    expect(p.postject.resource).toBe('NODE_SEA_BLOB');
    expect(p.postject.sentinelFuse).toBe('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
  });

  it('embeds tokens.css and the web UI files as SEA assets', () => {
    const assets = plan([]).seaConfig.assets;
    expect(assets['tokens.css']).toBe(join(tsRoot, 'packages', 'ui-tokens', 'src', 'tokens.css'));
    for (const [name, file] of Object.entries(assets)) {
      if (name === 'tokens.css') continue;
      expect(file).toBe(join(packageDir, 'webui', ...name.split('/')));
    }
  });

  it('macOS: Mach-O segment and both codesign steps; --no-sign skips them', () => {
    const mac = plan(['--platform-key', 'darwin-x64']);
    expect(mac.postject.machoSegmentName).toBe('NODE_SEA');
    expect(mac.removeSignature).toBe(true);
    expect(mac.adhocSign).toBe(true);
    expect(mac.output.endsWith(join('dist', 'darwin-x64', 'nh-gateway'))).toBe(true);
    const unsigned = plan(['--platform-key=darwin-arm64', '--no-sign']);
    expect(unsigned.removeSignature).toBe(false);
    expect(unsigned.adhocSign).toBe(false);
  });

  it('Windows and Linux: .exe name, no Mach-O segment, no codesign', () => {
    const win = plan(['--platform-key', 'win32-x64', '--name', 'gw']);
    expect(win.output.endsWith(join('win32-x64', 'gw.exe'))).toBe(true);
    expect(win.postject.machoSegmentName).toBeUndefined();
    expect(win.removeSignature).toBe(false);
    const linux = plan(['--platform-key', 'linux-arm64']);
    expect(linux.output.endsWith(join('linux-arm64', 'nh-gateway'))).toBe(true);
    expect(linux.adhocSign).toBe(false);
  });

  it('resolves --entry, --out-dir and --node against the working directory', () => {
    const p = plan(['--entry', 'some/entry.ts', '--out-dir', 'out/here', '--node', 'bin/node']);
    expect(p.entry).toBe(join(tsRoot, 'some', 'entry.ts'));
    expect(p.output).toBe(join(tsRoot, 'out', 'here', process.platform === 'win32' ? 'nh-gateway.exe' : 'nh-gateway'));
    expect(p.node).toBe(join(tsRoot, 'bin', 'node'));
  });

  it('rejects unknown flags and flags without a value', () => {
    const unknown = runScript(['--bogus']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown argument: --bogus');
    const missing = runScript(['--entry']);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('--entry needs a value');
    const flagAsValue = runScript(['--out-dir', '--dry-run']);
    expect(flagAsValue.status).toBe(2);
  });

  it('fails clearly when the entry does not exist', () => {
    const result = runScript(['--entry', 'does/not/exist.ts']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('entry not found');
  });

  it('--help prints usage', () => {
    const result = runScript(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('usage: build-sea.mjs');
  });
});
