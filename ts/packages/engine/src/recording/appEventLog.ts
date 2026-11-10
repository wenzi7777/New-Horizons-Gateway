// app_event_log.py: app events in the `.events.csv` beside the samples,
// each stamped with its frame's time from the sample CSV (FrameClock), so
// the two files share one time base and join on frame_seq.
import { isDict, PyFloat, pyIntOf, pyStrOr, pyTruthyOf } from '../parse/pyJson';
import { pyRoundInt, pyTrueDivInt } from '../parse/pyNumber';
import { csvRow } from './csv';
import { siblingPaths } from './paths';
import { dirname, type RecordingFileSink } from './sink';

/** timestamp_ms used to be device boot time; uptime_ms and time_ref were appended. */
export const EVENT_COLUMNS = ['seq', 'frame_seq', 'timestamp_ms', 'app', 'event', 'edge', 'value', 'uptime_ms', 'time_ref'] as const;

export type TimeRef = 'device' | 'received' | 'estimated' | 'uptime';

/** When each recorded frame was sampled, for one recording (bounded). */
export class FrameClock {
  private readonly times = new Map<number, [number, string]>();
  /** The recording's first frame (0 before any). */
  first = 0;
  /** The newest frame recorded so far. */
  last = 0;

  constructor(private readonly capacity = 8192) {}

  record(frameSeq: number, timestampMs: number, timeRef: string): void {
    if (frameSeq <= 0) return;
    if (this.last && frameSeq < this.last) {
      // The device restarted and counts frames from 1 again.
      this.times.clear();
      this.first = 0;
      this.last = 0;
    }
    if (!this.first) this.first = frameSeq;
    this.times.set(frameSeq, [Math.trunc(timestampMs), timeRef]);
    this.last = Math.max(this.last, frameSeq);
    while (this.times.size > this.capacity) {
      const oldest = this.times.keys().next().value as number;
      this.times.delete(oldest);
    }
  }

  /** [timestamp_ms, time_ref] of a frame: exact when recorded, else estimated. Null before any frame. */
  timeOf(frameSeq: number): [number, string] | null {
    if (this.times.size === 0) return null;
    const exact = this.times.get(frameSeq);
    if (exact !== undefined) return exact;
    const frames = [...this.times.keys()]; // ascending: recorded in frame order
    if (frameSeq <= 0) return [this.times.get(frames[frames.length - 1]!)![0], 'estimated'];
    const index = bisectLeft(frames, frameSeq);
    let lo: number;
    let hi: number;
    if (index > 0 && index < frames.length) {
      lo = frames[index - 1]!;
      hi = frames[index]!;
    } else if (frames.length >= 2) {
      [lo, hi] = index === 0 ? [frames[0]!, frames[1]!] : [frames[frames.length - 2]!, frames[frames.length - 1]!];
    } else {
      return [this.times.get(frames[0]!)![0], 'estimated'];
    }
    const tLo = this.times.get(lo)![0];
    const tHi = this.times.get(hi)![0];
    // round(t_lo + (t_hi - t_lo) * (frame_seq - lo) / (hi - lo)): an exact
    // int product, one correctly rounded true division, a float add.
    const product = BigInt(tHi - tLo) * BigInt(frameSeq - lo);
    const fraction = pyTrueDivInt(product, BigInt(hi - lo));
    return [pyRoundInt(tLo + fraction), 'estimated'];
  }
}

function bisectLeft(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** An app event as it reaches the writer (stream TLV or app_events reply). */
export type AppEventInput = Record<string, unknown>;

/** event_row: one EVENT_COLUMNS row as csv text, or null when the event is unusable. */
export function eventRow(event: unknown, clock: FrameClock | null = null): string | null {
  if (!isDict(event)) return null;
  let seq: number;
  let frameSeq: number;
  let uptimeMs: number;
  try {
    seq = pyIntOf(pyTruthyOf(event.seq) ? event.seq : 0);
    frameSeq = pyIntOf(pyTruthyOf(event.frame_seq) ? event.frame_seq : 0);
    uptimeMs = pyIntOf(pyTruthyOf(event.ms) ? event.ms : 0);
  } catch {
    return null;
  }
  const value = event.value;
  const stamped = clock !== null ? clock.timeOf(frameSeq) : null;
  const [timestampMs, timeRef] = stamped ?? [uptimeMs, 'uptime'];
  return csvRow([
    seq,
    frameSeq,
    timestampMs,
    pyStrOr(event.app),
    pyStrOr(event.event),
    pyStrOr(event.detail),
    value === null || value === undefined ? '' : value,
    uptimeMs,
    timeRef,
  ]);
}

/** The events file for a sample file (either layout). */
export function sidecarPathFor(samplePath: string): string {
  return siblingPaths(samplePath).events;
}

/** append_events: appends to the sidecar, header first when it is new. Returns rows written. Throws on a sink failure. */
export function appendEvents(sink: RecordingFileSink, samplePath: string, events: Iterable<unknown>, clock: FrameClock | null = null): number {
  const rows: string[] = [];
  for (const event of events) {
    const row = eventRow(event, clock);
    if (row !== null) rows.push(row);
  }
  if (rows.length === 0) return 0;
  const target = sidecarPathFor(samplePath);
  sink.mkdirp(dirname(target));
  const isNew = !sink.exists(target);
  const handle = sink.open(target);
  try {
    if (isNew) handle.append(csvRow([...EVENT_COLUMNS]));
    handle.append(rows.join(''));
  } finally {
    handle.close();
  }
  return rows.length;
}

/** events_lost_since: events that fell out of the device's ring between two reads (by seq gap). */
export function eventsLostSince(previousSeq: number, deviceSeq: number, events: unknown[]): number {
  if (previousSeq <= 0) return 0;
  const seqs: number[] = [];
  for (const event of events) {
    if (!isDict(event)) continue;
    try {
      seqs.push(pyIntOf(pyTruthyOf(event.seq) ? event.seq : 0));
    } catch {
      continue;
    }
  }
  const newer = seqs.filter((seq) => seq > previousSeq);
  const oldest = newer.length ? Math.min(...newer) : deviceSeq + 1;
  return Math.max(0, oldest - previousSeq - 1);
}

/** append_dropped_marker: records that `dropped` events were lost before anyone read them. */
export function appendDroppedMarker(sink: RecordingFileSink, samplePath: string, seq: number, dropped: number, clock: FrameClock | null = null): void {
  if (dropped <= 0) return;
  appendEvents(sink, samplePath, [{ seq, frame_seq: 0, ms: 0, app: '', event: 'events_dropped', detail: String(dropped) }], clock);
}

/** An app event's value as Python holds it: round(float32, 3), a float. */
export function eventValueToPy(event: { value?: number }): Record<string, unknown> {
  return event.value !== undefined ? { ...event, value: new PyFloat(event.value) } : { ...event };
}
