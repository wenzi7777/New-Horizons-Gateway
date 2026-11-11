// Recovery of `.nhraw` captures left behind by an app that died (killed,
// crashed, reloaded) while recording: on start, every capture in
// recordings/.raw that is not being written is either discarded (its live
// recording finished after all) or converted into the recording files
// (engine NhrawConverter), replacing the live recording's partial folder.
// The conversion is written to a staging folder under recordings/.raw first
// and only swapped in once it succeeded, so a failure keeps the partial CSV.
import type { Logger } from '@nhgw/core';
import {
  NHRAW_HEADER_LEN,
  NhrawConverter,
  NhrawStreamReader,
  type RecordingFileHandle,
  type RecordingFileSink,
  type RecordingPaths,
} from '@nhgw/engine';

import { NativeRecordingSink, NHRAW_SUFFIX, PATHS } from './files';
import type { HostFiles } from './nativeApi';
import type { RawSidecar } from './rawCaptures';

export const RECOVERY_CHUNK_BYTES = 1024 * 1024;
/** A capture that failed to convert is renamed so it is kept but not retried on every start. */
export const FAILED_SUFFIX = '.failed';
/** Conversions are staged here (one folder per capture), then moved into the data root. */
export const STAGING_DIR = `${PATHS.rawDir}/.convert`;

export type RecoveryInput = {
  /** The capture's size in bytes. */
  rawBytes: number;
  sidecar: RawSidecar | null;
  /** The live recording's meta.json, when the sidecar names a folder that still has one. */
  liveMeta: Record<string, unknown> | null;
  /** Whether the live folder the sidecar names still exists. */
  liveDirectoryExists: boolean;
};

export type RecoveryDecision =
  /** Nothing to keep (no records, or the live recording finished cleanly): delete the capture. */
  | { action: 'discard'; reason: 'empty' | 'live_finished' }
  /** Convert; first delete `replaceDirectory` (the live recording's partial folder) when set. */
  | { action: 'convert'; replaceDirectory: string | null };

/** What to do with one left-over capture (pure: test/recovery.test.ts). */
export function decideRecovery(input: RecoveryInput): RecoveryDecision {
  if (input.rawBytes <= NHRAW_HEADER_LEN) return { action: 'discard', reason: 'empty' };
  const recording = input.liveMeta?.recording;
  if (recording !== null && typeof recording === 'object' && !Array.isArray(recording)) {
    const stoppedAt = (recording as Record<string, unknown>).stopped_at;
    const reason = String((recording as Record<string, unknown>).stop_reason ?? '');
    if (typeof stoppedAt === 'string' && stoppedAt && !reason.startsWith('write_error')) return { action: 'discard', reason: 'live_finished' };
  }
  const live = input.sidecar?.live_directory ?? null;
  return { action: 'convert', replaceDirectory: live && input.liveDirectoryExists ? live : null };
}

export function parseSidecar(text: string | null): RawSidecar | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<RawSidecar>;
    if (typeof value !== 'object' || value === null || typeof value.uid !== 'string') return null;
    return {
      format: 1,
      uid: value.uid,
      start_epoch_us: Number(value.start_epoch_us) || 0,
      live_directory: typeof value.live_directory === 'string' && value.live_directory ? value.live_directory : null,
    };
  } catch {
    return null;
  }
}

