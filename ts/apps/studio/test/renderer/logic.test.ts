import { describe, expect, it } from 'vitest';

import type { RecordingSummary } from '../../src/shared/contract';
import { clockView, deviceSettingsView, updatePhaseKey } from '../../src/renderer/lib/deviceDetails';
import { formatBytes, formatDuration, groupByDay, isValidServerUrl, isValidStudioId, relativeDay } from '../../src/renderer/lib/format';
import { type Route, DEFAULT_ROUTE, formatRoute, liveColumns, NAV_ITEMS, parseRoute, toggleLiveDevice } from '../../src/renderer/lib/navigation';
import { finishOp, OP_LOG_LIMIT, payloadSummary, startOp } from '../../src/renderer/lib/opLog';
import { activeRecordingCount, groupRecordingsByDevice } from '../../src/renderer/lib/recordings';
import { timelinePaths } from '../../src/renderer/components/TimelineChart';

describe('navigation', () => {
  it('has the final information architecture, every area live', () => {
    expect(NAV_ITEMS.map((i) => i.id)).toEqual(['devices', 'live', 'recordings', 'profiles', 'apps', 'tools', 'settings']);
    expect(NAV_ITEMS.filter((i) => i.later)).toEqual([]);
    expect(NAV_ITEMS.filter((i) => i.bottom).map((i) => i.id)).toEqual(['settings']);
  });
  it('round-trips routes through the hash', () => {
    const routes = [
      { area: 'devices', uid: null, tab: 'overview' },
      { area: 'devices', uid: '3C84279A1F20', tab: 'settings' },
      { area: 'live', uids: ['A', 'B'] },
      { area: 'recordings', id: 'recordings/3C84279A1F20/20261110/091217' },
      { area: 'apps', path: [] },
      { area: 'apps', path: ['studio', 'my app'] },
      { area: 'settings', section: null },
      { area: 'settings', section: 'connection' },
    ] satisfies Route[];
    for (const route of routes) expect(parseRoute(formatRoute(route))).toEqual(route);
    expect(parseRoute('')).toEqual(DEFAULT_ROUTE);
    expect(parseRoute('#/devices/X/bogus')).toEqual({ area: 'devices', uid: 'X', tab: 'overview' });
    expect(parseRoute('#/live/a,b,c,d,e')).toEqual({ area: 'live', uids: ['a', 'b', 'c', 'd'] });
  });
  it('live selection is limited to four; columns', () => {
    expect(toggleLiveDevice(['a', 'b', 'c', 'd'], 'e')).toEqual(['a', 'b', 'c', 'd']);
    expect(toggleLiveDevice(['a', 'b'], 'a')).toEqual(['b']);
    expect([1, 2, 3, 4].map(liveColumns)).toEqual([1, 2, 3, 2]);
  });
});

describe('device settings view', () => {
  it('reads the Desktop fields with its defaults', () => {
    const empty = deviceSettingsView(undefined);
    expect(empty.hasStatus).toBe(false);
    expect(empty.scanTiming).toEqual({ target_fps: 60, settle_us: 20, send_every_n_frames: 1 });
    expect(empty.filter).toEqual({ enabled: false, median: 3, alpha: 0.25 });
    expect([empty.imu.enabled, empty.streamBuffer.enabled, empty.streamBuffer.mode, empty.chargeProfile, empty.logging.level]).toEqual([true, true, 'standard', 'balanced', 'error']);
    const v = deviceSettingsView({
      record: {},
      status: {
        runtime: { scan_timing: { target_fps: 90, settle_us: 15, send_every_n_frames: 2 } },
        stream_raw_adc: true,
        ota: { channel: 'beta', auto_apply_on_boot: true, manifest_url: '' },
        calibration: { tare_enabled: true, output_mode: 'tared' },
        battery: { profile: 'fast', soc_centi_percent: 5000, sample_valid: true },
      },
    });
    expect(v.scanTiming).toEqual({ target_fps: 90, settle_us: 15, send_every_n_frames: 2 });
    expect([v.rawAdc, v.ota.channelSupported, v.ota.channel, v.ota.autoApplyOnBoot, v.calibration.tareActive, v.chargeProfile, v.battery.socPercent]).toEqual([true, true, 'beta', true, true, 'fast', 50]);
    expect(deviceSettingsView({ record: {}, status: { ota: {} } }).ota.channelSupported).toBe(false);
  });
  it('update phases and clock replies', () => {
    expect(['ready', 'current', 'manifest', 'downloading', 'applied', 'error', ''].map(updatePhaseKey)).toEqual([
      'updateAvailableShort', 'updateUpToDate', 'updateCheckingDevice', 'updateInstalling', 'updateApplied', 'updateFailed', 'updateNotCheckedDevice',
    ]);
    expect(clockView({ ok: false })).toBeNull();
    expect(clockView({ data: { clock: { synced: true, source: 'hub', mode: 'espnow', epoch_ms: 5, hub: { last_rtt_us: 900, supported: true } }, clock_config: { ntp_server: 'x' } } })).toMatchObject({
      synced: true, source: 'hub', epochMs: 5, serverRttUs: 900, config: { ntpServer: 'x' },
    });
  });
});

