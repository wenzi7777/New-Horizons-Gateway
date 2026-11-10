// Whether a command may be sent to a device right now, and the bookkeeping
// around commands in flight (command_gating.py): the device's mode (normal /
// maintenance / safe), boot transitions, and the pending-command table that
// turns a later status into the result of a command whose reply was lost.
//
// With a device's own command catalog (firmware v1.15.0+) its flags decide;
// without one the static tables do. Times are monotonic ms.
import type { CommandCatalogStore } from './commandCatalog';
import { KNOWN_DEVICE_COMMANDS, MAINTENANCE_COMMANDS, MODE_COMMANDS, NORMAL_COMMANDS } from './commandTables';
import { type Dict, dictOr, has, isDict, setDefault, strOr, toInt, truthy } from './py';
import { normalizeCompletedWriteState, writeStateComplete } from './updateState';

/** How long a command waits for its reply in the pending table. */
export const PENDING_COMMAND_TTL_MS = 30_000;
export const BOOT_GRACE_MS = 90_000;

export interface PendingCommand {
  request_id: string;
  command: string;
  target_mode: unknown;
  /** Monotonic ms. */
  created_at: number;
}

export interface BootTransition {
  request_id: string;
  command: string;
  target_mode: string;
  created_at: number;
  expires_at: number;
}

/** `_mode_from_payload`: `mode`, else `runtime.mode`, lower-cased. */
export function modeFromPayload(payload: unknown): string {
  if (!isDict(payload)) return '';
  const mode = strOr(payload.mode).trim().toLowerCase();
  if (mode) return mode;
  return strOr(dictOr(payload.runtime).mode).trim().toLowerCase();
}

function commandOf(payload: Dict): string {
  return (strOr(payload.command) || strOr(payload.cmd)).trim();
}

/**
 * `_maintenance_mode_from_result`: enter/exit_maintenance acks carry no mode
 * and the device pushes no status afterwards, so derive it.
 */
export function maintenanceModeFromResult(payload: Dict): string | null {
  if (payload.ok === false || strOr(payload.status) === 'error') return null;
  const command = strOr(payload.command) || strOr(payload.cmd);
  const message = strOr(payload.message);
  if (command === 'enter_maintenance' || message === 'maintenance_entered') return 'maintenance';
  if (command === 'exit_maintenance' || message === 'maintenance_exited') return 'normal';
  return null;
}

/** `_boot_command_mode_error_for_status`: the static tables' answer. */
export function staticCommandModeError(status: Dict, payload: Dict): string {
  const command = commandOf(payload);
  let currentMode = modeFromPayload(status);
  // Existence is the allowlist's question; MODE_COMMANDS only answers "may it run in this mode".
  if (!KNOWN_DEVICE_COMMANDS.has(command)) return command ? 'unknown_command' : '';
  if (!currentMode) return '';
  if (currentMode === 'safe' || currentMode === 'safe-maintenance') currentMode = 'safe_maintenance';
  if (MAINTENANCE_COMMANDS.has(command) && !NORMAL_COMMANDS.has(command) && currentMode === 'normal') {
    return 'maintenance_required';
  }
  const known = new Set<string>();
  for (const commands of Object.values(MODE_COMMANDS)) for (const c of commands) known.add(c);
  if (!known.has(command)) return '';
  const allowed = MODE_COMMANDS[currentMode];
  if (allowed === undefined || !allowed.has(command)) return 'wrong_mode';
  return '';
}

/** `_catalog_command_mode_error`: the device's own flags; null without a catalog. */
export function catalogCommandModeError(catalogs: CommandCatalogStore, deviceUid: string, status: Dict, payload: Dict): string | null {
  const command = commandOf(payload);
  if (!command) return null;
  let currentMode = modeFromPayload(status);
  if (currentMode === 'safe' || currentMode === 'safe-maintenance') currentMode = 'safe_maintenance';
  // No known mode: only existence is checked, as the static path does.
  const maintenance = currentMode !== 'normal';
  const error = catalogs.modeError(deviceUid, command, maintenance);
  if (error === null) return null;
  if (!error && currentMode && MODE_COMMANDS[currentMode] === undefined) return 'wrong_mode';
  return error;
}

/** `_boot_command_mode_error_locked`: "" when the command may be sent now, else the error code. */
export function commandModeError(catalogs: CommandCatalogStore, deviceUid: string, status: Dict, payload: Dict): string {
  const catalogError = catalogCommandModeError(catalogs, deviceUid, status, payload);
  if (catalogError !== null) return catalogError;
  return staticCommandModeError(status, payload);
}

function resultFrom(payload: Dict, command: string, requestId: string, message: string): Dict {
  const result: Dict = { ...payload, command, request_id: requestId };
  setDefault(result, 'status', 'ok');
  setDefault(result, 'message', message);
  return result;
}

/**
 * `_result_from_pending_status`: whether a status (or its update_state)
 * answers a pending command whose own reply was lost; the synthetic result, or null.
 */
