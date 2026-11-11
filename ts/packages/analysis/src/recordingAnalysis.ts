// Reading a recorded session (the server's `<HHMMSS>.csv` and its
// `.events.csv` sidecar) back for the Tools > Data Analysis page.
//
// Pure functions over typed arrays, so they run in the parsing worker and in
// the node tests alike. Row order is the file's order: the backend appends
// frames as they arrive, so `timestamp_ms` only goes backwards when the
// device's clock was replaced mid-recording (counted, never reordered).

export const IMU_GROUPS = {
  acc: ["Acc_x", "Acc_y", "Acc_z"],
  gyro: ["Gyro_x", "Gyro_y", "Gyro_z"],
  mag: ["Mag_x", "Mag_y", "Mag_z"],
} as const;

export type ImuGroup = keyof typeof IMU_GROUPS;

// time_ref values the backend writes (service._csv_time_ref()).
export const TIME_REF_DEVICE = 0;
export const TIME_REF_RECEIVED = 1;
export const TIME_REF_OTHER = 2;

export type Recording = {
  name: string;
  columns: string[];
  rowCount: number;
  sensorNames: string[];
  sensorCount: number;
  /** timestamp_ms of each row: Unix epoch milliseconds. */
  time: Float64Array;
  /** The device's frame.seq, or null for files from before Desktop v0.25. */
  frameSeq: Float64Array | null;
  timeRef: Uint8Array | null;
  /** Row-major: row r, sensor s is pressure[r * sensorCount + s]. */
  pressure: Float32Array;
  imu: Partial<Record<string, Float32Array>>;
  /** Per row: the sum of all sensors, the highest one, and how many are above
   * activeThreshold (the contact area, in cells). */
  total: Float32Array;
  peak: Float32Array;
  active: Uint16Array;
  maxValue: number;
  activeThreshold: number;
  /** The file line (0 = header) each row came from, for exporting a range. */
  lineOfRow: Uint32Array;
  skippedLines: number;
};

/** Every typed array a Recording holds, to transfer it out of the worker. */
export function recordingBuffers(rec: Recording): ArrayBuffer[] {
  const arrays: (ArrayBufferView | null)[] = [
    rec.time, rec.frameSeq, rec.timeRef, rec.pressure, rec.total, rec.peak, rec.active, rec.lineOfRow,
    ...Object.values(rec.imu).map((values) => values ?? null),
  ];
  return arrays.filter((item): item is ArrayBufferView => item !== null).map((item) => item.buffer as ArrayBuffer);
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.endsWith("\r")) lines[index] = line.slice(0, -1);
  }
  return lines;
}

/** A cell counts as touched above this: 2 % of the recording's peak, so ADC
 * noise around zero is not contact. */
export function activeThresholdFor(maxValue: number): number {
  return Math.max(1, maxValue * 0.02);
}

/**
 * Parses a recording CSV incrementally: feed() takes text in any pieces
 * (a streamed file's chunks; a line may straddle two), finish() returns the
 * Recording. Arrays grow by doubling, so an hour of CSV never has to sit in
 * memory as one string.
 */
export class RecordingCsvBuilder {
  private columns: string[] | null = null;
  private pending = "";
  private line = 0;
  private timeColumn = 0;
  private sensorColumns: number[] = [];
  private imuColumns: [string, number][] = [];
  private seqColumn = -1;
  private refColumn = -1;
  private capacity = 0;
  private rows = 0;
  private skipped = 0;
  private maxValue = 0;
  private time = new Float64Array(0);
  private frameSeq: Float64Array | null = null;
  private timeRef: Uint8Array | null = null;
  private pressure = new Float32Array(0);
  private imuValues: Float32Array[] = [];
  private lineOfRow = new Uint32Array(0);
  private started = false;

  constructor(private readonly name = "") {}

  feed(text: string): void {
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    const joined = this.pending + text;
    let start = 0;
    for (;;) {
      const end = joined.indexOf("\n", start);
      if (end < 0) break;
      this.takeLine(joined.slice(start, end));
      start = end + 1;
    }
    this.pending = joined.slice(start);
  }

