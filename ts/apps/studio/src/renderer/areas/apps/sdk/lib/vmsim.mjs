// @ts-check
/**
 * The simulator: runs a package's NHVM/1 image -- the bytes the device runs
 * -- against frames, without a device. The emulators, the CLI and the tests
 * all use it.
 *
 * The host rules are AppVm's (firmware AppVm.cpp), case for case:
 *
 * - Arithmetic is the image's own, in 32-bit float as on the ESP32 (vm.mjs).
 * - Events are recorded only when the package declares `emit_event`; LED
 *   changes are reported separately, since the device logs nothing for them.
 * - `budget.load` / `budget.graceLeft` read whatever `setBudget()` last latched.
 * - `button.pressed()` is true for one run per `pressButton()`, with a false
 *   run between presses, and only with `button`. An app with an
 *   on("button") handler gets each press as a run of that handler instead.
 * - The OLED rows and the external strip are rebuilt every run from the calls
 *   that ran; `oledRows()`, `extLedFrame()` and `extLeds(count)` return them.
 * - imu/mag read the frame's samples and hold their last value without one.
 * - `tick(nowMs)` is the device's 10 Hz tick: it runs on("tick") every time,
 *   and on("idle") only while no frame has arrived for TICK_FALLBACK_MS.
 * - on("start") runs before the first delivery, on("stop") from `stop()`.
 * - Messages (`app.publish`) travel through a `SimBus` shared by simulators;
 *   each is delivered to the other apps' on("message", topic) at their next
 *   delivery, at most VM_MESSAGE_QUEUE waiting.
 * - store, device, i2c and uart go to a `SimDevice`: an in-memory store with
 *   the device's quota, the settings whitelist with its rate limit, and
 *   simulated I2C registers and a UART loopback.
 * - `persist` counters are what `persisted()` returns and `restore` seeds.
 */

import {
  FEATURE_FIELDS,
  LED_COLOURS,
  MAX_PENDING_PRESSES,
  OPS,
  PRESSURE_ACTIVE_THRESHOLD,
  PRESSURE_FULL_SCALE,
  TICK_FALLBACK_MS,
} from "./opset.mjs";
import { renderExtLeds } from "./extled.mjs";
import { formatOledTextLine, oledBarGeometry } from "./oled.mjs";
import { NO_PC, RUN_DONE, RUN_FAULT, VmMachine, decodeInsn, fromBase64, i2cAddressOk } from "./vm.mjs";
import {
  VM_DEVICE_CONFIG_INTERVAL_MS,
  VM_DEVICE_CONFIG_KEYS,
  VM_EVENTS,
  VM_FAULTS,
  VM_MESSAGE_QUEUE,
  VM_STORE_MAX_KEYS,
  VM_STORE_QUOTA_BYTES,
  flowOpName,
} from "./vmset.mjs";

const f32 = Math.fround;
const ACTIVE = f32(PRESSURE_ACTIVE_THRESHOLD);
const FULL_SCALE = f32(PRESSURE_FULL_SCALE);

/**
 * @typedef {object} Frame
 * @property {number} seq frame sequence number (the device's frame_seq)
 * @property {number} timestampMs
 * @property {ArrayLike<number>} values row-major cell values
 * @property {number} rows
 * @property {number} cols
 * @property {ArrayLike<number>} [imu] ax, ay, az (g), gx, gy, gz (deg/s)
 * @property {ArrayLike<number>} [mag] mx, my, mz (microtesla)
 * @property {number} [battery] percent; overrides setBattery() for this frame
 * @property {boolean} [linked] overrides setLinked() for this frame
 */

/**
 * @typedef {object} SimEvent
 * @property {number} seq
 * @property {number} frameSeq
 * @property {number} timestampMs
 * @property {string} app
 * @property {string} event
 * @property {string} detail rise/fall, or the formatted value for a value event
 * @property {number|null} value
 */

/**
 * @typedef {object} LedChange
 * @property {number} frameSeq
 * @property {number} timestampMs
 * @property {string} colour
 * @property {readonly [number, number, number]} rgb
 * @property {number} node the node-table entry whose state drove it, or -1
 */

