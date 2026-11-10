// Device commands for the apps area, through Studio's api.sendCommand (which
// waits for the device's result), shaped as the Desktop's queued results so
// the ported parsers and the file-transfer loop run unchanged.
import type { CommandOutcome } from "../../../../shared/contract";
import type { CommandRunner, InstallPhase, QueuedResult, TransferProgress, AbortRef } from "./deviceFileTransfer";
import { installAppPackage } from "./deviceFileTransfer";

/**
 * A CommandOutcome as the Desktop's result record. The host hands back the
 * device result's `data` when it has one, else the whole result: both shapes
 * are kept (top-level fields and `.data`), so `result.data.apps` and
 * `result.size` both read as they do on the Desktop. A string `data` (a
 * file_read_chunk's hex) stays `data`.
 */
export function outcomeResult(outcome: CommandOutcome): Record<string, unknown> {
  if (!outcome.ok) return { status: "error", ok: false, error: outcome.message || "command_failed", data: outcome.data };
  const data = outcome.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return { ...(data as Record<string, unknown>), status: "ok", data };
  return { status: "ok", data };
}

export type SendCommand = (uid: string, payload: Record<string, unknown>) => Promise<CommandOutcome>;

/** One command at a time per runner: the device (and a Hub) serve one command per device at once. */
export function commandRunner(send: SendCommand, uid: string): CommandRunner {
  let tail: Promise<unknown> = Promise.resolve();
  return (payload) => {
    const run = tail.then(async (): Promise<QueuedResult> => ({ result: outcomeResult(await send(uid, payload)) }));
    tail = run.catch(() => undefined);
    return run;
  };
}

export function isMaintenance(mode: string | undefined): boolean {
  return mode === "maintenance" || mode === "safe_maintenance" || mode === "SafeMaintenance";
}

export function resultFailure(result: Record<string, unknown> | null | undefined): string {
  if (!result) return "command_delivery_timeout";
  if (result.ok === false || result.status === "error") return String(result.error || result.message || "device_error");
  return "";
}

export type InstallStep = "maintenance" | "upload" | "install" | "restore";

export type InstallRun = {
  appId: string;
  devicePath: string;
  dataHex: string;
  sha256?: string;
  /** The device is already in maintenance: neither entered nor left. */
  alreadyInMaintenance: boolean;
  onStep?: (step: InstallStep | null) => void;
  onProgress?: (progress: TransferProgress) => void;
  abortRef?: AbortRef;
};

/**
 * The Desktop's AppInstallDialog sequence: enter maintenance (unless already
 * in it), chunked file_write_* of the package, app_install with replace, then
 * leave maintenance again -- also after a failure, but only when this run
 * entered it.
 */
export async function runAppInstall(queue: CommandRunner, options: InstallRun): Promise<Record<string, unknown> | null> {
  const { onStep } = options;
  let entered = false;
  try {
    if (!options.alreadyInMaintenance) {
      onStep?.("maintenance");
      const entering = await queue({ command: "enter_maintenance", reason: "app_install" });
      const failure = resultFailure(entering.result);
      if (failure) throw new Error(failure);
      entered = true;
    }
    const result = await installAppPackage(queue, {
      appId: options.appId,
      devicePath: options.devicePath,
      dataHex: options.dataHex,
      sha256: options.sha256,
      // The upload has already replaced the file by the time app_install runs, so the index must follow it.
      replace: true,
      onPhase: (phase: InstallPhase) => {
        if (phase === "upload" || phase === "install") onStep?.(phase);
      },
      onProgress: options.onProgress,
      abortRef: options.abortRef,
    });
    if (entered) {
      onStep?.("restore");
      entered = false;
      await queue({ command: "exit_maintenance" });
    }
    onStep?.(null);
    return result;
  } catch (error) {
    // Leave the device the way we found it, even after a failure.
    if (entered) {
      onStep?.("restore");
      await queue({ command: "exit_maintenance" }).catch(() => undefined);
    }
    onStep?.(null);
    throw error;
  }
}