  private takeLine(raw: string): void {
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    const lineNo = this.line;
    this.line += 1;
    if (this.columns === null) {
      this.header(raw);
      return;
    }
    if (!raw) return;
    const columns = this.columns;
    const cells = raw.split(",");
    const timestamp = Number(cells[this.timeColumn]);
    if (cells.length < columns.length || !Number.isFinite(timestamp)) {
      this.skipped += 1;
      return;
    }
    if (this.rows >= this.capacity) this.grow(Math.max(1024, this.capacity * 2));
    const row = this.rows;
    this.time[row] = timestamp;
    const sensorCount = this.sensorColumns.length;
    const base = row * sensorCount;
    for (let sensor = 0; sensor < sensorCount; sensor += 1) {
      const value = Number(cells[this.sensorColumns[sensor]!]);
      const clean = Number.isFinite(value) ? value : 0;
      this.pressure[base + sensor] = clean;
      if (clean > this.maxValue) this.maxValue = clean;
    }
    for (let channel = 0; channel < this.imuColumns.length; channel += 1) {
      const value = Number(cells[this.imuColumns[channel]![1]]);
      this.imuValues[channel]![row] = Number.isFinite(value) ? value : 0;
    }
    if (this.frameSeq) this.frameSeq[row] = Number(cells[this.seqColumn]) || 0;
    if (this.timeRef) {
      const ref = cells[this.refColumn];
      this.timeRef[row] = ref === "device" ? TIME_REF_DEVICE : ref === "received" ? TIME_REF_RECEIVED : TIME_REF_OTHER;
    }
    this.lineOfRow[row] = lineNo;
    this.rows += 1;
  }

  private header(raw: string): void {
    const columns = raw.split(",").map((cell) => cell.trim());
    this.columns = columns;
    this.timeColumn = Math.max(0, columns.indexOf("timestamp_ms"));
    columns.forEach((column, index) => {
      if (/^P\d+$/.test(column)) this.sensorColumns.push(index);
    });
    for (const group of Object.values(IMU_GROUPS)) {
      for (const column of group) {
        const index = columns.indexOf(column);
        if (index >= 0) this.imuColumns.push([column, index]);
      }
    }
    this.seqColumn = columns.indexOf("frame_seq");
    this.refColumn = columns.indexOf("time_ref");
    if (this.seqColumn >= 0) this.frameSeq = new Float64Array(0);
    if (this.refColumn >= 0) this.timeRef = new Uint8Array(0);
    this.imuValues = this.imuColumns.map(() => new Float32Array(0));
  }

  private grow(capacity: number): void {
    const sensorCount = this.sensorColumns.length;
    const f64 = (old: Float64Array) => { const n = new Float64Array(capacity); n.set(old); return n; };
    const f32 = (old: Float32Array, k = 1) => { const n = new Float32Array(capacity * k); n.set(old); return n; };
    this.time = f64(this.time);
    if (this.frameSeq) this.frameSeq = f64(this.frameSeq);
    if (this.timeRef) { const n = new Uint8Array(capacity); n.set(this.timeRef); this.timeRef = n; }
    this.pressure = f32(this.pressure, sensorCount);
    this.imuValues = this.imuValues.map((values) => f32(values));
    const lines = new Uint32Array(capacity); lines.set(this.lineOfRow); this.lineOfRow = lines;
    this.capacity = capacity;
  }

  /** Rows parsed so far (for progress). */
  get rowCount(): number {
    return this.rows;
  }

  finish(): Recording {
    if (this.pending) {
      const last = this.pending;
      this.pending = "";
      this.takeLine(last);
    }
    const columns = this.columns ?? [""];
    const rows = this.rows;
    const sensorCount = this.sensorColumns.length;
    const pressure = this.pressure.slice(0, rows * sensorCount);
    const activeThreshold = activeThresholdFor(this.maxValue);
    const total = new Float32Array(rows);
    const peak = new Float32Array(rows);
    const active = new Uint16Array(rows);
    for (let row = 0; row < rows; row += 1) {
      let sum = 0;
      let high = 0;
      let touched = 0;
      const base = row * sensorCount;
      for (let sensor = 0; sensor < sensorCount; sensor += 1) {
        const value = pressure[base + sensor]!;
        sum += value;
        if (value > high) high = value;
        if (value > activeThreshold) touched += 1;
      }
      total[row] = sum;
      peak[row] = high;
      active[row] = touched;
    }
    const imu: Partial<Record<string, Float32Array>> = {};
    this.imuColumns.forEach(([column], index) => {
      // An all-zero channel is a board without that sensor, not a reading.
      const values = this.imuValues[index]!.slice(0, rows);
      if (values.some((value) => value !== 0)) imu[column] = values;
    });
    return {
      name: this.name,
      columns,
      rowCount: rows,
      sensorNames: this.sensorColumns.map((index) => columns[index]!),
      sensorCount,
      time: this.time.slice(0, rows),
      frameSeq: this.frameSeq ? this.frameSeq.slice(0, rows) : null,
      timeRef: this.timeRef ? this.timeRef.slice(0, rows) : null,
      pressure,
      imu,
      total,
      peak,
      active,
      maxValue: this.maxValue,
      activeThreshold,
      lineOfRow: this.lineOfRow.slice(0, rows),
      skippedLines: this.skipped,
    };
  }
}