/**
 * One OLED row as the device's "app" page draws it.
 * @typedef {object} OledRow
 * @property {"text"|"bar"} kind
 * @property {string} label
 * @property {number} value
 * @property {number} node node-table entry, or -1 (a call's own state)
 * @property {string} [text] the whole row, for a text row (OLED_COLS characters)
 * @property {import("./oled.mjs").OledBarGeometry} [bar] for a bar row
 */

/**
 * @typedef {object} NodeValue
 * @property {string} name the variable or object, from the package's symbols
 * @property {string} op
 * @property {number} result
 * @property {boolean} bool
 */

/**
 * The same eight fields the device's Features computes, in float32.
 * @param {Frame} frame
 * @returns {Record<string, number>}
 */
export function computeFeatures(frame) {
  const values = frame.values;
  const cols = frame.cols || 1;
  let total = 0;
  let peak = 0;
  let peakIndex = 0;
  let active = 0;
  let weightedRow = 0;
  let weightedCol = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = f32(values[i]);
    total = f32(total + value);
    if (value > peak) {
      peak = value;
      peakIndex = i;
    }
    if (value >= ACTIVE) {
      active += 1;
      weightedRow = f32(weightedRow + f32(value * Math.floor(i / cols)));
      weightedCol = f32(weightedCol + f32(value * (i % cols)));
    }
  }
  const peak01 = Math.min(f32(peak / FULL_SCALE), 1);
  return {
    total_force: total,
    peak,
    peak01,
    peak_index: peakIndex,
    active_cells: active,
    centroid_row: total > 0 ? f32(weightedRow / total) : 0,
    centroid_col: total > 0 ? f32(weightedCol / total) : 0,
    in_contact: active > 0 ? 1 : 0,
  };
}

/** @param {readonly number[]} rgb */
function colourName(rgb) {
  for (const [name, value] of Object.entries(LED_COLOURS)) {
    if (value[0] === rgb[0] && value[1] === rgb[1] && value[2] === rgb[2]) return name;
  }
  return "off";
}

/** Device settings an app may change, with ConfigRegistry's ranges and defaults. */
const CONFIG_RANGES = Object.freeze({
  "scan.target_fps": { lo: 1, hi: 120, value: 60, int: true },
  "scan.send_every_n_frames": { lo: 1, hi: 255, value: 1, int: true },
  "filter.enabled": { lo: 0, hi: 1, value: 0, int: true },
  "filter.median": { lo: 1, hi: 5, value: 3, int: true },
  "filter.alpha": { lo: f32(0.05), hi: f32(0.6), value: f32(0.25), int: false },
  "imu.enabled": { lo: 0, hi: 1, value: 1, int: true },
});

/**
 * What a simulated device offers the v2.1.0 system calls. One per simulator
 * by default; pass the same one to several to share it.
 */
export class SimDevice {
  /** @param {{uartLoopback?: boolean, i2c?: Record<number, number[]>}} [options] */
  constructor(options = {}) {
    /** @type {Map<string, Map<string, number>>} per app */
    this.values = new Map();
    /** @type {Map<string, Map<string, {bytes: number, rows: string[]}>>} per app, per file */
    this.files = new Map();
    /** Apps already told their store is full. @type {Set<string>} */
    this.fullReported = new Set();
    /** @type {Record<string, number>} */
    this.config = Object.fromEntries(Object.entries(CONFIG_RANGES).map(([key, spec]) => [key, spec.value]));
    /** @type {Map<string, {saved: Record<string, number>, lastSetMs: number|null}>} */
    this.configBy = new Map();
    this.streaming = true;
    /** @type {string|null} the app that paused streaming */
    this.pausedBy = null;
    /** I2C registers by address: 256 bytes each, auto-incrementing. @type {Map<number, Uint8Array>} */
    this.i2c = new Map();
    for (const [addr, bytes] of Object.entries(options.i2c ?? {})) {
      const regs = new Uint8Array(256);
      regs.set(bytes.slice(0, 256));
      this.i2c.set(Number(addr), regs);
    }
    this.uartLoopback = options.uartLoopback ?? true;
    /** @type {string|null} */
    this.uartOwner = null;
    this.uartBaud = 0;
    /** @type {number[]} */
    this.uartRx = [];
    /** @type {number[]} bytes written, for display */
    this.uartTx = [];
  }

