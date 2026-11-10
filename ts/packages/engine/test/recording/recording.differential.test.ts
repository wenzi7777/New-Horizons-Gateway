// The same packets, clocks and switch presses through the Desktop backend's
// Python recording code and through DeviceRecorder: every file must match
// byte for byte, and so must what each side did (results, commands sent).
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLAG } from '../parse/packets';
import { hasPython, rng, runPython, tempDir } from './pyHarness';
import { runTs, Scenario, type RunResult, type ScenarioSpec } from './scenario';

const FULL_STATUS = JSON.stringify({
  device_name: 'NHOS-3CDC7545CCD0',
  protocol: 'NHO/Arduino/1',
  received_at: '2026-11-10T01:02:00.123456+00:00',
  system: { hardware_model: 'TIA-CTL v1.5.F 2026.7', firmware_version: 'v1.19.0', firmware_prerelease: false },
  runtime: { scan_timing: { target_fps: 60, send_every_n_frames: 1 }, transport: { mode: 'wifi' } },
  matrix_shape: { rows: 2, cols: 2 },
  matrix_layout: { analog_pins: [1, 2], select_pins: [3, 4], extra: 'ü' },
  calibration: { enabled: true, output_mode: 'kpa', tare_complete: false, fit_settings: { degree: 2, alpha: 0.5, scale: 1.0 }, metadata: { by: 'x' } },
  filter: { kind: 'ema', alpha: 0.25 },
  stream_raw_adc: false,
  imu: { chip: 'ICM42688', sample_rate_hz: 100.0 },
  magnetometer: true,
  clock: { source: 'gateway', synced: true, offset_ms: -1.5 },
  battery: { soc_percent: 81.25, vbat_mv: 3987 },
}).replace('"scale":1', '"scale":1.0').replace('"sample_rate_hz":100', '"sample_rate_hz":100.0');

const random = rng(42);
const floats = (n: number, scale = 100) => Array.from({ length: n }, () => (random() - 0.2) * scale);

function compare(spec: ScenarioSpec, options: { tz?: string; serverTimeZone?: string } = {}): { ts: RunResult; py: RunResult } {
  const py = runPython<RunResult>('record', spec, { outdir: tempDir(), ...(options.tz ? { tz: options.tz } : {}) });
  const ts = runTs(spec, options.serverTimeZone ? { serverTimeZone: options.serverTimeZone } : {});
  // NH_DUMP=<dir>: keep Python's output for inspection.
  if (process.env.NH_DUMP) appendFileSync(process.env.NH_DUMP, JSON.stringify(py) + '\n');
  expect(Object.keys(ts.files).sort()).toEqual(Object.keys(py.files).sort());
  for (const [path, text] of Object.entries(py.files)) expect(ts.files[path], path).toBe(text);
  expect(ts.log).toEqual(py.log);
  return { ts, py };
}