export function parseRecordingCsv(text: string, name = ""): Recording {
  const builder = new RecordingCsvBuilder(name);
  builder.feed(text);
  return builder.finish();
}

export function sensorValue(rec: Recording, row: number, sensor: number): number {
  return rec.pressure[row * rec.sensorCount + sensor] ?? 0;
}

// ── Sampling quality ────────────────────────────────────────────────────

export type RecordingIssue = {
  /** The row after the gap. */
  index: number;
  kind: "time_gap" | "lost_frames" | "restart" | "time_backwards";
  /** For time_gap / time_backwards: the step in ms; lost_frames: how many. */
  amount: number;
};

export type RecordingAnalysisSummary = {
  startMs: number;
  endMs: number;
  durationMs: number;
  rowCount: number;
  rateHz: number;
  intervalMs: { median: number; p95: number; p99: number; max: number };
  lostFrames: number;
  restarts: number;
  timeGaps: number;
  backwardsSteps: number;
  issues: RecordingIssue[];
  timeRefCounts: { device: number; received: number; other: number };
};

function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const position = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[position]!;
}

/** Steps between consecutive rows, in ms (length rowCount - 1). */
export function sampleIntervals(rec: Recording): Float64Array {
  const steps = new Float64Array(Math.max(0, rec.rowCount - 1));
  for (let row = 1; row < rec.rowCount; row += 1) steps[row - 1] = rec.time[row]! - rec.time[row - 1]!;
  return steps;
}

/** A pause this long in the timestamps is a gap rather than jitter. */
export function gapThresholdMs(medianIntervalMs: number): number {
  return Math.max(100, medianIntervalMs * 5);
}

export const MAX_LISTED_ISSUES = 500;

export function summarizeRecording(rec: Recording): RecordingAnalysisSummary {
  const steps = sampleIntervals(rec);
  const sorted = Float64Array.from(steps).sort();
  const median = quantile(sorted, 0.5);
  const threshold = gapThresholdMs(median);
  const issues: RecordingIssue[] = [];
  let lostFrames = 0;
  let restarts = 0;
  let timeGaps = 0;
  let backwardsSteps = 0;
  const push = (issue: RecordingIssue) => {
    if (issues.length < MAX_LISTED_ISSUES) issues.push(issue);
  };

  for (let row = 1; row < rec.rowCount; row += 1) {
    const step = steps[row - 1]!;
    if (step < 0) {
      backwardsSteps += 1;
      push({ index: row, kind: "time_backwards", amount: step });
    } else if (step > threshold) {
      timeGaps += 1;
      push({ index: row, kind: "time_gap", amount: step });
    }
    if (rec.frameSeq) {
      const jump = rec.frameSeq[row]! - rec.frameSeq[row - 1]!;
      if (jump < 0) {
        restarts += 1;
        push({ index: row, kind: "restart", amount: 0 });
      } else if (jump > 1) {
        lostFrames += jump - 1;
        push({ index: row, kind: "lost_frames", amount: jump - 1 });
      }
    }
  }

  const timeRefCounts = { device: 0, received: 0, other: 0 };
  if (rec.timeRef) {
    for (const ref of rec.timeRef) {
      if (ref === TIME_REF_DEVICE) timeRefCounts.device += 1;
      else if (ref === TIME_REF_RECEIVED) timeRefCounts.received += 1;
      else timeRefCounts.other += 1;
    }
  }

  const startMs = rec.rowCount ? rec.time[0]! : 0;
  const endMs = rec.rowCount ? rec.time[rec.rowCount - 1]! : 0;
  const durationMs = Math.max(0, endMs - startMs);
  return {
    startMs,
    endMs,
    durationMs,
    rowCount: rec.rowCount,
    rateHz: durationMs > 0 ? ((rec.rowCount - 1) * 1000) / durationMs : 0,
    intervalMs: {
      median,
      p95: quantile(sorted, 0.95),
      p99: quantile(sorted, 0.99),
      max: sorted.length ? sorted[sorted.length - 1]! : 0,
    },
    lostFrames,
    restarts,
    timeGaps,
    backwardsSteps,
    issues,
    timeRefCounts,
  };
}