export function resultFromPendingStatus(command: string, requestId: string, payload: Dict, state: Dict): Dict | null {
  if (['status', 'query', 'memory_status', 'scan_health'].includes(command)) return resultFrom(payload, command, requestId, command);
  if (command === 'storage_status') {
    const hasStorage = ['total_bytes', 'used_bytes', 'free_bytes', 'categories'].some((key) => has(payload, key)) || isDict(payload.storage);
    return hasStorage ? resultFrom(payload, command, requestId, command) : null;
  }
  if (command === 'enter_maintenance' && strOr(payload.mode) === 'maintenance') {
    return resultFrom(payload, command, requestId, 'maintenance_entered');
  }
  if (command === 'exit_maintenance' && strOr(payload.mode) === 'normal') {
    return resultFrom(payload, command, requestId, 'maintenance_exited');
  }
  const operation = strOr(state.operation);
  const phase = strOr(state.phase);
  if (command === 'check_update' && operation === command && phase === 'ready') {
    return {
      status: 'ok',
      message: 'update_checked',
      command,
      request_id: requestId,
      latest_version: has(state, 'version') ? state.version : '',
      manifest_url: has(state, 'manifest_url') ? state.manifest_url : '',
      changelog_url: has(state, 'changelog_url') ? state.changelog_url : '',
      update_state: state,
      reboot_required: false,
    };
  }
  if (command === 'apply_update' && operation === command && writeStateComplete(state)) {
    const done = normalizeCompletedWriteState(state);
    return {
      status: 'ok',
      message: 'update_applied',
      command,
      request_id: requestId,
      version: has(done, 'version') ? done.version : '',
      downloaded_files: toInt(done.downloaded_files),
      skipped_files: toInt(done.skipped_files),
      deleted_files: toInt(done.deleted_files),
      update_state: done,
      reboot_required: has(done, 'reboot_required') ? truthy(done.reboot_required) : true,
    };
  }
  return null;
}

/** The pending-command table and boot transitions (CommandGatingMixin's state). */
export class CommandGating {
  readonly pending = new Map<string, Map<string, PendingCommand>>();
  readonly bootTransitions = new Map<string, BootTransition>();

  constructor(private readonly nowMs: () => number) {}

  /**
   * `_boot_target_mode`: which mode a command reboots the device into. No
   * command does any more (the recovery boot commands were removed), so
   * boot transitions are never created; the machinery is kept as in Python.
   */
  bootTargetMode(command: string): string {
    void command;
    return '';
  }

  /** `_remember_pending_command`; returns the boot transition it started, if any. */
  remember(deviceUid: string, payload: Dict): BootTransition | null {
    const requestId = strOr(payload.request_id);
    const command = strOr(payload.command) || strOr(payload.cmd);
    if (!requestId || !command) return null;
    const now = this.nowMs();
    let transition: BootTransition | null = null;
    const bootTarget = this.bootTargetMode(command);
    if (bootTarget) {
      transition = { request_id: requestId, command, target_mode: bootTarget, created_at: now, expires_at: now + BOOT_GRACE_MS };
      this.bootTransitions.set(deviceUid, transition);
    }
    let forDevice = this.pending.get(deviceUid);
    if (forDevice === undefined) {
      forDevice = new Map();
      this.pending.set(deviceUid, forDevice);
    }
    // Replies that never came are of no use after the TTL; prune on every add
    // too, since a device behind a relay never sends the statuses that prune.
    for (const [staleId, stale] of [...forDevice]) {
      if (now - stale.created_at > PENDING_COMMAND_TTL_MS) forDevice.delete(staleId);
    }
    // Like the dict assignment: a repeated request_id keeps its place.
    forDevice.set(requestId, { request_id: requestId, command, target_mode: has(payload, 'target_mode') ? payload.target_mode : '', created_at: now });
    return transition;
  }

  forget(deviceUid: string, requestId: string): void {
    if (!requestId) return;
    const forDevice = this.pending.get(deviceUid);
    if (forDevice === undefined) return;
    forDevice.delete(requestId);
    if (forDevice.size === 0) this.pending.delete(deviceUid);
  }

  forgetDevice(deviceUid: string): void {
    this.pending.delete(deviceUid);
  }

  activeBootTransition(deviceUid: string): BootTransition | null {
    const transition = this.bootTransitions.get(deviceUid);
    if (transition === undefined) return null;
    if (this.nowMs() > transition.expires_at) {
      this.bootTransitions.delete(deviceUid);
      return null;
    }
    return transition;
  }

  /** `_clear_boot_pending_if_mode_changed_locked`: reaching the target mode ends a boot transition. */
  modeObserved(deviceUid: string, currentMode: string): void {
    const transition = this.bootTransitions.get(deviceUid);
    if (transition && currentMode && currentMode === transition.target_mode) this.bootTransitions.delete(deviceUid);
  }

  /** `_pending_result_from_status`: the first pending command this status answers (removed from the table). */
  pendingResultFromStatus(deviceUid: string, payload: Dict): Dict | null {
    const forDevice = this.pending.get(deviceUid);
    if (forDevice === undefined || forDevice.size === 0) return null;
    const now = this.nowMs();
    for (const [requestId, pending] of [...forDevice]) {
      if (now - pending.created_at > PENDING_COMMAND_TTL_MS) forDevice.delete(requestId);
    }
    if (forDevice.size === 0) {
      this.pending.delete(deviceUid);
      return null;
    }
    const state = dictOr(payload.update_state);
    for (const [requestId, pending] of [...forDevice]) {
      const result = resultFromPendingStatus(pending.command, requestId, payload, state);
      if (result !== null) {
        forDevice.delete(requestId);
        if (forDevice.size === 0) this.pending.delete(deviceUid);
        return result;
      }
    }
    return null;
  }
}
