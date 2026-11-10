import { describe, expect, it } from 'vitest';
import { normalizeConfig, defaultConfig } from '@nhgw/core';
import { NhrawWriter, PyFloat } from '@nhgw/engine';

import { quickCommandPayload } from '../src/commands';
import { NativeJsonStore, NativeRecordingSink } from '../src/files';
import { plainJson } from '../src/plainJson';
import { resultOutcome } from '../src/host';
import { decideRecovery, parseSidecar } from '../src/recovery';
import { recordingDirectory } from '../src/recordings';
import { LatestThrottle, type TimerPort } from '../src/throttle';
import {
  configPatchFromSettings,
  deviceView,
  isolationSuspected,
  liveFrame,
  nearbyView,
  hostDefaultConfig,
  recordingSummary,
  settingsFromConfig,
  timelineView,
} from '../src/views';
import { FakeNative } from './fakeNative';

describe('plainJson', () => {
  it('unwraps PyFloat, drops undefined, nulls non-finite numbers', () => {
    expect(plainJson({ a: new PyFloat(1), b: [new PyFloat(2.5), undefined, NaN], c: undefined, d: { e: 'x', f: true } })).toEqual({
      a: 1,
      b: [2.5, null, null],
      d: { e: 'x', f: true },
    });
  });
});