  /** @param {string} app */
  valuesOf(app) {
    let map = this.values.get(app);
    if (!map) {
      map = new Map();
      this.values.set(app, map);
    }
    return map;
  }

  /** @param {string} app */
  filesOf(app) {
    let map = this.files.get(app);
    if (!map) {
      map = new Map();
      this.files.set(app, map);
    }
    return map;
  }

  /** A file's CSV text, as the device would serve /appdata/<app>/<file>.csv. @param {string} app @param {string} file */
  fileText(app, file) {
    const entry = this.filesOf(app).get(file);
    return entry ? entry.rows.join("") : "";
  }

  /** Bytes an app's files take. @param {string} app */
  usedBytes(app) {
    let used = 0;
    for (const entry of this.filesOf(app).values()) used += entry.bytes;
    return used;
  }

  /**
   * The host hooks for one app.
   * @param {string} app
   * @param {(event: string, detail: string) => void} report
   * @returns {import("./vm.mjs").VmHostExt}
   */
  hooks(app, report) {
    return {
      storeGet: (key) => this.valuesOf(app).get(key) ?? 0,
      storeSet: (key, value) => {
        const values = this.valuesOf(app);
        // The device keeps VM_STORE_MAX_KEYS names; a new one past that is dropped.
        if (!values.has(key) && values.size >= VM_STORE_MAX_KEYS) return;
        values.set(key, value);
      },
      storeAppend: (file, nowMs, values) => {
        const cells = values.map((v) => (Number.isNaN(v) ? "" : String(Number(f32(v).toPrecision(7)))));
        const row = `${nowMs},${cells.join(",")}\n`;
        if (this.usedBytes(app) + row.length > VM_STORE_QUOTA_BYTES) {
          // Told once, until a clear frees room (as the device does).
          if (!this.fullReported.has(app)) {
            this.fullReported.add(app);
            report("store_full", file);
          }
          return false;
        }
        const files = this.filesOf(app);
        const entry = files.get(file) ?? { bytes: 0, rows: [] };
        entry.rows.push(row);
        entry.bytes += row.length;
        files.set(file, entry);
        return true;
      },
      storeClear: (file) => {
        this.filesOf(app).delete(file);
        this.fullReported.delete(app);
      },
      configGet: (key) => this.config[key] ?? 0,
      configSet: (key, value, nowMs) => {
        const spec = CONFIG_RANGES[/** @type {keyof typeof CONFIG_RANGES} */ (key)];
        if (!spec || !VM_DEVICE_CONFIG_KEYS.includes(key)) return false;
        if (!(value >= spec.lo && value <= spec.hi) || (spec.int && !Number.isInteger(value))) return false;
        const state = this.configBy.get(app) ?? { saved: {}, lastSetMs: null };
        if (state.lastSetMs !== null && ((nowMs - state.lastSetMs) >>> 0) < VM_DEVICE_CONFIG_INTERVAL_MS) return false;
        if (!(key in state.saved)) state.saved[key] = this.config[key];
        state.lastSetMs = nowMs;
        this.configBy.set(app, state);
        this.config[key] = value;
        return true;
      },
      stream: (on) => {
        this.streaming = on;
        this.pausedBy = on ? null : app;
      },
      i2cRead: (addr, reg, n) => {
        const regs = this.i2c.get(addr);
        if (!regs) return null;
        return Array.from({ length: n }, (_, i) => regs[(reg + i) & 0xff]);
      },
      i2cWrite: (addr, bytes) => {
        const regs = this.i2c.get(addr);
        if (!regs || !i2cAddressOk(addr)) return false;
        const [reg, ...data] = bytes;
        data.forEach((b, i) => {
          regs[(reg + i) & 0xff] = b;
        });
        return true;
      },
      uartOpen: (baud) => {
        if (this.uartOwner !== null && this.uartOwner !== app) return false;
        this.uartOwner = app;
        this.uartBaud = baud;
        return true;
      },
      uartClose: () => {
        if (this.uartOwner === app) this.closeUart();
      },
      uartWrite: (bytes) => {
        if (this.uartOwner !== app) return 0;
        this.uartTx.push(...bytes);
        if (this.uartLoopback) {
          for (const b of bytes) if (this.uartRx.length < 256) this.uartRx.push(b);
        }
        return bytes.length;
      },
      uartAvailable: () => (this.uartOwner === app ? this.uartRx.length : 0),
      uartRead: () => (this.uartOwner === app && this.uartRx.length > 0 ? /** @type {number} */ (this.uartRx.shift()) : -1),
    };
  }

