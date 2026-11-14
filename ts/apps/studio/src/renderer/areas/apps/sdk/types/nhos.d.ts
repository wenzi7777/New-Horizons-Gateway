// The NHOS app API, for app.ts files (docs/authoring.md).
//
// An app is a TypeScript file the App SDK compiles to bytecode for the
// device. These declarations are the whole API: reference this file from an
// app.ts (`/// <reference path=".../nhos.d.ts" />`) and an editor completes
// and type-checks it. The compiler accepts a subset of TypeScript -- numbers
// and booleans, Float32Array, top-level functions, if/while/for -- and tells
// you, with a line and column, when you step outside it.
//
// Values are 32-bit floats on the device (whole numbers are exact up to
// 16,777,216). Dividing by zero, and `%` by zero, give 0. Bit operators work
// on unsigned 32-bit integers.

// --- the TypeScript library, cut down to what the device has -----------------

interface Array<T> { length: number; [n: number]: T }
interface Boolean {}
interface CallableFunction {}
interface Function {}
interface IArguments {}
interface NewableFunction {}
interface Number {}
interface Object {}
interface RegExp {}
interface String { readonly length: number }
interface Float32Array {
  readonly length: number;
  [index: number]: number;
}
declare var Float32Array: {
  /** A fixed array of numbers, created once at the top level. */
  new (length: number): Float32Array;
};
declare var NaN: number;
declare var Infinity: number;
interface Math {
  readonly PI: number;
  readonly E: number;
  abs(x: number): number;
  sqrt(x: number): number;
  floor(x: number): number;
  ceil(x: number): number;
  round(x: number): number;
  min(...values: number[]): number;
  max(...values: number[]): number;
}
declare var Math: Math;

// --- the app's description -------------------------------------------------

/** What `export const manifest` holds. Capabilities and min_os are computed. */
interface NhosManifest {
  /** a-z, 0-9 and _, starting with a letter, up to 15 characters; the app's id on the device */
  readonly id: string;
  readonly name: string;
  /** x.y.z */
  readonly version: string;
  readonly author: string;
  readonly summary?: string;
  readonly category?: string;
  readonly icon?: string;
  /** Microseconds per frame the app may take (default 1500). */
  readonly budget_us?: number;
}

/**
 * When a handler runs.
 * - `start`: once, when the app starts
 * - `frame`: every frame the scanner produces
 * - `tick`: 10 times a second, always
 * - `idle`: 10 times a second, but only while no frames arrive (the scanner
 *   is stopped or nothing streams); matrix readings hold their last values
 * - `button`: each short press of the action button
 * - `stop`: once, when the app is stopped or removed
 */
type NhosEvent = "start" | "frame" | "tick" | "idle" | "button" | "stop";

/** Runs `handler` on each `event`. Called at the top level, once per event. */
declare function on(event: NhosEvent, handler: () => void): void;
/**
 * Runs `handler` with the value another app sent with
 * `app.publish(topic, value)`. Needs nothing to be granted.
 */
declare function on(event: "message", topic: string, handler: (value: number) => void): void;

// --- the sensor matrix ----------------------------------------------------

/** A rectangle of the matrix. Create it at the top level. */
declare class Region {
  /**
   * `rows` and `cols` are [first, last], inclusive; with `percent`, in
   * percent of the board's own matrix, so the app fits every board.
   */
  constructor(options: { rows?: [number, number]; cols?: [number, number]; percent?: boolean });
  /** Sum of the region's cells. */
  sum(): number;
  /** Largest cell. */
  peak(): number;
  /** Cells at or above `level`. */
  active(level: number): number;
  /** Centre of force, as a fractional row index (cells >= 50). */
  rowCentroid(): number;
  colCentroid(): number;
}

