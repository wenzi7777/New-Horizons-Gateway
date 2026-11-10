// Firmware-update progress as the Desktop shows it (update_state.py): reading
// a device's check_update / apply_update results into one update_state, and
// merging successive reports so a partial one never wipes what is known.
import { type Dict, has, isDict, strOr, toInt, truthy } from './py';

/** A Direct (ESP-NOW) reply only starts the Hub-relayed operation; its state is still "idle". */
export const RELAYED_UPDATE_START: Readonly<Record<string, string>> = {
  update_check_started: 'checking',
  update_started: 'starting',
};

/** `_mark_relayed_update_started` (mutates `payload` and its `data`). */
export function markRelayedUpdateStarted(payload: Dict): void {
  const phase = RELAYED_UPDATE_START[strOr(payload.message)];
  if (phase === undefined) return;
  for (const container of [payload, payload.data]) {
    if (!isDict(container)) continue;
    let state = container.update_state;
    if (isDict(state) && (strOr(state.phase) || 'idle') === 'idle') {
      state = { ...state, phase };
      if (!has(state as Dict, 'operation')) (state as Dict).operation = phase === 'checking' ? 'check_update' : 'apply_update';
      // Blank fields would erase what the last status knew.
      const cleaned: Dict = {};
      for (const [key, value] of Object.entries(state as Dict)) {
        if (value !== '' && value !== null && value !== undefined) cleaned[key] = value;
      }
      container.update_state = cleaned;
    }
  }
}

function pyBoolDefault(payload: Dict, key: string, fallback: boolean): boolean {
  return has(payload, key) ? truthy(payload[key]) : fallback;
}

/** `_update_state_from_result`: the update_state a check/apply result implies, or null. */
export function updateStateFromResult(payload: Dict): Dict | null {
  const message = strOr(payload.message);
  if (message === 'update_checked') {
    return {
      phase: 'ready',
      operation: 'check_update',
      version: truthy(payload.version) ? payload.version : has(payload, 'latest_version') ? payload.latest_version : '',
      manifest_url: has(payload, 'manifest_url') ? payload.manifest_url : '',
      changelog_url: has(payload, 'changelog_url') ? payload.changelog_url : '',
      total_files: 0,
      applied_files: 0,
      downloaded_files: 0,
      skipped_files: 0,
      current_file: '',
      last_error: '',
      last_result: 'manifest_ready',
      reboot_required: false,
    };
  }
  if (message === 'update_applied') {
    const downloaded = toInt(payload.downloaded_files);
    const skipped = toInt(payload.skipped_files);
    const total = toInt(truthy(payload.total_files) ? payload.total_files : downloaded + skipped || 1);
    return {
      phase: 'done',
      operation: 'apply_update',
      version: has(payload, 'version') ? payload.version : '',
      total_files: total,
      applied_files: total,
      downloaded_files: downloaded,
      skipped_files: skipped,
      deleted_files: toInt(payload.deleted_files),
      current_file: '',
      last_error: '',
      last_result: 'applied',
      reboot_required: pyBoolDefault(payload, 'reboot_required', true),
    };
  }
  if (message === 'update_started') {
    return {
      phase: 'downloading',
      operation: 'apply_update',
      version: has(payload, 'version') ? payload.version : '',
      total_files: 0,
      applied_files: 0,
      downloaded_files: 0,
      skipped_files: 0,
      current_file: has(payload, 'current_file') ? payload.current_file : 'firmware',
      last_error: '',
      last_result: 'starting',
      reboot_required: pyBoolDefault(payload, 'reboot_required', true),
    };
  }
  if (message === 'command_failed' || payload.status === 'error') {
    return {
      phase: 'error',
      operation: strOr(payload.command),
      total_files: 0,
      applied_files: 0,
      downloaded_files: 0,
      skipped_files: 0,
      current_file: '',
      last_error: strOr(payload.error) || strOr(payload.message) || 'command_failed',
      last_result: 'error',
      reboot_required: false,
    };
  }
  return null;
}

export function appliedCount(state: Dict): number {
  const applied = toInt(state.applied_files);
  if (applied) return applied;
  return toInt(state.downloaded_files) + toInt(state.skipped_files);
}

export function writeStateComplete(state: Dict): boolean {
  if (strOr(state.operation) !== 'apply_update') return false;
  if (strOr(state.phase) === 'done') return true;
  const total = toInt(state.total_files);
  return total > 0 && appliedCount(state) >= total;
}

export function normalizeCompletedWriteState(state: Dict): Dict {
  if (!writeStateComplete(state)) return state;
  return { ...state, phase: 'done', current_file: '', last_error: '', last_result: 'applied', reboot_required: true };
}

/** A device reporting the version an apply_update targeted has finished it. */
export function finalizeApplyUpdateForFirmwareVersion<T>(payload: T): T {
  if (!isDict(payload)) return payload;
  const state = payload.update_state;
  if (!isDict(state)) return payload;
  if (strOr(state.operation) !== 'apply_update') return payload;
  const firmwareVersion = strOr(payload.firmware_version);
  const targetVersion = strOr(state.version);
  if (!firmwareVersion || !targetVersion || firmwareVersion !== targetVersion) return payload;
  const completed: Dict = { ...state };
  let total = toInt(completed.total_files);
  let downloaded = toInt(completed.downloaded_files);
  const skipped = toInt(completed.skipped_files);
  if (total <= 0) total = Math.max(downloaded + skipped, 1);
  if (downloaded <= 0 && skipped <= 0) downloaded = 1;
  const applied = toInt(completed.applied_files);
  Object.assign(completed, {
    phase: 'done',
    total_files: total,
    applied_files: Math.max(applied, total),
    downloaded_files: downloaded,
    skipped_files: skipped,
    current_file: '',
    last_error: '',
    last_result: 'applied',
    reboot_required: true,
  });
  return { ...payload, update_state: completed } as T;
}

/** `_merge_update_state`: a partial or stale report never overwrites a fuller one. */
export function mergeUpdateState(existing: unknown, incoming: unknown, existingMode = '', incomingMode = ''): unknown {
  if (!isDict(incoming)) return existing;
  const next = normalizeCompletedWriteState(incoming);
  if (!isDict(existing)) return next;
  const prev = normalizeCompletedWriteState(existing);
  const existingPhase = strOr(prev.phase);
  const incomingPhase = strOr(next.phase);
  const existingOperation = strOr(prev.operation);
  const incomingOperation = strOr(next.operation);
  const modeChanged = Boolean(existingMode && incomingMode && existingMode !== incomingMode);

  if ((incomingPhase === '' || incomingPhase === 'idle') && existingOperation) {
    return modeChanged ? next : prev;
  }
  if (
    existingPhase === 'done' &&
    incomingOperation === existingOperation &&
    incomingOperation === 'apply_update' &&
    incomingPhase === 'downloading' &&
    ['starting', 'planned'].includes(strOr(next.last_result))
  ) {
    return next;
  }
  if (existingPhase === 'done' && incomingPhase !== 'done') return modeChanged ? next : prev;
  if (incomingOperation === existingOperation && incomingOperation === 'apply_update') {
    if (appliedCount(next) < appliedCount(prev)) return prev;
  }
  return next;
}
