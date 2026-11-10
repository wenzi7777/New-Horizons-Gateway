import { describe, expect, it } from 'vitest';
import { parsePyJson, pyEquals, PyFloat, pyJsonDumps } from '../../src/parse/pyJson';
import { FrameClock, eventsLostSince } from '../../src/recording/appEventLog';
import { DeviceRecorder } from '../../src/recording/deviceRecorder';
import { isoMs, localTimeZoneOffset, recordingBase, siblingPaths, strftimeUtc } from '../../src/recording/paths';
import { LagTracker } from '../../src/recording/session';
import { MemoryRecordingSink, type RecordingFileSink } from '../../src/recording/sink';
import { parseBinaryPacket } from '../../src/parse/packetParser';
import { encodePacket, FLAG } from '../parse/packets';

describe('pyJson', () => {
  it('keeps the int/float distinction through parse and dump', () => {
    const text = '{"a": 1, "b": 1.0, "c": [1e-05, -0.0, 2.5e+20], "d": NaN, "é": "\\u00e9\\n", "e": {}, "f": []}';
    const value = parsePyJson(text);
    expect(pyJsonDumps(value)).toBe('{"a": 1, "b": 1.0, "c": [1e-05, -0.0, 2.5e+20], "d": NaN, "\\u00e9": "\\u00e9\\n", "e": {}, "f": []}');
    expect(pyJsonDumps(value, { indent: 2, ensureAscii: false })).toBe(
      '{\n  "a": 1,\n  "b": 1.0,\n  "c": [\n    1e-05,\n    -0.0,\n    2.5e+20\n  ],\n  "d": NaN,\n  "é": "é\\n",\n  "e": {},\n  "f": []\n}',
    );
    expect(pyEquals(true, new PyFloat(1))).toBe(true);
    expect(pyEquals({ a: [1, 'x'] }, { a: [1.0, 'x'] })).toBe(true);
    expect(pyEquals('1', 1)).toBe(false);
  });
});

describe('paths and time', () => {
  it('formats UTC names and ISO times as Python does', () => {
    const us = Date.UTC(2026, 0, 2, 3, 4, 5, 678) * 1000 + 999;
    expect(strftimeUtc(us, '%Y%m%d/%H%M%S')).toBe('20260102/030405');
    expect(isoMs(us)).toBe('2026-01-02T03:04:05.678Z');
    expect(localTimeZoneOffset(us)).toMatch(/^[+-]\d\d:\d\d$/);
    expect(recordingBase('a/062756-2.data.csv')).toBe('062756-2');
    expect(siblingPaths('d/062756.csv', (p) => p === 'd/062756.csv').data).toBe('d/062756.csv');
  });
});

describe('FrameClock', () => {
  it('interpolates, extrapolates and forgets on a restart', () => {
    const clock = new FrameClock(3);
    expect(clock.timeOf(1)).toBeNull();
    clock.record(10, 1000, 'device');
    expect(clock.timeOf(12)).toEqual([1000, 'estimated']);
    clock.record(12, 1034, 'device');
    expect(clock.timeOf(11)).toEqual([1017, 'estimated']);
    expect(clock.timeOf(14)).toEqual([1068, 'estimated']);
    expect(clock.timeOf(0)).toEqual([1034, 'estimated']);
    clock.record(13, 1051, 'device');
    clock.record(14, 1068, 'device');
    expect(clock.timeOf(10)).toEqual([1000, 'estimated']); // forgotten past capacity, extrapolated from 12, 13
    clock.record(1, 5000, 'received');
    expect([clock.first, clock.last]).toEqual([1, 1]);
    expect(eventsLostSince(5, 9, [{ seq: 8 }])).toBe(2);
    expect(eventsLostSince(5, 9, [])).toBe(4);
  });
  it('LagTracker measures delay that builds up', () => {
    const now = { ms: 1000 };
    const lag = new LagTracker({ nowEpochUs: () => 0, monotonicMs: () => now.ms });
    lag.observe(5000);
    now.ms += 40;
    expect(lag.observe(5017)).toBeCloseTo(23);
  });
});

describe('DeviceRecorder', () => {
  const clock = { us: Date.UTC(2026, 10, 10) * 1000, ms: 1 };
  const deps = (sink: RecordingFileSink) => ({
    sink,
    dataRoot: 'root',
    clock: { nowEpochUs: () => clock.us, monotonicMs: () => clock.ms },
    knowledge: () => ({ device: {}, status: {} }),
    serverTimeZone: '+00:00',
  });

  it('a failed data write ends the recording with write_error and keeps the meta', () => {
    const sink = new MemoryRecordingSink();
    let fail = false;
    const failing: RecordingFileSink = {
      exists: (p) => sink.exists(p),
      mkdirp: (p) => sink.mkdirp(p),
      writeAtomic: (p, t) => sink.writeAtomic(p, t),
      open: (p) => {
        const handle = sink.open(p);
        return { size: handle.size, flush: () => handle.flush(), close: () => handle.close(), append: (t) => { if (fail) throw new Error('No space left on device'); handle.append(t); } };
      },
    };
    const updates: unknown[] = [];
    const recorder = new DeviceRecorder('3CDC7545CCD0', { ...deps(failing), onUpdate: (u) => updates.push(u) });
    expect(recorder.setEnabled(true).needsStatus).toBe(true);
    expect(recorder.onFrame(parseBinaryPacket(encodePacket({ frameId: 1, matrix: [1] })))).toEqual({});
    fail = true;
    const result = recorder.onFrame(parseBinaryPacket(encodePacket({ frameId: 2, matrix: [1] })));
    expect(result.finished).toBe('write_error: No space left on device');
    expect(recorder.enabled).toBe(false);
    expect(recorder.error).toBe('No space left on device');
    const meta = JSON.parse([...sink.files.entries()].find(([p]) => p.endsWith('.meta.json'))![1]);
    expect(meta.recording.stop_reason).toBe('write_error: No space left on device');
    expect(updates.at(-1)).toEqual({ type: 'recording_update', device_uid: '3CDC7545CCD0', enabled: false, error: 'No space left on device' });
    // Off: further frames are not written.
    expect(recorder.onFrame(parseBinaryPacket(encodePacket({ frameId: 3, matrix: [1] })))).toEqual({});
  });

  it('reports lag on device-clock frames and nothing when off', () => {
    const sink = new MemoryRecordingSink();
    const recorder = new DeviceRecorder('3CDC7545CCD0', deps(sink));
    expect(recorder.onFrame(parseBinaryPacket(encodePacket({ frameId: 1, matrix: [1] })))).toEqual({});
    recorder.setEnabled(true);
    const r = recorder.onFrame(parseBinaryPacket(encodePacket({ frameId: 1, timestamp: 1792056866000, flags: FLAG.EPOCH, matrix: [1] })));
    expect(r).toEqual({ recording_lag_ms: 0 });
    expect(recorder.paths?.data).toBe('root/3CDC7545CCD0/20261110/000000/000000.data.csv');
    recorder.setEnabled(false);
    expect(recorder.paths).toBeNull();
  });
});
