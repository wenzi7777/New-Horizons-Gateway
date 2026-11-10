// Desktop lib tests (New-Horizons-Desktop/frontend/tests/*.test.mjs) ported
// to vitest against the renderer's copies, so their behaviour stays the same.
import { describe, expect, it } from 'vitest';

import * as battery from '../../src/renderer/lib/batteryProfile';
import { normalizeCommandResult } from '../../src/renderer/lib/commandResult';
import { connectionRank, connectionStateLabel, connectionStateOf, deviceClassName, statusDot } from '../../src/renderer/lib/deviceStatus';
import { cssColorForValue, DEFAULT_RANGE, presetIndexForRange, RANGE_PRESETS, rgbForValue, valueRatio, clampRange } from '../../src/renderer/lib/pressureColor';
import { adcUnitForGpio, formatBucketRange, formatMicros, isFaultReset, rssiQuality, scanHealthView, scanRateLow } from '../../src/renderer/lib/scanHealth';
import { isAppliedComplete, progressOf, updateTransferProgress } from '../../src/renderer/lib/updateProgress';

describe('batteryProfile (tests/batteryProfile.test.mjs)', () => {
  it('builds set_battery_profile for a custom capacity', () => {
    expect(battery.buildBatteryProfileCommand('custom', '650', '230')).toEqual({ command: 'set_battery_profile', capacity_mah: 650, max_charge_current_ma: 230 });
  });
  it('offers no detection command and a distinct resync', () => {
    expect('buildBatteryProfileDetectionCommand' in battery).toBe(false);
    expect(battery.buildBatteryGaugeResyncCommand()).toEqual({ command: 'resync_battery_gauge' });
  });
  it('rejects invalid profiles', () => {
    expect(() => battery.buildBatteryProfileCommand('custom', '0', '235')).toThrow(/invalid_battery_profile/);
    expect(battery.batteryProfileValidationError('custom', '', '230')).toBe('invalid_battery_profile');
    expect(battery.batteryProfileValidationError('400', '', '230')).toBeNull();
  });
  it('requires setup only when required or unresolved', () => {
    expect(battery.batteryProfileSetupRequired({ battery_profile_required: true, profile_resolved: true })).toBe(true);
    expect(battery.batteryProfileSetupRequired({ battery_profile_required: false, profile_resolved: false })).toBe(true);
    expect(battery.batteryProfileSetupRequired({ battery_profile_required: false, profile_resolved: true, profile_source: 'manual' })).toBe(false);
  });
  it('normalizes firmware battery status', () => {
    expect(
      battery.normalizeBatteryStatus({
        battery_present: true,
        vbat_mv: 4175,
        soc_centi_percent: 7350,
        rate: -208,
        profile_source: 'manual',
        profile_resolved: false,
        profile_required: true,
        capacity_mah: 400,
        max_charge_current_ma: 200,
        temperature_monitoring: 'bypassed',
      }),
    ).toEqual({
      socPercent: 73.5,
      vbatMv: 4175,
      ratePercentPerHour: -2.08,
      batteryPresent: true,
      profileSource: 'manual',
      batteryId: null,
      profileResolved: false,
      profileRequired: true,
      capacityMah: 400,
      maxChargeCurrentMa: 200,
      thermalMonitoringBypassed: true,
      syncState: null,
      lastSyncReason: null,
      syncCount: null,
    });
  });
  it('hides stale measurements while resyncing', () => {
    for (const gauge_sync_state of ['syncing', 'error']) {
      const b = battery.normalizeBatteryStatus({ sample_valid: false, vbat_mv: 4175, soc_centi_percent: 7350, rate: -208, gauge_sync_state, last_sync_reason: 'manual', gauge_sync_count: 4 });
      expect([b.socPercent, b.vbatMv, b.ratePercentPerHour, b.syncState, b.syncCount]).toEqual([null, null, null, gauge_sync_state, 4]);
    }
  });
  it('presets set their own current', () => {
    const expected = { 200: 100, 400: 200, 500: 350, 600: 350, 700: 350 } as const;
    for (const [capacity, current] of Object.entries(expected)) {
      expect(battery.buildBatteryProfileCommand(capacity as battery.BatteryCapacityChoice, '', '120')).toEqual({ command: 'set_battery_profile', capacity_mah: Number(capacity), max_charge_current_ma: current });
    }
    expect(battery.batteryCapacityChoiceFor(500, 350)).toBe('500');
    expect(battery.batteryCapacityChoiceFor(400, 100)).toBe('custom');
  });
  it('estimates time without inventing one', () => {
    expect(battery.estimateBatteryTime({ socPercent: 73.5, ratePercentPerHour: -2.1, batteryPresent: true }, 'not_charging')).toEqual({ kind: 'remaining', minutes: 2100 });
    expect(battery.estimateBatteryTime({ socPercent: 70, ratePercentPerHour: 2.5, batteryPresent: true }, 'charging')).toEqual({ kind: 'until_full', minutes: 720 });
    expect(battery.estimateBatteryTime({ socPercent: 100, ratePercentPerHour: 0, batteryPresent: true }, 'charge_done')).toEqual({ kind: 'full' });
    expect(battery.estimateBatteryTime({ socPercent: 70, ratePercentPerHour: -2, batteryPresent: false }, 'not_charging')).toEqual({ kind: 'unavailable' });
  });
  it('low-battery threshold command and duration labels', () => {
    expect(battery.buildBatteryLedThresholdCommand(10)).toEqual({ command: 'set_indicators', battery_led: { low_battery_threshold_percent: 10 } });
    expect(() => battery.buildBatteryLedThresholdCommand(26)).toThrow(/invalid_low_battery_threshold/);
    expect([0, 45, 60, 200].map(battery.durationLabel)).toEqual(['0m', '45m', '1h', '3h 20m']);
  });
  it('low-battery warning mirrors BatteryLedPolicy', () => {
    const readout = (o: Partial<Parameters<typeof battery.deviceBatteryReadout>[0]> = {}) =>
      battery.deviceBatteryReadout({ supported: true, battery: { sample_valid: true, battery_present: true, soc_centi_percent: 800, rate: -200 }, power: { charge_state: 'not_charging' }, batteryLed: { low_battery_threshold_percent: 10 }, ...o });
    expect(readout().lowBattery).toBe(true);
    expect(readout({ batteryLed: { low_battery_threshold_percent: 0 } }).lowBattery).toBe(false);
    expect(readout({ power: { charge_state: 'charging' } }).lowBattery).toBe(false);
    expect(readout({ batteryLed: {} }).lowBattery).toBe(false);
    expect(readout({ supported: false }).socPercent).toBeNull();
  });
});

