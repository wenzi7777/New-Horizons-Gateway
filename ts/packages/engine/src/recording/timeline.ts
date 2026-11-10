// recording_timeline.py: a recording at a glance for the export page's
// preview -- the total pressure (sum of the P columns) as a min/max pair per
// time bucket, duration, rate, lost frames, pauses, restarts and where the
// app events fall. Same numbers as Python, and timelineJson() writes the
// same JSON the Desktop API returns (json.dumps(..., separators=(",", ":"))).
import { pyFloat as parseFloatPy, pyStrip } from '../../../core/src/py';
import { pyJsonDumps, PyFloat } from '../parse/pyJson';
import { pyRound, pyRoundInt } from '../parse/pyNumber';
import { csvParse } from './csv';

export const DEFAULT_BUCKETS = 240;
export const MAX_EVENTS = 200;
// Python's re \d is any Unicode decimal digit; IGNORECASE lets "p1" in.
// (ASCII digits only where the runtime lacks Unicode property escapes.)
const PRESSURE_COLUMN = (() => {
  try {
    return new RegExp('^P\\p{Nd}+$', 'iu');
  } catch {
    return /^P[0-9]+$/i;
  }
})();

export type TimelineEvent = { at_ms: number; label: string };

export type Timeline = {
  rows: number;
  skipped_lines: number;
  sensor_count: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  /** A float, or the int 0 when the recording has no duration. */
  rate_hz: number;
  median_interval_ms: number;
  lost_frames: number;
  restarts: number;
  gaps: number;
  series: 'total';
  /** A float, or the int 0 for an empty recording. */
  bucket_ms: number;
  buckets: ([number, number] | null)[];
  /** A float, or the int 0 for an empty recording. */
  max_value: number;
  events: TimelineEvent[];
  events_total: number;
};

/** float(text) as recording_timeline._number: null for unparsable, NaN or infinite. */
function number(text: string | null | undefined): number | null {
  let value: number;
  try {
    value = parseFloatPy(text ?? '');
  } catch {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

/**
 * sum() of floats as CPython 3.12+ computes it: the int start 0 plus the
 * first item, then Neumaier-compensated additions.
 */
export function pySumFloats(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0 + values[0]!;
  let compensation = 0.0;
  for (let i = 1; i < values.length; i++) {
    const x = values[i]!;
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) compensation += total - t + x;
    else compensation += x - t + total;
    total = t;
  }
  if (compensation && Number.isFinite(compensation)) total += compensation;
  return total;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) / 2]!;
  return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/** _event_offsets: up to MAX_EVENTS events as {at_ms, label}, and how many there are. */
function eventOffsets(eventsText: string | null, startMs: number): [TimelineEvent[], number] {
  if (eventsText === null) return [[], 0];
  const rows = csvParse(eventsText);
  if (!rows.length) return [[], 0];
  const fieldnames = rows[0]!;
  const markers: TimelineEvent[] = [];
  let total = 0;
  for (const cells of rows.slice(1)) {
    if (cells.length === 0) continue; // DictReader skips blank rows
    const row = new Map<string, string | null>();
    fieldnames.forEach((name, index) => row.set(name, index < cells.length ? cells[index]! : null));
    const timestamp = number(row.get('timestamp_ms') || '');
    // A pre-v0.25.1 sidecar's timestamps are device uptime: not on this timeline.
    if (timestamp === null || (row.get('time_ref') || '') === 'uptime') continue;
    total += 1;
    if (markers.length < MAX_EVENTS) {
      const label = [row.get('app'), row.get('event'), row.get('edge')].filter((part) => part).join(' · ');
      markers.push({ at_ms: pyRoundInt(timestamp - startMs), label });
    }
  }
  return [markers, total];
}

