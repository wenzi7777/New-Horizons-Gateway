// Port of New-Horizons-Desktop/backend/newhorizons_backend/terminal.py:
// terminal_help_items, compile_terminal_command and its helpers. The
// allowlist and validate_device_command_payload are not duplicated here: they
// live in @nhgw/engine (DEVICE_COMMAND_ALLOWLIST / validateDeviceCommandPayload)
// and are re-exported below.
//
// Errors: every Python `ValueError("<code>")` throws `Error("<code>")` with the
// same code. Where the Python fails implicitly, this throws instead of
// returning something lenient:
//   - shlex.split ValueError("No closing quotation" / "No escaped character")
//     -> Error("No closing quotation") / Error("No escaped character")
//   - int()/float() ValueError on a non-numeric value -> Error("invalid_number")
//   - KeyError on a required option that was not given -> Error("missing_option")
// Platform-independent: no Node APIs.

export { DEVICE_COMMAND_ALLOWLIST, InvalidCommandError, validateDeviceCommandPayload } from '@nhgw/engine';

export type TerminalHelpItem = { command: string; description: string; example: string };
export type CompiledTerminalCommand = { command: string; payload: Record<string, unknown>; argv: string[] };

/** Python's shlex.split(s) (posix=True, comments=False). */
export function shlexSplit(s: string): string[] {
  const WHITESPACE = ' \t\r\n';
  const tokens: string[] = [];
  let token = '';
  let inToken = false; // a token has started (quotes count even when empty)
  let state: 'none' | "'" | '"' = 'none';
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (state === 'none') {
      if (WHITESPACE.includes(ch)) {
        if (inToken) {
          tokens.push(token);
          token = '';
          inToken = false;
        }
      } else if (ch === '\\') {
        if (i + 1 >= s.length) throw new Error('No escaped character');
        token += s[i + 1];
        inToken = true;
        i += 1;
      } else if (ch === "'" || ch === '"') {
        state = ch;
        inToken = true;
      } else {
        token += ch;
        inToken = true;
      }
    } else if (state === "'") {
      if (ch === "'") state = 'none';
      else token += ch;
    } else {
      if (ch === '"') {
        state = 'none';
      } else if (ch === '\\') {
        if (i + 1 >= s.length) throw new Error('No closing quotation');
        const next = s[i + 1]!;
        // Inside double quotes only the quote and the escape char are escaped.
        if (next === '"' || next === '\\') {
          token += next;
          i += 1;
        } else {
          token += ch;
        }
      } else {
        token += ch;
      }
    }
    i += 1;
  }
  if (state !== 'none') throw new Error('No closing quotation');
  if (inToken) tokens.push(token);
  return tokens;
}

// Python str.strip() whitespace (ASCII subset is what matters here).
function pyStrip(value: string): string {
  return value.replace(/^[\s\u001c-\u001f]+|[\s\u001c-\u001f]+$/g, '');
}

/** Python int(str|int): surrounding whitespace, sign, digit underscores. */
function pyInt(value: string | number): number {
  if (typeof value === 'number') return Math.trunc(value);
  const text = pyStrip(value);
  if (!/^[+-]?\d+(_\d+)*$/.test(text)) throw new Error('invalid_number');
  return Number.parseInt(text.replace(/_/g, ''), 10);
}