  closeUart() {
    this.uartOwner = null;
    this.uartBaud = 0;
    this.uartRx = [];
  }

  /** What the device undoes when an app stops. @param {string} app */
  release(app) {
    const state = this.configBy.get(app);
    if (state) {
      Object.assign(this.config, state.saved);
      this.configBy.delete(app);
    }
    if (this.pausedBy === app) {
      this.streaming = true;
      this.pausedBy = null;
    }
    if (this.uartOwner === app) this.closeUart();
  }
}

/** Messages between simulators, as AppManager routes them between slots. */
export class SimBus {
  constructor() {
    /** @type {Set<VmSimulator>} */
    this.members = new Set();
  }

  /** @param {VmSimulator} from @param {string} topic @param {number} value */
  publish(from, topic, value) {
    for (const sim of this.members) {
      if (sim !== from) sim.enqueueMessage(topic, value);
    }
  }
}

export class VmSimulator {
  /**
   * @param {Record<string, any>} pkg a package with a `vm` image
   * @param {{appName?: string, restore?: Record<number, number>, fuelLimit?: number, device?: SimDevice, bus?: SimBus}} [options]
   *   `fuelLimit` bounds one call's work, as the device's time slice does:
   *   a handler that spends it is suspended and resumed by the next delivery.
   */
  constructor(pkg, options = {}) {
    if (pkg.kind === "readout" || pkg.kind === "panel") throw new Error(`a ${pkg.kind} package has nothing to run`);
    if (typeof pkg.vm !== "string") throw new Error("the package has no image: rebuild it with the App SDK");
    const manifest = pkg.manifest ?? {};
    /** @type {string[]} */
    const capList = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
    const caps = new Set(capList);
    this.image = fromBase64(pkg.vm);
    this.machine = new VmMachine(this.image, { capabilities: capList });
    /** @type {{name: string, kind: string, type: string}[]} */
    this.symbols = Array.isArray(pkg.symbols) ? pkg.symbols : [];
    this.canEmit = caps.has("emit_event");
    this.canDriveLed = caps.has("drive_led");
    this.canDisplay = caps.has("display");
    this.hearsButton = caps.has("button");
    this.canDriveExtLed = caps.has("drive_ext_led");
    this.readsImu = caps.has("read_imu");
    this.readsMag = caps.has("read_mag");
    this.readsPower = caps.has("power");
    this.readsLink = caps.has("link");
    this.onTicks = caps.has("tick");
    this.canPersist = caps.has("persist");
    this.restoreValues = options.restore ?? null;
    this.fuelLimit = options.fuelLimit ?? Infinity;
    this.appName = options.appName ?? String(manifest.id ?? pkg.name ?? "app");
    this.device = options.device ?? new SimDevice();
    this.bus = options.bus ?? null;
    if (this.bus) this.bus.members.add(this);
    this.battery = -1;
    this.linkUp = false;
    this.reset();
  }

  reset() {
    this.machine.reset();
    if (this.canPersist && this.restoreValues) {
      for (const [index, value] of Object.entries(this.restoreValues)) {
        const node = this.machine.image.nodes[Number(index)];
        const op = node ? flowOpName(node.op) : null;
        if (node && (node.flags & 1) !== 0 && (op === "counter" || op === "counter_reset")) {
          this.machine.f[node.slot] = f32(value);
        }
      }
    }
    this.lastFrameSeq = 0;
    /** @type {number|null} */
    this.lastFrameMs = null;
    this.ticks = 0;
    /** @type {SimEvent[]} */
    this.events = [];
    /** @type {LedChange[]} */
    this.ledChanges = [];
    /** @type {readonly [number, number, number]} */
    this.led = LED_COLOURS.off;
    this.seq = 0;
    this.frames = 0;
    this.degraded = false;
    this.degradations = 0;
    this.pendingPresses = 0;
    this.pressShown = false;
    this.framesSkipped = 0;
    /** @type {string|null} */
    this.fault = null;
    this.handler = -1;
    this.started = false;
    this.stopped = false;
    /** @type {{topic: string, value: number}[]} */
    this.inbox = [];
    this.messagesDropped = 0;
  }