declare const matrix: {
  /** Sum of every cell. */
  total(): number;
  /** Largest cell. */
  peak(): number;
  /** Cells at or above `level` (a constant). */
  activeCells(level: number): number;
  /** Index of the largest cell (row * cols + col). */
  argMax(): number;
  /** Centre of force (cells >= 50), as fractional row / column indices. */
  rowCentroid(): number;
  colCentroid(): number;
  /** One cell's value. A row or column outside the matrix stops the app. */
  cell(row: number, col: number): number;
  readonly rows: number;
  readonly cols: number;
};

/** All per-frame features in one pass over the matrix. */
declare class Features {
  constructor();
  /** Recomputes the fields; returns totalForce. */
  update(): number;
  readonly value: number;
  readonly totalForce: number;
  readonly peak: number;
  /** peak / 2000, at most 1 */
  readonly peak01: number;
  readonly peakIndex: number;
  readonly activeCells: number;
  readonly centroidRow: number;
  readonly centroidCol: number;
  readonly inContact: boolean;
}

// --- other sensors --------------------------------------------------------

/** The IMU: acceleration in g, rotation in deg/s, angles in degrees. Holds its last value without a sample. */
declare const imu: {
  readonly ax: number; readonly ay: number; readonly az: number;
  readonly gx: number; readonly gy: number; readonly gz: number;
  readonly accMag: number; readonly gyroMag: number;
  readonly pitch: number; readonly roll: number;
};
/** The magnetometer, in microtesla; heading in degrees. */
declare const mag: {
  readonly x: number; readonly y: number; readonly z: number;
  readonly strength: number; readonly heading: number;
};
/** Battery charge in percent, or -1 without a fuel gauge. */
declare function battery(): number;
/** Whether the device has a relay to stream to. */
declare function linked(): boolean;
/** Seconds since boot. */
declare function uptime(): number;
/** Milliseconds since boot, modulo 2^24. */
declare function now(): number;
/** The frame's sequence number, modulo 2^24. */
declare function frameSeq(): number;
declare const button: {
  /** True for one run per short press (unless the app has on("button")). */
  pressed(): boolean;
};
/** How loaded the device's app budget is, and how many grace frames are left. */
declare const budget: { readonly load: number; readonly graceLeft: number };

// --- state that lasts from frame to frame ---------------------------------
// Create these at the top level: each owns a fixed piece of the app's memory.

/** On at `on`, off below `on - hysteresis`. */
declare class Threshold {
  constructor(on: number, hysteresis?: number);
  update(value: number): boolean;
  readonly value: boolean;
  /** True on the update that turned it on / off. */
  readonly rose: boolean;
  readonly fell: boolean;
}
/** Follows its input once the input has held for `ms`. */
declare class Debounce {
  constructor(ms: number);
  update(input: boolean): boolean;
  readonly value: boolean;
  readonly rose: boolean;
  readonly fell: boolean;
}
/** Rising and falling edges of any boolean. */
declare class Edge {
  constructor();
  /** Returns its input. */
  update(input: boolean): boolean;
  readonly value: boolean;
  readonly rose: boolean;
  readonly fell: boolean;
}
/** Mean / largest / sum of the last `frames` updates (at most 128 each). */
declare class Mean { constructor(frames: number); update(value: number): number; readonly value: number }
declare class MaxHold { constructor(frames: number); update(value: number): number; readonly value: number }
declare class Integrate { constructor(frames: number); update(value: number): number; readonly value: number }
/** value - the previous update's value. */
declare class Delta { constructor(initial?: number); update(value: number): number; readonly value: number }
/** Counts rising edges; a rising `reset` sets it to 0. With persist, survives a reboot. */
declare class Counter {
  constructor(options?: { persist?: boolean });
  update(input: boolean, reset?: boolean): number;
  readonly value: number;
}
/** Milliseconds its input has been true (0 while false). */
declare class Duration { constructor(); update(input: boolean): number; readonly value: number }
/** Milliseconds between the last two rising edges. */
declare class Interval { constructor(); update(input: boolean): number; readonly value: number }
/** Largest value since `reset` last rose. */
declare class PeakSince { constructor(); update(value: number, reset: boolean): number; readonly value: number }