describe('views', () => {
  const entry = {
    device_uid: '3CDC7545CCD0',
    device_name: 'NHOS-3CDC7545CCD0',
    nickname: '',
    device_group: 'lab',
    gateway_connected: true,
    mode: 'normal',
    hardware_model: 'unknown',
    system_summary: { hardware_model: 'TIA-CTL v1.5.F 2026.7', firmware_version: 'v1.19.0' },
    matrix_shape: { rows: 2, cols: 3 },
    last_status: { battery: { soc_centi_percent: 8123 }, power: { charge_state: 'charging' } },
    latest_sample: { device_udp_fps: 61, received_at_ms: 1000 },
    recording_enabled: true,
    recording_error: '',
    last_seen_at: '2026-11-10T03:00:00.000000+00:00',
  };

  it('maps a device entry', () => {
    expect(deviceView(entry, 1500)).toEqual({
      uid: '3CDC7545CCD0',
      displayName: 'NHOS-3CDC7545CCD0',
      nickname: '',
      group: 'lab',
      online: true,
      mode: 'normal',
      hardwareModel: 'TIA-CTL v1.5.F 2026.7',
      firmwareVersion: 'v1.19.0',
      battery: { percent: 81, charging: true },
      fps: 61,
      matrix: { rows: 2, cols: 3 },
      recording: { enabled: true, finishing: false, error: '' },
      lastSeenMs: Date.UTC(2026, 10, 10, 3, 0, 0),
    });
  });

  it('fps drops to 0 once frames stop; nickname wins; no battery block -> null', () => {
    const view = deviceView({ ...entry, nickname: 'Left glove', last_status: {}, latest_sample: { device_udp_fps: 61, received_at_ms: 1000 } }, 4000);
    expect(view.fps).toBe(0);
    expect(view.displayName).toBe('Left glove');
    expect(view.battery).toBeNull();
    expect(deviceView({ device_uid: 'AABBCCDDEEFF' }, 0).displayName).toBe('NHOS-AABBCCDDEEFF');
  });

  it('maps nearby items and live frames', () => {
    expect(nearbyView({ device_uid: 'AABBCCDDEEFF', device_name: '', addr: '10.0.0.2', last_findme_at: '2026-11-10T03:00:00+00:00' }, 'gw-lab')).toEqual({
      uid: 'AABBCCDDEEFF',
      name: 'NHOS-AABBCCDDEEFF',
      ip: '10.0.0.2',
      attachedTo: 'gw-lab',
      lastSeenMs: Date.UTC(2026, 10, 10, 3, 0, 0),
    });
    const data = { p: [new PyFloat(1), new PyFloat(2.5), 3, 4, 5, 6], timestamp_ms: 42, device_udp_fps: 60 };
    expect(liveFrame('X', data, { rows: 2, cols: 3 })).toEqual({ uid: 'X', values: [1, 2.5, 3, 4, 5, 6], rows: 2, cols: 3, timestampMs: 42, fps: 60 });
    expect(liveFrame('X', data, { rows: 4, cols: 4 })).toMatchObject({ rows: 1, cols: 6 });
    expect(liveFrame('X', {}, null)).toBeNull();
  });

  it('summarizes a recording meta', () => {
    const meta = {
      device: { uid: '3CDC7545CCD0', display_name: 'Left glove' },
      recording: { started_at: '2026-11-10T03:00:00.000Z', stopped_at: '2026-11-10T03:01:00.500Z', rows: 3600 },
    };
    expect(recordingSummary('3CDC7545CCD0/20261110/030000', meta, 1234, false, 0)).toEqual({
      id: '3CDC7545CCD0/20261110/030000',
      uid: '3CDC7545CCD0',
      deviceName: 'Left glove',
      startedAtMs: Date.UTC(2026, 10, 10, 3, 0, 0),
      durationMs: 60_500,
      frames: 3600,
      bytes: 1234,
      inProgress: false,
      syncState: 'local',
    });
    const open = recordingSummary('A/B/C', { recording: { started_at: '2026-11-10T03:00:00.000Z', stopped_at: null } }, 0, true, Date.UTC(2026, 10, 10, 3, 0, 5));
    expect(open.durationMs).toBe(5000);
    expect(open.inProgress).toBe(true);
  });

  it('maps a timeline', () => {
    const view = timelineView({
      rows: 3, skipped_lines: 0, sensor_count: 1, start_ms: 0, end_ms: 10, duration_ms: 10, rate_hz: 100, median_interval_ms: 5,
      lost_frames: 2, restarts: 0, gaps: 1, series: 'total', bucket_ms: 5, buckets: [[1, 2], null], max_value: 2,
      events: [{ at_ms: 3, label: 'tap' }], events_total: 1,
    });
    expect(view).toEqual({ buckets: [{ min: 1, max: 2 }, { min: 0, max: 0 }], durationMs: 10, lostFrames: 2, gaps: 1, events: [{ atMs: 3, label: 'tap' }] });
  });

  it('suspects client isolation only after 60 s with Wi-Fi up and no FindMe', () => {
    const wifi = [{ name: 'wlan0', address: '192.168.1.20' }];
    expect(isolationSuspected(61_000, wifi, 0)).toBe(true);
    expect(isolationSuspected(59_000, wifi, 0)).toBe(false);
    expect(isolationSuspected(61_000, wifi, 1)).toBe(false);
    expect(isolationSuspected(61_000, [{ name: 'rmnet0', address: '10.1.2.3' }], 0)).toBe(false);
    expect(isolationSuspected(null, wifi, 0)).toBe(false);
  });

  it('settings round-trip through the config', () => {
    const config = normalizeConfig({ ...defaultConfig(), ...hostDefaultConfig('pocket-1234', 'NH Pocket') });
    expect(settingsFromConfig(config)).toEqual({
      pocketId: 'pocket-1234',
      displayName: 'NH Pocket',
      serverTarget: 'production',
      manualUrl: '',
      relayEnabled: true,
      offerPolicy: 'managed',
      syncPolicy: 'manual',
      theme: 'auto',
      locale: 'system',
    });
    const patch = configPatchFromSettings({ relayEnabled: false, serverTarget: 'manual', manualUrl: ' ws://10.0.0.1:5051/x ', locale: 'ja' });
    expect(patch).toEqual({ pocket_relay_enabled: false, target_mode: 'manual', manual_url: 'ws://10.0.0.1:5051/x', pocket_locale: 'ja' });
    const next = settingsFromConfig(normalizeConfig({ ...config, ...patch }));
    expect(next).toMatchObject({ relayEnabled: false, serverTarget: 'manual', locale: 'ja' });
    expect(normalizeConfig({ ...config, ...patch }).server_url).toBe('ws://10.0.0.1:5051/x');
  });
});

