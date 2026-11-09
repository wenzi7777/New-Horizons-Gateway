// The desktop UpdateInstaller (packages/core/src/update/installer.ts) and the
// switch supervisor, replacing Python's slot_a/slot_b + bootloader
// (newhorizons_gateway/bootloader.py, boot_state.py). The Gateway is one
// executable (Node SEA), so:
//
//   stage()     verified bytes -> <exe>.new (tmp file + rename, chmod 755)
//   activate()  <exe> -> <exe>.old, <exe>.new -> <exe>; phase pending_switch
//   superviseSwitch()  (run by the old process after handle.done = "switch")
//               launch <exe>, wait up to 30 s for health.json to name the new
//               version and its web port to accept a connection; healthy ->
//               commit, else kill it and swap <exe>.old back (rolled_back)
//   cleanupAfterStart()  a healthy start deletes leftovers (<exe>.old, ...)
//
// State lives in <runDir>/update-state.json (Python kept boot_state.json;
// slots are gone, so the file is new rather than a reinterpretation).
//
// Platform notes:
//  - Windows lets a running .exe be renamed but not deleted. Every place that
//    would delete a binary that may still be running (the old one during a
//    switch, a parent supervisor still waiting) renames it to
//    `<exe>.<n>.del` instead when the delete fails; cleanupAfterStart removes
//    those once nothing runs them.
//  - macOS ties a code signature to the file's vnode: the new binary is always
//    a new file renamed into place, never written over the running one.

import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, type FileHandle, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { basename, dirname, join } from 'node:path';
import type { InstallerBootStatus, Logger, StagedUpdate, StageInfo, UpdateInstaller } from '@nhgw/core';
import type { HealthRecord, InstallerFactory, RuntimePaths } from './hostApi';

export const UPDATE_STATE_FILE = 'update-state.json';
/** Python's DEFAULT_BOOT_TIMEOUT_SEC. */
export const DEFAULT_SWITCH_TIMEOUT_MS = 30_000;
export const HEALTH_POLL_MS = 250;
const STATE_RECHECK_MS = 1_000;
const WRITE_CHUNK = 1 << 20;

export type BootPhase = 'idle' | 'staged' | 'pending_switch' | 'rolled_back';

/** <runDir>/update-state.json. */
export interface UpdateState {
  boot_phase: BootPhase;
  /** Version written to <exe>.new (staged) or swapped in (pending_switch). */
  staged_version: string;
  staged_platform_key: string;
  staged_sha256: string;
  staged_size: number;
  staged_at: string;
  /** Version the pending switch expects in health.json (= staged_version once activated). */
  target_version: string;
  rollback_reason: string;
  health_ready: boolean;
  /** pid of the process supervising a pending switch, so a start does not clean up under it. */
  supervisor_pid: number;
  last_transition_at: string;
}

export function defaultUpdateState(): UpdateState {
  return {
    boot_phase: 'idle',
    staged_version: '',
    staged_platform_key: '',
    staged_sha256: '',
    staged_size: 0,
    staged_at: '',
    target_version: '',
    rollback_reason: '',
    health_ready: false,
    supervisor_pid: 0,
    last_transition_at: new Date().toISOString(),
  };
}

const PHASES: readonly BootPhase[] = ['idle', 'staged', 'pending_switch', 'rolled_back'];

function normalizeState(raw: unknown): UpdateState {
  const state = defaultUpdateState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
  const r = raw as Record<string, unknown>;
  const s = (key: keyof UpdateState) => (typeof r[key] === 'string' ? (r[key] as string) : '');
  const n = (key: keyof UpdateState) => (typeof r[key] === 'number' && Number.isFinite(r[key]) ? (r[key] as number) : 0);
  state.boot_phase = PHASES.includes(r.boot_phase as BootPhase) ? (r.boot_phase as BootPhase) : 'idle';
  state.staged_version = s('staged_version');
  state.staged_platform_key = s('staged_platform_key');
  state.staged_sha256 = s('staged_sha256');
  state.staged_size = n('staged_size');
  state.staged_at = s('staged_at');
  state.target_version = s('target_version');
  state.rollback_reason = s('rollback_reason');
  state.health_ready = r.health_ready === true;
  state.supervisor_pid = n('supervisor_pid');
  state.last_transition_at = s('last_transition_at') || state.last_transition_at;
  return state;
}

