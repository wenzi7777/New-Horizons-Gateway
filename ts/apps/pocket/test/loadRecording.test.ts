import { describe, expect, it } from 'vitest';

import { loadRecordingForAnalysis } from '../src/ui/analysis/loadRecording';

const csv = ['timestamp_ms,frame_seq,P1,P2,P3,P4', ...Array.from({ length: 50 }, (_, i) => `${1_700_000_000_000 + i * 20},${i},${300 + i},${400},${500},${600 + (i % 7)}`)].join('\r\n') + '\r\n';
const events = 'seq,frame_seq,timestamp_ms,app,event,edge,value,time_ref\r\n1,10,1700000000200,app,按下,rise,1,0\r\n';
const meta = { format: 1, sensors: { count: 4, rows: 2, cols: 2 }, device: { hardware_model: 'TIA-CTL v2.0.F 2026.10' } };

function fakeStore(files: { data: string; events: string }, slice = 37) {
  const bytes = { data: new TextEncoder().encode(files.data), events: new TextEncoder().encode(files.events) };
  let reads = 0;
  return {
    reads: () => reads,
    store: {
      recordingAnalysisInfo: async () => ({ dataBytes: bytes.data.length, eventsBytes: bytes.events.length, meta }),
      readRecordingChunk: async (_id: string, file: 'data' | 'events', offset: number, length: number) => {
        reads += 1;
        const all = bytes[file];
        const data = all.slice(offset, offset + Math.min(length, slice));
        return { data, nextOffset: offset + data.length, done: offset + data.length >= all.length, totalBytes: all.length };
      },
    },
  };
}

describe('loadRecordingForAnalysis', () => {
  it('parses a CSV read in odd slices, with its events and meta', async () => {
    const { store, reads } = fakeStore({ data: csv, events });
    const progress: number[] = [];
    const loaded = await loadRecordingForAnalysis(store, 'U/20260101/010101', 'x', (f) => progress.push(f));
    expect(loaded!.recording.rowCount).toBe(50);
    expect(loaded!.recording.sensorCount).toBe(4);
    expect(loaded!.events).toHaveLength(1);
    expect(loaded!.events[0]!.event).toBe('按下'); // multi-byte text survives slice boundaries
    expect(loaded!.meta?.device.hardwareModel).toBe('TIA-CTL v2.0.F 2026.10');
    expect(reads()).toBeGreaterThan(10);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('works without an events file and stops when cancelled', async () => {
    const plain = await loadRecordingForAnalysis(fakeStore({ data: csv, events: '' }).store, 'id', 'x', () => undefined);
    expect(plain!.events).toEqual([]);
    let calls = 0;
    const cancelled = await loadRecordingForAnalysis(fakeStore({ data: csv, events }).store, 'id', 'x', () => undefined, () => ++calls > 3);
    expect(cancelled).toBeNull();
  });

  it('fails for a recording with no data file', async () => {
    await expect(loadRecordingForAnalysis({ recordingAnalysisInfo: async () => ({ dataBytes: 0, eventsBytes: 0, meta: null }), readRecordingChunk: async () => ({ data: new Uint8Array(0), nextOffset: 0, done: true, totalBytes: 0 }) }, 'id', 'x', () => undefined)).rejects.toThrow('recording_not_found');
  });
});