  /** @param {number} percent */
  setBattery(percent) {
    this.battery = f32(percent);
  }

  /** @param {boolean} linked */
  setLinked(linked) {
    this.linkUp = Boolean(linked);
  }

  persisted() {
    /** @type {Record<number, number>} */
    const out = {};
    if (!this.canPersist) return out;
    this.machine.image.nodes.forEach((node, index) => {
      const op = flowOpName(node.op);
      if ((node.flags & 1) !== 0 && (op === "counter" || op === "counter_reset")) out[index] = this.machine.f[node.slot];
    });
    return out;
  }

  /**
   * A short press. With an on("button") handler it runs now (at `nowMs`, or
   * the last frame's time); otherwise button.pressed() reads it next run.
   * @param {number} [nowMs]
   */
  pressButton(nowMs) {
    if (!this.hearsButton) return [];
    if (this.machine.hasEntry(VM_EVENTS.button)) {
      const now = nowMs ?? this.lastFrameMs ?? 0;
      return this.dispatch(VM_EVENTS.button, null, now >>> 0, { seq: this.lastFrameSeq, timestampMs: now });
    }
    if (this.pendingPresses < MAX_PENDING_PRESSES) this.pendingPresses += 1;
    return [];
  }

  /** @param {number} load @param {number} graceLeft */
  setBudget(load, graceLeft) {
    this.machine.budgetLoad = f32(load);
    this.machine.graceLeft = Math.max(0, Math.min(255, Math.trunc(graceLeft)));
  }

  /**
   * @param {{seq: number, timestampMs: number}} at
   * @param {string} event
   * @param {string} detail
   * @param {number|null} [value]
   */
  record(at, event, detail, value = null) {
    if (!this.canEmit) return;
    this.seq += 1;
    this.events.push({ seq: this.seq, frameSeq: at.seq, timestampMs: at.timestampMs, app: this.appName, event, detail, value });
  }

  /** @param {Iterable<Frame>} frames */
  run(frames) {
    for (const frame of frames) this.step(frame);
    return this;
  }

  /** @param {Frame} frame */
  step(frame) {
    this.frames += 1;
    this.lastFrameSeq = frame.seq;
    this.lastFrameMs = frame.timestampMs >>> 0;
    return this.dispatch(VM_EVENTS.frame, frame, frame.timestampMs >>> 0, frame);
  }

  /**
   * The 10 Hz tick.
   * @param {number} nowMs
   * @param {{imu?: ArrayLike<number>, mag?: ArrayLike<number>, battery?: number, linked?: boolean}} [sensors]
   */
  tick(nowMs, sensors = {}) {
    const at = { seq: this.lastFrameSeq, timestampMs: nowMs, ...sensors };
    // A suspended handler resumes on any delivery.
    if (this.machine.suspended) return this.dispatch(-1, null, nowMs >>> 0, at);
    const first = this.events.length;
    if (this.onTicks && this.machine.hasEntry(VM_EVENTS.tick)) this.dispatch(VM_EVENTS.tick, null, nowMs >>> 0, at);
    if (this.onTicks && this.machine.hasEntry(VM_EVENTS.idle_tick) && !this.machine.suspended
      && !(this.lastFrameMs !== null && ((nowMs - this.lastFrameMs) >>> 0) < TICK_FALLBACK_MS)) {
      this.ticks += 1;
      this.dispatch(VM_EVENTS.idle_tick, null, nowMs >>> 0, at);
    }
    return this.events.slice(first);
  }

  /** @param {string} topic @param {number} value */
  enqueueMessage(topic, value) {
    if (!this.machine.hasEntry(VM_EVENTS.message)) return;
    if (this.inbox.length >= VM_MESSAGE_QUEUE) {
      this.messagesDropped += 1;
      return;
    }
    this.inbox.push({ topic, value: f32(value) });
  }