export function updateStatePath(paths: RuntimePaths): string {
  return join(paths.runDir, UPDATE_STATE_FILE);
}

export function readUpdateStateSync(file: string): UpdateState {
  try {
    return normalizeState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return defaultUpdateState();
  }
}

/** Writes `data` to `file` via a temporary file and a rename, so readers never see half a file. */
async function writeFileAtomic(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, data, mode === undefined ? undefined : { mode });
    await renameWithRetry(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function writeUpdateState(file: string, patch: Partial<UpdateState>): Promise<UpdateState> {
  const next = { ...readUpdateStateSync(file), ...patch, last_transition_at: new Date().toISOString() };
  await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** fs.rename, retried briefly on Windows' transient sharing errors (antivirus, a process just exiting). */
async function renameWithRetry(from: string, to: string, attempts = process.platform === 'win32' ? 10 : 1): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (i + 1 >= attempts || !RETRYABLE.has(code)) throw err;
      await delay(100 * (i + 1));
    }
  }
}

/**
 * Removes a file that may be a running executable. Deleting fails on Windows
 * while it runs; renaming does not, so it is moved to `<file>.<n>.del` and
 * left for cleanupAfterStart.
 */
async function removeOrMoveAside(file: string): Promise<'removed' | 'moved' | 'absent'> {
  if (!existsSync(file)) return 'absent';
  try {
    await unlink(file);
    return 'removed';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOENT') return 'absent';
    if (!RETRYABLE.has(code)) throw err;
    await rename(file, `${file}.${Date.now()}.del`);
    return 'moved';
  }
}

export function stagedPath(executable: string): string {
  return `${executable}.new`;
}
export function oldPath(executable: string): string {
  return `${executable}.old`;
}
export function failedPath(executable: string): string {
  return `${executable}.failed`;
}

/** Whether this process is a Node single executable (node:sea isSea()). */
export function runningAsSea(): boolean {
  try {
    // node:sea exists from Node 20.12/21.7; required lazily so tests and older runtimes do not break.
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const sea = getBuiltin?.('node:sea') as { isSea?: () => boolean } | undefined;
    return Boolean(sea?.isSea?.());
  } catch {
    return false;
  }
}

export interface DesktopInstallerOptions {
  paths: RuntimePaths;
  executable: string;
  logger: Logger;
  /** Default: runningAsSea(). False refuses to stage (dev runs under `node`, whose binary must not be replaced). */
  packaged?: boolean;
}

export class DesktopInstaller implements UpdateInstaller {
  private readonly stateFile: string;
  private cache: UpdateState | null = null;
  private cacheMtime = -1;
  private cacheCheckedAt = 0;
  private stagedFileExists = false;

  constructor(private readonly options: DesktopInstallerOptions) {
    this.stateFile = updateStatePath(options.paths);
  }

  private get packaged(): boolean {
    return this.options.packaged ?? runningAsSea();
  }