describe('updateProgress (tests/updateProgress.test.mjs)', () => {
  it('Hub transfers count chunks, Wi-Fi files', () => {
    const state = { phase: 'downloading', operation: 'apply_update', total_chunks: 425, applied_chunks: 120 };
    expect(updateTransferProgress(state)).toBe('120 / 425 (28%)');
    expect(progressOf(state)).toBe(28);
    expect(isAppliedComplete(state)).toBe(false);
    expect(isAppliedComplete({ ...state, applied_chunks: 425 })).toBe(true);
    expect(updateTransferProgress({ phase: 'downloading', total_files: 4, applied_files: 1 })).toBe('1 / 4 (25%)');
    expect(updateTransferProgress({ phase: 'ready', total_chunks: 425 })).toBeNull();
    expect(updateTransferProgress({ phase: 'downloading' })).toBeNull();
  });
});

describe('deviceStatus (tests/deviceStatus.test.mjs)', () => {
  const d = (connectionState: 'online' | 'offline' | 'reconnecting' | 'booting', mode = 'normal') => ({ connectionState, mode });
  it('class, dot, label, rank', () => {
    expect(deviceClassName(d('offline', 'maintenance'))).toBe('offline');
    expect(deviceClassName(d('booting', 'maintenance'))).toBe('maintenance');
    expect(deviceClassName(d('online', 'safe_maintenance'))).toBe('maintenance');
    expect(statusDot(d('online', 'maintenance'))).toBe('status-dot online');
    expect(statusDot(d('reconnecting'))).toBe('status-dot reconnecting');
    expect(connectionStateLabel(d('online', 'maintenance'), (k) => `t:${k}`)).toBe('t:online');
    const sorted = (['offline', 'reconnecting', 'booting', 'online'] as const).map((s) => d(s)).sort((a, b) => connectionRank(a) - connectionRank(b));
    expect(sorted.map((x) => x.connectionState)).toEqual(['online', 'booting', 'reconnecting', 'offline']);
    expect(connectionStateOf({ online: false })).toBe('offline');
  });
});

