// Recovery of `.nhraw` captures left behind by an app that died (killed,
// crashed, reloaded) while recording: on start, every capture in
// recordings/.raw that is not being written is either discarded (its live
// recording finished after all) or converted into the recording files
// (engine NhrawConverter), replacing the live recording's partial folder.
import type { Logger } from '@nhgw/core';
import { NHRAW_HEADER_LEN, NhrawConverter, NhrawStreamReader, type RecordingPaths } from '@nhgw/engine';

import { NativeRecordingSink, NHRAW_SUFFIX, PATHS } from './files';
import type { HostFiles } from './nativeApi';
import type { RawSidecar } from './rawCaptures';

export const RECOVERY_CHUNK_BYTES = 1024 * 1024;
/** A capture that failed to convert is renamed so it is kept but not retried on every start. */
export const FAILED_SUFFIX = '.failed';

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

/** Converts one capture into the data root, in chunks. Returns the recording's paths (null when it held no frame). */
export async function convertCapture(
  native: HostFiles,
  rawPath: string,
  yieldToUi: () => Promise<void> = defaultYield,
  serverTimeZone?: string,
): Promise<RecordingPaths | null> {
  const sink = new NativeRecordingSink(native);
  const reader = new NhrawStreamReader();
  let converter: NhrawConverter | null = null;
  let offset = 0;
  for (;;) {
    const chunk = native.readBytes(rawPath, offset, RECOVERY_CHUNK_BYTES);
    if (chunk.length === 0) break;
    offset += chunk.length;
    for (const record of reader.push(chunk)) {
      converter ??= new NhrawConverter(reader.header!, {
        sink,
        dataRoot: PATHS.dataRoot,
        ...(serverTimeZone !== undefined ? { serverTimeZone } : {}),
      });
      converter.push(record);
    }
    await yieldToUi();
  }
  const { truncated } = reader.end();
  converter ??= new NhrawConverter(reader.header!, { sink, dataRoot: PATHS.dataRoot });
  return converter.finish({ truncated, closeOpen: true }).paths;
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
        if (decision.replaceDirectory) native.deletePath(decision.replaceDirectory);
        outcome.paths = await convertCapture(native, raw, options.yieldToUi, options.serverTimeZone);
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
