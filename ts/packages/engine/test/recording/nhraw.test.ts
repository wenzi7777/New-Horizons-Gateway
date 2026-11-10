import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../../../core/src/bytes';
import { convertRaw, encodeNhrawHeader, NhrawConverter, NhrawStreamReader, NhrawWriter, readNhraw } from '../../src/recording/nhraw';
import { encodePacket, FLAG, type PacketSpec } from '../parse/packets';
import { hasPython, rng, runPython, tempDir } from './pyHarness';
import { runTs, Scenario, type RunResult } from './scenario';

const UID = '3CDC7545CCD0';
const START = Date.UTC(2026, 10, 10, 23, 59, 58, 900) * 1000 + 123;

/** Writes a .nhraw and the equivalent scenario side by side (wall = arrival, monotonic = arrival in ms). */
class Both {
  readonly raw = new NhrawWriter({ deviceUid: UID, startEpochUs: START });
  readonly scenario = new Scenario(UID, START, START / 1000);
  constructor() {
    this.scenario.enable();
  }
  private at(us: number) {
    this.scenario.wallUs = us;
    this.scenario.monoMs = us / 1000;
  }
  frame(us: number, spec: PacketSpec) {
    this.at(us);
    const bytes = encodePacket({ uid: UID, ...spec });
    this.raw.record(us, 'stream', bytes);
    this.scenario.rawFrame(bytes);
  }
  knowledge(us: number, device: string, status: string, statusUpdate: boolean) {
    this.at(us);
    this.raw.record(us, 'event', utf8Encode(`{"type":"knowledge","device":${device},"status":${status},"status_update":${statusUpdate}}`));
    this.scenario.setKnowledge({ device, status }, statusUpdate);
  }
  switch(us: number, on: boolean) {
    this.at(us);
    this.raw.event(us, { type: on ? 'start' : 'stop' });
    this.scenario.enable(on);
  }
  poll(us: number, requestId: string, since: number) {
    this.at(us);
    this.raw.event(us, { type: 'app_events_request', request_id: requestId, since });
    this.scenario.poll();
  }
  appEvents(us: number, data: string, requestId: string) {
    this.at(us);
    this.raw.record(us, 'control', utf8Encode(`{"type":"result","request_id":"${requestId}","payload":{"command":"app_events","data":${data}}}`));
    this.scenario.appEventsResult(`{"command":"app_events","data":${data},"request_id":"${requestId}"}`);
  }
}

function build(): Both {
  const both = new Both();
  const random = rng(11);
  const status = '{"system":{"hardware_model":"TIA-CTL v2.3.D GCU LTS","firmware_version":"v1.19.0"},"matrix_shape":{"rows":1,"cols":3},"calibration":{"enabled":true,"fit_settings":{"k":1.0}},"battery":{"soc_percent":50.0,"vbat_mv":3800}}';
  both.knowledge(START + 10, '{"device_name":"NHOS-3CDC7545CCD0"}', status, false);
  let us = START + 1000;
  let epoch = 1792108798000;
  for (let i = 1; i <= 400; i++) {
    us += 16_000 + Math.floor(random() * 2000);
    epoch += 17;
    const events = i === 50 ? [{ seq: 1, frame_seq: 50, ms: 10, app: 'flow', event: 'tap', detail: '', value: 2 }] : i === 90 ? [{ seq: 4, frame_seq: 90, ms: 11, app: 'flow', event: 'tap', detail: 'x' }] : [];
    both.frame(us, { frameId: i, timestamp: epoch, flags: i % 50 === 0 ? 0 : FLAG.EPOCH, matrix: [random() * 10, random(), -random()], imu: [1, 2, 3, 4, 5, 6, 7], battery: { status: 1, fault: 0, vbat_mv: 3800, soc_centi_percent: 5000 }, events });
    if (i === 95) both.poll(us + 1, 'appev-00000000000000000000000000000001', 1);
    if (i === 96) both.appEvents(us + 2, '{"seq":4,"events":[{"seq":2,"frame_seq":60,"ms":5,"app":"flow","event":"tap","detail":"","value":1.0}]}', 'appev-00000000000000000000000000000001');
    if (i === 200) both.knowledge(us + 1, '{"device_name":"NHOS-3CDC7545CCD0"}', status.replace('"enabled":true', '"enabled":false'), true);
    if (i === 300) both.switch(us + 1, false);
    if (i === 302) both.switch(us + 1, true);
  }
  both.switch(us + 5000, false);
  return both;
}