export type IntervalHistogram = { binWidthMs: number; counts: number[]; overflow: number; limitMs: number };

/** Sample intervals in 1 ms bins (wider for slow streams) up to about twice
 * the 99th percentile; anything longer lands in `overflow`. */
export function intervalHistogram(rec: Recording, summary: RecordingAnalysisSummary, maxBins = 60): IntervalHistogram {
  const limitMs = Math.max(4, Math.ceil(summary.intervalMs.p99 * 2));
  const binWidthMs = Math.max(1, Math.ceil(limitMs / maxBins));
  const counts = new Array<number>(Math.ceil(limitMs / binWidthMs)).fill(0);
  let overflow = 0;
  for (let row = 1; row < rec.rowCount; row += 1) {
    const step = rec.time[row]! - rec.time[row - 1]!;
    const bin = Math.floor(Math.max(0, step) / binWidthMs);
    if (bin >= counts.length) overflow += 1;
    else counts[bin]! += 1;
  }
  return { binWidthMs, counts, overflow, limitMs: counts.length * binWidthMs };
}

// ── Ranges and statistics ───────────────────────────────────────────────

/** The first row at or after `ms` (rowCount when there is none). */
export function indexAtTime(time: Float64Array, ms: number, count = time.length): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (time[mid]! < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The row closest in time to `ms`. */
export function nearestIndex(time: Float64Array, ms: number, count = time.length): number {
  if (count === 0) return 0;
  const after = Math.min(count - 1, indexAtTime(time, ms, count));
  const before = Math.max(0, after - 1);
  return Math.abs(time[before]! - ms) <= Math.abs(time[after]! - ms) ? before : after;
}

export type SensorStat = {
  sensor: number;
  name: string;
  mean: number;
  peak: number;
  std: number;
  /** Share of rows above the recording's activeThreshold, 0..1. */
  activeShare: number;
};

/** Per-sensor statistics over rows [start, end). */
export function sensorStats(rec: Recording, start: number, end: number): SensorStat[] {
  const from = Math.max(0, Math.min(start, rec.rowCount));
  const to = Math.max(from, Math.min(end, rec.rowCount));
  const count = to - from;
  const sums = new Float64Array(rec.sensorCount);
  const squares = new Float64Array(rec.sensorCount);
  const peaks = new Float64Array(rec.sensorCount);
  const actives = new Float64Array(rec.sensorCount);
  for (let row = from; row < to; row += 1) {
    const base = row * rec.sensorCount;
    for (let sensor = 0; sensor < rec.sensorCount; sensor += 1) {
      const value = rec.pressure[base + sensor]!;
      sums[sensor]! += value;
      squares[sensor]! += value * value;
      if (value > peaks[sensor]!) peaks[sensor] = value;
      if (value > rec.activeThreshold) actives[sensor]! += 1;
    }
  }
  return rec.sensorNames.map((name, sensor) => {
    const mean = count ? sums[sensor]! / count : 0;
    const variance = count ? Math.max(0, squares[sensor]! / count - mean * mean) : 0;
    return {
      sensor,
      name,
      mean,
      peak: peaks[sensor]!,
      std: Math.sqrt(variance),
      activeShare: count ? actives[sensor]! / count : 0,
    };
  });
}

/** One value per sensor: a single row, or the mean / peak over [start, end). */
export function sensorFrame(rec: Recording, mode: "frame" | "mean" | "peak", start: number, end: number): Float32Array {
  const frame = new Float32Array(rec.sensorCount);
  if (rec.rowCount === 0) return frame;
  if (mode === "frame") {
    const row = Math.max(0, Math.min(start, rec.rowCount - 1));
    frame.set(rec.pressure.subarray(row * rec.sensorCount, (row + 1) * rec.sensorCount));
    return frame;
  }
  for (const stat of sensorStats(rec, start, end)) frame[stat.sensor] = mode === "mean" ? stat.mean : stat.peak;
  return frame;
}

/** A sensor grid as close to square as the count allows (25 -> 5 x 5,
 * 112 -> 8 x 14), wider than tall. */
export function defaultGridColumns(count: number): number {
  if (count <= 0) return 1;
  const root = Math.sqrt(count);
  for (let columns = Math.ceil(root); columns <= Math.ceil(root * 2); columns += 1) {
    if (count % columns === 0) return columns;
  }
  return Math.ceil(root);
}

// ── Drawing ─────────────────────────────────────────────────────────────

export type Bucket = { min: number; max: number; first: number; last: number };

/** Min/max of `value(row)` per pixel column across rows [start, end), placed
 * by time between t0 and t1 -- enough to draw a 200k-row trace without
 * losing a spike. Columns no row falls in are null. */
export function bucketSeries(
  time: Float64Array,
  value: (row: number) => number,
  start: number,
  end: number,
  t0: number,
  t1: number,
  columns: number,
): (Bucket | null)[] {
  const buckets: (Bucket | null)[] = new Array(columns).fill(null);
  const span = Math.max(1e-9, t1 - t0);
  for (let row = start; row < end; row += 1) {
    const column = Math.min(columns - 1, Math.max(0, Math.floor(((time[row]! - t0) / span) * columns)));
    const sample = value(row);
    const bucket = buckets[column]!;
    if (bucket === null) buckets[column] = { min: sample, max: sample, first: sample, last: sample };
    else {
      if (sample < bucket.min) bucket.min = sample;
      if (sample > bucket.max) bucket.max = sample;
      bucket.last = sample;
    }
  }
  return buckets;
}

/** Round axis ticks (1 / 2 / 5 x 10^n) covering [min, max]. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max <= min) return [min];
  const rough = (max - min) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-9; tick += step) {
    ticks.push(Math.abs(tick) < step * 1e-9 ? 0 : tick);
  }
  return ticks;
}

/** Time-axis ticks in ms from the recording's start: 1 / 2 / 5 / 10 / 15 /
 * 30 s, then whole minutes. */
export function timeTicks(fromMs: number, toMs: number, target = 6): number[] {
  const span = Math.max(1, toMs - fromMs);
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000];
  const step = steps.find((candidate) => span / candidate <= target) ?? 3600000;
  const ticks: number[] = [];
  for (let tick = Math.ceil(fromMs / step) * step; tick <= toMs; tick += step) ticks.push(tick);
  return ticks;
}