describe('quick commands', () => {
  it('match the Desktop payloads', () => {
    expect(quickCommandPayload({ kind: 'status' })).toEqual({ command: 'status' });
    expect(quickCommandPayload({ kind: 'reboot' })).toEqual({ command: 'reboot' });
    expect(quickCommandPayload({ kind: 'enter_maintenance' })).toEqual({ command: 'enter_maintenance', reason: 'manual' });
    expect(quickCommandPayload({ kind: 'exit_maintenance' })).toEqual({ command: 'exit_maintenance' });
    expect(quickCommandPayload({ kind: 'scan_rate', fps: 60 })).toEqual({ command: 'set_scan_timing', target_fps: 60, settle_us: 20, send_every_n_frames: 1 });
    expect(quickCommandPayload({ kind: 'scan_rate', fps: 90 })).toEqual({ command: 'set_scan_timing', target_fps: 90, settle_us: 15, send_every_n_frames: 1 });
    expect(quickCommandPayload({ kind: 'tare' })).toEqual({ command: 'calibration_tare_capture', duration_ms: 1000 });
    expect(quickCommandPayload({ kind: 'tare_clear' })).toEqual({ command: 'calibration_tare_clear' });
  });

  it('results become outcomes', () => {
    expect(resultOutcome({ status: 'ok', data: { a: new PyFloat(1) } })).toEqual({ ok: true, message: 'ok', data: { a: 1 } });
    expect(resultOutcome({ status: 'error', message: 'wrong_mode' })).toMatchObject({ ok: false, message: 'wrong_mode' });
    expect(resultOutcome({ ok: false })).toMatchObject({ ok: false, message: 'error' });
  });
});