/** compute_timeline over a recording's sample CSV text (and its events CSV text, if any). */
export function computeTimeline(dataText: string, eventsText: string | null = null, buckets = DEFAULT_BUCKETS): Timeline {
  const times: number[] = [];
  const totals: number[] = [];
  let lostFrames = 0;
  let restarts = 0;
  let skipped = 0;
  const rows = csvParse(dataText);
  const header = rows[0] ?? [];
  const columns = header.map((cell) => pyStrip(cell));
  const timeColumn = columns.includes('timestamp_ms') ? columns.indexOf('timestamp_ms') : 0;
  const pressure = columns.flatMap((name, index) => (PRESSURE_COLUMN.test(name) ? [index] : []));
  const sensorCount = pressure.length;
  const contiguous = pressure.length > 0 && pressure.every((value, i) => value === pressure[0]! + i);
  const seqColumn = columns.includes('frame_seq') ? columns.indexOf('frame_seq') : -1;
  let previousSeq: number | null = null;
  for (const row of rows.slice(1)) {
    if (row.length < columns.length) {
      skipped += 1;
      continue;
    }
    const timestamp = number(row[timeColumn]);
    if (timestamp === null) {
      skipped += 1;
      continue;
    }
    let total: number;
    try {
      const cells = contiguous
        ? row.slice(pressure[0]!, pressure[pressure.length - 1]! + 1)
        : pressure.map((index) => row[index]!);
      total = cells.length ? pySumFloats(cells.map((cell) => parseFloatPy(cell))) : 0.0;
    } catch {
      skipped += 1;
      continue;
    }
    times.push(timestamp);
    totals.push(total);
    if (seqColumn >= 0) {
      const seq = number(row[seqColumn]);
      if (seq !== null && previousSeq !== null) {
        if (seq < previousSeq) restarts += 1;
        else if (seq - previousSeq > 1) lostFrames += Math.trunc(seq - previousSeq - 1);
      }
      previousSeq = seq !== null ? seq : previousSeq;
    }
  }

  const count = times.length;
  const start = count ? times[0]! : 0.0;
  const end = count ? times[count - 1]! : 0.0;
  const duration = Math.max(0.0, end - start);
  const steps: number[] = [];
  for (let i = 1; i < count; i++) steps.push(times[i]! - times[i - 1]!);
  const typical = steps.length ? median(steps) : 0.0;
  const gapThreshold = Math.max(100.0, typical * 5);
  const gaps = steps.filter((step) => step > gapThreshold).length;

  const bucketCount = Math.max(1, Math.min(buckets, count || 1));
  const envelope: ([number, number] | null)[] = new Array(bucketCount).fill(null);
  const span = duration || 1.0;
  for (let i = 0; i < count; i++) {
    const index = Math.min(bucketCount - 1, Math.max(0, Math.trunc(((times[i]! - start) / span) * bucketCount)));
    const bucket = envelope[index];
    const total = totals[i]!;
    if (!bucket) envelope[index] = [total, total];
    else {
      if (total < bucket[0]) bucket[0] = total;
      if (total > bucket[1]) bucket[1] = total;
    }
  }
  let maxTotal = totals.length ? totals[0]! : 0;
  for (const total of totals) if (total > maxTotal) maxTotal = total;

  const [events, eventsTotal] = count ? eventOffsets(eventsText, start) : [[], 0];
  return {
    rows: count,
    skipped_lines: skipped,
    sensor_count: sensorCount,
    start_ms: pyRoundInt(start),
    end_ms: pyRoundInt(end),
    duration_ms: pyRoundInt(duration),
    rate_hz: duration > 0 ? pyRound(((count - 1) * 1000) / duration, 2) : 0,
    median_interval_ms: pyRound(typical, 2),
    lost_frames: lostFrames,
    restarts,
    gaps,
    series: 'total',
    bucket_ms: count ? duration / bucketCount : 0,
    buckets: envelope.map((pair) => (pair ? [pyRound(pair[0], 3), pyRound(pair[1], 3)] : null)),
    max_value: totals.length ? pyRound(maxTotal, 3) : 0,
    events,
    events_total: eventsTotal,
  };
}

/** The timeline with Python's int/float types restored, for pyJsonDumps. */
export function timelineToPy(timeline: Timeline): Record<string, unknown> {
  const f = (value: number) => new PyFloat(value);
  return {
    ...timeline,
    rate_hz: timeline.duration_ms > 0 || timeline.rate_hz !== 0 ? f(timeline.rate_hz) : 0,
    median_interval_ms: f(timeline.median_interval_ms),
    bucket_ms: timeline.rows ? f(timeline.bucket_ms) : 0,
    buckets: timeline.buckets.map((pair) => (pair ? [f(pair[0]), f(pair[1])] : null)),
    max_value: timeline.rows ? f(timeline.max_value) : 0,
  };
}

/** json.dumps(timeline, separators=(",", ":")): the body the Desktop API serves (without path/name). */
export function timelineJson(timeline: Timeline): string {
  return pyJsonDumps(timelineToPy(timeline), { separators: [',', ':'] });
}