  /** Runs on("stop") and undoes what the app changed on the device. @param {number} nowMs */
  stop(nowMs) {
    const first = this.events.length;
    if (!this.stopped && this.fault === null && !this.machine.suspended && this.machine.hasEntry(VM_EVENTS.stop)) {
      this.dispatch(VM_EVENTS.stop, null, nowMs >>> 0, { seq: this.lastFrameSeq, timestampMs: nowMs });
    }
    this.stopped = true;
    this.device.release(this.appName);
    return this.events.slice(first);
  }

  /**
   * @param {number} event the handler to start, or -1 to only resume
   * @param {Frame|null} frame
   * @param {number} nowMs
   * @param {{seq: number, timestampMs: number, imu?: ArrayLike<number>, mag?: ArrayLike<number>, battery?: number, linked?: boolean}} at
   * @param {{topic: string, value: number}|null} [message]
   */
  dispatch(event, frame, nowMs, at, message = null) {
    const firstEvent = this.events.length;
    if (this.fault !== null) return [];
    if (!this.started && event !== VM_EVENTS.start && !this.machine.suspended) {
      this.started = true;
      if (this.machine.hasEntry(VM_EVENTS.start)) {
        this.dispatch(VM_EVENTS.start, null, nowMs, at);
        if (this.machine.suspended || this.fault !== null) return this.events.slice(firstEvent);
      }
    }
    // Messages waiting from other apps run first, each as its own run.
    if (event !== VM_EVENTS.message && event !== VM_EVENTS.start && !this.machine.suspended) {
      while (this.inbox.length > 0 && !this.machine.suspended && this.fault === null) {
        const next = /** @type {{topic: string, value: number}} */ (this.inbox.shift());
        this.dispatch(VM_EVENTS.message, null, nowMs, at, next);
      }
      if (this.machine.suspended || this.fault !== null) return this.events.slice(firstEvent);
    }
    const machine = this.machine;
    if (machine.suspended) {
      if (event === VM_EVENTS.frame && this.handler === VM_EVENTS.frame) this.framesSkipped += 1;
    } else {
      if (event < 0 || !machine.hasEntry(event)) return this.events.slice(firstEvent);
      let pressed = false;
      if (event === VM_EVENTS.button) {
        pressed = true;
      } else if (this.pressShown) {
        this.pressShown = false;
      } else if (this.pendingPresses !== 0) {
        this.pendingPresses -= 1;
        pressed = true;
        this.pressShown = true;
      }
      this.handler = event;
      this.currentMessage = message;
      machine.begin(event, pressed);
    }
    const ctx = {
      nowMs,
      frameSeq: at.seq,
      frame: frame ? { values: frame.values, rows: frame.rows, cols: frame.cols || 1 } : null,
      imu: this.readsImu && at.imu && at.imu.length >= 6 ? at.imu : null,
      mag: this.readsMag && at.mag && at.mag.length >= 3 ? at.mag : null,
      battery: this.readsPower ? f32(at.battery ?? this.battery) : -1,
      linked: this.readsLink ? Boolean(at.linked ?? this.linkUp) : false,
      message: this.currentMessage ?? null,
    };
    const host = {
      emitEvent: (/** @type {string} */ name, /** @type {string} */ detail) => this.record(at, name, detail),
      emitValue: (/** @type {string} */ name, /** @type {number} */ value) => this.record(at, name, value.toFixed(3), value),
      log: () => {},
      led: (/** @type {boolean} */ on, /** @type {readonly number[]} */ rgb, /** @type {number} */ state) => {
        if (!this.canDriveLed) return;
        const colour = on ? colourName(rgb) : "off";
        const shown = LED_COLOURS[colour] ?? LED_COLOURS.off;
        this.led = shown;
        this.ledChanges.push({ frameSeq: at.seq, timestampMs: at.timestampMs, colour, rgb: shown, node: this.nodeOfSlot(state) });
      },
      ext: {
        ...this.device.hooks(this.appName, (name, detail) => this.record(at, name, detail)),
        publish: (/** @type {string} */ topic, /** @type {number} */ value) => this.bus?.publish(this, topic, value),
      },
    };
    const outcome = machine.run(ctx, host, this.fuelLimit);
    if (outcome === RUN_FAULT) {
      this.fault = VM_FAULTS[machine.fault] ?? "fault";
      this.record(at, "fault", this.fault);
      this.device.release(this.appName);
    } else if (outcome === RUN_DONE) {
      this.currentMessage = null;
      if (machine.runDegraded !== this.degraded) {
        this.degraded = machine.runDegraded;
        if (machine.runDegraded) this.degradations += 1;
        this.record(at, "degraded", machine.runDegraded ? "rise" : "fall");
      }
      if (this.framesSkipped > 0) {
        this.record(at, "frames_skipped", this.framesSkipped.toFixed(3), this.framesSkipped);
        this.framesSkipped = 0;
      }
    }
    return this.events.slice(firstEvent);
  }