class FakeTimers implements TimerPort {
  t = 0;
  queue: { at: number; fn: () => void; id: number }[] = [];
  private id = 0;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.id;
    this.queue.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.queue = this.queue.filter((item) => item.id !== handle);
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

describe('live throttle', () => {
  it('sends the first frame at once, then at most one per 50 ms, always the newest', () => {
    const timers = new FakeTimers();
    const got: number[] = [];
    const throttle = new LatestThrottle<number>((v) => got.push(v), 50, timers);
    // a 100 fps stream for 200 ms
    for (let i = 0; i < 20; i++) {
      throttle.push(i);
      timers.advance(10);
    }
    expect(got[0]).toBe(0);
    expect(got.length).toBeGreaterThanOrEqual(4);
    expect(got.length).toBeLessThanOrEqual(5);
    timers.advance(100);
    expect(got[got.length - 1]).toBe(19); // the trailing frame is not lost
    for (let i = 1; i < got.length; i++) expect(got[i]! > got[i - 1]!).toBe(true);
  });

  it('close() drops a pending frame', () => {
    const timers = new FakeTimers();
    const got: number[] = [];
    const throttle = new LatestThrottle<number>((v) => got.push(v), 50, timers);
    throttle.push(1);
    throttle.push(2);
    throttle.close();
    timers.advance(100);
    throttle.push(3);
    expect(got).toEqual([1]);
  });
});

describe('recovery decision', () => {
  const sidecar = { format: 1 as const, uid: 'A', start_epoch_us: 1, live_directory: 'recordings/A/20261110/030000' };
  it('discards an empty capture or one whose live recording finished', () => {
    expect(decideRecovery({ rawBytes: 24, sidecar, liveMeta: null, liveDirectoryExists: true })).toEqual({ action: 'discard', reason: 'empty' });
    const finished = { recording: { stopped_at: '2026-11-10T03:00:01.000Z', stop_reason: 'user' } };
    expect(decideRecovery({ rawBytes: 1000, sidecar, liveMeta: finished, liveDirectoryExists: true })).toEqual({ action: 'discard', reason: 'live_finished' });
  });

  it('converts over an unfinished or failed live recording, or with none', () => {
    const open = { recording: { stopped_at: null, stop_reason: null } };
    expect(decideRecovery({ rawBytes: 1000, sidecar, liveMeta: open, liveDirectoryExists: true })).toEqual({ action: 'convert', replaceDirectory: sidecar.live_directory });
    const failed = { recording: { stopped_at: '2026-11-10T03:00:01.000Z', stop_reason: 'write_error: ENOSPC' } };
    expect(decideRecovery({ rawBytes: 1000, sidecar, liveMeta: failed, liveDirectoryExists: true })).toEqual({ action: 'convert', replaceDirectory: sidecar.live_directory });
    expect(decideRecovery({ rawBytes: 1000, sidecar: null, liveMeta: null, liveDirectoryExists: false })).toEqual({ action: 'convert', replaceDirectory: null });
    expect(decideRecovery({ rawBytes: 1000, sidecar, liveMeta: null, liveDirectoryExists: false })).toEqual({ action: 'convert', replaceDirectory: null });
  });

  it('reads sidecars defensively', () => {
    expect(parseSidecar('{"uid":"A","start_epoch_us":5,"live_directory":""}')).toEqual({ format: 1, uid: 'A', start_epoch_us: 5, live_directory: null });
    expect(parseSidecar('not json')).toBeNull();
    expect(parseSidecar(null)).toBeNull();
  });
});

describe('native file adapters', () => {
  it('the recording sink appends, flushes, reports size and writes atomically', () => {
    const native = new FakeNative();
    const sink = new NativeRecordingSink(native);
    sink.mkdirp('recordings/A/20261110/030000');
    expect(sink.exists('recordings/A/20261110')).toBe(true);
    const file = sink.open('recordings/A/20261110/030000/x.data.csv');
    expect(file.size).toBe(0);
    file.append('a,b\r\n');
    expect(native.text('recordings/A/20261110/030000/x.data.csv')).toBe('');
    file.flush();
    file.append('1,2\r\n');
    file.close();
    expect(native.text('recordings/A/20261110/030000/x.data.csv')).toBe('a,b\r\n1,2\r\n');
    expect(() => file.append('late')).toThrow('closed file');
    expect(sink.open('recordings/A/20261110/030000/x.data.csv').size).toBe(10);
    sink.writeAtomic('recordings/A/20261110/030000/x.meta.json', '{}\n');
    expect(native.text('recordings/A/20261110/030000/x.meta.json')).toBe('{}\n');
  });

  it('the JSON store loads defaults on first run and a damaged file', async () => {
    const native = new FakeNative();
    const store = new NativeJsonStore<{ a: number }>(native, 'config/x.json', () => ({ a: 1 }));
    expect(await store.load()).toEqual({ a: 1 });
    await store.save({ a: 2 });
    expect(await store.load()).toEqual({ a: 2 });
    native.writeAtomic('config/x.json', '{broken');
    expect(await store.load()).toEqual({ a: 1 });
    expect(await new NativeJsonStore(native, 'config/none.json').load()).toBeNull();
  });

  it('recording ids cannot leave the data root', () => {
    expect(recordingDirectory('3CDC7545CCD0/20261110/030000')).toBe('recordings/3CDC7545CCD0/20261110/030000');
    for (const bad of ['', '../x/y', 'a/b', 'a/../c', '.raw/x/y', 'a/b/c/d']) expect(() => recordingDirectory(bad)).toThrow('invalid_recording_id');
  });

  it('the fake capture writes what NhrawWriter writes', () => {
    const native = new FakeNative();
    const handle = native.rawStart('3CDC7545CCD0', 'r.nhraw', 1000, new Uint8Array([1]));
    native.nowUs = 900; // a clock step back is clamped
    native.rawAppend(handle, 2, new Uint8Array([2]));
    const writer = new NhrawWriter({ deviceUid: '3CDC7545CCD0', startEpochUs: 1000 });
    writer.record(1000, 'event', new Uint8Array([1]));
    writer.record(1000, 'event', new Uint8Array([2]));
    expect(native.files.get('r.nhraw')).toEqual(writer.bytes());
  });
});