describe('formatting, grouping, op log', () => {
  it('formats', () => {
    expect([formatBytes(512), formatBytes(1234), formatBytes(34e6), formatBytes(1.05e9)]).toEqual(['512 B', '1.23 KB', '34 MB', '1.05 GB']);
    expect([formatDuration(7000), formatDuration(725_000), formatDuration(3_723_000)]).toEqual(['0:07', '12:05', '1:02:03']);
    const now = new Date(2026, 10, 10, 12).getTime();
    expect([relativeDay(now - 3600_000, now), relativeDay(now - 86_400_000, now), relativeDay(now - 3 * 86_400_000, now)]).toEqual(['today', 'yesterday', null]);
    expect([isValidStudioId('nh-studio_1.lab'), isValidStudioId('bad id'), isValidServerUrl('wss://a.b/x'), isValidServerUrl('http://a')]).toEqual([true, false, true, false]);
    expect(groupByDay([1, 2], (x) => x).length).toBe(1);
  });
  it('groups recordings by device then day', () => {
    const day = (d: number, h: number) => new Date(2026, 10, d, h).getTime();
    const r = (uid: string, at: number): RecordingSummary => ({ id: `${uid}/${at}`, uid, deviceName: uid, startedAtMs: at, durationMs: 1, frames: 1, bytes: 10, inProgress: false, syncState: 'local' });
    const groups = groupRecordingsByDevice([r('A', day(8, 9)), r('B', day(10, 9)), r('A', day(10, 8)), r('A', day(10, 11))]);
    expect(groups.map((g) => g.uid)).toEqual(['A', 'B']);
    expect(groups[0]!.days.map((d) => d.items.length)).toEqual([2, 1]);
    expect(groups[0]!.bytes).toBe(30);
    expect(activeRecordingCount([{ recording: { enabled: true } }, { recording: { enabled: false } }])).toBe(1);
  });
  it('keeps an operation log with payload summaries', () => {
    let log = startOp([], { id: 1, atMs: 1000, uid: 'A', label: 'Filter', payload: { command: 'set_filter', enabled: true, median: 3 } });
    expect(log[0]!.status).toBe('running');
    log = finishOp(log, 1, false, 'device_offline', 1250);
    expect(log[0]).toMatchObject({ status: 'error', message: 'device_offline', durationMs: 250 });
    expect(payloadSummary(log[0]!.payload)).toBe('set_filter enabled=true median=3');
    expect(payloadSummary({ command: 'set_indicators', battery_led: { low_battery_threshold_percent: 10 } })).toBe('set_indicators battery_led={"low_battery_threshold_percent":10}');
    for (let i = 2; i < OP_LOG_LIMIT + 10; i++) log = startOp(log, { id: i, atMs: i, uid: '', label: 'x', payload: null });
    expect(log).toHaveLength(OP_LOG_LIMIT);
  });
  it('builds the timeline band', () => {
    expect(timelinePaths([])).toEqual({ band: '', top: '' });
    const { band, top } = timelinePaths([{ min: 0, max: 10 }, { min: 5, max: 20 }], 100, 50);
    expect(top.startsWith('M0.0,')).toBe(true);
    expect(band.endsWith('Z')).toBe(true);
  });
});
