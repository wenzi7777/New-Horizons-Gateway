import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '@nhgw/core';
import type { RuntimePaths } from '../src/hostApi';
import {
  cleanupAfterStart,
  createDesktopInstaller,
  DesktopInstaller,
  readUpdateStateSync,
  superviseSwitch,
  superviseSwitchDetailed,
  updateStatePath,
} from '../src/installer';

let root: string;
let paths: RuntimePaths;
let exe: string;

function makePaths(dir: string): RuntimePaths {
  const runDir = join(dir, '.run');
  return {
    root: dir,
    runDir,
    configFile: join(runDir, 'config', 'config.json'),
    logFile: join(runDir, 'logs', 'gateway.log'),
    healthFile: join(runDir, 'health.json'),
    pidFile: join(runDir, 'gateway.pid'),
    downloadsDir: join(runDir, 'downloads'),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nhgw-installer-'));
  paths = makePaths(root);
  mkdirSync(paths.runDir, { recursive: true });
  exe = join(root, 'nh-gateway');
  writeFileSync(exe, 'OLD');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const info = (version: string) => ({ version, platformKey: 'darwin-arm64', url: 'https://example.invalid/gw', sha256: 'ab'.repeat(32), size: 3 });

describe('DesktopInstaller', () => {
  it('refuses to stage when not running as a packaged executable', async () => {
    const installer = createDesktopInstaller({ paths, executable: process.execPath, logger: silentLogger });
    // vitest runs under node, not a SEA.
    await expect(installer.stage(new Uint8Array([1]), info('v2.0.1'))).rejects.toThrow(/packaged Gateway executable/);
    expect(existsSync(`${process.execPath}.new`)).toBe(false);
    expect(installer.staged()).toBeNull();
  });

  it('stages to <exe>.new atomically and records the version', async () => {
    const installer = new DesktopInstaller({ paths, executable: exe, logger: silentLogger, packaged: true });
    expect(installer.staged()).toBeNull();
    const progress: number[] = [];
    await installer.stage(new TextEncoder().encode('NEW'), info('v2.0.1'), (p) => progress.push(p));
    expect(readFileSync(`${exe}.new`, 'utf8')).toBe('NEW');
    if (process.platform !== 'win32') expect(statSync(`${exe}.new`).mode & 0o777).toBe(0o755);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(100);
    expect(installer.staged()).toEqual({ version: 'v2.0.1' });
    const state = readUpdateStateSync(updateStatePath(paths));
    expect(state).toMatchObject({ boot_phase: 'staged', staged_version: 'v2.0.1', staged_platform_key: 'darwin-arm64', staged_size: 3 });
    // No temporary files left.
    expect(existsSync(`${exe}.new.tmp-${process.pid}`)).toBe(false);
    // Another process (a fresh installer) reads the same state.
    const other = new DesktopInstaller({ paths, executable: exe, logger: silentLogger, packaged: true });
    expect(other.staged()).toEqual({ version: 'v2.0.1' });
    // Restaging replaces.
    await installer.stage(new TextEncoder().encode('NEWER'), info('v2.0.2'));
    expect(readFileSync(`${exe}.new`, 'utf8')).toBe('NEWER');
    expect(installer.staged()).toEqual({ version: 'v2.0.2' });
  });

  it('staged() is null when the staged file is gone', async () => {
    const installer = new DesktopInstaller({ paths, executable: exe, logger: silentLogger, packaged: true });
    await installer.stage(new TextEncoder().encode('NEW'), info('v2.0.1'));
    rmSync(`${exe}.new`);
    const fresh = new DesktopInstaller({ paths, executable: exe, logger: silentLogger, packaged: true });
    expect(fresh.staged()).toBeNull();
  });

  it('activate swaps <exe> -> <exe>.old and <exe>.new -> <exe>', async () => {
    const installer = new DesktopInstaller({ paths, executable: exe, logger: silentLogger, packaged: true });
    await expect(installer.activate()).rejects.toThrow(/no staged/);
    writeFileSync(`${exe}.old`, 'STALE');
    await installer.stage(new TextEncoder().encode('NEW'), info('v2.0.1'));
    await installer.activate();
    expect(readFileSync(exe, 'utf8')).toBe('NEW');
    expect(readFileSync(`${exe}.old`, 'utf8')).toBe('OLD');
    expect(existsSync(`${exe}.new`)).toBe(false);
    expect(installer.staged()).toBeNull();
    expect(readUpdateStateSync(updateStatePath(paths))).toMatchObject({ boot_phase: 'pending_switch', target_version: 'v2.0.1' });
    expect(installer.bootStatus()).toEqual({ healthReady: false });
  });

  it('bootStatus reports rollback_reason and health_ready', () => {
    writeFileSync(updateStatePath(paths), JSON.stringify({ boot_phase: 'rolled_back', rollback_reason: 'health_timeout', health_ready: true }));
    const installer = new DesktopInstaller({ paths, executable: exe, logger: silentLogger, packaged: true });
    expect(installer.bootStatus()).toEqual({ rollbackReason: 'health_timeout', healthReady: true });
  });

  it('tolerates a corrupt state file', () => {
    writeFileSync(updateStatePath(paths), '{not json');
    const installer = new DesktopInstaller({ paths, executable: exe, logger: silentLogger, packaged: true });
    expect(installer.staged()).toBeNull();
    expect(installer.bootStatus()).toEqual({ healthReady: false });
  });
});

describe('cleanupAfterStart', () => {
  it('removes leftovers and marks the start healthy', async () => {
    for (const suffix of ['.old', '.failed', '.new.tmp-123', '.old.1700000000000.del']) writeFileSync(`${exe}${suffix}`, 'x');
    writeFileSync(`${exe}.new`, 'staged stays');
    writeFileSync(join(root, 'unrelated.old'), 'keep');
    writeFileSync(updateStatePath(paths), JSON.stringify({ boot_phase: 'idle' }));
    await cleanupAfterStart(paths, exe);
    for (const suffix of ['.old', '.failed', '.new.tmp-123', '.old.1700000000000.del']) expect(existsSync(`${exe}${suffix}`)).toBe(false);
    expect(existsSync(`${exe}.new`)).toBe(true);
    expect(existsSync(exe)).toBe(true);
    expect(existsSync(join(root, 'unrelated.old'))).toBe(true);
    expect(readUpdateStateSync(updateStatePath(paths)).health_ready).toBe(true);
  });

  it('leaves a switch alone while its supervisor is alive', async () => {
    writeFileSync(`${exe}.old`, 'OLD');
    writeFileSync(updateStatePath(paths), JSON.stringify({ boot_phase: 'pending_switch', target_version: 'v2', supervisor_pid: process.pid }));
    await cleanupAfterStart(paths, exe);
    expect(existsSync(`${exe}.old`)).toBe(true);
    expect(readUpdateStateSync(updateStatePath(paths)).boot_phase).toBe('pending_switch');
  });

  it('commits an unsupervised pending switch', async () => {
    writeFileSync(`${exe}.old`, 'OLD');
    writeFileSync(updateStatePath(paths), JSON.stringify({ boot_phase: 'pending_switch', target_version: 'v2', supervisor_pid: 0 }));
    await cleanupAfterStart(paths, exe);
    expect(existsSync(`${exe}.old`)).toBe(false);
    expect(readUpdateStateSync(updateStatePath(paths))).toMatchObject({ boot_phase: 'idle', health_ready: true, target_version: '' });
  });
});

// The fake "executable": a POSIX shell wrapper exec'ing node on a script, so
// the pid superviseSwitch sees is the node process. (Windows would need a
// .cmd/.exe wrapper; the logic under test is platform-independent.)
const FAKE_GATEWAY = `
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
const [mode, healthFile, version] = process.argv.slice(2);
if (mode === 'exit3') process.exit(3);
if (mode === 'healthy' || mode === 'wrong-version') {
  const server = createServer((s) => s.end());
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    writeFileSync(healthFile, JSON.stringify({ pid: process.pid, version: mode === 'healthy' ? version : 'v0.0.0', web_port: port, ready: true, updated_at: new Date().toISOString() }));
    console.log('fake gateway up on ' + port);
  });
}
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`;

function installFakeExecutable(target: string, label: string): void {
  const script = join(root, 'fake-gateway.mjs');
  writeFileSync(script, FAKE_GATEWAY);
  writeFileSync(target, `#!/bin/sh\n# ${label}\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(target, 0o755);
}

function pendingSwitch(target: string): void {
  installFakeExecutable(exe, 'NEW');
  installFakeExecutable(`${exe}.old`, 'OLD');
  writeFileSync(updateStatePath(paths), JSON.stringify({ boot_phase: 'pending_switch', target_version: target, previous_version: 'v1' }));
  writeFileSync(paths.healthFile, JSON.stringify({ ready: true, version: 'v1', web_port: 1, pid: 1 }));
}

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('superviseSwitch', () => {
  it('healthy: the new version reports health and its port answers', async () => {
    pendingSwitch('v2');
    const result = await superviseSwitchDetailed({
      paths,
      executable: exe,
      args: ['healthy', paths.healthFile, 'v2'],
      attach: false,
      timeoutMs: 10_000,
      pollMs: 50,
    });
    try {
      expect(result.outcome).toBe('healthy');
      expect(result.child?.pid).toBeGreaterThan(0);
      const state = readUpdateStateSync(updateStatePath(paths));
      expect(state).toMatchObject({ boot_phase: 'idle', health_ready: true, rollback_reason: '', supervisor_pid: 0, target_version: '' });
      expect(readFileSync(exe, 'utf8')).toContain('# NEW');
      // .old stays for the next start's cleanupAfterStart.
      expect(existsSync(`${exe}.old`)).toBe(true);
      // Detached: stdout went to the log.
      await new Promise((r) => setTimeout(r, 100));
      expect(readFileSync(paths.logFile, 'utf8')).toContain('fake gateway up on');
    } finally {
      result.child?.kill('SIGTERM');
      if (result.exited) await result.exited;
    }
  }, 15_000);

  it('rolls back on a health timeout (wrong version never counts)', async () => {
    pendingSwitch('v2');
    const outcome = await superviseSwitch({
      paths,
      executable: exe,
      args: ['wrong-version', paths.healthFile, 'v2'],
      attach: false,
      timeoutMs: 800,
      pollMs: 50,
    });
    expect(outcome).toBe('rolled_back');
    expect(readFileSync(exe, 'utf8')).toContain('# OLD');
    expect(existsSync(`${exe}.old`)).toBe(false);
    expect(existsSync(`${exe}.failed`)).toBe(false);
    const state = readUpdateStateSync(updateStatePath(paths));
    expect(state).toMatchObject({ boot_phase: 'rolled_back', rollback_reason: 'health_timeout', health_ready: false, staged_version: '' });
    const installer = new DesktopInstaller({ paths, executable: exe, logger: silentLogger, packaged: true });
    expect(installer.bootStatus()).toEqual({ rollbackReason: 'health_timeout', healthReady: false, rolledBackVersion: 'v2' });
    expect(installer.staged()).toBeNull();
  }, 15_000);

  it('rolls back when the new process exits early', async () => {
    pendingSwitch('v2');
    const started = Date.now();
    const outcome = await superviseSwitch({ paths, executable: exe, args: ['exit3', paths.healthFile, 'v2'], attach: false, timeoutMs: 10_000, pollMs: 50 });
    expect(outcome).toBe('rolled_back');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(readFileSync(exe, 'utf8')).toContain('# OLD');
    expect(readUpdateStateSync(updateStatePath(paths)).rollback_reason).toBe('process_exit_3');
  }, 15_000);

  it('rolls back when the executable cannot be started', async () => {
    pendingSwitch('v2');
    writeFileSync(exe, 'not executable');
    chmodSync(exe, 0o644);
    const outcome = await superviseSwitch({ paths, executable: exe, args: [], attach: false, timeoutMs: 2_000, pollMs: 50 });
    expect(outcome).toBe('rolled_back');
    expect(readFileSync(exe, 'utf8')).toContain('# OLD');
    expect(readUpdateStateSync(updateStatePath(paths)).rollback_reason).toBe('spawn_failed');
  }, 15_000);
});