/** Python float(str): decimals, exponents, inf/infinity/nan, underscores. */
function pyFloat(value: string | number): number {
  if (typeof value === 'number') return value;
  const text = pyStrip(value);
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(text);
  if (special) {
    if (special[2]!.toLowerCase() === 'nan') return Number.NaN;
    return special[1] === '-' ? -Infinity : Infinity;
  }
  const digits = '\\d+(?:_\\d+)*';
  const re = new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?$`);
  if (!re.test(text)) throw new Error('invalid_number');
  return Number.parseFloat(text.replace(/_/g, ''));
}

type Options = Map<string, string>;

function req(parsed: Options, key: string): string {
  const value = parsed.get(key);
  if (value === undefined) throw new Error('missing_option'); // Python KeyError
  return value;
}

function opt<T>(parsed: Options, key: string, fallback: T): string | T {
  const value = parsed.get(key);
  return value === undefined ? fallback : value;
}

function parseOptions(args: string[]): Options {
  const parsed: Options = new Map();
  let idx = 0;
  while (idx < args.length) {
    const token = args[idx]!;
    if (!token.startsWith('--')) throw new Error('unexpected_argument');
    const key = token.slice(2).replace(/-/g, '_');
    if (idx + 1 >= args.length) throw new Error('missing_option_value');
    parsed.set(key, args[idx + 1]!);
    idx += 2;
  }
  return parsed;
}

function parseCsvInts(value: string): number[] {
  return value
    .split(',')
    .filter((part) => pyStrip(part))
    .map((part) => pyInt(pyStrip(part)));
}

function addScope(payload: Record<string, unknown>, parsed: Options): void {
  if (parsed.has('scope')) payload.scope = parsed.get('scope');
}

function asBool(value: string | boolean): boolean {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(pyStrip(String(value)).toLowerCase());
}

const INT_RE = /^-?(0|[1-9][0-9]*)$/;
const FLOAT_RE = /^-?(0|[1-9][0-9]*)\.[0-9]+$/;

// Strict on purpose: "0123", "1e3", "nan" stay strings.
function coerceScalar(value: string): unknown {
  const lowered = pyStrip(value).toLowerCase();
  if (lowered === 'true' || lowered === 'false') return lowered === 'true';
  if (INT_RE.test(value)) return Number.parseInt(value, 10);
  if (FLOAT_RE.test(value)) return Number.parseFloat(value);
  return value;
}

export function terminalHelpItems(): TerminalHelpItem[] {
  return [
    { command: "status", description: "Query device status.", example: "status" },
    { command: "check-update", description: "Check the Arduino firmware update manifest.", example: "check-update" },
    { command: "apply-update", description: "Apply an Arduino whole-firmware OTA update.", example: "apply-update" },
    { command: "enter-maintenance", description: "Enter maintenance mode and stop normal scanning.", example: "enter-maintenance --reason calibration" },
    { command: "exit-maintenance", description: "Exit maintenance mode.", example: "exit-maintenance" },
    { command: "scan-health", description: "Query lightweight scan, stream, memory, and control health.", example: "scan-health" },
    { command: "sensor-sample", description: "Read the latest IMU, magnetometer and battery values (firmware v1.6.0+).", example: "sensor-sample" },
    { command: "task-list", description: "List the scheduler's task table with per-task timing and CPU share.", example: "task-list" },
    { command: "crash-log", description: "Show recorded panics/watchdog resets, with the faulting task and PC.", example: "crash-log" },
    { command: "health", description: "Show device health: power-on hours, reset counts, OTA history, temperature.", example: "health" },
    { command: "service-list", description: "List supervised services with state, restart count, and health failures.", example: "service-list" },
    { command: "service-restart", description: "Restart one supervised service without rebooting the device.", example: "service-restart --name imu" },
    { command: "service-stop", description: "Stop a supervised service until it is started again or the device reboots (firmware v1.19.0+).", example: "service-stop --name imu" },
    { command: "service-start", description: "Start a service stopped with service-stop (firmware v1.19.0+).", example: "service-start --name imu" },
    { command: "task-stop", description: "Stop a scheduler task until it is started again or the device reboots; protected tasks are refused (firmware v1.19.0+).", example: "task-stop --name imu" },
    { command: "task-start", description: "Start a task stopped with task-stop (firmware v1.19.0+).", example: "task-start --name imu" },
    { command: "task-set-period", description: "Change how often a task runs, in microseconds, or \"default\" to restore it; lasts until reboot (firmware v1.19.0+).", example: "task-set-period --name imu --period-us 20000" },
    { command: "thread-list", description: "List FreeRTOS threads with priority, core, stack headroom and CPU share, plus per-core load (firmware v1.19.0+).", example: "thread-list" },
    { command: "sysmon", description: "One snapshot of everything the system monitor shows: CPU, tasks, services, apps, memory, scan and threads (firmware v1.19.0+).", example: "sysmon" },
    { command: "dmesg", description: "Tail the in-RAM kernel log ring (no flash reads).", example: "dmesg" },
    { command: "set-time", description: "Set a device's clock to the given time (--force overrides an active NTP/Hub source).", example: "set-time --epoch-ms 1780000000000 --force true" },
    { command: "clock-sync", description: "Re-sync the device clock now from its own source (the Gateway, else NTP, in WiFi mode; the Hub in ESP-NOW mode).", example: "clock-sync" },
    { command: "clock-status", description: "Show the device clock: source, sync age, uncertainty and its clock settings.", example: "clock-status" },
    { command: "app-list", description: "List installed on-device apps with state, time budget and measured cost.", example: "app-list" },
    { command: "app-enable", description: "Enable an installed app slot.", example: "app-enable --name flow" },
    { command: "app-disable", description: "Disable an app slot without uninstalling its package.", example: "app-disable --name flow1" },
    { command: "app-revive", description: "Clear a budget-overrun kill and restart the app.", example: "app-revive --name flow" },
    { command: "app-stop", description: "Stop an app slot until it is started again or the device reboots, without touching its saved enabled state (firmware v1.19.0+).", example: "app-stop --name flow" },
    { command: "app-start", description: "Start an app slot stopped with app-stop (firmware v1.19.0+).", example: "app-start --name flow" },
    { command: "app-events", description: "Events emitted by apps since a sequence number, with a dropped count.", example: "app-events --since-seq 0" },
    { command: "app-list-packages", description: "Installed app packages and which slot each is bound to.", example: "app-list-packages" },
    { command: "app-install", description: "Install an uploaded .nha package into the registry.", example: "app-install --path apps/heel_strike.nha" },
    { command: "app-uninstall", description: "Remove a package from the registry and delete its file.", example: "app-uninstall --id heel_strike" },
    { command: "app-activate", description: "Bind an installed package to a flow slot.", example: "app-activate --id heel_strike --slot 1" },
    { command: "app-deactivate", description: "Unbind a package from its slot, leaving it installed.", example: "app-deactivate --id heel_strike" },
    { command: "app-verify", description: "Re-hash an installed package and compare it with the index.", example: "app-verify --id heel_strike" },
    { command: "app-reindex", description: "Rebuild the package index from the .nha files present.", example: "app-reindex" },
    { command: "app-load-flow", description: "Load a flow graph into slot 0; rejected at load time if it exceeds the budget.", example: "app-load-flow --path apps/flow.json" },
    { command: "app-unload-flow", description: "Unload the flow graph in slot 0.", example: "app-unload-flow" },
    { command: "capabilities", description: "Report protocol, config schema hash, board features, and available subsystems.", example: "capabilities" },
    { command: "config-schema", description: "Describe every configuration knob: path, type, range, and owning command.", example: "config-schema" },
    { command: "config-get", description: "Read one configuration path, or all of them when no path is given.", example: "config-get --path scan.target_fps" },
    { command: "config-set", description: "Write one configuration path; dispatches to the owning set_* handler.", example: "config-set --path scan.target_fps --value 60" },
    { command: "set-power-profile", description: "Choose the idle CPU frequency policy (never applied while scanning).", example: "set-power-profile --profile balanced" },
    { command: "crash-clear", description: "Erase the recorded crash ring and the stored core dump.", example: "crash-clear" },
    { command: "set-stream-buffer", description: "Enable or disable the packet ring buffer and choose standard or extended depth.", example: "set-stream-buffer --enabled true --mode extended" },
    { command: "calibration-status", description: "Query manual calibration status, coverage, and metadata.", example: "calibration-status" },
    { command: "calibration-enable", description: "Enable the saved manual calibration profile.", example: "calibration-enable" },
    { command: "calibration-disable", description: "Disable the saved manual calibration profile.", example: "calibration-disable" },
    { command: "calibration-clear-profile", description: "Delete the saved calibration profile and all stored levels.", example: "calibration-clear-profile" },
    { command: "calibration-session-begin", description: "Start a draft calibration session.", example: "calibration-session-begin" },
    { command: "calibration-session-abort", description: "Abort the current draft calibration session.", example: "calibration-session-abort" },
    { command: "calibration-session-commit", description: "Commit the current draft calibration session.", example: "calibration-session-commit --auto-enable true" },
    { command: "calibration-dump-tare", description: "Dump the saved and draft tare baseline matrix cells.", example: "calibration-dump-tare" },
    { command: "calibration-dump-level", description: "Dump one calibration level with saved and draft matrix cells.", example: "calibration-dump-level --level 10" },
    { command: "calibration-dump-fit", description: "Dump every sensor's fitted coefficients (p = a + b*sqrt(x) + c*x) and fit result.", example: "calibration-dump-fit" },
    { command: "calibration-set-fit", description: "Set the fit inputs: lowest level used, each ADC's readout curve (dV = c1*x + c2*x^2) and clip level.", example: "calibration-set-fit --min-level 3 --adc1-c1 2.6657 --adc1-c2 -9.447e-05" },
    { command: "calibration-set-reference", description: "Set the pressure actually applied for one captured level (what the fit uses).", example: "calibration-set-reference --level 10 --reference 10.12" },
    { command: "calibration-delete-level", description: "Delete one calibration level from the saved profile or current draft session.", example: "calibration-delete-level --level 10" },
    { command: "calibration-capture-cell", description: "Capture one sensor into the current draft calibration session.", example: "calibration-capture-cell --sensor-index 3 --level 10 --duration-ms 3000" },
    { command: "calibration-capture-tare", description: "Capture the no-load tare baseline into the current draft calibration session.", example: "calibration-capture-tare --duration-ms 3000" },
    { command: "calibration-capture-all", description: "Capture all active sensors into the current draft calibration session.", example: "calibration-capture-all --level 10 --reference 10.12 --duration-ms 10000" },
    { command: "findme-discover", description: "Run FindMe and attach to a New Horizons Gateway on the local network.", example: "findme-discover" },
    { command: "findme-switch-gateway", description: "Ask the device to rerun FindMe with a preferred gateway claim.", example: "findme-switch-gateway --preferred-gateway-id local-gateway --claim-id claim-1 --ttl-ms 30000" },
    { command: "set-matrix-layout", description: "Configure active analog and select pins.", example: "set-matrix-layout --analog-pins 1,2,3 --select-pins 13,14,15" },
    { command: "set-scan-timing", description: "Configure matrix scan timing. WebUI offers 60/90 FPS presets; terminal can set custom values.", example: "set-scan-timing --target-fps 75 --settle-us 20 --send-every-n-frames 2" },
    { command: "set-charge-profile", description: "Configure the charging profile. Profiles: ultra_slow (100mA), slow (200mA), balanced (250mA), fast (300mA), extreme (350mA).", example: "set-charge-profile --profile balanced" },
    { command: "power-set-state", description: "Switch the device between normal mode and soft-off power states. Some boards use a remote-only soft-off UX.", example: "power-set-state --state soft_off_auto" },
    { command: "set-log", description: "Configure device rolling log level and capacity.", example: "set-log --enabled true --level info --mode standard" },
    { command: "set-ota-config", description: "Configure firmware updates: boot-time auto update, update channel (stable / beta), optional custom manifest URL.", example: "set-ota-config --auto-apply-on-boot true --channel beta" },
    { command: "set-indicators", description: "Configure supported indicator hardware. Brightness expects decimal values such as 0.10, 0.35, 0.50, or 1.00.", example: "set-indicators --external-led-mode enabled --preset solid_marker --external-led-color teal --brightness 0.35 --oled-mode auto --oled-page live_status" },
    { command: "set-imu", description: "Enable or disable the optional IMU service.", example: "set-imu --enabled false" },
    { command: "io-config", description: "Open the board-aware pin layout and overview helper in the terminal UI.", example: "io-config" },
    { command: "file-list", description: "List maintenance files. Use --scope proc for live kernel state.", example: "file-list --scope proc" },
    { command: "file-read-begin", description: "Begin a maintenance-mode file read.", example: "file-read-begin --scope logs --path device.log" },
    { command: "file-read-chunk", description: "Read a maintenance-mode file chunk. The proc scope is readable outside maintenance.", example: "file-read-chunk --scope proc --path tasks --offset 0 --length 1024" },
    { command: "file-write-begin", description: "Begin a maintenance-mode file write.", example: "file-write-begin --scope user --path configs/profile.json --size 2 --sha256 deadbeef" },
    { command: "file-write-chunk", description: "Write a maintenance-mode file chunk.", example: "file-write-chunk --scope user --path configs/profile.json --offset 0 --data 4e48" },
    { command: "file-write-finish", description: "Finish a maintenance-mode file write.", example: "file-write-finish --scope user --path configs/profile.json" },
    { command: "file-delete", description: "Delete a maintenance file.", example: "file-delete --scope user --path tmp/sample.csv" },
    { command: "log-tail", description: "Read the last N log lines.", example: "log-tail --lines 50" },
    { command: "log-clear", description: "Clear device.log and device.log.1.", example: "log-clear" },
    { command: "reboot", description: "Reboot the current system.", example: "reboot" },
    { command: "reboot-wifi-setup", description: "Reboot into the Wi-Fi setup portal, as holding the action button at power-on does.", example: "reboot-wifi-setup" },
  ];
}

const SIMPLE_COMMANDS: Readonly<Record<string, string>> = {
  status: 'status',
  'check-update': 'check_update',
  'apply-update': 'apply_update',
  'exit-maintenance': 'exit_maintenance',
  'scan-health': 'scan_health',
  'sensor-sample': 'sensor_sample',
  'battery-status': 'battery_status',
  'storage-status': 'storage_status',
  'calibration-status': 'calibration_status',
  'calibration-enable': 'calibration_enable',
  'calibration-disable': 'calibration_disable',
  'calibration-clear-profile': 'calibration_clear_profile',
  'calibration-session-begin': 'calibration_session_begin',
  'calibration-session-abort': 'calibration_session_abort',
  'calibration-dump-tare': 'calibration_dump_tare',
  'calibration-dump-fit': 'calibration_dump_fit',
  'findme-discover': 'findme_discover',
  'log-clear': 'log_clear',
  reboot: 'reboot',
  'reboot-wifi-setup': 'reboot_wifi_setup',
  'task-list': 'task_list',
  'thread-list': 'thread_list',
  sysmon: 'sysmon',
  'service-list': 'service_list',
  'crash-log': 'crash_log',
  'crash-clear': 'crash_clear',
  health: 'health',
  dmesg: 'dmesg',
  'clock-sync': 'clock_sync',
  'clock-status': 'clock_status',
  capabilities: 'capabilities',
  commands: 'commands',
  'config-schema': 'config_schema',
  'app-list': 'app_list',
  'app-list-packages': 'app_list_packages',
  'app-view': 'app_view',
  'app-reindex': 'app_reindex',
  'app-unload-flow': 'app_unload_flow',
};

export function compileTerminalCommand(commandLine: string, deviceCommands?: Iterable<string> | null): CompiledTerminalCommand {
  const argv = shlexSplit(commandLine || '');
  if (!argv.length) throw new Error('empty_command');
  const command = pyStrip(argv[0]!).toLowerCase();
  const args = argv.slice(1);
  const done = (name: string, payload: Record<string, unknown>): CompiledTerminalCommand => ({ command: name, payload, argv });

  if (Object.prototype.hasOwnProperty.call(SIMPLE_COMMANDS, command)) {
    const name = SIMPLE_COMMANDS[command]!;
    return done(name, { command: name });
  }

  switch (command) {
    case 'enter-maintenance': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'enter_maintenance' };
      if (parsed.has('reason')) payload.reason = parsed.get('reason');
      return done('enter_maintenance', payload);
    }
    case 'calibration-session-commit': {
      const parsed = parseOptions(args);
      return done('calibration_session_commit', { command: 'calibration_session_commit', auto_enable: asBool(opt(parsed, 'auto_enable', 'false')) });
    }
    case 'calibration-dump-level': {
      const parsed = parseOptions(args);
      return done('calibration_dump_level', { command: 'calibration_dump_level', level: pyFloat(req(parsed, 'level')) });
    }
    case 'calibration-capture-tare': {
      const parsed = parseOptions(args);
      return done('calibration_capture_tare', { command: 'calibration_capture_tare', duration_ms: pyInt(opt(parsed, 'duration_ms', 3000)) });
    }
    case 'calibration-delete-level': {
      const parsed = parseOptions(args);
      return done('calibration_delete_level', { command: 'calibration_delete_level', level: pyFloat(req(parsed, 'level')) });
    }
    case 'calibration-capture-cell': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = {
        command: 'calibration_capture_cell',
        sensor_index: pyInt(req(parsed, 'sensor_index')),
        duration_ms: pyInt(opt(parsed, 'duration_ms', 3000)),
      };
      if (parsed.has('level')) payload.level = pyFloat(parsed.get('level')!);
      if (parsed.has('reference')) payload.reference = pyFloat(parsed.get('reference')!);
      return done('calibration_capture_cell', payload);
    }
    case 'calibration-capture-all': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = {
        command: 'calibration_capture_all',
        level: pyFloat(req(parsed, 'level')),
        duration_ms: pyInt(opt(parsed, 'duration_ms', 3000)),
      };
      if (parsed.has('reference')) payload.reference = pyFloat(parsed.get('reference')!);
      return done('calibration_capture_all', payload);
    }
    case 'calibration-set-reference': {
      const parsed = parseOptions(args);
      return done('calibration_set_reference', {
        command: 'calibration_set_reference',
        level: pyFloat(req(parsed, 'level')),
        reference: pyFloat(req(parsed, 'reference')),
      });
    }
    case 'calibration-set-fit': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'calibration_set_fit' };
      for (const key of ['min_level', 'adc1_c1', 'adc1_c2', 'adc2_c1', 'adc2_c2', 'adc1_clip_mv', 'adc2_clip_mv']) {
        if (parsed.has(key)) payload[key] = pyFloat(parsed.get(key)!);
      }
      if (Object.keys(payload).length === 1) throw new Error('fit_setting_required');
      return done('calibration_set_fit', payload);
    }
    case 'set-matrix-layout': {
      const parsed = parseOptions(args);
      return done('set_matrix_layout', {
        command: 'set_matrix_layout',
        analog_pins: parseCsvInts(opt(parsed, 'analog_pins', '')),
        select_pins: parseCsvInts(opt(parsed, 'select_pins', '')),
      });
    }
    case 'set-scan-timing': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'set_scan_timing' };
      for (const key of ['target_fps', 'settle_us', 'send_every_n_frames']) {
        if (parsed.has(key)) payload[key] = pyInt(parsed.get(key)!);
      }
      if (Object.keys(payload).length === 1) throw new Error('scan_timing_option_required');
      return done('set_scan_timing', payload);
    }
    case 'set-stream-buffer': {
      const parsed = parseOptions(args);
      const mode = opt(parsed, 'mode', 'standard');
      if (mode !== 'standard' && mode !== 'extended') throw new Error('invalid_stream_buffer_mode');
      return done('set_stream_buffer', { command: 'set_stream_buffer', enabled: asBool(opt(parsed, 'enabled', 'true')), mode });
    }
    case 'set-charge-profile': {
      const parsed = parseOptions(args);
      const profile = opt(parsed, 'profile', 'balanced');
      if (!['ultra_slow', 'slow', 'balanced', 'fast', 'extreme'].includes(profile)) throw new Error('invalid_charge_profile');
      return done('set_charge_profile', { command: 'set_charge_profile', profile });
    }
    case 'power-set-state': {
      const parsed = parseOptions(args);
      const state = opt(parsed, 'state', 'soft_off_auto');
      if (!['normal', 'soft_off_auto', 'soft_off_battery', 'soft_off_charging'].includes(state)) throw new Error('invalid_power_state');
      return done('power_set_state', { command: 'power_set_state', state });
    }
    case 'set-log': {
      const parsed = parseOptions(args);
      const mode = opt(parsed, 'mode', 'standard');
      return done('set_log', {
        command: 'set_log',
        enabled: asBool(opt(parsed, 'enabled', 'true')),
        level: opt(parsed, 'level', 'error'),
        mode,
        max_bytes: pyInt(opt(parsed, 'max_bytes', mode === 'extended' ? 24576 : 12288)),
      });
    }
    case 'set-ota-config': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = {
        command: 'set_ota_config',
        auto_apply_on_boot: asBool(opt(parsed, 'auto_apply_on_boot', 'false')),
      };
      // Only what was given: a present manifest_url (even empty) replaces the custom URL.
      if (parsed.get('manifest_url')) payload.manifest_url = parsed.get('manifest_url');
      if (parsed.has('channel')) {
        const channel = pyStrip(parsed.get('channel')!).toLowerCase();
        if (channel !== 'stable' && channel !== 'beta') throw new Error('invalid_update_channel');
        payload.channel = channel;
      }
      return done('set_ota_config', payload);
    }
    case 'findme-switch-gateway': {
      const parsed = parseOptions(args);
      return done('findme_switch_gateway', {
        command: 'findme_switch_gateway',
        preferred_gateway_id: req(parsed, 'preferred_gateway_id'),
        claim_id: opt(parsed, 'claim_id', ''),
        ttl_ms: pyInt(opt(parsed, 'ttl_ms', 30000)),
      });
    }
    case 'set-indicators': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'set_indicators' };
      const external: Record<string, unknown> = {};
      const oled: Record<string, unknown> = {};
      if (parsed.has('external_led_mode')) {
        const mode = parsed.get('external_led_mode')!;
        if (mode !== 'off' && mode !== 'enabled') throw new Error('invalid_external_led_mode');
        external.mode = mode;
      }
      if (parsed.has('preset')) external.preset = parsed.get('preset');
      if (parsed.has('external_led_color')) external.color = parsed.get('external_led_color');
      if (parsed.has('brightness')) external.brightness = pyFloat(parsed.get('brightness')!);
      if (parsed.has('oled_mode')) {
        const mode = parsed.get('oled_mode')!;
        if (!['off', 'auto', 'enabled'].includes(mode)) throw new Error('invalid_oled_mode');
        oled.mode = mode;
      }
      if (parsed.has('oled_page')) oled.page = parsed.get('oled_page');
      if (parsed.has('oled_update_hz')) oled.update_hz = pyInt(parsed.get('oled_update_hz')!);
      if (parsed.has('oled_contrast')) oled.contrast = pyInt(parsed.get('oled_contrast')!);
      if (Object.keys(external).length) payload.external_led = external;
      if (Object.keys(oled).length) payload.oled = oled;
      if (Object.keys(payload).length === 1) throw new Error('indicator_option_required');
      return done('set_indicators', payload);
    }
    case 'set-imu': {
      const parsed = parseOptions(args);
      return done('set_imu', { command: 'set_imu', enabled: asBool(opt(parsed, 'enabled', 'true')) });
    }
    case 'file-list': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'file_list' };
      addScope(payload, parsed);
      return done('file_list', payload);
    }
    case 'file-read-begin': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'file_read_begin', path: req(parsed, 'path') };
      addScope(payload, parsed);
      return done('file_read_begin', payload);
    }
    case 'file-read-chunk': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = {
        command: 'file_read_chunk',
        path: req(parsed, 'path'),
        offset: pyInt(opt(parsed, 'offset', 0)),
        length: pyInt(opt(parsed, 'length', 1024)),
      };
      addScope(payload, parsed);
      return done('file_read_chunk', payload);
    }
    case 'file-write-begin': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = {
        command: 'file_write_begin',
        path: req(parsed, 'path'),
        size: pyInt(req(parsed, 'size')),
        sha256: opt(parsed, 'sha256', ''),
      };
      addScope(payload, parsed);
      return done('file_write_begin', payload);
    }
    case 'file-write-chunk': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = {
        command: 'file_write_chunk',
        path: req(parsed, 'path'),
        offset: pyInt(opt(parsed, 'offset', 0)),
        data: opt(parsed, 'data', opt(parsed, 'data_hex', '')),
      };
      addScope(payload, parsed);
      return done('file_write_chunk', payload);
    }
    case 'file-write-finish': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'file_write_finish', path: req(parsed, 'path') };
      // Optional: the firmware re-hashes and deletes the file on a mismatch.
      if (parsed.has('sha256')) payload.sha256 = parsed.get('sha256');
      addScope(payload, parsed);
      return done('file_write_finish', payload);
    }
    case 'file-delete': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'file_delete', path: req(parsed, 'path') };
      addScope(payload, parsed);
      return done('file_delete', payload);
    }
    case 'service-restart':
    case 'service-stop':
    case 'service-start':
    case 'task-stop':
    case 'task-start':
    case 'app-enable':
    case 'app-disable':
    case 'app-revive':
    case 'app-stop':
    case 'app-start': {
      const parsed = parseOptions(args);
      const resolved = command.replace(/-/g, '_');
      return done(resolved, { command: resolved, name: req(parsed, 'name') });
    }
    case 'task-set-period': {
      const parsed = parseOptions(args);
      const raw = pyStrip(String(opt(parsed, 'period_us', '')));
      if (!raw) throw new Error('period_us_required');
      // "default" restores the task's own period; anything else is a number.
      const period: number | string = raw === 'default' ? 'default' : pyInt(raw);
      return done('task_set_period', { command: 'task_set_period', name: req(parsed, 'name'), period_us: period });
    }
    case 'config-get': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'config_get' };
      // No --path means "dump every value".
      if (parsed.has('path')) payload.path = parsed.get('path');
      return done('config_get', payload);
    }
    case 'config-set': {
      const parsed = parseOptions(args);
      return done('config_set', { command: 'config_set', path: req(parsed, 'path'), value: req(parsed, 'value') });
    }
    case 'set-time': {
      const parsed = parseOptions(args);
      const raw = parsed.get('epoch_ms') ?? parsed.get('epoch');
      if (raw === undefined) throw new Error('epoch_ms_required');
      // A string, not a JSON number: a millisecond epoch overflows the firmware's
      // 32-bit ints. BigInt keeps Python's exact int() -> str() round trip.
      const text = pyStrip(raw);
      if (!/^[+-]?\d+(_\d+)*$/.test(text)) throw new Error('invalid_number');
      const payload: Record<string, unknown> = { command: 'set_time', epoch_ms: BigInt(text.replace(/_/g, '')).toString() };
      if (parsed.has('force')) payload.force = asBool(parsed.get('force')!);
      return done('set_time', payload);
    }
    case 'set-power-profile': {
      const parsed = parseOptions(args);
      return done('set_power_profile', { command: 'set_power_profile', profile: req(parsed, 'profile') });
    }
    case 'app-load-flow': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'app_load_flow' };
      // The firmware defaults to apps/flow.json when path is omitted.
      if (parsed.has('path')) payload.path = parsed.get('path');
      return done('app_load_flow', payload);
    }
    case 'app-events': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'app_events' };
      if (parsed.has('since_seq')) payload.since_seq = pyInt(parsed.get('since_seq')!);
      if (parsed.has('limit')) payload.limit = pyInt(parsed.get('limit')!);
      return done('app_events', payload);
    }
    case 'app-install': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'app_install', path: req(parsed, 'path') };
      if (parsed.has('sha256')) payload.sha256 = parsed.get('sha256');
      if (parsed.has('replace')) payload.replace = asBool(parsed.get('replace')!);
      return done('app_install', payload);
    }
    case 'app-uninstall': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'app_uninstall', id: req(parsed, 'id') };
      if (parsed.has('keep_file')) payload.keep_file = asBool(parsed.get('keep_file')!);
      return done('app_uninstall', payload);
    }
    case 'app-activate': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'app_activate', id: req(parsed, 'id') };
      if (parsed.has('slot')) payload.slot = pyInt(parsed.get('slot')!);
      return done('app_activate', payload);
    }
    case 'app-deactivate': {
      const parsed = parseOptions(args);
      const payload: Record<string, unknown> = { command: 'app_deactivate' };
      if (parsed.has('id')) payload.id = parsed.get('id');
      if (parsed.has('slot')) payload.slot = pyInt(parsed.get('slot')!);
      if (!('id' in payload) && !('slot' in payload)) throw new Error('id_or_slot_required');
      return done('app_deactivate', payload);
    }
    case 'app-verify': {
      const parsed = parseOptions(args);
      return done('app_verify', { command: 'app_verify', id: req(parsed, 'id') });
    }
    case 'log-tail': {
      const parsed = parseOptions(args);
      return done('log_tail', { command: 'log_tail', max_lines: pyInt(opt(parsed, 'lines', opt(parsed, 'max_lines', 50))) });
    }
    default:
      break;
  }

  // A command the device lists but this file has no parser for: `--key value`
  // pairs become payload fields, with numbers and true/false converted.
  const generic = command.replace(/-/g, '_');
  const known = deviceCommands ? new Set(deviceCommands) : null;
  if (known && known.size && known.has(generic)) {
    const payload: Record<string, unknown> = { command: generic };
    for (const [key, value] of parseOptions(args)) payload[key] = coerceScalar(value);
    return done(generic, payload);
  }
  throw new Error('unknown_command');
}