describe('.nhraw', () => {
  it('round-trips header and records, and reports a cut-off tail', () => {
    const writer = new NhrawWriter({ deviceUid: UID, startEpochUs: START });
    writer.record(START + 1, 'stream', new Uint8Array([1, 2, 3]));
    writer.event(START + 2, { type: 'stop' });
    const bytes = writer.bytes();
    const file = readNhraw(bytes);
    expect(file.header).toEqual({ version: 1, deviceUid: UID, startEpochUs: START });
    expect(file.records.map((r) => [r.rxEpochUs, r.source, Array.from(r.payload)])).toEqual([
      [START + 1, 'stream', [1, 2, 3]],
      [START + 2, 'event', Array.from(utf8Encode('{"type":"stop"}'))],
    ]);
    expect(file.truncated).toBe(false);
    const cut = readNhraw(bytes.subarray(0, bytes.length - 3));
    expect(cut.records).toHaveLength(1);
    expect(cut.truncated).toBe(true);
    expect(() => readNhraw(new Uint8Array(30))).toThrow('nhraw_bad_magic');
    expect(encodeNhrawHeader({ deviceUid: UID, startEpochUs: 1 }).length).toBe(24);
  });

  it('converts to exactly what recording live writes', () => {
    const both = build();
    const converted = convertRaw(both.raw.bytes(), { serverTimeZone: '+09:00' });
    const live = runTs(both.scenario.spec(), { serverTimeZone: '+09:00' });
    expect(Object.fromEntries(converted.files)).toEqual(live.files);
    expect(Object.keys(live.files).length).toBe(5); // two recordings, the first with events
    expect(converted.paths?.data).toMatch(/^3CDC7545CCD0\/2026111[01]\/\d{6}(-\d+)?\/\d{6}(-\d+)?\.data\.csv$/);
  });

  it('joins chunked control replies and ignores other devices and heartbeats', () => {
    const writer = new NhrawWriter({ deviceUid: UID, startEpochUs: START });
    writer.record(START + 10, 'stream', encodePacket({ uid: UID, frameId: 1, matrix: [1] }));
    writer.record(START + 20, 'stream', encodePacket({ uid: 'AABBCCDDEEFF', frameId: 1, matrix: [9] }));
    writer.record(START + 25, 'stream', encodePacket({ uid: UID, frameId: 2, flags: FLAG.HEARTBEAT }));
    const reply = '{"command":"app_events","data":{"seq":1,"events":[{"seq":1,"frame_seq":1,"ms":1,"app":"a","event":"e","detail":"d","value":1.0}]}}';
    const half = Math.floor(reply.length / 2);
    for (const [i, part] of [reply.slice(0, half), reply.slice(half)].entries()) {
      writer.record(START + 30 + i, 'control', utf8Encode(JSON.stringify({ type: 'result_chunk', request_id: 'r1', chunk: i, chunks: 2, data: part })));
    }
    writer.event(START + 40, { type: 'stop' });
    const result = convertRaw(writer.bytes(), { serverTimeZone: '+00:00' });
    const data = [...result.files.entries()].find(([path]) => path.endsWith('.data.csv'))![1];
    expect(data.trim().split('\r\n')).toHaveLength(2);
    const events = [...result.files.entries()].find(([path]) => path.endsWith('.events.csv'))![1];
    expect(events).toContain(',1.0,1,');
  });

  it('a stop with frames queued drains; the timer fires at its deadline', () => {
    const writer = new NhrawWriter({ deviceUid: UID, startEpochUs: START });
    let epoch = 1792108798000;
    for (let i = 1; i <= 60; i++) writer.record(START + i * 40_000, 'stream', encodePacket({ uid: UID, frameId: i, timestamp: (epoch += 17), flags: FLAG.EPOCH, matrix: [i] }));
    writer.event(START + 61 * 40_000, { type: 'stop' });
    const result = convertRaw(writer.bytes(), { serverTimeZone: '+00:00' });
    const meta = JSON.parse([...result.files.entries()].find(([path]) => path.endsWith('.meta.json'))![1]) as { recording: Record<string, unknown> };
    expect(meta.recording.stop_reason).toBe('user_drain_timeout');
    expect(meta.recording.stop_requested_at).not.toBeNull();
  });
});