  /** The state file, re-read when its mtime changed (checked at most once a second): another process may write it. */
  private state(): UpdateState {
    const nowMs = Date.now();
    if (this.cache && nowMs - this.cacheCheckedAt < STATE_RECHECK_MS) return this.cache;
    this.cacheCheckedAt = nowMs;
    let mtime = 0;
    try {
      mtime = statSync(this.stateFile).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (!this.cache || mtime !== this.cacheMtime) {
      this.cache = mtime ? readUpdateStateSync(this.stateFile) : defaultUpdateState();
      this.cacheMtime = mtime;
      this.stagedFileExists = existsSync(stagedPath(this.options.executable));
    }
    return this.cache;
  }

  private remember(state: UpdateState): void {
    this.cache = state;
    try {
      this.cacheMtime = statSync(this.stateFile).mtimeMs;
    } catch {
      this.cacheMtime = 0;
    }
    this.cacheCheckedAt = Date.now();
    this.stagedFileExists = existsSync(stagedPath(this.options.executable));
  }

  async stage(bytes: Uint8Array, info: StageInfo, onProgress?: (pct: number) => void): Promise<void> {
    const exe = this.options.executable;
    if (!this.packaged) {
      throw new Error(
        `self-update needs the packaged Gateway executable; this process runs under ${basename(process.execPath)} (${exe}), which is not replaced. Build it with npm run build:sea.`,
      );
    }
    const target = stagedPath(exe);
    const tmp = `${target}.tmp-${process.pid}`;
    onProgress?.(0);
    const handle = await open(tmp, 'w', 0o755);
    try {
      for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK) {
        const end = Math.min(bytes.length, offset + WRITE_CHUNK);
        await handle.write(bytes, offset, end - offset, offset);
        onProgress?.(Math.floor((end / Math.max(1, bytes.length)) * 95));
      }
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    await handle.close();
    try {
      if (process.platform !== 'win32') await chmod(tmp, 0o755);
      await removeOrMoveAside(target);
      await renameWithRetry(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    const state = await writeUpdateState(this.stateFile, {
      boot_phase: 'staged',
      staged_version: info.version,
      staged_platform_key: info.platformKey,
      staged_sha256: info.sha256,
      staged_size: info.size || bytes.length,
      staged_at: new Date().toISOString(),
      target_version: '',
      rollback_reason: '',
    });
    this.remember(state);
    this.options.logger.info(`gateway update ${info.version} staged at ${target}`);
    onProgress?.(100);
  }

  staged(): StagedUpdate | null {
    const state = this.state();
    if (state.boot_phase !== 'staged' || !state.staged_version || !this.stagedFileExists) return null;
    return { version: state.staged_version };
  }

  async activate(): Promise<void> {
    const exe = this.options.executable;
    const state = this.state();
    const next = stagedPath(exe);
    if (state.boot_phase !== 'staged' || !state.staged_version || !existsSync(next)) {
      throw new Error('no staged gateway update to activate');
    }
    const old = oldPath(exe);
    // A leftover from an earlier switch (on Windows maybe still running: moved aside then).
    await removeOrMoveAside(old);
    await renameWithRetry(exe, old);
    try {
      await renameWithRetry(next, exe);
    } catch (err) {
      await renameWithRetry(old, exe).catch((restoreErr) => {
        this.options.logger.error(`gateway update: could not restore ${exe}: ${String(restoreErr)}`);
      });
      throw err;
    }
    const updated = await writeUpdateState(this.stateFile, {
      boot_phase: 'pending_switch',
      target_version: state.staged_version,
      rollback_reason: '',
      health_ready: false,
      supervisor_pid: 0,
    });
    this.remember(updated);
    this.options.logger.info(`gateway update ${state.staged_version} activated; ${basename(old)} kept for rollback`);
  }

  bootStatus(): InstallerBootStatus {
    const state = this.state();
    const status: InstallerBootStatus = { healthReady: state.health_ready };
    if (state.rollback_reason) status.rollbackReason = state.rollback_reason;
    if (state.boot_phase === 'rolled_back' && state.target_version) status.rolledBackVersion = state.target_version;
    return status;
  }
}

export const createDesktopInstaller: InstallerFactory = (options) => new DesktopInstaller(options);

// ---------------------------------------------------------------- switch

function readHealth(file: string): Partial<HealthRecord> | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as Partial<HealthRecord>) : null;
  } catch {
    return null;
  }
}

/** Whether 127.0.0.1:port accepts a TCP connection within timeoutMs (Python _probe_web_ready). */
export function probePort(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function terminate(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const gone = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
  if (!gone) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(2_000)]);
  }
}

