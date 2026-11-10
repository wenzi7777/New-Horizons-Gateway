// The emulator's logic, kept out of React so it can be tested: turning live
// samples into frames, noticing the frames the browser never saw, and moving
// a simulation to any point of a recording.

import { PRESSURE_FULL_SCALE, Simulator, type Frame, type SimEvent } from "../sdk/lib/index.mjs";
import type { LiveFrame } from "../../../../shared/contract";
import type { SynthPattern } from "./sdkProject";

/**
 * A simulator as the emulator runs it. Every frame it sees was streamed, so on
 * the device linked() was true while it arrived.
 */
export function emulatorSimulator(pkg: Record<string, any>): Simulator {
  const sim = new Simulator(pkg);
  sim.setLinked(true);
  return sim;
}

/**
 * A Studio live frame as a simulator frame, or null if it carries no
 * pressures. Studio's live stream has no frame_seq or IMU samples, so the
 * emulator numbers frames itself and imu()/mag() read nothing.
 */
export function frameFromLiveFrame(entry: Pick<LiveFrame, "values" | "rows" | "cols" | "timestampMs">, fallbackSeq: number): Frame | null {
  if (!Array.isArray(entry.values) || entry.values.length === 0) return null;
  const fits = entry.rows * entry.cols === entry.values.length;
  return {
    seq: fallbackSeq,
    timestampMs: Math.trunc(Number(entry.timestampMs) || Date.now()),
    values: Float32Array.from(entry.values, (v) => Number(v) || 0),
    rows: fits ? entry.rows : 1,
    cols: fits ? entry.cols : entry.values.length,
  };
}

/**
 * Counts frames the device scanned but the browser never received.
 *
 * The backend pushes at most 60 frames a second and drops the rest
 * (latest-wins), so on a faster scan the emulator sees a thinned stream. A
 * debounce or a window then spans more real time per sample than it will on
 * the device, and the emulator must say so rather than quietly differ.
 * frame_seq gaps are how it knows.
 */
export class SeqGapTracker {
  received = 0;
  missed = 0;
  private last: number | null = null;

  /** @returns frames skipped just before this one */
  observe(seq: number): number {
    this.received += 1;
    if (this.last === null) {
      this.last = seq;
      return 0;
    }
    // uint32 on the device; a large jump backwards is a reboot, not a gap.
    const delta = (seq - this.last) >>> 0;
    this.last = seq;
    if (delta === 0 || delta > 0x7fffffff) return 0;
    const skipped = delta - 1;
    this.missed += skipped;
    return skipped;
  }

  /** Share of the device's frames that arrived, 0..1. */
  get coverage(): number {
    const total = this.received + this.missed;
    return total === 0 ? 1 : this.received / total;
  }

  reset() {
    this.received = 0;
    this.missed = 0;
    this.last = null;
  }
}

/**
 * A simulation positioned at a frame of a recording.
 *
 * Moving forward steps on from where it is. Moving backward replays from the
 * start: a debounce's timer and a window's ring are the history, so there is
 * no other way to know their state at an earlier frame.
 *
 * Button presses are part of that history, so they are kept by frame index
 * and replayed with it -- a press sent straight to the simulator would vanish
 * the first time the operator scrubbed backwards past it.
 */
export class RecordingCursor {
  private sim: Simulator;
  /** Index of the last frame evaluated, or -1 before the first. */
  position = -1;
  private budget = { load: 0, graceLeft: 0 };

  constructor(
    private readonly pkg: Record<string, any>,
    private readonly frames: readonly Frame[],
    private readonly presses: ReadonlySet<number> = new Set(),
  ) {
    this.sim = emulatorSimulator(pkg);
  }

  get simulator(): Simulator {
    return this.sim;
  }

  get length(): number {
    return this.frames.length;
  }

  setBudget(load: number, graceLeft: number) {
    this.budget = { load, graceLeft };
    this.sim.setBudget(load, graceLeft);
  }