// ── Time ────────────────────────────────────────────────────────────────

export type TimestampUnit = "s" | "ms" | "us" | "ns";

export const TIMESTAMP_UNIT_MS: Record<TimestampUnit, number> = { s: 1000, ms: 1, us: 1e-3, ns: 1e-6 };

/** Which unit an epoch number is in, by size: today is about 1.8e9 s, 1.8e12
 * ms, 1.8e15 us. Any date from 1973 to 5138 is told apart this way. */
export function detectTimestampUnit(value: number): TimestampUnit {
  const magnitude = Math.abs(value);
  if (magnitude < 1e11) return "s";
  if (magnitude < 1e14) return "ms";
  if (magnitude < 1e17) return "us";
  return "ns";
}

export function timestampToEpochMs(value: number, unit: TimestampUnit): number {
  return value * TIMESTAMP_UNIT_MS[unit];
}

/** A point in time to the millisecond, in the viewer's zone or `timeZone`;
 * "—" outside the range a Date can hold (a us value read as ms, say). */
export function formatInstant(ms: number, locale: string, timeZone?: string): string {
  if (!Number.isFinite(new Date(ms).getTime())) return "—";
  // fractionalSecondDigits is ES2021; the project's lib stops at ES2020.
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
    timeZone,
    timeZoneName: "short",
  } as Intl.DateTimeFormatOptions;
  return new Intl.DateTimeFormat(locale, options).format(new Date(ms));
}