export type SwitchOutcome = 'healthy' | 'rolled_back';

export interface SuperviseSwitchOptions {
  paths: RuntimePaths;
  /** The (now swapped-in) executable to launch. */
  executable: string;
  args: string[];
  /** Default 30 s (Python's DEFAULT_BOOT_TIMEOUT_SEC). */
  timeoutMs?: number;
  /**
   * Keep the new process attached to this one: stdio inherited, not detached.
   * Default: process.stdout.isTTY. Attached, the caller must stay alive and wait
   * for `exited` (see superviseSwitchDetailed): a terminal's shell takes the
   * terminal back as soon as the process it started exits. Detached, stdout and
   * stderr go to paths.logFile and the child outlives this process.
   */
  attach?: boolean;
  /** Extra environment for the child. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  pollMs?: number;
}

export interface SwitchResult {
  outcome: SwitchOutcome;
  /** healthy: the new process, and when it exits (its exit code; signal -> 1). */
  child?: ChildProcess;
  exited?: Promise<number>;
  rollbackReason?: string;
}

/** superviseSwitch with the launched process: an attached (TTY) caller waits for `exited` and exits with its code. */
export async function superviseSwitchDetailed(options: SuperviseSwitchOptions): Promise<SwitchResult> {
  const { paths, executable, args } = options;
  const logger = options.logger;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SWITCH_TIMEOUT_MS;
  const pollMs = options.pollMs ?? HEALTH_POLL_MS;
  const attach = options.attach ?? Boolean(process.stdout.isTTY);
  const stateFile = updateStatePath(paths);
  const initial = readUpdateStateSync(stateFile);
  const target = initial.target_version || initial.staged_version;

  await writeUpdateState(stateFile, { supervisor_pid: process.pid });
  await rm(paths.healthFile, { force: true }).catch(() => undefined);

  // Detached: the child's stdout/stderr append to the log (closed here once the child has its own copy).
  let logHandle: FileHandle | null = null;
  if (!attach) {
    await mkdir(dirname(paths.logFile), { recursive: true });
    logHandle = await open(paths.logFile, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT);
  }

  let child: ChildProcess;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let spawnError: Error | null = null;
  try {
    child = spawn(executable, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...options.env },
      detached: !attach,
      stdio: attach || !logHandle ? 'inherit' : ['ignore', logHandle.fd, logHandle.fd],
      windowsHide: !attach,
    });
  } catch (err) {
    spawnError = err as Error;
    child = null as unknown as ChildProcess;
  }
  // Listeners first (a spawn error is emitted on the next tick), then close our copy of the log fd.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (!child) return resolve({ code: null, signal: null });
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
    child.once('error', (err) => {
      spawnError = err;
      exitInfo = exitInfo ?? { code: null, signal: null };
      resolve(exitInfo);
    });
  });
  await logHandle?.close().catch(() => undefined);

  let reason = '';
  const started = Date.now();
  if (spawnError) reason = 'spawn_failed';
  while (!reason) {
    if (spawnError) {
      reason = 'spawn_failed';
      break;
    }
    if (exitInfo) {
      const info = exitInfo as { code: number | null; signal: NodeJS.Signals | null };
      reason = `process_exit_${info.code ?? info.signal ?? 'unknown'}`;
      break;
    }
    const health = readHealth(paths.healthFile);
    if (health?.ready && (!target || health.version === target)) {
      const port = Number(health.web_port) || 5052;
      if (await probePort(port)) {
        await writeUpdateState(stateFile, {
          boot_phase: 'idle',
          staged_version: '',
          staged_platform_key: '',
          staged_sha256: '',
          staged_size: 0,
          staged_at: '',
          target_version: '',
          rollback_reason: '',
          health_ready: true,
          supervisor_pid: 0,
        });
        logger?.info(`gateway update ${target || '(unknown)'} is healthy (pid ${child.pid})`);
        if (!attach) child.unref();
        return {
          outcome: 'healthy',
          child,
          exited: exited.then((info) => info.code ?? 1),
        };
      }
    }
    if (Date.now() - started > timeoutMs) {
      reason = 'health_timeout';
      break;
    }
    await delay(pollMs);
  }

  if (child && !spawnError) await terminate(child, exited);
  await rollbackBinary(executable, logger);
  await writeUpdateState(stateFile, {
    boot_phase: 'rolled_back',
    staged_version: '',
    staged_platform_key: '',
    staged_sha256: '',
    staged_size: 0,
    staged_at: '',
    // Kept so the manager knows which release failed (bootStatus().rolledBackVersion).
    target_version: target,
    rollback_reason: reason,
    health_ready: false,
    supervisor_pid: 0,
  });
  await rm(paths.healthFile, { force: true }).catch(() => undefined);
  logger?.warn(`gateway update ${target || '(unknown)'} rolled back: ${reason}`);
  return { outcome: 'rolled_back', rollbackReason: reason };
}