/** The meta.json in a recording folder, parsed; null when missing or unreadable. */
export function readFolderMeta(native: HostFiles, directory: string): Record<string, unknown> | null {
  let entries;
  try {
    entries = native.listDir(directory);
  } catch {
    return null;
  }
  const meta = entries.find((entry) => !entry.isDirectory && entry.name.endsWith('.meta.json'));
  if (!meta) return null;
  try {
    const text = native.readText(`${directory}/${meta.name}`);
    const parsed = text === null ? null : (JSON.parse(text) as unknown);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type RecoveryOutcome = { raw: string; decision: RecoveryDecision; paths: RecordingPaths | null; error: string };

export interface RecoveryOptions {
  native: HostFiles;
  logger: Logger;
  /** Captures being written right now (left alone). */
  skip?: ReadonlySet<string>;
  /** Called between chunks so a long conversion does not freeze the UI (default: a zero timeout). */
  yieldToUi?: () => Promise<void>;
  serverTimeZone?: string;
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The native sink, remembering what it opened so a failed conversion can close it all. */
class ClosingSink implements RecordingFileSink {
  private readonly inner: NativeRecordingSink;
  private readonly open_ = new Set<RecordingFileHandle>();
  constructor(native: HostFiles) {
    this.inner = new NativeRecordingSink(native);
  }
  exists(path: string): boolean {
    return this.inner.exists(path);
  }
  mkdirp(path: string): void {
    this.inner.mkdirp(path);
  }
  open(path: string): RecordingFileHandle {
    const handle = this.inner.open(path);
    this.open_.add(handle);
    const open = this.open_;
    return {
      size: handle.size,
      append: (text: string) => handle.append(text),
      flush: () => handle.flush(),
      close: () => {
        open.delete(handle);
        handle.close();
      },
    };
  }
  writeAtomic(path: string, text: string): void {
    this.inner.writeAtomic(path, text);
  }
  closeAll(): void {
    for (const handle of [...this.open_]) {
      this.open_.delete(handle);
      try {
        handle.close();
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Converts one capture under `dataRoot` (default: the data root), in chunks.
 * Returns the recording's paths (null when it held no frame). On failure
 * every file it opened is closed before the error propagates.
 */
export async function convertCapture(
  native: HostFiles,
  rawPath: string,
  yieldToUi: () => Promise<void> = defaultYield,
  serverTimeZone?: string,
  dataRoot: string = PATHS.dataRoot,
): Promise<RecordingPaths | null> {
  const sink = new ClosingSink(native);
  const reader = new NhrawStreamReader();
  let converter: NhrawConverter | null = null;
  const options = { sink, dataRoot, ...(serverTimeZone !== undefined ? { serverTimeZone } : {}) };
  try {
    let offset = 0;
    for (;;) {
      const chunk = native.readBytes(rawPath, offset, RECOVERY_CHUNK_BYTES);
      if (chunk.length === 0) break;
      offset += chunk.length;
      for (const record of reader.push(chunk)) {
        converter ??= new NhrawConverter(reader.header!, options);
        converter.push(record);
      }
      await yieldToUi();
    }
    const { truncated } = reader.end();
    converter ??= new NhrawConverter(reader.header!, options);
    return converter.finish({ truncated, closeOpen: true }).paths;
  } finally {
    sink.closeAll();
  }
}

/** `paths` with its `from` root swapped for `to`. */
function rebase(paths: RecordingPaths, from: string, to: string): RecordingPaths {
  const move = (path: string) => (path.startsWith(`${from}/`) ? `${to}/${path.slice(from.length + 1)}` : path);
  return { directory: move(paths.directory), data: move(paths.data), events: move(paths.events), meta: move(paths.meta) };
}

/**
 * Converts a capture in a staging folder, then puts the result where the
 * recording belongs, replacing `replaceDirectory` (the live partial) only
 * now. Anything that fails leaves the partial folder as it was.
 */
async function convertAndSwap(
  native: HostFiles,
  raw: string,
  stagingName: string,
  replaceDirectory: string | null,
  options: RecoveryOptions,
): Promise<RecordingPaths | null> {
  const staging = `${STAGING_DIR}/${stagingName}`;
  native.deletePath(staging); // a previous attempt's leftovers
  try {
    const staged = await convertCapture(native, raw, options.yieldToUi, options.serverTimeZone, staging);
    // No frame: nothing better than what the partial folder holds.
    if (staged === null) return null;
    const paths = rebase(staged, staging, PATHS.dataRoot);
    // The folders to give way: the live partial, and whatever already sits at the target.
    const aside: { from: string; to: string }[] = [];
    for (const directory of new Set([replaceDirectory, paths.directory])) {
      if (directory === null || !native.fileExists(directory)) continue;
      const to = `${STAGING_DIR}/${stagingName}.replaced-${aside.length}`;
      native.deletePath(to);
      if (!native.movePath(directory, to)) throw new Error(`could not move ${directory} aside`);
      aside.push({ from: directory, to });
    }
    if (!native.movePath(staged.directory, paths.directory)) {
      for (const item of aside.reverse()) native.movePath(item.to, item.from);
      throw new Error(`could not move the conversion to ${paths.directory}`);
    }
    for (const item of aside) native.deletePath(item.to);
    return paths;
  } finally {
    native.deletePath(staging);
  }
}

/** Every left-over capture in recordings/.raw: decided, then converted or discarded. */
export async function recoverCaptures(options: RecoveryOptions): Promise<RecoveryOutcome[]> {
  const { native, logger } = options;
  const outcomes: RecoveryOutcome[] = [];
  let entries;
  try {
    entries = native.listDir(PATHS.rawDir);
  } catch {
    return outcomes;
  }
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(NHRAW_SUFFIX)) continue;
    const raw = `${PATHS.rawDir}/${entry.name}`;
    if (options.skip?.has(raw)) continue;
    const sidecarPath = `${raw.slice(0, -NHRAW_SUFFIX.length)}.json`;
    let sidecarText: string | null = null;
    try {
      sidecarText = native.readText(sidecarPath);
    } catch {
      sidecarText = null;
    }
    const sidecar = parseSidecar(sidecarText);
    const live = sidecar?.live_directory ?? null;
    const liveDirectoryExists = live !== null && native.fileExists(live);
    const decision = decideRecovery({
      rawBytes: entry.size,
      sidecar,
      liveMeta: liveDirectoryExists ? readFolderMeta(native, live!) : null,
      liveDirectoryExists,
    });
    const outcome: RecoveryOutcome = { raw, decision, paths: null, error: '' };
    try {
      if (decision.action === 'convert') {
        const stagingName = entry.name.slice(0, -NHRAW_SUFFIX.length);
        outcome.paths = await convertAndSwap(native, raw, stagingName, decision.replaceDirectory, options);
        logger.info(`recovered ${entry.name} -> ${outcome.paths?.directory ?? '(no frames)'}`);
      }
      native.deletePath(raw);
      native.deletePath(sidecarPath);
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
      logger.error(`recovery of ${entry.name} failed: ${outcome.error}`);
      try {
        native.movePath(raw, `${raw}${FAILED_SUFFIX}`);
      } catch {
        // left as is
      }
    }
    outcomes.push(outcome);
  }
  return outcomes;
}
