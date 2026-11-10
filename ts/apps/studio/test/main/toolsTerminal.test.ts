// Port of New-Horizons-Desktop/tests/test_terminal.py (parsing, help, allowlist cases).
import { describe, expect, it } from 'vitest';

import { COMMAND_BLOCKS } from '../../src/renderer/areas/tools/lib/terminalCommands';
import {
  compileTerminalCommand,
  shlexSplit,
  terminalHelpItems,
  validateDeviceCommandPayload,
} from '../../../../packages/host/src/tools/terminal';

const EITHER_OR_PARAM_COMMANDS: Record<string, string> = { 'app-deactivate': 'id_or_slot_required' };

// Python shlex.quote.
function shlexQuote(s: string): string {
  if (!s) return "''";
  if (!/[^\w@%+=:,./-]/.test(s)) return s;
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

describe('shlexSplit (Python shlex.split)', () => {
  it('splits like POSIX shlex', () => {
    expect(shlexSplit('  a  b\tc\n')).toEqual(['a', 'b', 'c']);
    expect(shlexSplit(`a"b c"d 'e f' ""`)).toEqual(['ab cd', 'e f', '']);
    expect(shlexSplit('a\\ b "x\\"y\\\\z\\n"')).toEqual(['a b', 'x"y\\z\\n']);
    expect(shlexSplit("'a\\b'")).toEqual(['a\\b']);
    expect(() => shlexSplit('config-set --path "x')).toThrow('No closing quotation');
    expect(() => shlexSplit("a 'b")).toThrow('No closing quotation');
    expect(() => shlexSplit('a\\')).toThrow('No escaped character');
  });
});

describe('DeviceCommandValidation', () => {
  it('every command block compiles with its defaults', () => {
    expect(COMMAND_BLOCKS.length).toBeGreaterThan(60);
    let compiled = 0;
    for (const block of COMMAND_BLOCKS) {
      if (block.command === 'io-config' || block.command === 'visualize-io') continue;
      const parts = [block.command];
      let runnable = true;
      for (const param of block.params as Array<{ key: string; required?: boolean; defaultValue?: string; placeholder?: string }>) {
        const value = param.defaultValue || (param.required ? param.placeholder : undefined);
        if (param.required && !value) runnable = false;
        if (value) parts.push(`--${param.key}`, shlexQuote(value));
      }
      if (!runnable) continue;
      const line = parts.join(' ');
      const either = EITHER_OR_PARAM_COMMANDS[block.command];
      if (either) {
        expect(() => compileTerminalCommand(line), line).toThrow(either);
        continue;
      }
      expect(() => validateDeviceCommandPayload(compileTerminalCommand(line).payload), line).not.toThrow();
      compiled += 1;
    }
    expect(compiled).toBeGreaterThan(55);
  });

  it('terminal command builder covers every help command', () => {
    const blockCommands = new Set(COMMAND_BLOCKS.map((block) => block.command));
    for (const removed of ['calibration-sample-cell', 'calibration-sample-all', 'calibration-save', 'set-filter']) {
      expect(blockCommands.has(removed)).toBe(false);
    }
    for (const item of terminalHelpItems()) {
      if (item.command === 'io-config') continue;
      expect(blockCommands.has(item.command), item.command).toBe(true);
    }
  });

  it('memory_status is allowed', () => {
    const payload = validateDeviceCommandPayload({ command: 'memory_status', request_id: 'req-memory' });
    expect(payload.command).toBe('memory_status');
    expect(payload.request_id).toBe('req-memory');
  });

  it('scan_health is allowed and compiles from terminal', () => {
    const payload = validateDeviceCommandPayload({ command: 'scan_health', request_id: 'req-health' });
    expect(payload.command).toBe('scan_health');
    expect(payload.request_id).toBe('req-health');
    expect(compileTerminalCommand('scan-health').payload.command).toBe('scan_health');
  });

  it('storage_status is allowed and compiles from terminal', () => {
    const payload = validateDeviceCommandPayload({ command: 'storage_status', request_id: 'req-storage' });
    expect(payload.command).toBe('storage_status');
    expect(payload.request_id).toBe('req-storage');
    expect(compileTerminalCommand('storage-status').payload.command).toBe('storage_status');
  });

  it('manual calibration commands are allowed and compile from terminal', () => {
    for (const command of [
      'calibration_status', 'calibration_enable', 'calibration_disable', 'calibration_clear_profile',
      'calibration_session_begin', 'calibration_session_abort', 'calibration_session_commit',
      'calibration_dump_tare', 'calibration_dump_level', 'calibration_delete_level',
      'calibration_capture_tare', 'calibration_capture_cell', 'calibration_capture_all',
    ]) {
      expect(validateDeviceCommandPayload({ command, request_id: `req-${command}` }).command).toBe(command);
    }
    expect(compileTerminalCommand('calibration-dump-tare').payload.command).toBe('calibration_dump_tare');
    expect(compileTerminalCommand('calibration-dump-level --level 10').payload.command).toBe('calibration_dump_level');
    expect(compileTerminalCommand('calibration-delete-level --level 10').payload.command).toBe('calibration_delete_level');
    const captureTare = compileTerminalCommand('calibration-capture-tare --duration-ms 2500');
    expect(captureTare.payload.command).toBe('calibration_capture_tare');
    expect(captureTare.payload.duration_ms).toBe(2500);
    const captureCell = compileTerminalCommand('calibration-capture-cell --sensor-index 3 --level 10 --duration-ms 2500');
    expect(captureCell.payload.command).toBe('calibration_capture_cell');
    expect(captureCell.payload.sensor_index).toBe(3);
    expect(compileTerminalCommand('calibration-capture-all --level 10 --duration-ms 2500').payload.command).toBe('calibration_capture_all');
    expect(compileTerminalCommand('calibration-session-begin').payload.command).toBe('calibration_session_begin');
    const commit = compileTerminalCommand('calibration-session-commit --auto-enable true');
    expect(commit.payload.command).toBe('calibration_session_commit');
    expect(commit.payload.auto_enable).toBe(true);
  });

  it('charge profile is allowed and compiles from terminal', () => {
    const payload = validateDeviceCommandPayload({ command: 'set_charge_profile', profile: 'balanced', request_id: 'req-charge' });
    expect(payload.command).toBe('set_charge_profile');
    expect(payload.profile).toBe('balanced');
    const compiled = compileTerminalCommand('set-charge-profile --profile fast');
    expect(compiled.payload).toEqual({ command: 'set_charge_profile', profile: 'fast' });
    for (const invalid of ['compatible', 'tiny', 'max', 'safe_default', 'fast_800mah_only']) {
      expect(() => compileTerminalCommand(`set-charge-profile --profile ${invalid}`)).toThrow('invalid_charge_profile');
    }
  });

  it('battery profile command requires positive capacity and supported current', () => {
    const payload = validateDeviceCommandPayload({ command: 'set_battery_profile', capacity_mah: 400, max_charge_current_ma: 230 });
    expect(payload).toMatchObject({ command: 'set_battery_profile', capacity_mah: 400, max_charge_current_ma: 230 });
    const bad: Array<[unknown, unknown]> = [[0, 100], [400, 355], [400, 235], [400, 230.9], [true, 100], [400, true], ['400', 230], [400, '230.9']];
    for (const [capacity, current] of bad) {
      expect(() => validateDeviceCommandPayload({ command: 'set_battery_profile', capacity_mah: capacity, max_charge_current_ma: current })).toThrow('invalid_battery_profile');
    }
  });

  it('battery detection command is no longer accepted', () => {
    expect(() => validateDeviceCommandPayload({ command: 'detect_battery_profile' })).toThrow('unknown_command');
  });

  it('battery gauge resync is allowed without manual fields', () => {
    const payload = validateDeviceCommandPayload({ command: 'resync_battery_gauge', request_id: 'req-battery-resync' });
    expect(payload.command).toBe('resync_battery_gauge');
    expect(payload.request_id).toBe('req-battery-resync');
  });

  it('action button command is allowed with both gestures', () => {
    const payload = validateDeviceCommandPayload({ command: 'set_action_button', short_press: 'identify', long_press: 'soft_off', request_id: 'req-action-button' });
    expect(payload).toMatchObject({ command: 'set_action_button', short_press: 'identify', long_press: 'soft_off' });
  });

  it('recovery update commands are removed from terminal', () => {
    for (const command of ['check_os_release', 'write_os', 'check_recovery_release', 'write_recovery', 'reboot_to_os', 'reboot_to_recovery', 'release_recovery_resources']) {
      expect(() => validateDeviceCommandPayload({ command, request_id: 'req-old' })).toThrow('unknown_command');
    }
    for (const line of ['check-os-release', 'write-os', 'check-recovery-release', 'write-recovery', 'reboot-to-os', 'reboot-to-recovery', 'boot-minimal']) {
      expect(() => compileTerminalCommand(line)).toThrow('unknown_command');
    }
  });

  it('arduino update commands are allowed and compile from terminal', () => {
    expect(validateDeviceCommandPayload({ command: 'check_update', request_id: 'req-check' }).command).toBe('check_update');
    expect(validateDeviceCommandPayload({ command: 'apply_update', request_id: 'req-apply' }).command).toBe('apply_update');
    expect(compileTerminalCommand('check-update').payload.command).toBe('check_update');
    expect(compileTerminalCommand('apply-update').payload.command).toBe('apply_update');
  });

  it('service_control is not exposed by default', () => {
    expect(() => validateDeviceCommandPayload({ command: 'service_control', service: 'matrix_scan', action: 'restart', request_id: 'req-service' })).toThrow('unknown_command');
    expect(() => compileTerminalCommand('service-control --service matrix_scan --action restart')).toThrow('unknown_command');
  });

  it('scan timing compiles full runtime controls', () => {
    const compiled = compileTerminalCommand('set-scan-timing --target-fps 75 --settle-us 18 --send-every-n-frames 3');
    expect(compiled.payload).toEqual({ command: 'set_scan_timing', target_fps: 75, settle_us: 18, send_every_n_frames: 3 });
  });

  it('set-imu compiles enabled flag', () => {
    const compiled = compileTerminalCommand('set-imu --enabled false');
    expect(compiled.payload).toEqual({ command: 'set_imu', enabled: false });
    expect(validateDeviceCommandPayload(compiled.payload).command).toBe('set_imu');
  });

  it('set-stream-buffer compiles mode and enabled flag', () => {
    const compiled = compileTerminalCommand('set-stream-buffer --enabled true --mode extended');
    expect(compiled.payload).toEqual({ command: 'set_stream_buffer', enabled: true, mode: 'extended' });
    expect(validateDeviceCommandPayload(compiled.payload).command).toBe('set_stream_buffer');
  });

  it('set-log defaults to error and new capacity limits', () => {
    const compiled = compileTerminalCommand('set-log');
    expect(compiled.payload).toEqual({ command: 'set_log', enabled: true, level: 'error', mode: 'standard', max_bytes: 12288 });
    expect(validateDeviceCommandPayload(compiled.payload).command).toBe('set_log');
    expect(compileTerminalCommand('set-log --mode extended').payload.max_bytes).toBe(24576);
  });

  it('power_set_state is allowed and compiles from terminal', () => {
    const payload = validateDeviceCommandPayload({ command: 'power_set_state', state: 'soft_off_auto', request_id: 'req-power' });
    expect(payload).toMatchObject({ command: 'power_set_state', state: 'soft_off_auto' });
    expect(compileTerminalCommand('power-set-state --state normal').payload).toEqual({ command: 'power_set_state', state: 'normal' });
  });

  it('set-indicators compiles external LED color and OLED modes', () => {
    const compiled = compileTerminalCommand(
      'set-indicators --external-led-mode enabled --preset solid_marker --external-led-color teal --brightness 0.35 ' +
        '--oled-mode auto --oled-page live_status --oled-update-hz 1 --oled-contrast 128',
    );
    const payload = validateDeviceCommandPayload(compiled.payload);
    expect(payload).toEqual({
      command: 'set_indicators',
      external_led: { mode: 'enabled', preset: 'solid_marker', color: 'teal', brightness: 0.35 },
      oled: { mode: 'auto', page: 'live_status', update_hz: 1, contrast: 128 },
    });
    const systemStatus = validateDeviceCommandPayload(compileTerminalCommand('set-indicators --external-led-mode enabled --preset system_status').payload);
    expect((systemStatus.external_led as Record<string, unknown>).preset).toBe('system_status');
  });

  it('set-indicators help calls out decimal brightness', () => {
    const item = terminalHelpItems().find((entry) => entry.command === 'set-indicators')!;
    expect(item.description).toContain('0.10');
    expect(item.example).toContain('--preset solid_marker');
    expect(item.example).toContain('--external-led-color teal');
    expect(item.example).toContain('--brightness 0.35');
    const brightness = COMMAND_BLOCKS.find((b) => b.command === 'set-indicators')!.params.find((p) => p.key === 'brightness') as { placeholder?: string };
    expect(brightness.placeholder).toBe('0.10, 0.20, 0.35, 0.50, 1.00');
  });

  it('terminal uses arduino file read/write commands', () => {
    expect(compileTerminalCommand('file-read-begin --scope logs --path device.log').payload).toEqual({ command: 'file_read_begin', path: 'device.log', scope: 'logs' });
    expect(compileTerminalCommand('file-read-chunk --scope logs --path device.log --offset 0 --length 128').payload.command).toBe('file_read_chunk');
    expect(compileTerminalCommand('file-write-begin --scope user --path configs/profile.json --size 2 --sha256 deadbeef').payload).toEqual({
      command: 'file_write_begin', path: 'configs/profile.json', size: 2, sha256: 'deadbeef', scope: 'user',
    });
    expect(compileTerminalCommand('file-write-chunk --scope user --path configs/profile.json --offset 0 --data 4e48').payload.command).toBe('file_write_chunk');
    expect(compileTerminalCommand('file-write-finish --scope user --path configs/profile.json').payload.command).toBe('file_write_finish');
    for (const command of ['file_upload_begin', 'file_upload_chunk', 'file_upload_finish', 'file_download_begin', 'file_download_chunk']) {
      expect(() => validateDeviceCommandPayload({ command, request_id: 'req-old-file' })).toThrow('unknown_command');
    }
  });
});

// Extra coverage of the port itself (Python behaviour the tests above don't pin).
describe('compileTerminalCommand error codes and edge cases', () => {
  it('raises the Python error codes', () => {
    expect(() => compileTerminalCommand('')).toThrow('empty_command');
    expect(() => compileTerminalCommand('   ')).toThrow('empty_command');
    expect(() => compileTerminalCommand('set-log stray')).toThrow('unexpected_argument');
    expect(() => compileTerminalCommand('set-log --level')).toThrow('missing_option_value');
    expect(() => compileTerminalCommand('calibration-set-fit')).toThrow('fit_setting_required');
    expect(() => compileTerminalCommand('set-scan-timing')).toThrow('scan_timing_option_required');
    expect(() => compileTerminalCommand('set-indicators')).toThrow('indicator_option_required');
    expect(() => compileTerminalCommand('set-time')).toThrow('epoch_ms_required');
    expect(() => compileTerminalCommand('task-set-period --name imu')).toThrow('period_us_required');
    expect(() => compileTerminalCommand('set-ota-config --channel nightly')).toThrow('invalid_update_channel');
    expect(() => compileTerminalCommand('set-stream-buffer --mode huge')).toThrow('invalid_stream_buffer_mode');
    // int()/float() ValueError and KeyError on a required option.
    expect(() => compileTerminalCommand('log-tail --lines many')).toThrow('invalid_number');
    expect(() => compileTerminalCommand('calibration-dump-level --level x')).toThrow('invalid_number');
    expect(() => compileTerminalCommand('calibration-dump-level')).toThrow('missing_option');
    expect(() => compileTerminalCommand('config-set --path a.b "unclosed')).toThrow('No closing quotation');
  });

  it('mirrors Python int/float leniency', () => {
    expect(compileTerminalCommand('log-tail --lines " 1_0 "').payload.max_lines).toBe(10);
    expect(compileTerminalCommand('calibration-dump-level --level 1e1').payload.level).toBe(10);
    expect(compileTerminalCommand('task-set-period --name imu --period-us default').payload.period_us).toBe('default');
    expect(compileTerminalCommand('set-time --epoch-ms 1780000000000 --force true').payload).toEqual({ command: 'set_time', epoch_ms: '1780000000000', force: true });
    expect(compileTerminalCommand('set-matrix-layout --analog-pins "1, 2,,3"').payload).toEqual({ command: 'set_matrix_layout', analog_pins: [1, 2, 3], select_pins: [] });
    expect(compileTerminalCommand('STATUS').payload).toEqual({ command: 'status' });
  });

  it('passes unknown device catalog commands through with scalar coercion', () => {
    const compiled = compileTerminalCommand('blink-twice --count 3 --ratio 0.5 --on true --id 0123', ['blink_twice']);
    expect(compiled).toEqual({
      command: 'blink_twice',
      payload: { command: 'blink_twice', count: 3, ratio: 0.5, on: true, id: '0123' },
      argv: ['blink-twice', '--count', '3', '--ratio', '0.5', '--on', 'true', '--id', '0123'],
    });
    expect(() => compileTerminalCommand('blink-twice')).toThrow('unknown_command');
  });

  it('every help example compiles and validates', () => {
    const items = terminalHelpItems();
    expect(items.length).toBe(84);
    for (const item of items) {
      if (item.command === 'io-config') continue;
      expect(() => validateDeviceCommandPayload(compileTerminalCommand(item.example).payload), item.example).not.toThrow();
    }
  });
});
