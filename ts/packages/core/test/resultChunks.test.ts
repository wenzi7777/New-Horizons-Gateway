import { describe, expect, it } from 'vitest';

import { ResultChunkReassembler } from '../src/resultChunks';

function splitResult(response: string, chunkRaw: number, requestId: string, deviceUid: string) {
  const total = Math.ceil(response.length / chunkRaw);
  return Array.from({ length: total }, (_, i) => ({
    type: 'result_chunk',
    device_uid: deviceUid,
    request_id: requestId,
    chunk: i,
    chunks: total,
    data: response.slice(i * chunkRaw, (i + 1) * chunkRaw),
  }));
}

function make(start = 0) {
  const clock = { ms: start };
  return { clock, reasm: new ResultChunkReassembler({ ttlMs: 10_000, nowMs: () => clock.ms }) };
}

describe('ResultChunkReassembler', () => {
  it('reassembles in-order chunks into a full result frame', () => {
    const { reasm } = make();
    const response = JSON.stringify({ ok: true, cmd: 'status', data: { matrix_shape: { rows: 3, cols: 3 }, x: 'y'.repeat(500) } });
    const frames = splitResult(response, 120, 'req-1', '3CDC7545CCD0');
    expect(frames.length).toBeGreaterThan(1);
    let result = null;
    for (const frame of frames) result = reasm.add(frame);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('result');
    expect(result!.device_uid).toBe('3CDC7545CCD0');
    expect(result!.request_id).toBe('req-1');
    expect(result!.payload.cmd).toBe('status');
    expect((result!.payload.data as Record<string, unknown>).matrix_shape).toEqual({ rows: 3, cols: 3 });
  });

  it('returns null until all chunks are received', () => {
    const { reasm } = make();
    const frames = splitResult(JSON.stringify({ ok: true, data: 'z'.repeat(400) }), 100, 'req-2', 'DEV');
    for (const frame of frames.slice(0, -1)) expect(reasm.add(frame)).toBeNull();
    expect(reasm.add(frames[frames.length - 1]!)).not.toBeNull();
  });

  it('reassembles out-of-order chunks', () => {
    const { reasm } = make();
    const response = JSON.stringify({ ok: true, data: 'abc'.repeat(300) });
    let result = null;
    for (const frame of splitResult(response, 90, 'req-3', 'DEV').reverse()) result = reasm.add(frame);
    expect(JSON.stringify(result!.payload)).toBe(response);
  });

  it('returns null for invalid or non-object JSON', () => {
    const { reasm } = make();
    expect(reasm.add({ type: 'result_chunk', device_uid: 'DEV', request_id: 'req-4', chunk: 0, chunks: 1, data: '{not json' })).toBeNull();
    expect(reasm.add({ request_id: 'req-4b', chunk: 0, chunks: 1, data: '[1,2]' })).toBeNull();
    expect(reasm.pendingCount()).toBe(0);
  });

  it('purges expired partial buffers', () => {
    const { clock, reasm } = make();
    const frames = splitResult(JSON.stringify({ ok: true, data: 'q'.repeat(300) }), 80, 'req-5', 'DEV');
    reasm.add(frames[0]!);
    expect(reasm.pendingCount()).toBe(1);
    clock.ms = 11_000;
    reasm.purge();
    expect(reasm.pendingCount()).toBe(0);
    expect(reasm.add(frames[1]!)).toBeNull();
  });

  it('keeps a buffer that is still within the TTL, refreshed by each chunk', () => {
    const { clock, reasm } = make();
    const frames = splitResult(JSON.stringify({ ok: true, data: 'q'.repeat(300) }), 80, 'req-5b', 'DEV');
    let result = null;
    for (const frame of frames) {
      clock.ms += 9_000;
      result = reasm.add(frame);
    }
    expect(result).not.toBeNull();
  });

  it('rejects a missing request_id or bad fields', () => {
    const { reasm } = make();
    expect(reasm.add({ type: 'result_chunk', chunk: 0, chunks: 1, data: 'x' })).toBeNull();
    expect(reasm.add({ type: 'result_chunk', request_id: 'r', chunk: 0, chunks: 0, data: 'x' })).toBeNull();
    expect(reasm.add({ request_id: 'r', chunk: 1, chunks: 1, data: 'x' })).toBeNull();
    expect(reasm.add({ request_id: 'r', chunk: -1, chunks: 2, data: 'x' })).toBeNull();
    expect(reasm.add({ request_id: 'r', chunk: 'abc', chunks: 2, data: 'x' })).toBeNull();
    expect(reasm.add({ request_id: 'r', chunk: null, chunks: 2, data: 'x' })).toBeNull();
    expect(reasm.add({ request_id: 'r', chunk: 0, chunks: 2, data: 5 })).toBeNull();
    expect(reasm.pendingCount()).toBe(0);
  });

  it('coerces fields like Python int()/str()', () => {
    const { reasm } = make();
    // int("0"), int(1.9) == 1, str(42) == "42"
    expect(reasm.add({ request_id: 42, chunk: '0', chunks: 2.9, data: '{"a":' })).toBeNull();
    const result = reasm.add({ request_id: 42, chunk: 1.9, chunks: '2', data: '1}' });
    expect(result).toEqual({ type: 'result', device_uid: '', request_id: '42', payload: { a: 1 } });
  });

  it('restarts a request whose chunk count changed', () => {
    const { reasm } = make();
    reasm.add({ request_id: 'r', device_uid: 'OLD', chunk: 0, chunks: 3, data: 'stale' });
    expect(reasm.add({ request_id: 'r', chunk: 0, chunks: 2, data: '{"b":' })).toBeNull();
    const result = reasm.add({ request_id: 'r', chunk: 1, chunks: 2, data: '2}' });
    // The restarted buffer took this frame's (empty) device_uid, not the old one.
    expect(result).toEqual({ type: 'result', device_uid: '', request_id: 'r', payload: { b: 2 } });
  });

  it('keeps the last non-empty device_uid', () => {
    const { reasm } = make();
    reasm.add({ request_id: 'r', device_uid: 'A', chunk: 0, chunks: 2, data: '{"c":' });
    expect(reasm.add({ request_id: 'r', chunk: 1, chunks: 2, data: '3}' })!.device_uid).toBe('A');
  });

  it('never uses a TTL below one second', () => {
    const clock = { ms: 0 };
    const reasm = new ResultChunkReassembler({ ttlMs: 10, nowMs: () => clock.ms });
    reasm.add({ request_id: 'r', chunk: 0, chunks: 2, data: '{' });
    clock.ms = 900;
    reasm.purge();
    expect(reasm.pendingCount()).toBe(1);
    clock.ms = 1001;
    reasm.purge();
    expect(reasm.pendingCount()).toBe(0);
  });
});