/**
 * Launches the swapped-in executable and waits for its health (Python
 * await_pending_health): 'healthy' leaves it running and commits the switch;
 * 'rolled_back' kills it, puts <exe>.old back and records rollback_reason
 * ("health_timeout", "process_exit_<code>", "spawn_failed").
 */
export async function superviseSwitch(options: SuperviseSwitchOptions): Promise<SwitchOutcome> {
  return (await superviseSwitchDetailed(options)).outcome;
}

async function rollbackBinary(executable: string, logger?: Logger): Promise<void> {
  const old = oldPath(executable);
  if (!existsSync(old)) {
    logger?.error(`gateway update rollback: ${old} is missing; ${executable} stays the new version`);
    return;
  }
  const failed = failedPath(executable);
  await removeOrMoveAside(failed);
  if (existsSync(executable)) await renameWithRetry(executable, failed);
  await renameWithRetry(old, executable);
  await removeOrMoveAside(failed).catch(() => undefined);
}

/**
 * Once the current start is healthy: deletes a leftover <exe>.old / .failed /
 * .new.tmp-* / *.del, and commits a pending switch that no supervisor is
 * watching any more (the new build started without one, e.g. by hand). While
 * a live supervisor still watches the switch nothing is touched: it commits
 * itself, and the next start removes <exe>.old.
 */
export async function cleanupAfterStart(paths: RuntimePaths, executable: string, logger?: Logger): Promise<void> {
  const stateFile = updateStatePath(paths);
  const state = readUpdateStateSync(stateFile);
  if (state.boot_phase === 'pending_switch') {
    if (state.supervisor_pid && pidAlive(state.supervisor_pid)) return;
    await writeUpdateState(stateFile, {
      boot_phase: 'idle',
      staged_version: '',
      target_version: '',
      rollback_reason: '',
      health_ready: true,
      supervisor_pid: 0,
    });
  } else if (!state.health_ready && existsSync(stateFile)) {
    await writeUpdateState(stateFile, { health_ready: true });
  }
  const dir = dirname(executable);
  const base = basename(executable);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const leftover =
      name === `${base}.old` ||
      name === `${base}.failed` ||
      name.startsWith(`${base}.new.tmp-`) ||
      (name.startsWith(`${base}.`) && name.endsWith('.del'));
    if (!leftover) continue;
    try {
      await unlink(join(dir, name));
      logger?.info(`removed leftover ${name}`);
    } catch (err) {
      // Windows: still running (a parent supervisor); the next start tries again.
      logger?.warn(`could not remove ${name}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
    }
  }
}

/** For the CLI: the update state as last written (e.g. to print a rollback reason at start). */
export async function readUpdateState(paths: RuntimePaths): Promise<UpdateState> {
  try {
    return normalizeState(JSON.parse(await readFile(updateStatePath(paths), 'utf8')));
  } catch {
    return defaultUpdateState();
  }
}
