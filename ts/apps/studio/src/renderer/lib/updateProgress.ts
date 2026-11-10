// Ported from New-Horizons-Desktop/frontend/src/lib/updateProgress.ts; keep in step.
// Firmware-update progress as the UI shows it. Plain functions with no
// React or browser dependency, so tests/updateProgress.test.mjs loads them.

export type UpdateState = {
  phase?: string;
  operation?: string;
  version?: string;
  manifest_url?: string;
  changelog_url?: string;
  total_files?: number;
  applied_files?: number;
  // A Direct-mode (Hub-relayed) update counts chunks, not files.
  total_chunks?: number;
  applied_chunks?: number;
  skipped_files?: number;
  downloaded_files?: number;
  deleted_files?: number;
  current_file?: string;
  last_error?: string;
  last_result?: string;
  request_id?: string;
  reboot_required?: boolean;
};

export function appliedFileCount(state: UpdateState): number {
  if (Number(state.total_chunks ?? 0) > 0) return Number(state.applied_chunks ?? 0);
  return Number(state.applied_files ?? Number(state.downloaded_files ?? 0) + Number(state.skipped_files ?? 0));
}

/** Files over WiFi, chunks through a Hub; 0 when unknown. */
export function totalUnits(state: UpdateState): number {
  return Number(state.total_chunks ?? 0) > 0 ? Number(state.total_chunks) : Number(state.total_files ?? 0);
}

/** "123 / 425 (29%)" while a transfer runs, else null. Files over WiFi, chunks through a Hub. */
export function updateTransferProgress(state: UpdateState): string | null {
  const total = totalUnits(state);
  if (total <= 0 || state.phase !== "downloading") return null;
  const done = Math.min(appliedFileCount(state), total);
  return `${done} / ${total} (${Math.round((done / total) * 100)}%)`;
}

export function isAppliedComplete(state: UpdateState): boolean {
  const operation = String(state.operation ?? "");
  const total = totalUnits(state);
  return operation === "apply_update" && total > 0 && appliedFileCount(state) >= total;
}

export function progressOf(state: UpdateState): number {
  if (isAppliedComplete(state)) return 100;
  if (state.phase === "done") return 100;
  if (state.phase === "ready") return 12;
  if (state.phase === "downloading") {
    const total = totalUnits(state);
    return total > 0 ? Math.min(96, Math.max(12, Math.round((appliedFileCount(state) / total) * 100))) : 12;
  }
  if (state.phase === "error") return 100;
  return state.operation ? 8 : 0;
}