/** 346903 -> "5:46.903"; an hour or more -> "1:05:46.903". */
export function formatDuration(ms: number, withMs = true): string {
  const sign = ms < 0 ? "-" : "";
  const value = Math.abs(ms);
  const whole = Math.floor(value / 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const fraction = withMs ? `.${String(Math.floor(value % 1000)).padStart(3, "0")}` : "";
  const body = hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
  return `${sign}${body}${fraction}`;
}

// ── Events sidecar ──────────────────────────────────────────────────────

export type RecordingEvent = {
  seq: number;
  frameSeq: number;
  timestampMs: number;
  app: string;
  event: string;
  edge: string;
  value: string;
  timeRef: string;
};

export type PlacedEvent = RecordingEvent & { index: number; atMs: number };

// ── File names ──────────────────────────────────────────────────────────
//
// Since Desktop v0.27.0 a recording is a folder `<HHMMSS>/` holding
// `<HHMMSS>.data.csv`, `<HHMMSS>.events.csv` and `<HHMMSS>.meta.json`
// (backend recording_meta.py); before that the samples sat flat in the day
// folder as `<HHMMSS>.csv` beside `<HHMMSS>.events.csv`. Both are read.

const RECORDING_SUFFIXES = [".data.csv", ".events.csv", ".meta.json", ".csv"];

/** "062756" for any of a recording's files, in either layout. */
export function recordingBase(name: string): string {
  const lowered = name.toLowerCase();
  const suffix = RECORDING_SUFFIXES.find((candidate) => lowered.endsWith(candidate));
  return suffix ? name.slice(0, -suffix.length) : name;
}

export function sidecarNameFor(sampleName: string): string {
  return recordingBase(sampleName) + ".events.csv";
}

export function metaNameFor(sampleName: string): string {
  return recordingBase(sampleName) + ".meta.json";
}

export function isEventsSidecar(name: string): boolean {
  return /\.events\.csv$/i.test(name);
}

export function isMetaFile(name: string): boolean {
  return /\.meta\.json$/i.test(name);
}

/** A recording's samples: `.data.csv`, or a pre-v0.27.0 `.csv`. */
export function isSamplesCsv(name: string): boolean {
  return /\.csv$/i.test(name) && !isEventsSidecar(name);
}

// ── Meta (`.meta.json`, format 1) ───────────────────────────────────────

export type RecordingMetaChange = { at: string | null; frameSeq: number | null; field: string; from: unknown; to: unknown };

/** The fields of a recording's meta the pages show; anything missing is null.
 * The backend's recording_meta.py documents the whole file. */
export type RecordingMeta = {
  format: number | null;
  device: {
    uid: string | null;
    displayName: string | null;
    hardwareModel: string | null;
    firmwareVersion: string | null;
    firmwarePrerelease: boolean | null;
  };
  sensors: { count: number | null; rows: number | null; cols: number | null; rawAdcColumns: boolean | null };
  calibration: { enabled: boolean | null; outputMode: string | null; tareComplete: boolean | null };
  stream: { targetFps: number | null };
  transport: { path: string | null; relay: string | null; relayId: string | null };
  statusReceivedAt: string | null;
  recording: {
    startedAt: string | null;
    rows: number | null;
    /** How far behind real time the frames being written got (absent in older metas). */
    maxLagMs: number | null;
    updatedAt: string | null;
    /** When Stop was pressed, if queued frames were then written up to it. */
    stopRequestedAt: string | null;
    stoppedAt: string | null;
    stopReason: string | null;
  };
  changes: RecordingMetaChange[];
  /** The file as read, for exporting it again. */
  raw: Record<string, unknown>;
};

function objectAt(value: unknown, key: string): Record<string, unknown> {
  const inner = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {};
}

const textOf = (value: unknown) => (typeof value === "string" && value ? value : null);
const numberOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const boolOf = (value: unknown) => (typeof value === "boolean" ? value : null);

/** A meta document, or null when `value` is not one. Never throws: a meta
 * from a newer backend, or a hand-edited one, still shows what it has. */
export function parseRecordingMeta(value: unknown): RecordingMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const device = objectAt(root, "device");
  const sensors = objectAt(root, "sensors");
  const shape = objectAt(sensors, "matrix_shape");
  const calibration = objectAt(root, "calibration");
  const stream = objectAt(root, "stream");
  const transport = objectAt(root, "transport");
  const recording = objectAt(root, "recording");
  const changes = Array.isArray(root.changes) ? root.changes : [];
  return {
    format: numberOf(root.format),
    device: {
      uid: textOf(device.uid),
      displayName: textOf(device.display_name),
      hardwareModel: textOf(device.hardware_model),
      firmwareVersion: textOf(device.firmware_version),
      firmwarePrerelease: boolOf(device.firmware_prerelease),
    },
    sensors: {
      count: numberOf(sensors.count),
      rows: numberOf(shape.rows),
      cols: numberOf(shape.cols),
      rawAdcColumns: boolOf(sensors.raw_adc_columns),
    },
    calibration: {
      enabled: boolOf(calibration.enabled),
      outputMode: textOf(calibration.output_mode),
      tareComplete: boolOf(calibration.tare_complete),
    },
    stream: { targetFps: numberOf(stream.target_fps) },
    transport: { path: textOf(transport.path), relay: textOf(transport.relay), relayId: textOf(transport.relay_id) },
    statusReceivedAt: textOf(root.status_received_at),
    recording: {
      startedAt: textOf(recording.started_at),
      rows: numberOf(recording.rows),
      maxLagMs: numberOf(recording.max_lag_ms),
      updatedAt: textOf(recording.updated_at),
      stopRequestedAt: textOf(recording.stop_requested_at),
      stoppedAt: textOf(recording.stopped_at),
      stopReason: textOf(recording.stop_reason),
    },
    changes: changes
      .filter((change): change is Record<string, unknown> => Boolean(change) && typeof change === "object")
      .map((change) => ({
        at: textOf(change.at),
        frameSeq: numberOf(change.frame_seq),
        field: textOf(change.field) ?? "",
        from: change.from,
        to: change.to,
      })),
    raw: root,
  };
}