  /** Evaluate up to and including frame `index`. Returns that frame's events. */
  seek(index: number): SimEvent[] {
    const target = Math.max(-1, Math.min(index, this.frames.length - 1));
    if (target < this.position) {
      this.sim = emulatorSimulator(this.pkg);
      this.sim.setBudget(this.budget.load, this.budget.graceLeft);
      this.position = -1;
    }
    let last: SimEvent[] = [];
    while (this.position < target) {
      this.position += 1;
      if (this.presses.has(this.position)) this.sim.pressButton();
      last = this.sim.step(this.frames[this.position]!);
    }
    return last;
  }

  get frame(): Frame | null {
    return this.position >= 0 ? this.frames[this.position] ?? null : null;
  }
}

/** Every event a package produces over a whole recording, for the timeline. */
export function simulateAll(pkg: Record<string, any>, frames: readonly Frame[], presses: ReadonlySet<number> = new Set()): SimEvent[] {
  const sim = emulatorSimulator(pkg);
  frames.forEach((frame, index) => {
    if (presses.has(index)) sim.pressButton();
    sim.step(frame);
  });
  return sim.events;
}

/** Largest cell value across frames: the default top of the colour scale. */
export function peakOf(frames: readonly Frame[]): number {
  let peak = 0;
  for (const frame of frames) {
    for (let i = 0; i < frame.values.length; i += 1) peak = Math.max(peak, frame.values[i] ?? 0);
  }
  return peak;
}

/** `HHMMSS.csv` -> `HHMMSS.events.csv`, the sidecar the Desktop writes beside it. */
export function sidecarPathFor(path: string): string {
  return path.replace(/\.csv$/i, ".events.csv");
}

export function isSidecar(name: string): boolean {
  return /\.events\.csv$/i.test(name);
}

/**
 * Which source lines to mark in the editor for this frame's output: the
 * statements whose nodes emitted.
 */
export function linesForEvents(pkg: Record<string, any>, nodeLines: readonly number[], events: readonly SimEvent[]): Set<number> {
  const lines = new Set<number>();
  if (!events.length) return lines;
  const names = new Set(events.map((event) => event.event));
  (pkg.nodes as { op: string; event?: string }[]).forEach((node, index) => {
    if ((node.op === "emit" || node.op === "emit_value") && node.event && names.has(node.event)) {
      const line = nodeLines[index];
      if (line) lines.add(line);
    }
  });
  return lines;
}

// --- generated frames ----------------------------------------------------------

/** The scan rate a virtual device runs at, as the Build tab assumes. */
export const SYNTH_FPS = 60;
/** Peak of a generated press: firm, clear of any sensible threshold's floor. */
const PRESS_PEAK = 0.7;
/** Top of the noise slider, as a share of full scale. */
const NOISE_CEILING = 0.1;
/** A held mouse press reaches its peak after this long; a release fades in RELEASE_MS. */
const MOUSE_RISE_MS = 600;
const MOUSE_PEAK = 0.9;
const RELEASE_MS = 200;

type Blob = { row: number; col: number; amp: number };

/** Seeded, so a test (or a reset) sees the same noise again. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A smooth 0 -> 1 -> 0 over `length`, flat at 1 between the two ramps. */
function envelope(t: number, length: number, ramp: number): number {
  if (t < 0 || t > length) return 0;
  if (t < ramp) return t / ramp;
  if (t > length - ramp) return (length - t) / ramp;
  return 1;
}

/**
 * Where a preset pattern presses at `t` ms into its run, or null between
 * presses. Every pattern repeats, so a debounce or a window sees it more than
 * once without the author restarting.
 */
