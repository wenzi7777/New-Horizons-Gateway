import { afterEach, describe, expect, it } from 'vitest';

import { resolveApi, platformOf } from '../../src/renderer/api';
import { generateFrame, MockStudioApi } from '../../src/renderer/mock';
import * as c from '../../src/renderer/lib/commands';
import { deviceSettingsView } from '../../src/renderer/lib/deviceDetails';

let api: MockStudioApi;
afterEach(() => api?.dispose());
const make = () => (api = new MockStudioApi({ delayScale: 0, autoStart: false }));

describe('mock StudioApi', () => {
  it('starts with 3 managed devices (one recording, one offline), 2 nearby, recordings over several days', async () => {
    const snap = await make().snapshot();
    expect(snap.devices).toHaveLength(3);
    expect(snap.devices.filter((d) => d.recording.enabled)).toHaveLength(1);
    expect(snap.devices.filter((d) => !d.online)).toHaveLength(1);
    expect(snap.devices.map((d) => d.matrix)).toContainEqual({ rows: 14, cols: 10 });
    expect(snap.nearby).toHaveLength(2);
    expect(snap.nearby.filter((n) => n.attachedTo)).toHaveLength(1);
    expect(new Set(snap.recordings.map((r) => new Date(r.startedAtMs).toDateString())).size).toBeGreaterThanOrEqual(3);
    expect(snap.recordings.filter((r) => r.inProgress)).toHaveLength(1);
    expect(snap.status.serviceError).toBe('');
    for (const d of snap.devices) expect(snap.deviceDetails[d.uid]?.status).toBeTruthy();
  });

  it('falls back to the mock without window.nhStudio and uses the bridge when present', () => {
    expect(resolveApi(undefined).source).toBe('mock');
    const bridge = make();
    expect(resolveApi({ nhStudio: bridge }).api).toBe(bridge);
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('darwin');
    expect(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('win32');
  });

  it('settings commands change the status the settings pages read', async () => {
    const m = make();
    const uid = '3C84279A1F20';
    const view = async () => deviceSettingsView((await m.snapshot()).deviceDetails[uid]);
    expect((await view()).filter.enabled).toBe(false);
    expect((await m.sendCommand(uid, c.filterCommand(true, 5, 0.3))).ok).toBe(true);
    expect((await view()).filter).toEqual({ enabled: true, median: 5, alpha: 0.3 });
    await m.sendCommand(uid, c.scanTimingCommand(c.scanPresetTiming(90)));
    expect((await view()).scanTiming).toEqual({ target_fps: 90, settle_us: 15, send_every_n_frames: 1 });
    await m.sendCommand(uid, c.streamBufferCommand(true, 'extended'));
    expect((await view()).streamBuffer.mode).toBe('extended');
    await m.sendCommand(uid, c.chargeProfileCommand('slow'));
    expect((await view()).chargeProfile).toBe('slow');
    await m.sendCommand(uid, c.updateChannelCommand('beta'));
    expect((await view()).ota.channel).toBe('beta');
    await m.sendCommand(uid, c.logSettingsCommand(true, 'debug', 'extended'));
    expect((await view()).logging).toMatchObject({ level: 'debug', mode: 'extended', totalBytes: 24 * 1024 });
    await m.sendCommand(uid, c.maintenanceCommand(true));
    expect((await m.snapshot()).devices.find((d) => d.uid === uid)?.mode).toBe('maintenance');
    expect(m.frameFor(uid)).toBeNull();
    await m.sendCommand(uid, c.maintenanceCommand(false));
    expect(m.sent.map((s) => s.payload.command)).toEqual(['set_filter', 'set_scan_timing', 'set_stream_buffer', 'set_charge_profile', 'set_ota_config', 'set_log', 'enter_maintenance', 'exit_maintenance']);
  });

  it('tare via run() maps to the Desktop payload and sets the tared output', async () => {
    const m = make();
    const uid = '3C84279A2B44';
    await m.run(uid, { kind: 'tare' });
    expect(m.sent.at(-1)?.payload).toEqual(c.tareCommand());
    expect(deviceSettingsView((await m.snapshot()).deviceDetails[uid]).calibration.tareActive).toBe(true);
    await m.run(uid, { kind: 'tare_clear' });
    expect(m.sent.at(-1)?.payload).toEqual(c.tareClearCommand());
    expect(deviceSettingsView((await m.snapshot()).deviceDetails[uid]).calibration.tareActive).toBe(false);
  });

  it('clock commands answer with a clock_status shape', async () => {
    const m = make();
    const outcome = await m.sendCommand('3C84279A1F20', c.clockStatusCommand());
    expect(outcome.ok).toBe(true);
    expect((outcome.data as { clock: { synced: boolean } }).clock.synced).toBe(true);
    const cfg = await m.sendCommand('3C84279A1F20', c.clockConfigCommand({ ntpServer: 'ntp.nict.jp', ntpIntervalS: '', syncIntervalS: '' }));
    expect((cfg.data as { clock_config: { ntp_server: string } }).clock_config.ntp_server).toBe('ntp.nict.jp');
  });

  it('offline devices refuse commands; unknown commands fail', async () => {
    const m = make();
    expect(await m.sendCommand('F412FA0C77D8', c.statusCommand())).toMatchObject({ ok: false, message: 'device_offline' });
    expect(await m.sendCommand('3C84279A1F20', { command: 'self_destruct' })).toMatchObject({ ok: false, message: 'unknown_command' });
    expect(await m.sendCommand('NOPE', c.statusCommand())).toMatchObject({ ok: false, message: 'device_not_found' });
  });

  it('adopts, takes over devices attached elsewhere, releases', async () => {
    const m = make();
    expect((await m.adopt('84F703B19A6C')).ok).toBe(true);
    expect((await m.adopt('3C84279A5E10')).ok).toBe(true);
    let snap = await m.snapshot();
    expect(snap.devices.map((d) => d.uid)).toContain('3C84279A5E10');
    expect(snap.nearby.map((n) => n.uid)).not.toContain('3C84279A5E10');
    await m.release('3C84279A5E10');
    snap = await m.snapshot();
    expect(snap.nearby.map((n) => n.uid)).toContain('3C84279A5E10');
  });

  it('records, renames, groups, deletes', async () => {
    const m = make();
    const uid = '3C84279A2B44';
    await m.setRecording(uid, true);
    let snap = await m.snapshot();
    const rec = snap.recordings.find((r) => r.uid === uid && r.inProgress)!;
    expect(rec).toBeTruthy();
    await expect(m.deleteRecording(rec.id)).rejects.toThrow('recording_in_progress');
    await m.setRecording(uid, false);
    await m.setNickname(uid, 'Right insole');
    await m.setGroup(uid, 'Gait study B');
    snap = await m.snapshot();
    const d = snap.devices.find((x) => x.uid === uid)!;
    expect([d.displayName, d.group, d.recording.enabled]).toEqual(['Right insole', 'Gait study B', false]);
    expect(snap.recordings.find((r) => r.id === rec.id)?.deviceName).toBe('Right insole');
    const timeline = await m.timeline(snap.recordings[1]!.id);
    expect(timeline.buckets.length).toBeGreaterThan(1);
    expect(timeline.buckets.length).toBeLessThanOrEqual(240);
    expect(await m.exportRecording(rec.id)).toMatch(/\.zip$/);
    await m.deleteRecording(rec.id);
    expect((await m.snapshot()).recordings.some((r) => r.id === rec.id)).toBe(false);
    expect(await m.chooseDataFolder()).not.toBe('/Users/lab/Documents/NH Studio');
  });

  it('pushes snapshots to listeners and generates frames for both matrix sizes', async () => {
    const m = make();
    const seen: number[] = [];
    const off = m.onSnapshot((s) => seen.push(s.devices.length));
    await m.setGroup('3C84279A1F20', 'x');
    off();
    expect(seen.length).toBeGreaterThan(0);
    const a = generateFrame('A', 10, 12, 1000, null, () => 0.5);
    const b = generateFrame('B', 14, 10, 1000, null, () => 0.5);
    expect([a.length, b.length]).toEqual([120, 140]);
    for (const v of [...a, ...b]) expect(v >= 0 && v <= 4990).toBe(true);
    expect(Math.max(...a)).toBeGreaterThan(Math.min(...a) + 300);
  });

  it('applies settings and reconnects', async () => {
    const m = make();
    await m.updateSettings({ theme: 'dark', locale: 'ja', relayEnabled: false });
    const snap = await m.snapshot();
    expect([snap.settings.theme, snap.settings.locale, snap.settings.relayEnabled]).toEqual(['dark', 'ja', false]);
  });
});
