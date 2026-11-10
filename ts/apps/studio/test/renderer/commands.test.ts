// Every settings payload, pinned to what the Desktop sends for the same control.
import { describe, expect, it } from 'vitest';

import * as c from '../../src/renderer/lib/commands';

describe('device command payloads', () => {
  it('status, reboot, scan health, quiet', () => {
    expect(c.statusCommand()).toEqual({ command: 'status' });
    expect(c.rebootCommand()).toEqual({ command: 'reboot' });
    expect(c.scanHealthCommand()).toEqual({ command: 'scan_health' });
    expect(c.quiet({ command: 'status' })).toEqual({ command: 'status', quiet: true });
  });

  it('scan timing presets and custom', () => {
    expect(c.scanTimingCommand(c.scanPresetTiming(60))).toEqual({ command: 'set_scan_timing', target_fps: 60, settle_us: 20, send_every_n_frames: 1 });
    expect(c.scanTimingCommand(c.scanPresetTiming(90))).toEqual({ command: 'set_scan_timing', target_fps: 90, settle_us: 15, send_every_n_frames: 1 });
    expect(c.scanTimingCommand({ target_fps: 120, settle_us: 10, send_every_n_frames: 2 })).toEqual({ command: 'set_scan_timing', target_fps: 120, settle_us: 10, send_every_n_frames: 2 });
    expect(c.effectiveSendFps({ target_fps: 90, send_every_n_frames: 4 })).toBe(23);
    expect(c.scanTimingValidationError({ target_fps: 0, settle_us: 20, send_every_n_frames: 1 })).toBe('invalid_scan_timing');
    expect(c.scanTimingValidationError({ target_fps: 60, settle_us: 20.5, send_every_n_frames: 1 })).toBe('invalid_scan_timing');
    expect(c.scanTimingValidationError(c.scanPresetTiming(60))).toBeNull();
  });

  it('filter, IMU, raw ADC, stream buffer', () => {
    expect(c.filterCommand(true, 3, 0.25)).toEqual({ command: 'set_filter', enabled: true, median: 3, alpha: 0.25 });
    expect(c.filterCommand(false, 1, 0.6)).toEqual({ command: 'set_filter', enabled: false, median: 1, alpha: 0.6 });
    expect([c.filterAlphaValid(0.05), c.filterAlphaValid(0.6), c.filterAlphaValid(0.7), c.filterAlphaValid(0.01)]).toEqual([true, true, false, false]);
    expect(c.imuCommand(false)).toEqual({ command: 'set_imu', enabled: false });
    expect(c.rawAdcCommand(true)).toEqual({ command: 'set_raw_adc', enabled: true });
    expect(c.streamBufferCommand(true, 'extended')).toEqual({ command: 'set_stream_buffer', enabled: true, mode: 'extended' });
  });

  it('power and charging', () => {
    expect(c.CHARGE_PROFILES).toEqual(['ultra_slow', 'slow', 'balanced', 'fast', 'extreme']);
    expect(c.chargeProfileCommand('fast')).toEqual({ command: 'set_charge_profile', profile: 'fast' });
    expect(c.powerStateCommand('soft_off_auto')).toEqual({ command: 'power_set_state', state: 'soft_off_auto' });
    expect(c.powerStateCommand('normal')).toEqual({ command: 'power_set_state', state: 'normal' });
    expect(c.buildBatteryProfileCommand('400', '', '')).toEqual({ command: 'set_battery_profile', capacity_mah: 400, max_charge_current_ma: 200 });
    expect(c.buildBatteryGaugeResyncCommand()).toEqual({ command: 'resync_battery_gauge' });
  });

  it('clock', () => {
    expect(c.clockStatusCommand()).toEqual({ command: 'clock_status', quiet: true });
    expect(c.clockSyncCommand()).toEqual({ command: 'clock_sync' });
    expect(c.setTimeCommand(1_762_750_000_123)).toEqual({ command: 'set_time', epoch_ms: '1762750000123', force: true });
    expect(c.clockConfigCommand({ ntpServer: ' pool.ntp.org ', ntpIntervalS: '3600', syncIntervalS: '' })).toEqual({ command: 'set_clock_config', ntp_server: 'pool.ntp.org', ntp_interval_s: 3600 });
    expect(c.clockConfigCommand({ ntpServer: '', ntpIntervalS: '', syncIntervalS: '30' })).toEqual({ command: 'set_clock_config', sync_interval_s: 30 });
  });

  it('maintenance mode', () => {
    expect(c.maintenanceCommand(true)).toEqual({ command: 'enter_maintenance', reason: 'manual' });
    expect(c.maintenanceCommand(false)).toEqual({ command: 'exit_maintenance' });
  });

  it('firmware update', () => {
    expect(c.updateChannelCommand('beta')).toEqual({ command: 'set_ota_config', channel: 'beta' });
    expect(c.normalizeUpdateChannel('nightly')).toBe('stable');
    expect(c.otaConfigCommand(true, ' https://x/y.json ')).toEqual({ command: 'set_ota_config', auto_apply_on_boot: true, manifest_url: 'https://x/y.json' });
    expect(c.otaConfigCommand(false, '')).toEqual({ command: 'set_ota_config', auto_apply_on_boot: false, manifest_url: '' });
    expect(c.otaConfigCommand(false, ' u ', false)).toEqual({ command: 'set_ota_config', auto_apply_on_boot: false, manifest_url: ' u ' });
    expect(c.updateCommand('check_update')).toEqual({ command: 'check_update' });
    expect(c.updateCommand('apply_update', '  ')).toEqual({ command: 'apply_update' });
    expect(c.updateCommand('apply_update', 'https://m.json')).toEqual({ command: 'apply_update', manifest_url: 'https://m.json' });
  });

  it('logs', () => {
    expect(c.logSettingsCommand(true, 'info', 'standard')).toEqual({ command: 'set_log', enabled: true, level: 'info', mode: 'standard', max_bytes: 12 * 1024 });
    expect(c.logSettingsCommand(false, 'error', 'extended')).toEqual({ command: 'set_log', enabled: false, level: 'error', mode: 'extended', max_bytes: 24 * 1024 });
    expect(c.logClearCommand()).toEqual({ command: 'log_clear' });
  });

  it('calibration basics', () => {
    expect(c.tareCommand()).toEqual({ command: 'calibration_tare_capture', duration_ms: 1000 });
    expect(c.tareClearCommand()).toEqual({ command: 'calibration_tare_clear' });
  });
});