  /** @param {number} slot */
  nodeOfSlot(slot) {
    return this.machine.image.nodes.findIndex((node) => node.slot === slot);
  }

  /** @param {number} pc */
  natAt(pc) {
    const insn = /** @type {NonNullable<ReturnType<typeof decodeInsn>>} */ (decodeInsn(this.machine.image.code, pc));
    const [op, state, param] = insn.args;
    return { name: /** @type {string} */ (flowOpName(op)), state, param };
  }

  /** @returns {(OledRow|null)[]} */
  oledRows() {
    const m = this.machine;
    const k = m.image.consts;
    return m.displayPc.map((pc) => {
      if (!this.canDisplay || pc === NO_PC) return null;
      const { name, state, param } = this.natAt(pc);
      const label = m.image.strings[k[param + 1]] ?? "";
      const value = m.f[state];
      const node = this.nodeOfSlot(state);
      if (name === "oled_bar") {
        return { kind: "bar", label, value, node, bar: oledBarGeometry(label.length, value, k[param + 2], k[param + 3]) };
      }
      return { kind: "text", label, value, node, text: formatOledTextLine(label, value, k[param + 2]) };
    });
  }

  /** @returns {import("./extled.mjs").ExtLedFrame | null} */
  extLedFrame() {
    if (!this.canDriveExtLed) return null;
    const m = this.machine;
    const k = m.image.consts;
    let meter = null;
    if (m.meterPc !== NO_PC) {
      const { state, param } = this.natAt(m.meterPc);
      meter = { value: m.f[state], lo: k[param], hi: k[param + 1] };
    }
    return {
      meter,
      pixels: m.pixelPc.map((pc) => {
        if (pc === NO_PC) return null;
        const { param } = this.natAt(pc);
        return LED_COLOURS[colourName([k[param + 1], k[param + 2], k[param + 3]])];
      }),
    };
  }

  /** @param {number} count */
  extLeds(count) {
    const frame = this.extLedFrame();
    return frame ? renderExtLeds(frame, count) : null;
  }

  /** Every named value's current value, from the node table and the package's symbols. @returns {NodeValue[]} */
  nodeValues() {
    const m = this.machine;
    return m.image.nodes.map((node, index) => {
      const op = /** @type {string} */ (flowOpName(node.op));
      const result = m.f[node.slot];
      return { name: this.symbols[index]?.name ?? `#${index}`, op, result, bool: (node.flags & 2) !== 0 && result !== 0 };
    });
  }

  /** A Features object's fields, from its state record. */
  get features() {
    const index = this.machine.image.nodes.findIndex((node) => flowOpName(node.op) === "features");
    if (index < 0) return Object.fromEntries(FEATURE_FIELDS.map((name) => [name, 0]));
    const slot = this.machine.image.nodes[index].slot;
    return Object.fromEntries(FEATURE_FIELDS.map((name, i) => [name, this.machine.f[slot + 1 + i]]));
  }

  /** True when the image reads the matrix per cell, for UIs that ask. */
  get sweeps() {
    const code = this.machine.image.code;
    for (let pc = 0; pc < code.length;) {
      const insn = decodeInsn(code, pc);
      if (!insn) break;
      if (insn.spec.name === "nat" && OPS[/** @type {string} */ (flowOpName(insn.args[0]))]?.sweep) return true;
      pc += insn.size;
    }
    return false;
  }
}

/** The name the emulators and older callers use. */
export const Simulator = VmSimulator;

/**
 * Convenience: run a package over frames from a fresh start.
 * @param {Record<string, any>} pkg
 * @param {Iterable<Frame>} frames
 * @param {{appName?: string}} [options]
 */
export function simulate(pkg, frames, options = {}) {
  return new VmSimulator(pkg, options).run(frames);
}