// --- output ---------------------------------------------------------------

/** Logs a value event (event names: up to 23 characters). */
declare function emit(name: string, value: number): void;
/** Logs `name` rise / fall whenever `on` changes. */
declare function event(name: string, on: boolean): void;
/** A debug line in the device log. */
declare function log(label: string, value: number): void;
declare function clamp(value: number, lo: number, hi: number): number;
/** atan2 in degrees, -180 to 180. */
declare function atan2deg(y: number, x: number): number;

declare const enum Color { Red = 0, Green = 1, Blue = 2, White = 3, Off = 4 }

/** The status LED: shows `color` while `on`. */
declare const led: { set(color: Color, on: boolean): void };
/** The external LED strip (taken over from the device's preset while the app runs). */
declare const strip: {
  /** Pixel `index` (0-8, a constant) shows `color` while `on`. */
  pixel(index: number, color: Color, on: boolean): void;
  /** The strip as a bar from `lo` to `hi`. */
  meter(value: number, lo: number, hi: number): void;
};
/** The OLED's app page: rows 0-3, labels up to 10 characters. */
declare const oled: {
  text(row: number, label: string, value: number, digits?: number): void;
  bar(row: number, label: string, value: number, lo: number, hi: number): void;
};

// --- v2.1.0: storage, messages, device control, I/O ------------------------
// Those marked [ask] need the operator's consent when the app is installed.

/** [ask] Values and CSV files kept on the device (16 KB of files per app). */
declare const store: {
  /** A named value kept across reboots (0 if never set); up to 16 names. */
  get(key: string): number;
  set(key: string, value: number): void;
  /**
   * Appends `ms,a,b,c,d` to /appdata/<app>/<file>.csv (`file`: up to 8 of
   * a-z, 0-9, _). False once the 16 KB
   * is full (the device then logs store_full); missing values are empty.
   */
  append(file: string, a: number, b?: number, c?: number, d?: number): boolean;
  /** Deletes the file. */
  clear(file: string): void;
};

declare const app: {
  /** Sends `value` to every other running app with on("message", topic). */
  publish(topic: string, value: number): void;
};

/** Device settings an app may change. Never saved; restored when the app stops. */
type NhosSetting = "scan.target_fps" | "scan.send_every_n_frames" | "filter.enabled" | "filter.median" | "filter.alpha" | "imu.enabled";

declare const device: {
  /** [ask] */
  configGet(key: NhosSetting): number;
  /** [ask] False when out of range, or called again within a second. */
  configSet(key: NhosSetting, value: number): boolean;
  /** [ask] Pauses (false) or resumes streaming; resumed when the app stops. */
  stream(on: boolean): void;
};

/**
 * [ask] The exposed I2C bus, on v1.5.F and v2.0.F only. Addresses 0x08-0x77,
 * except the board's own chips. -1 on no answer.
 */
declare const i2c: {
  read8(addr: number, reg: number): number;
  /** Two registers, high byte first. */
  read16(addr: number, reg: number): number;
  write8(addr: number, reg: number, value: number): number;
  /** Reads `count` (<= 32) bytes from `reg` into `into[0..]`; returns the count or -1. */
  read(addr: number, reg: number, into: Float32Array, count: number): number;
  /** Writes `from[0..count)` (register first); returns the count or -1. */
  write(addr: number, from: Float32Array, count: number): number;
};

/** [ask] UART0 on the FPC (TX FPC1.17, RX FPC1.16), on v1.5.F and v2.0.F only. */
declare const uart: {
  /** 1200-921600 baud. Closed when the app stops. */
  open(baud: number): boolean;
  close(): void;
  /** One byte; returns how many were queued. */
  write(byte: number): number;
  writeBytes(from: Float32Array, count: number): number;
  available(): number;
  /** One byte, or -1 when none is waiting. */
  read(): number;
};
