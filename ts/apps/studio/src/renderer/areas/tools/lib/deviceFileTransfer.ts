/**
 * Writing a file to a device, in one place.
 *
 * This is the loop DeviceFilesPage has always used, lifted out so that
 * installing an app package and uploading a file are the same code rather than
 * two implementations that drift.
 *
 * It stays in the frontend rather than moving server-side because the backend
 * has no await-result primitive at all: `publish_command` is fire-and-forget on
 * every transport, and the only request_id-to-result correlation in the system
 * is `useDeviceCommand`'s. Chunk progress would also need a push channel that
 * does not exist.
 */

export type QueuedResult = { result: Record<string, unknown> | null };
export type CommandRunner = (
  payload: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<QueuedResult>;

/** SPIFFS caps a full path at 31 bytes, and the user scope adds "/files/". */
export const MAX_USER_PATH = 24;
/** One command per chunk, so this trades round trips against payload size. */
export const CHUNK_BYTES = 96;
/**
 * Bytes asked for per file_read_chunk. The reply carries them as hex, so
 * about 8 KB: two UDP-chunked datagram bursts, or two ESP-NOW pages through a
 * Hub. Bigger chunks mean fewer round trips but a bigger buffer on the device.
 */
export const READ_CHUNK_BYTES = 4096;

export type TransferProgress = {
  loaded: number;
  total: number;
  startTime: number;
};

export type AbortRef = { current: boolean };

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Throws on a device-reported failure, which a queued result reports in-band. */
export function ensureWriteOk(result: Record<string, unknown> | null) {
  if (result && (result.status === "error" || result.ok === false)) {
    throw new Error(String(result.error ?? result.message ?? "file_write_failed"));
  }
}

/**
 * Why a file_read_* reply cannot be used, or null when it can. A missing
 * reply counts: a timed-out chunk has no data and no next_offset, and a loop
 * that took it as "empty, try again" re-sent the same offset forever -- 8-10
 * failed commands a second, each flashing the device's LED red, until the
 * tab was closed.
 */
export function readFailure(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) return "no_response";
  if (result.status === "error" || result.ok === false) {
    return String(result.error ?? result.message ?? "file_read_failed");
  }
  return null;
}

export function ensureReadOk(result: Record<string, unknown> | null | undefined) {
  const failure = readFailure(result);
  if (failure) throw new Error(failure);
}

/** A read that said there was more but did not move forward. */
export function ensureReadAdvanced(offset: number, nextOffset: number, hasMore: boolean) {
  if (hasMore && !(nextOffset > offset)) throw new Error("file_read_stalled");
}

export type WriteOptions = {
  path: string;
  bytes: Uint8Array;
  scope?: string;
  /** Optional integrity check; the device deletes the file on a mismatch. */
  sha256?: string;
  onProgress?: (progress: TransferProgress) => void;
  abortRef?: AbortRef;
};

export async function writeDeviceFile(queue: CommandRunner, options: WriteOptions): Promise<void> {
  const { path, bytes, scope = "user", sha256, onProgress, abortRef } = options;
  if (scope === "user" && path.length > MAX_USER_PATH) {
    // Caught here because the device's own error arrives from file_write_begin
    // as an opaque path_too_long, long before anything explains why.
    throw new Error(`path_too_long (${path.length}/${MAX_USER_PATH})`);
  }

  const startTime = Date.now();
  onProgress?.({ loaded: 0, total: bytes.length, startTime });

  const begin = await queue({ command: "file_write_begin", scope, path, size: bytes.length });
  ensureWriteOk(begin.result);

  let offset = 0;
  while (offset < bytes.length) {
    if (abortRef?.current) {
      throw new Error("upload_cancelled");
    }
    const chunk = bytes.slice(offset, offset + CHUNK_BYTES);
    const written = await queue({
      command: "file_write_chunk",
      scope,
      path,
      offset,
      data: bytesToHex(chunk),
    });
    ensureWriteOk(written.result);
    offset += chunk.length;
    onProgress?.({ loaded: offset, total: bytes.length, startTime });
  }

  const finishPayload: Record<string, unknown> = { command: "file_write_finish", scope, path };
  if (sha256) {
    finishPayload.sha256 = sha256;
  }
  const finish = await queue(finishPayload);
  ensureWriteOk(finish.result);
}

export type InstallPhase = "upload" | "install" | "activate" | "done";

export type InstallOptions = {
  appId: string;
  devicePath: string;
  dataHex: string;
  sha256?: string;
  /** Slot to bind to, or undefined to let the device pick a free one. */
  slot?: number;
  replace?: boolean;
  onPhase?: (phase: InstallPhase) => void;
  onProgress?: (progress: TransferProgress) => void;
  abortRef?: AbortRef;
};

/** Upload the package, register it, and optionally bind it to a slot. */
export async function installAppPackage(queue: CommandRunner, options: InstallOptions) {
  const { appId, devicePath, dataHex, sha256, slot, replace, onPhase, onProgress, abortRef } = options;

  onPhase?.("upload");
  await writeDeviceFile(queue, {
    path: devicePath,
    bytes: hexToBytes(dataHex),
    sha256,
    onProgress,
    abortRef,
  });

  onPhase?.("install");
  const installed = await queue({
    command: "app_install",
    path: devicePath,
    ...(sha256 ? { sha256 } : {}),
    ...(replace ? { replace: true } : {}),
  });
  ensureWriteOk(installed.result);

  if (slot !== undefined) {
    onPhase?.("activate");
    const activated = await queue({ command: "app_activate", id: appId, slot });
    ensureWriteOk(activated.result);
  }

  onPhase?.("done");
  return installed.result;
}

export type ReadOptions = {
  path: string;
  scope?: string;
  /** Bytes per request; READ_CHUNK_BYTES unless a caller needs otherwise. */
  chunkBytes?: number;
};

/**
 * Read a file back off the device.
 *
 * Used to load an installed package from the device that holds it, rather than
 * from the catalog: the device is the source of truth for what it has, and
 * this still works for a sideloaded package or an unreachable library.
 */
export async function readDeviceFile(
  queue: CommandRunner,
  { path, scope = "user", chunkBytes = READ_CHUNK_BYTES }: ReadOptions,
): Promise<Uint8Array> {
  const begin = await queue({ command: "file_read_begin", scope, path });
  ensureReadOk(begin.result);
  const size = Number((begin.result as Record<string, unknown> | null)?.size ?? 0);
  if (!size) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < size) {
    const response = await queue({
      command: "file_read_chunk", scope, path, offset, length: chunkBytes,
    });
    ensureReadOk(response.result);
    const result = (response.result ?? {}) as Record<string, unknown>;
    const hex = typeof result.data === "string" ? result.data : "";
    if (!hex) break;
    const bytes = hexToBytes(hex);
    chunks.push(bytes);
    const nextOffset = Number(result.next_offset ?? offset + bytes.length);
    ensureReadAdvanced(offset, nextOffset, result.has_more !== false);
    offset = nextOffset;
    if (result.has_more === false) break;
  }

  const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.length;
  }
  return merged;
}
