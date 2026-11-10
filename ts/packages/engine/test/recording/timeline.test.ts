import { describe, expect, it } from 'vitest';
import { computeTimeline, timelineJson } from '../../src/recording/timeline';
import { hasPython, rng, runPython, tempDir } from './pyHarness';

const HEADER = 'timestamp_ms,P1,P2,P3,Acc_x,frame_seq,time_ref';
const EVENTS_HEADER = 'seq,frame_seq,timestamp_ms,app,event,edge,value,uptime_ms,time_ref';

describe('timeline', () => {
  it('duration, rate and the total pressure envelope', () => {
    const rows = Array.from({ length: 11 }, (_, i) => `${1000 + i * 20},${i},1,0,0.1,${i + 1},device`);
    const t = computeTimeline([HEADER, ...rows].join('\n') + '\n', null, 2);
    expect(t.rows).toBe(11);
    expect(t.sensor_count).toBe(3);
    expect(t.duration_ms).toBe(200);
    expect(t.rate_hz).toBe(50);
    expect(t.buckets).toEqual([
      [1, 5],
      [6, 11],
    ]);
    expect(t.max_value).toBe(11);
  });
  it('lost frames, pauses and restarts', () => {
    const rows = ['1000,0,0,0,0,1,device', '1017,0,0,0,0,2,device', '1067,0,0,0,0,5,device', '1084,0,0,0,0,6,device', '3084,0,0,0,0,7,device', '3101,0,0,0,0,1,device'];
    const t = computeTimeline([HEADER, ...rows].join('\n'));
    expect([t.lost_frames, t.gaps, t.restarts]).toEqual([2, 1, 1]);
  });
});

function cases() {
  const random = rng(3);
  const out: { data: string; events: string | null; buckets?: number }[] = [];
  for (let k = 0; k < 40; k++) {
    const sensors = 1 + Math.floor(random() * 20);
    const n = Math.floor(random() * 600);
    const header = ['timestamp_ms', ...Array.from({ length: sensors }, (_, i) => `P${i + 1}`), 'Mag_x', 'frame_seq', 'time_ref'];
    const lines = [header.join(',')];
    let t = 1792056866000 + Math.floor(random() * 1e6);
    let seq = 1;
    for (let i = 0; i < n; i++) {
      t += random() < 0.02 ? 500 + Math.floor(random() * 3000) : 15 + Math.floor(random() * 3);
      seq += random() < 0.05 ? 2 + Math.floor(random() * 4) : random() < 0.005 ? -seq + 1 : 1;
      const cells = Array.from({ length: sensors }, () => String(Math.fround((random() - 0.3) * 10 ** (Math.floor(random() * 6) - 2))));
      let line = [String(t), ...cells, '0', String(seq), 'device'].join(',');
      if (random() < 0.01) line = line.split(',').slice(0, 3).join(',');
      if (random() < 0.01) line = line.replace(/^\d+/, 'x');
      if (random() < 0.005) line = '';
      lines.push(line);
    }
    const eventLines = [EVENTS_HEADER];
    for (let i = 0; i < Math.floor(random() * 260); i++) {
      const ts = 1792056866000 + Math.floor(random() * 2e6);
      eventLines.push(`${i},${i},${random() < 0.1 ? '' : ts},app${i % 3},ev,${random() < 0.3 ? '' : 'rise'},,${i},${random() < 0.1 ? 'uptime' : 'device'}`);
    }
    out.push({ data: lines.join(random() < 0.5 ? '\r\n' : '\n') + '\r\n', events: random() < 0.7 ? eventLines.join('\r\n') + '\r\n' : null, buckets: random() < 0.3 ? 10 : 240 });
  }
  out.push({ data: '', events: null }, { data: HEADER + '\n', events: null }, { data: `${HEADER}\n1000,1,2,3,0,1,device\n`, events: `${EVENTS_HEADER}\n1,1,1000,a,b,c,0.5,1,device\n` });
  out.push({ data: 'P1,p2,P٣,timestamp_ms\n1,2,3,10\n4,5,6,20\n', events: null });
  out.push({ data: `${HEADER}\n1000,1e308,1e308,-1e308,0,1,device\n1010,nan,0,0,0,2,device\n1020,inf,0,0,0,3,device\n1030, 1_0 ,0,0,0,4,device\n`, events: null });
  return out;
}

describe.skipIf(!hasPython)('compute_timeline, differential', () => {
  it('gives the same JSON as the Desktop API', () => {
    const all = cases();
    const py = runPython<string[]>('timeline', { cases: all }, { outdir: tempDir() });
    const ts = all.map((c) => timelineJson(computeTimeline(c.data, c.events, c.buckets)));
    const mismatches = ts.flatMap((text, i) => (text === py[i] ? [] : [{ i, ts: text, py: py[i] }]));
    expect(mismatches).toEqual([]);
  });
});
