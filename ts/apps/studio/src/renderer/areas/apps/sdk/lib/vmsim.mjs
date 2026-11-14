// @ts-check
/**
 * The simulator on the VM: runs a package's NHVM/1 image -- the bytes the
 * device runs -- behind the same interface as the graph Simulator, so the
 * emulators, the CLI and the tests can swap one for the other.
 *
 * The host rules (button presses, the tick fallback, budget latching,
 * degraded events, the LED and display bookkeeping) are FlowApp's, now
 * AppVm's; the per-op semantics live in vm.mjs's natives.
 */

import { FEATURE_FIELDS, LED_COLOURS, MAX_PENDING_PRESSES, OPS, TICK_FALLBACK_MS } from "./opset.mjs";
import { renderExtLeds } from "./extled.mjs";
import { formatOledTextLine, oledBarGeometry } from "./oled.mjs";
import { NO_PC, RUN_DONE, RUN_FAULT, VmMachine, decodeInsn, fromBase64, lowerGraph } from "./vm.mjs";
import { VM_EVENTS, VM_FAULTS, flowOpName } from "./vmset.mjs";

const f32 = Math.fround;

/** @param {readonly number[]} rgb */
function colourName(rgb) {
  for (const [name, value] of Object.entries(LED_COLOURS)) {
    if (value[0] === rgb[0] && value[1] === rgb[1] && value[2] === rgb[2]) return name;
  }
  return "off";
}

export class VmSimulator {
  /**
   * @param {Record<string, any>} pkg a package with a `vm` image, or a flow
   *   graph (lowered on the fly, exactly as the build does)
   * @param {{appName?: string, restore?: Record<number, number>, fuelLimit?: number}} [options]
   *   `fuelLimit` bounds one call's work, as the device's time slice does:
   *   a handler that spends it is suspended and resumed by the next frame.
   */
  constructor(pkg, options = {}) {
    if (pkg.kind === "readout" || pkg.kind === "panel") throw new Error(`a ${pkg.kind} package has nothing to run`);
    const manifest = pkg.manifest ?? {};
    /** @type {string[]} */
    const capList = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
    const caps = new Set(capList);
    this.image = typeof pkg.vm === "string" ? fromBase64(pkg.vm) : lowerGraph(pkg);
    this.machine = new VmMachine(this.image, { capabilities: capList });
    /** @type {Record<string, any>[]} */
    this.nodes = Array.isArray(pkg.nodes) ? pkg.nodes : [];
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
    this.appName = options.appName ?? String(manifest.id ?? pkg.name ?? "flow");
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
    /** @type {import("./simulate.mjs").SimEvent[]} */
    this.events = [];
    /** @type {import("./simulate.mjs").LedChange[]} */
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

  pressButton() {
    if (this.hearsButton && this.pendingPresses < MAX_PENDING_PRESSES) this.pendingPresses += 1;
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

  /** @param {Iterable<import("./simulate.mjs").Frame>} frames */
  run(frames) {
    for (const frame of frames) this.step(frame);
    return this;
  }

  /** @param {import("./simulate.mjs").Frame} frame */
  step(frame) {
    this.frames += 1;
    this.lastFrameSeq = frame.seq;
    this.lastFrameMs = frame.timestampMs >>> 0;
    return this.dispatch(VM_EVENTS.frame, frame, frame.timestampMs >>> 0, frame);
  }

  /**
   * @param {number} nowMs
   * @param {{imu?: ArrayLike<number>, mag?: ArrayLike<number>, battery?: number, linked?: boolean}} [sensors]
   */
  tick(nowMs, sensors = {}) {
    const at = { seq: this.lastFrameSeq, timestampMs: nowMs, ...sensors };
    // A suspended handler resumes on any delivery.
    if (this.machine.suspended) return this.dispatch(-1, null, nowMs >>> 0, at);
    if (!this.onTicks || !this.machine.hasEntry(VM_EVENTS.idle_tick)) return [];
    if (this.lastFrameMs !== null && ((nowMs - this.lastFrameMs) >>> 0) < TICK_FALLBACK_MS) return [];
    this.ticks += 1;
    return this.dispatch(VM_EVENTS.idle_tick, null, nowMs >>> 0, at);
  }

  /**
   * @param {number} event the handler to start, or -1 to only resume
   * @param {import("./simulate.mjs").Frame|null} frame
   * @param {number} nowMs
   * @param {{seq: number, timestampMs: number, imu?: ArrayLike<number>, mag?: ArrayLike<number>, battery?: number, linked?: boolean}} at
   */
  dispatch(event, frame, nowMs, at) {
    const firstEvent = this.events.length;
    if (this.fault !== null) return [];
    const machine = this.machine;
    if (machine.suspended) {
      if (event === VM_EVENTS.frame && this.handler === VM_EVENTS.frame) this.framesSkipped += 1;
    } else {
      if (event < 0 || !machine.hasEntry(event)) return [];
      let pressed = false;
      if (this.pressShown) {
        this.pressShown = false;
      } else if (this.pendingPresses !== 0) {
        this.pendingPresses -= 1;
        pressed = true;
        this.pressShown = true;
      }
      this.handler = event;
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
    };
    const outcome = machine.run(ctx, host, this.fuelLimit);
    if (outcome === RUN_FAULT) {
      this.fault = VM_FAULTS[machine.fault] ?? "fault";
      this.record(at, "fault", this.fault);
    } else if (outcome === RUN_DONE) {
      // Degradation is recorded, not silent.
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

  /** @returns {(import("./simulate.mjs").OledRow|null)[]} */
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

  /** Every node's current value, from the slots the image's node table names. */
  nodeValues() {
    const m = this.machine;
    let skipUntil = 0;
    return m.image.nodes.map((node, index) => {
      const op = /** @type {string} */ (flowOpName(node.op));
      const result = m.f[node.slot];
      const skipped = index < skipUntil;
      if (!skipped && op === "gate" && result === 0) {
        skipUntil = Math.min(index + 1 + (Number(this.nodes[index]?.span ?? 0) & 0xff), m.image.nodes.length);
      }
      return { op, result, bool: (node.flags & 2) !== 0 && result !== 0, skipped };
    });
  }

  /** The `features` op's fields, from its state record. */
  get features() {
    const index = this.machine.image.nodes.findIndex((node) => flowOpName(node.op) === "features");
    if (index < 0) return Object.fromEntries(FEATURE_FIELDS.map((name) => [name, 0]));
    const slot = this.machine.image.nodes[index].slot;
    return Object.fromEntries(FEATURE_FIELDS.map((name, i) => [name, this.machine.f[slot + 1 + i]]));
  }

  /** True when a sweep op exists, for UIs that ask. */
  get sweeps() {
    return this.machine.image.nodes.some((node) => OPS[/** @type {string} */ (flowOpName(node.op))]?.sweep);
  }
}