export function patternBlob(pattern: SynthPattern, t: number, rows: number, cols: number): Blob | null {
  const row = (rows - 1) / 2;
  const col = (cols - 1) / 2;
  switch (pattern) {
    case "tap": {
      // A 250 ms tap every 2 s.
      const at = t % 2000;
      return at < 250 ? { row, col, amp: PRESS_PEAK * Math.sin((Math.PI * at) / 250) } : null;
    }
    case "hold": {
      // Half a second free, then held for 3 s.
      const at = (t % 4000) - 500;
      const amp = envelope(at, 3000, 150);
      return amp > 0 ? { row, col, amp: PRESS_PEAK * amp } : null;
    }
    case "swipe": {
      // Across the middle row, edge to edge in 2 s, then a second free.
      const at = t % 3000;
      if (at >= 2000) return null;
      return { row, col: -0.5 + (cols * at) / 2000, amp: PRESS_PEAK * envelope(at, 2000, 100) };
    }
    case "ramp": {
      // From nothing to full scale over 4 s, then released.
      const at = t % 5000;
      return at < 4000 ? { row, col, amp: at / 4000 } : null;
    }
    default:
      return null;
  }
}

/**
 * Frames for a virtual device: a preset pattern, a press the author makes
 * with the mouse, and background noise, summed and clipped to full scale.
 */
export class SyntheticFeed {
  private seq = 0;
  private startMs: number | null = null;
  private held: { row: number; col: number; since: number } | null = null;
  private fading: { row: number; col: number; at: number; amp: number } | null = null;
  private random: () => number;
  private currentPattern: SynthPattern;
  /** Background noise, 0..1 of the noise ceiling. */
  noise: number;

  constructor(
    readonly rows: number,
    readonly cols: number,
    options: { pattern: SynthPattern; noise: number; seed?: number },
  ) {
    this.random = mulberry32(options.seed ?? 1);
    this.currentPattern = options.pattern;
    this.noise = options.noise;
  }

  get pattern(): SynthPattern {
    return this.currentPattern;
  }

  /** Changing the pattern starts it from its beginning on the next frame. */
  set pattern(pattern: SynthPattern) {
    if (pattern === this.currentPattern) return;
    this.currentPattern = pattern;
    this.startMs = null;
  }

  /** Press at a cell, move there while pressed, or release with null. */
  press(cell: { row: number; col: number } | null, nowMs: number) {
    if (cell) {
      this.held = this.held ? { ...this.held, row: cell.row, col: cell.col } : { ...cell, since: nowMs };
      this.fading = null;
    } else if (this.held) {
      this.fading = { row: this.held.row, col: this.held.col, at: nowMs, amp: this.mouseAmp(nowMs) };
      this.held = null;
    }
  }

  private mouseAmp(nowMs: number): number {
    // Frames are made in batches, some stamped a little before the press.
    const unit = (value: number) => Math.min(1, Math.max(0, value));
    if (this.held) return MOUSE_PEAK * unit((nowMs - this.held.since) / MOUSE_RISE_MS);
    if (this.fading) return this.fading.amp * unit(1 - (nowMs - this.fading.at) / RELEASE_MS);
    return 0;
  }

  frame(nowMs: number): Frame {
    if (this.startMs === null) this.startMs = nowMs;
    const { rows, cols } = this;
    const values = new Float32Array(rows * cols);
    // About a sixth of the short side, so a press covers a few cells on any board.
    const sigma = Math.max(0.8, Math.min(rows, cols) / 6);
    const blobs: Blob[] = [];
    const preset = patternBlob(this.currentPattern, nowMs - this.startMs, rows, cols);
    if (preset) blobs.push(preset);
    const mouse = this.mouseAmp(nowMs);
    const at = this.held ?? this.fading;
    if (mouse > 0 && at) blobs.push({ row: at.row, col: at.col, amp: mouse });
    else if (!this.held) this.fading = null;
    const noise = this.noise * NOISE_CEILING * PRESSURE_FULL_SCALE;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        let value = noise > 0 ? noise * this.random() : 0;
        for (const blob of blobs) {
          const d2 = (r - blob.row) ** 2 + (c - blob.col) ** 2;
          value += PRESSURE_FULL_SCALE * blob.amp * Math.exp(-d2 / (2 * sigma * sigma));
        }
        values[r * cols + c] = Math.min(PRESSURE_FULL_SCALE, value);
      }
    }
    const frame = { seq: this.seq, timestampMs: Math.trunc(nowMs), values, rows, cols };
    this.seq += 1;
    return frame;
  }
}
