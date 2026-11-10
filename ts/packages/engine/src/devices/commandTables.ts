// What the Desktop knows about device commands without a device catalog
// (device_commands.py's static tables, terminal.py's allowlist and payload
// checks). Devices on firmware older than v1.15.0 are gated by these alone.

/** terminal.DEVICE_COMMAND_ALLOWLIST: what a user may send. */
export const DEVICE_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  'status', 'query', 'check_update', 'apply_update', 'reboot', 'reboot_wifi_setup',
  'enter_maintenance', 'exit_maintenance', 'memory_status', 'sensor_sample', 'battery_status',
  'scan_health', 'storage_status', 'task_list', 'crash_log', 'crash_clear', 'health',
  'service_list', 'service_restart', 'dmesg',
  'sysmon', 'thread_list', 'task_stop', 'task_start', 'task_set_period', 'service_stop',
  'service_start', 'app_stop', 'app_start',
  'set_time', 'clock_sync', 'clock_status', 'set_clock_config', 'set_power_profile',
  'config_schema', 'config_get', 'config_set', 'capabilities', 'commands',
  'app_list', 'app_enable', 'app_disable', 'app_revive', 'app_load_flow', 'app_unload_flow',
  'app_events', 'app_view', 'app_list_packages', 'app_install', 'app_uninstall', 'app_activate',
  'app_deactivate', 'app_verify', 'app_reindex',
  'calibration_status', 'calibration_enable', 'calibration_disable', 'calibration_clear_profile',
  'calibration_session_begin', 'calibration_session_abort', 'calibration_session_commit',
  'calibration_dump_tare', 'calibration_dump_fit', 'calibration_set_fit', 'calibration_set_reference',
  'calibration_dump_level', 'calibration_delete_level', 'calibration_capture_tare',
  'calibration_capture_cell', 'calibration_capture_all', 'calibration_tare_capture',
  'calibration_tare_clear',
  'findme_discover', 'findme_switch_gateway',
  'set_matrix_layout', 'set_scan_timing', 'set_stream_buffer', 'set_charge_profile',
  'set_battery_profile', 'resync_battery_gauge', 'power_set_state', 'set_action_button',
  'set_log', 'set_ota_config', 'set_indicators', 'set_imu', 'set_filter', 'set_raw_adc',
  'file_list', 'file_read_begin', 'file_read_chunk', 'file_write_begin', 'file_write_chunk',
  'file_write_finish', 'file_delete', 'log_tail', 'log_clear',
]);

export const STATUS_COMMANDS: ReadonlySet<string> = new Set(['status', 'query', 'memory_status', 'scan_health', 'storage_status']);

export const SHARED_COMMANDS: ReadonlySet<string> = new Set([
  'status', 'query', 'memory_status', 'sensor_sample', 'battery_status', 'scan_health',
  'storage_status', 'findme_discover', 'findme_switch_gateway', 'set_wifi', 'log_tail',
  'log_clear', 'file_list', 'file_read_begin', 'file_read_chunk', 'set_log', 'set_ota_config',
  'check_update', 'apply_update', 'reboot', 'reboot_wifi_setup', 'set_transport',
  'task_list', 'service_list', 'service_restart', 'dmesg', 'crash_log', 'crash_clear', 'health',
  'capabilities', 'config_schema', 'config_get', 'config_set', 'set_time', 'clock_sync',
  'clock_status', 'set_clock_config', 'set_power_profile', 'app_list', 'app_enable',
  'app_disable', 'app_revive', 'app_load_flow', 'app_unload_flow', 'app_events',
  'app_list_packages', 'app_verify', 'app_view', 'commands',
  'sysmon', 'thread_list', 'task_stop', 'task_start', 'task_set_period', 'service_stop',
  'service_start', 'app_stop', 'app_start',
]);