describe.skipIf(!hasPython)('recording, differential against the Desktop backend', () => {
  it('v5 frames on the device clock with IMU, magnetometer and battery; a hub relay', () => {
    const s = new Scenario();
    s.enable();
    let epoch = 1792056866000;
    for (let i = 1; i <= 40; i++) {
      s.advance(16.667, 16.5);
      epoch += 17;
      s.frame({ frameId: 100 + i, timestamp: epoch, flags: FLAG.EPOCH, matrix: floats(4), imu: floats(7, 2), mag: floats(3, 50), battery: { status: 1, fault: 0, vbat_mv: 3990, soc_centi_percent: 8000 } });
    }
    s.advance(10).enable(false);
    const { ts } = compare(
      s.spec({ device: JSON.stringify({ gateway_id: 'hub-1', gateway_connected: true, display_name: 'Left foot' }), status: FULL_STATUS, nickname: 'L', group: 'feet', gateways: JSON.stringify({ 'hub-1': { client_type: 'hub' } }) }),
    );
    expect(Object.keys(ts.files)).toHaveLength(2); // no events
  });

  it('v3 frames on the received clock, raw ADC, restart in the same second, naming collisions', () => {
    const s = new Scenario();
    const day = '3CDC7545CCD0/20261110';
    s.existing = [`${day}/010203`, `${day}/010203-2.csv`];
    s.enable();
    for (let i = 1; i <= 10; i++) s.advance(20).frame({ version: 3, frameId: i, timestamp: i * 20, matrix: floats(3, 4000), raw: floats(3, 4096) });
    s.advance(5).enable(false).advance(1).enable(true);
    for (let i = 11; i <= 15; i++) s.advance(20).frame({ version: 3, frameId: i, timestamp: i * 20, matrix: floats(3, 1e-3), raw: floats(3) });
    s.enable(false);
    // A later recording on a new day, v2 packets.
    s.advance(86_400_000).enable();
    for (let i = 1; i <= 3; i++) s.advance(20).frame({ version: 2, frameId: i, matrix: floats(2) });
    s.enable(false);
    compare(s.spec());
  });

  it('v4 with epoch valid and not, frame-sequence gaps, a device restart, sensor count change, zero sensors', () => {
    const s = new Scenario();
    s.enable();
    let epoch = 1792056866000;
    for (let i = 1; i <= 30; i++) {
      s.advance(17);
      epoch += 17;
      const seq = i < 10 ? i : i < 20 ? i + 5 : i - 18; // gap of 5, then the device restarts
      s.frame({ version: 4, frameId: seq, timestamp: epoch, flags: i % 7 === 0 ? 0 : FLAG.EPOCH, matrix: floats(i > 25 ? 5 : 4) });
    }
    s.advance(17).frame({ version: 4, frameId: 0, timestamp: epoch, flags: FLAG.EPOCH, matrix: [] });
    s.advance(17).frame({ version: 4, frameId: 77, timestamp: epoch, flags: FLAG.EPOCH, matrix: [0.0078125, -0.0078125, 1e-7, -1e-7, -0, NaN, Infinity, 1e10] });
    s.rawFrame(new Uint8Array([0x5a, 0xa5, 5, 0, 1, 2, 3, 4, 5, 6])); // too short: dropped
    s.advance(17).enable(false);
    compare(s.spec({ device: '{"hardware_model": "TIA-CTL v1.0.F 2026.4"}' }));
  });

  it('112 sensors with raw ADC at 60 fps for 12 s: periodic meta rewrites, a recording never stopped', () => {
    const s = new Scenario();
    s.enable();
    let epoch = 1792056866000;
    for (let i = 1; i <= 720; i++) {
      s.advance(16.6667, 16.6667);
      epoch += 17;
      s.frame({ frameId: i, timestamp: epoch, flags: FLAG.EPOCH, matrix: floats(112, 300), raw: floats(112, 4095), imu: floats(7) });
    }
    // No stop: the meta is whatever the last 10-second rewrite left.
    compare(s.spec({ status: FULL_STATUS }));
  });

  it('meta follows a status: fills unknowns, logs tracked changes', () => {
    const s = new Scenario();
    s.enable();
    let epoch = 1792056866000;
    const frame = (i: number) => s.advance(17).frame({ frameId: i, timestamp: (epoch += 17), flags: FLAG.EPOCH, matrix: floats(4) });
    for (let i = 1; i <= 5; i++) frame(i);
    s.setKnowledge({ status: FULL_STATUS, device: '{"transport_path": "arduino_udp"}' }, true);
    for (let i = 6; i <= 8; i++) frame(i);
    const changed = JSON.parse(FULL_STATUS) as Record<string, any>;
    changed.calibration.enabled = false;
    changed.calibration.output_mode = 'raw';
    changed.system.firmware_version = 'v1.20.0';
    changed.runtime.scan_timing.target_fps = 30;
    changed.stream_raw_adc = 1; // == True in Python: not a change
    s.setKnowledge({ status: JSON.stringify(changed), device: '{"transport_path": "espnow", "gateway_id": "gw-9", "gateway_connected": true}' }, true);
    for (let i = 9; i <= 10; i++) frame(i);
    s.advance(1).enable(false);
    compare(s.spec({ device: '{"device_name": "NHOS-3CDC7545CCD0"}' }));
  });

  it('a stop while frames are queued drains up to the stop; the drain timer; enabling during a drain', () => {
    const s = new Scenario();
    s.enable();
    let epoch = 1792056866000;
    // The server falls behind: 30 ms of monotonic time per 17 ms of device time.
    for (let i = 1; i <= 60; i++) s.advance(30, 30).frame({ frameId: i, timestamp: (epoch += 17), flags: FLAG.EPOCH, matrix: floats(3) });
    s.advance(1).enable(false); // lag ~ 780 ms: drains
    for (let i = 61; i <= 120; i++) s.advance(5, 5).frame({ frameId: i, timestamp: (epoch += 17), flags: FLAG.EPOCH, matrix: floats(3) });
    // Second recording: stopped while behind, the stream stops, the timer ends it.
    s.advance(2000).enable(true);
    for (let i = 121; i <= 160; i++) s.advance(30, 30).frame({ frameId: i, timestamp: (epoch += 17), flags: FLAG.EPOCH, matrix: floats(3) });
    s.advance(1).enable(false);
    s.advance(12_000).drainTimer();
    // Third: stopped behind, then switched on again mid-drain (that one ends as "user").
    s.advance(3000).enable(true);
    for (let i = 161; i <= 200; i++) s.advance(30, 30).frame({ frameId: i, timestamp: (epoch += 17), flags: FLAG.EPOCH, matrix: floats(3) });
    s.advance(1).enable(false).advance(10).enable(true);
    for (let i = 201; i <= 205; i++) s.advance(17).frame({ frameId: i, timestamp: (epoch += 17), flags: FLAG.EPOCH, matrix: floats(3) });
    // Fourth: the drain deadline passes on a frame (user_drain_timeout from write()).
    s.advance(1).enable(false).enable(true);
    for (let i = 206; i <= 240; i++) s.advance(40, 40).frame({ frameId: i, timestamp: (epoch += 17), flags: FLAG.EPOCH, matrix: floats(3) });
    s.advance(1).enable(false);
    s.advance(20_000, 20_000).frame({ frameId: 241, timestamp: epoch - 5000, flags: FLAG.EPOCH, matrix: floats(3) });
    s.shutdown();
    compare(s.spec({ status: FULL_STATUS }));
  });

  it('shutdown ends a recording as server_stopped', () => {
    const s = new Scenario();
    s.enable();
    for (let i = 1; i <= 5; i++) s.advance(17).frame({ frameId: i, timestamp: 1792056866000 + i * 17, flags: FLAG.EPOCH, matrix: floats(2) });
    s.advance(3).shutdown();
    compare(s.spec());
  });

  it('streamed app events: gaps, repairs, restarts, events from before the first frame', () => {
    const s = new Scenario();
    s.enable().poll();
    let epoch = 1792056866000;
    const ev = (seq: number, frame: number, extra: Partial<{ value: number; app: string; event: string; detail: string }> = {}) => ({
      seq,
      frame_seq: frame,
      ms: 1000 + seq,
      app: extra.app ?? 'flow1',
      event: extra.event ?? 'step',
      detail: extra.detail ?? 'rise',
      ...(extra.value !== undefined ? { value: extra.value } : {}),
    });
    const frame = (i: number, events: ReturnType<typeof ev>[] = []) =>
      s.advance(17).frame({ frameId: i, timestamp: (epoch += 17), flags: FLAG.EPOCH, matrix: floats(4), imu: floats(7), events });
    frame(10, [ev(1, 9), ev(2, 10, { value: 1 })]); // seq 1 is from before the first frame
    frame(11, [ev(3, 11, { value: 0.1, detail: 'a,"b"' })]);
    frame(12);
    frame(13, [ev(6, 13, { value: -2.5 })]); // 4, 5 lost: repair request
    s.advance(100).poll();
    s.appEventsResult(JSON.stringify({ command: 'app_events', request_id: 'appev-00000000000000000000000000000002', data: { seq: 6, streaming: true, events: [ev(4, 12), ev(5, 12, { value: 3.0 })] } }).replace('"value":3', '"value":3.0'));
    frame(14, [ev(7, 14), ev(7, 14)]);
    frame(15, [ev(9, 15)]); // 8 lost
    s.online(false).advance(1500).poll();
    s.online(true);
    frame(16, [ev(10, 16, { app: '日本', event: 'é' })]);
    s.advance(6000).poll(); // streaming: the 5 s check
    s.appEventsResult(JSON.stringify({ command: 'app_events', request_id: 'appev-00000000000000000000000000000003', data: { seq: 10, events: [ev(10, 16)] } }));
    frame(17, [ev(2, 17)]); // the device restarted its sequence
    frame(1, [ev(3, 1)]); // and its frames
    frame(2, [ev(4, 9999)]); // an event on a frame not recorded (estimated time)
    s.advance(5).enable(false); // behind after the pauses above: drains
    s.advance(20_000).drainTimer();
    compare(s.spec({ status: FULL_STATUS }));
  });

  it('polled app_events (pre-stream firmware): held events, hold expiry, losses and dropped markers', () => {
    const s = new Scenario();
    s.enable();
    let epoch = 1792056866000;
    const ev = (seq: number, frame: number, value?: number) => ({ seq, frame_seq: frame, ms: 500 + seq, app: 'a', event: 'e', detail: 'd', ...(value !== undefined ? { value } : {}) });
    const frame = (i: number) => s.advance(17).frame({ frameId: i, timestamp: (epoch += 17), flags: FLAG.EPOCH, matrix: floats(2) });
    const reply = (n: number, seq: number, events: ReturnType<typeof ev>[], extra: Record<string, unknown> = {}) =>
      s.appEventsResult(JSON.stringify({ command: 'app_events', request_id: `appev-${n.toString(16).padStart(32, '0')}`, data: { seq, events, ...extra } }));
    for (let i = 1; i <= 3; i++) frame(i);
    s.advance(500).poll();
    reply(1, 3, [ev(1, 1, 0.5), ev(2, 2), ev(3, 5)]); // 3 waits for frame 5
    s.advance(500).poll();
    frame(4);
    reply(2, 3, [ev(3, 5)]); // still waiting
    s.advance(3500).poll();
    reply(3, 3, [ev(3, 5)]); // waited too long: written with an estimated time
    s.advance(500).poll();
    reply(4, 9, [ev(8, 4), ev(9, 4)]); // 4..7 rolled off the ring
    s.advance(500).poll();
    reply(5, 12, []); // nothing back, device moved on
    s.advance(500).poll();
    reply(6, 2, [ev(1, 4), ev(2, 4)]); // device restarted its sequence
    reply(99, 3, [ev(3, 4, 7)]); // unknown request id
    s.appEventsResult('{"command": "app_events", "request_id": "x", "data": {"seq": 4, "events": [{"seq": 4, "frame_seq": 4, "ms": 1, "app": "a", "event": "e", "detail": "d", "value": 2.0}, {"seq": "bad"}, 5]}}');
    s.appEventsResult('{"command": "app_events", "data": "not a dict"}');
    for (let i = 5; i <= 6; i++) frame(i);
    reply(7, 20, [ev(20, 6)]); // 10..19 lost
    s.advance(5).enable(false); // behind after the pauses above: drains
    s.advance(20_000).drainTimer();
    reply(8, 21, [ev(21, 6)]); // after the recording ended: ignored
    compare(s.spec());
  });

  it('v5 packets with events split by the known matrix shape', () => {
    const s = new Scenario();
    s.enable();
    const events = [{ seq: 1, frame_seq: 1, ms: 1, app: 'x', event: 'y', detail: 'z', value: 0.3 }];
    // With an unknown TLV after the event only the known shape can split it.
    for (let i = 1; i <= 3; i++) s.advance(17).frame({ frameId: i, timestamp: 1792056866000 + i, flags: FLAG.EPOCH, matrix: floats(4), events: i === 1 ? events : [], extraTlv: [0x09, 0x01, 0x00] });
    s.enable(false);
    compare(s.spec({ device: '{"matrix_shape": {"rows": 2, "cols": 2}}' }));
  });

  it('another server time zone', () => {
    const s = new Scenario();
    s.enable();
    for (let i = 1; i <= 3; i++) s.advance(17).frame({ frameId: i, matrix: floats(2) });
    s.enable(false);
    compare(s.spec(), { tz: 'America/New_York', serverTimeZone: '-05:00' });
  });
});

describe('studio / pocket relay values', () => {
  it('a device streaming to the host directly records the host as its relay', () => {
    const s = new Scenario();
    s.enable();
    s.advance(17).frame({ frameId: 1, matrix: [1] });
    s.enable(false);
    const result = runTs(s.spec(), { localRelay: 'pocket', localRelayId: 'pocket-abc' });
    const metaPath = Object.keys(result.files).find((path) => path.endsWith('.meta.json'))!;
    const meta = JSON.parse(result.files[metaPath]!) as { transport: unknown };
    expect(meta.transport).toEqual({ path: null, relay: 'pocket', relay_id: 'pocket-abc' });
    const studio = runTs(s.spec({ device: '{"gateway_id": "studio-1", "gateway_connected": true}', gateways: '{"studio-1": {"client_type": "studio"}}' }));
    const studioMeta = JSON.parse(studio.files[Object.keys(studio.files).find((p) => p.endsWith('.meta.json'))!]!) as { transport: unknown };
    expect(studioMeta.transport).toEqual({ path: null, relay: 'studio', relay_id: 'studio-1' });
  });
});