describe('scanHealth (tests/scanHealth.test.mjs)', () => {
  const V15F = {
    scan_active: true,
    requested_target_fps: 60,
    actual_scan_fps: 60,
    budget_us: 16666,
    start_lateness: { samples: 1000, late: 12, gaps: 1, max_us: 5300, recent_max_us: 800, hist: [988, 9, 2, 1], bounds_us: [500, 2000, 5000] },
    adc_read_errors: [0, 3],
    adc_cal_digi: [998, 985],
  };
  it('ADC split and per-unit reporting', () => {
    expect([adcUnitForGpio(10), adcUnitForGpio(11)]).toEqual([1, 2]);
    expect(scanHealthView(V15F, [3, 4, 10, 13, 14]).adc).toEqual([
      { unit: 1, calDigi: 998, readErrors: 0, gpios: [3, 4, 10] },
      { unit: 2, calDigi: 985, readErrors: 3, gpios: [13, 14] },
    ]);
    const { adc_read_errors: _e, adc_cal_digi: _d, ...older } = V15F;
    expect(scanHealthView(older, [3]).adc).toBeNull();
    expect(scanHealthView({}).actualFps).toBeNull();
  });
  it('lateness buckets, timings, RSSI, rate, resets', () => {
    const { lateness } = scanHealthView(V15F);
    expect(lateness?.lateShare).toBe(0.012);
    expect(lateness?.buckets.map(formatBucketRange)).toEqual(['< 500 µs', '500 µs – 2.0 ms', '2.0 ms – 5.0 ms', '≥ 5.0 ms']);
    expect([formatMicros(850), formatMicros(16666), formatMicros(null)]).toEqual(['850 µs', '16.7 ms', '-']);
    expect([rssiQuality(-50), rssiQuality(-70), rssiQuality(-82), rssiQuality(0)]).toEqual(['excellent', 'fair', 'weak', null]);
    expect(scanRateLow(scanHealthView({ ...V15F, actual_scan_fps: 55 }))).toBe(true);
    expect(scanRateLow(scanHealthView({ ...V15F, actual_scan_fps: 0, scan_active: false }))).toBe(false);
    expect([isFaultReset('panic'), isFaultReset('poweron')]).toEqual([true, false]);
  });
});

describe('commandResult', () => {
  it('hoists the firmware envelope data', () => {
    expect(normalizeCommandResult({ cmd: 'clock_status', ok: true, data: { clock: { synced: true } } })).toEqual({ cmd: 'clock_status', ok: true, data: { clock: { synced: true } }, clock: { synced: true }, command: 'clock_status' });
    expect(normalizeCommandResult({ command: 'status', mode: 'normal' })).toEqual({ command: 'status', mode: 'normal' });
    expect(normalizeCommandResult(null)).toBeNull();
  });
});

describe('pressureColor (Desktop lib/pressureColor.ts)', () => {
  it('matches the Desktop scale and presets', () => {
    expect(cssColorForValue(300, DEFAULT_RANGE)).toBe('hsl(154deg 58% 78%)');
    expect(cssColorForValue(3150, DEFAULT_RANGE)).toBe('hsl(46deg 58% 48%)');
    expect(valueRatio(10_000, DEFAULT_RANGE)).toBe(1);
    expect(RANGE_PRESETS).toEqual([{ min: 300, max: 3150 }, { min: 300, max: 4990 }]);
    expect(presetIndexForRange({ min: 300, max: 4990 })).toBe(1);
    expect(presetIndexForRange({ min: 0, max: 100 })).toBe(-1);
    for (const c of rgbForValue(1500, DEFAULT_RANGE)) expect(c).toBeGreaterThanOrEqual(0);
    expect(clampRange(500, 200)).toBeNull();
    expect(clampRange(-5, 9000)).toEqual({ min: 0, max: 4990 });
  });
});