export const NORMAL_COMMANDS: ReadonlySet<string> = new Set([
  ...SHARED_COMMANDS,
  'enter_maintenance', 'set_matrix_layout', 'set_scan_timing', 'set_stream_buffer',
  'set_charge_profile', 'set_battery_profile', 'resync_battery_gauge', 'power_set_state',
  'set_action_button', 'set_indicators', 'set_imu', 'set_filter', 'set_raw_adc',
  'calibration_status', 'calibration_enable', 'calibration_disable', 'calibration_dump_tare',
  'calibration_dump_level', 'calibration_dump_fit', 'calibration_tare_capture',
  'calibration_tare_clear',
]);

export const MAINTENANCE_COMMANDS: ReadonlySet<string> = new Set([
  ...NORMAL_COMMANDS,
  'exit_maintenance', 'calibration_clear_profile', 'calibration_delete_level',
  'calibration_session_begin', 'calibration_session_abort', 'calibration_session_commit',
  'calibration_capture_tare', 'calibration_capture_cell', 'calibration_capture_all',
  'calibration_set_fit', 'calibration_set_reference', 'file_write_begin', 'file_write_chunk',
  'file_write_finish', 'file_delete', 'app_install', 'app_uninstall', 'app_activate',
  'app_deactivate', 'app_reindex',
]);

export const MODE_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  normal: NORMAL_COMMANDS,
  maintenance: MAINTENANCE_COMMANDS,
  safe_maintenance: MAINTENANCE_COMMANDS,
  safemaintenance: MAINTENANCE_COMMANDS,
};

/** Sent by the service itself (hub migration, WiFi provisioning); real commands users do not type. */
export const INTERNAL_DEVICE_COMMANDS: ReadonlySet<string> = new Set(['set_transport', 'set_wifi']);

export const KNOWN_DEVICE_COMMANDS: ReadonlySet<string> = new Set([...DEVICE_COMMAND_ALLOWLIST, ...INTERNAL_DEVICE_COMMANDS]);

/** Firmware Storage scopes; "proc" is a read-only synthetic view. */
export const READABLE_SCOPES: ReadonlySet<string> = new Set(['user', 'logs', 'calibration', 'proc']);
export const WRITABLE_SCOPES: ReadonlySet<string> = new Set(['user', 'logs', 'calibration']);
export const WRITE_COMMANDS: ReadonlySet<string> = new Set(['file_write_begin', 'file_write_chunk', 'file_write_finish', 'file_delete']);

/** Thrown by validateDeviceCommandPayload; `code` is the Desktop's error code. */
export class InvalidCommandError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'InvalidCommandError';
  }
}

function isStrictInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * terminal.validate_device_command_payload: the command must be on the
 * allowlist or in the device's own public commands (its catalog); a few
 * payloads are checked. Returns a copy with `command` (stripped) and `scope`
 * normalized. Throws InvalidCommandError.
 */
export function validateDeviceCommandPayload(
  payload: Record<string, unknown>,
  deviceCommands: ReadonlySet<string> | null = null,
): Record<string, unknown> {
  const command = (payload.command === null || payload.command === undefined || payload.command === '' ? '' : String(payload.command)).trim();
  if (!command || (!DEVICE_COMMAND_ALLOWLIST.has(command) && !(deviceCommands?.has(command) ?? false))) {
    throw new InvalidCommandError('unknown_command');
  }
  const result: Record<string, unknown> = { ...payload, command };
  if (command === 'set_battery_profile') {
    const capacity = result.capacity_mah;
    const current = result.max_charge_current_ma;
    if (!isStrictInt(capacity) || !isStrictInt(current)) throw new InvalidCommandError('invalid_battery_profile');
    if (capacity <= 0 || current < 100 || current > 350 || current % 10) throw new InvalidCommandError('invalid_battery_profile');
  }
  if ('scope' in result) {
    const raw = result.scope;
    const scope = (raw === null || raw === undefined || raw === '' || raw === false || raw === 0 ? 'user' : String(raw)).trim();
    if (!READABLE_SCOPES.has(scope)) throw new InvalidCommandError('invalid_scope');
    if (!WRITABLE_SCOPES.has(scope) && WRITE_COMMANDS.has(command)) throw new InvalidCommandError('read_only_scope');
    result.scope = scope;
  }
  return result;
}