export function parseRecordingMetaText(text: string): RecordingMeta | null {
  try {
    return parseRecordingMeta(JSON.parse(text));
  } catch {
    return null;
  }
}

/** How a recording ended: stopped (by the user or a write error), still
 * going (its meta was written moments ago), or cut off -- the backend
 * restarted or died while it ran, so nobody wrote `stopped_at`. */
export function recordingEnd(meta: RecordingMeta, nowMs = Date.now(), liveWithinMs = 30000): "stopped" | "live" | "cut_off" {
  if (meta.recording.stoppedAt) return "stopped";
  const updated = meta.recording.updatedAt ? Date.parse(meta.recording.updatedAt) : NaN;
  return Number.isFinite(updated) && nowMs - updated <= liveWithinMs ? "live" : "cut_off";
}

/** The sensor grid's columns from the meta, when its shape matches the
 * file's sensor count. */
export function metaGridColumns(meta: RecordingMeta | null, sensorCount: number): number | null {
  const { rows, cols } = meta?.sensors ?? { rows: null, cols: null };
  return rows && cols && rows * cols === sensorCount ? cols : null;
}

function splitCsvRow(line: string): string[] {
  // Event names and values never hold commas today, but `detail` may be
  // quoted by the writer; honour quotes rather than splitting inside them.
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

export function parseEventsCsv(text: string): RecordingEvent[] {
  const lines = splitLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const header = splitCsvRow(lines[0] ?? "").map((cell) => cell.trim());
  const at = (name: string) => header.indexOf(name);
  const columns = {
    seq: at("seq"), frameSeq: at("frame_seq"), timestamp: at("timestamp_ms"), app: at("app"),
    event: at("event"), edge: at("edge"), value: at("value"), timeRef: at("time_ref"),
  };
  const events: RecordingEvent[] = [];
  for (let line = 1; line < lines.length; line += 1) {
    if (!lines[line]) continue;
    const cells = splitCsvRow(lines[line]!);
    const cell = (index: number) => (index >= 0 ? cells[index] ?? "" : "");
    events.push({
      seq: Number(cell(columns.seq)) || 0,
      frameSeq: Number(cell(columns.frameSeq)) || 0,
      timestampMs: Number(cell(columns.timestamp)) || 0,
      app: cell(columns.app),
      event: cell(columns.event),
      edge: cell(columns.edge),
      value: cell(columns.value),
      timeRef: cell(columns.timeRef),
    });
  }
  return events;
}

/** Puts each event on the recording's timeline: by its frame when that frame
 * was recorded, else by its timestamp -- unless that is device uptime
 * (sidecars from before v0.25.1), which no row can be matched against. */
export function placeEvents(rec: Recording, events: RecordingEvent[]): PlacedEvent[] {
  const rowOfFrame = new Map<number, number>();
  if (rec.frameSeq) {
    for (let row = 0; row < rec.rowCount; row += 1) rowOfFrame.set(rec.frameSeq[row]!, row);
  }
  const start = rec.rowCount ? rec.time[0]! : 0;
  const placed: PlacedEvent[] = [];
  for (const event of events) {
    const matched = event.frameSeq ? rowOfFrame.get(event.frameSeq) : undefined;
    let index = matched;
    if (index === undefined) {
      if (event.timeRef === "uptime" || !event.timestampMs || rec.rowCount === 0) continue;
      index = nearestIndex(rec.time, event.timestampMs, rec.rowCount);
    }
    const timestampMs = matched !== undefined ? rec.time[matched]! : event.timestampMs;
    placed.push({ ...event, index, atMs: timestampMs - start });
  }
  placed.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
  return placed;
}

// ── Export ──────────────────────────────────────────────────────────────

/** The header and rows [start, end] (inclusive) of the original file, byte for
 * byte, so the export reads exactly like a recording. */
export function sliceRecordingText(text: string, rec: Recording, start: number, end: number): string {
  const lines = splitLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const out = [lines[0] ?? ""];
  const last = Math.min(end, rec.rowCount - 1);
  for (let row = Math.max(0, start); row <= last; row += 1) out.push(lines[rec.lineOfRow[row]!]!);
  return out.join("\n") + "\n";
}

/** The events whose rows fall in [start, end], in the sidecar's own format. */
export function sliceEventsText(text: string, placed: PlacedEvent[], start: number, end: number): string | null {
  const keep = new Set(placed.filter((event) => event.index >= start && event.index <= end).map((event) => event.seq));
  if (keep.size === 0) return null;
  const lines = splitLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const header = splitCsvRow(lines[0] ?? "");
  const seqColumn = header.indexOf("seq");
  const out = [lines[0]];
  for (let line = 1; line < lines.length; line += 1) {
    if (!lines[line]) continue;
    if (keep.has(Number(splitCsvRow(lines[line]!)[seqColumn]) || 0)) out.push(lines[line]!);
  }
  return out.join("\n") + "\n";
}

// ── The CSV export page's small timeline ────────────────────────────────

/** SVG polygons (one per run of non-empty buckets) filling between each
 * bucket's min and max, scaled to width x height with 0 at the bottom. */
export function envelopePolygons(buckets: ([number, number] | null)[], width: number, height: number, maxValue: number): string[] {
  const count = buckets.length;
  if (count === 0) return [];
  const top = Math.max(maxValue, 1e-9);
  const x = (index: number) => ((index + 0.5) / count) * width;
  const y = (value: number) => height - (Math.max(0, value) / top) * height;
  const polygons: string[] = [];
  let run: [number, [number, number]][] = [];
  const flush = () => {
    if (run.length) {
      // A lone bucket still needs a width to be seen.
      const points = run.length === 1
        ? [[x(run[0]![0]) - 0.5, run[0]![1]], [x(run[0]![0]) + 0.5, run[0]![1]]] as [number, [number, number]][]
        : run.map(([index, pair]) => [x(index), pair] as [number, [number, number]]);
      const upper = points.map(([px, pair]) => `${px.toFixed(2)},${y(pair[1]).toFixed(2)}`);
      const lower = points.slice().reverse().map(([px, pair]) => `${px.toFixed(2)},${Math.min(height, y(pair[0]) + 0.6).toFixed(2)}`);
      polygons.push([...upper, ...lower].join(" "));
    }
    run = [];
  };
  buckets.forEach((pair, index) => {
    if (pair) run.push([index, pair]);
    else flush();
  });
  flush();
  return polygons;
}