describe('.nhraw, streaming', () => {
  it('chunked reading and record-by-record conversion match convertRaw', () => {
    const bytes = build().raw.bytes();
    const whole = convertRaw(bytes, { serverTimeZone: '+09:00' });
    for (const chunkSize of [1, 7, 4096, bytes.length]) {
      const reader = new NhrawStreamReader();
      let converter: NhrawConverter | null = null;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        for (const record of reader.push(bytes.subarray(offset, offset + chunkSize))) {
          converter ??= new NhrawConverter(reader.header!, { serverTimeZone: '+09:00' });
          converter.push(record);
        }
      }
      expect(reader.end()).toEqual({ truncated: false });
      const result = converter!.finish();
      expect(Object.fromEntries(result.files)).toEqual(Object.fromEntries(whole.files));
      expect(result.paths).toEqual(whole.paths);
    }
  });

  it('reports a cut-off tail and a bad header like readNhraw', () => {
    const writer = new NhrawWriter({ deviceUid: UID, startEpochUs: START });
    writer.record(START + 1, 'stream', new Uint8Array([1, 2, 3]));
    const bytes = writer.bytes();
    const reader = new NhrawStreamReader();
    expect(reader.push(bytes.subarray(0, bytes.length - 2))).toHaveLength(0);
    expect(reader.header).toEqual({ version: 1, deviceUid: UID, startEpochUs: START });
    expect(reader.end()).toEqual({ truncated: true });
    expect(() => new NhrawStreamReader().push(new Uint8Array(30))).toThrow('nhraw_bad_magic');
    expect(() => new NhrawStreamReader().end()).toThrow('nhraw_bad_magic');
  });

  it('closeOpen ends a recording the app never stopped as a shutdown', () => {
    const writer = new NhrawWriter({ deviceUid: UID, startEpochUs: START });
    let epoch = 1792108798000;
    for (let i = 1; i <= 5; i++) writer.record(START + i * 20_000, 'stream', encodePacket({ uid: UID, frameId: i, timestamp: (epoch += 17), flags: FLAG.EPOCH, matrix: [i] }));
    const file = readNhraw(writer.bytes());
    const open = new NhrawConverter(file.header, { serverTimeZone: '+00:00' });
    for (const record of file.records) open.push(record);
    const left = open.finish();
    const metaOf = (files: Map<string, string>) =>
      JSON.parse([...files.entries()].find(([path]) => path.endsWith('.meta.json'))![1]) as { recording: Record<string, unknown> };
    expect(metaOf(left.files).recording.stopped_at).toBeNull();
    const closed = new NhrawConverter(file.header, { serverTimeZone: '+00:00' });
    for (const record of file.records) closed.push(record);
    const result = closed.finish({ closeOpen: true });
    expect(metaOf(result.files).recording.stop_reason).toBe('server_stopped');
    expect(metaOf(result.files).recording.rows).toBe(5);
    expect(() => closed.push(file.records[0]!)).toThrow('nhraw_converter_finished');
  });
});

describe.skipIf(!hasPython)('.nhraw, differential', () => {
  it('a converted recording is byte-identical to the Desktop backend recording the same datagrams', () => {
    const both = build();
    const py = runPython<RunResult>('record', both.scenario.spec(), { outdir: tempDir(), tz: 'Asia/Tokyo' });
    const converted = convertRaw(both.raw.bytes(), { serverTimeZone: '+09:00' });
    expect(Object.keys(py.files).sort()).toEqual([...converted.files.keys()].sort());
    for (const [path, text] of Object.entries(py.files)) expect(converted.files.get(path), path).toBe(text);
  });
});
