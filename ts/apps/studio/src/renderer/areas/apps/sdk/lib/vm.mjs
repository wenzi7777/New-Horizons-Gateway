// @ts-check
/**
 * NHVM/1 in JavaScript: the image format, the verifier, the lowering of a flow
 * graph to bytecode, and the interpreter. docs/vm.md is the specification;
 * vmset.mjs holds the tables. The firmware's AppVm is the other
 * implementation, and `test/vm-conformance.test.mjs` runs both on the same
 * images and inputs and requires the same outputs.
 *
 * Float semantics follow the device: every value is IEEE-754 single
 * precision. Values live in Float32Arrays, so each store rounds exactly once,
 * which for + - * / sqrt fmod gives the same bits as the ESP32's float unit.
 */

import {
  CAPABILITIES,
  DEVICE_CAPABILITIES,
  FEATURE_FIELDS,
  IMU_FIELDS,
  LED_COLOURS,
  MAG_FIELDS,
  MAX_EXT_LEDS,
  MAX_OLED_DIGITS,
  MAX_REL_PERCENT,
  MAX_WINDOW,
  OLED_ROWS,
  OPS,
  PRESSURE_ACTIVE_THRESHOLD,
  PRESSURE_FULL_SCALE,
  REL_COLS,
  REL_ROWS,
  nodeCostNs,
} from "./opset.mjs";
import {
  NATIVE_LAYOUT,
  OPERAND_BYTES,
  VM_ENTRY_BYTES,
  VM_EVENTS,
  VM_FN_BYTES,
  VM_FUEL_CHECK,
  VM_HEADER_BYTES,
  VM_IMAGE_MAGIC,
  VM_IMAGE_VERSION,
  VM_INIT_BYTES,
  VM_INSN_NS,
  VM_MAX_ARENA,
  VM_MAX_CALL_DEPTH,
  VM_MAX_CODE,
  VM_MAX_CONSTS,
  VM_MAX_FUNCTIONS,
  VM_MAX_NODES,
  VM_MAX_STACK,
  VM_MAX_STRING,
  VM_MAX_STRINGS,
  VM_NODE_BYTES,
  VM_OPCODES,
  VM_OPS,
  VM_SYSCALLS,
  flowOpName,
  flowOpNumber,
  nativeFuel,
} from "./vmset.mjs";
import { atan2Deg, imuField, magField, resolveSpan, sqrtSafe } from "./flowmath.mjs";

const f32 = Math.fround;
const ACTIVE = f32(PRESSURE_ACTIVE_THRESHOLD);
const FULL_SCALE = f32(PRESSURE_FULL_SCALE);
const NO_PC = 0xffff;

// --- image ---------------------------------------------------------------------

/**
 * @typedef {object} VmFunction
 * @property {number} pc
 * @property {number} base arena slot of its locals
 * @property {number} args
 * @property {number} locals
 * @property {number} rets
 */

/**
 * @typedef {object} VmNodeInfo
 * @property {number} op FlowOp number
 * @property {number} flags bit 0 persist, bit 1 boolean
 * @property {number} slot arena slot holding the node's value
 */

/**
 * @typedef {object} VmImageParts
 * @property {Uint8Array} code
 * @property {number[]} consts
 * @property {string[]} strings
 * @property {VmFunction[]} functions
 * @property {Record<string, number>} entries event name -> function index
 * @property {[number, number][]} init [slot, const index]
 * @property {VmNodeInfo[]} nodes
 * @property {number} arena slots
 * @property {number} stack slots
 */

/**
 * @typedef {object} VmImage
 * @property {Uint8Array} bytes
 * @property {Uint8Array} code
 * @property {Float32Array} consts
 * @property {string[]} strings
 * @property {VmFunction[]} functions
 * @property {Map<number, number>} entries event id -> function index
 * @property {[number, number][]} init
 * @property {VmNodeInfo[]} nodes
 * @property {number} arena
 * @property {number} stack
 */

const align4 = (/** @type {number} */ n) => (n + 3) & ~3;

/**
 * Serialises an image. Layout (little-endian), docs/vm.md §7:
 *   header (20) | functions | entries | init | nodes | strings | pad4 | consts | code
 * @param {VmImageParts} parts
 * @returns {Uint8Array}
 */
export function encodeImage(parts) {
  const strings = parts.strings.map((s) => [...s].map((c) => c.charCodeAt(0)));
  const stringBytes = strings.reduce((sum, s) => sum + s.length + 2, 0);
  const entries = Object.entries(parts.entries).map(([event, fn]) => {
    const id = VM_EVENTS[/** @type {keyof typeof VM_EVENTS} */ (event)];
    if (id === undefined) throw new Error(`unknown event ${event}`);
    return [id, fn];
  });
  const tablesEnd = VM_HEADER_BYTES + parts.functions.length * VM_FN_BYTES + entries.length * VM_ENTRY_BYTES
    + parts.init.length * VM_INIT_BYTES + parts.nodes.length * VM_NODE_BYTES + stringBytes;
  const constsAt = align4(tablesEnd);
  const codeAt = constsAt + parts.consts.length * 4;
  const total = codeAt + parts.code.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes[0] = VM_IMAGE_MAGIC[0];
  bytes[1] = VM_IMAGE_MAGIC[1];
  bytes[2] = VM_IMAGE_VERSION;
  bytes[3] = 0;
  view.setUint16(4, parts.code.length, true);
  view.setUint16(6, parts.consts.length, true);
  view.setUint16(8, parts.arena, true);
  view.setUint16(10, parts.stack, true);
  bytes[12] = parts.functions.length;
  bytes[13] = entries.length;
  bytes[14] = parts.init.length;
  bytes[15] = strings.length;
  bytes[16] = parts.nodes.length;
  bytes[17] = 0;
  view.setUint16(18, stringBytes, true);
  let at = VM_HEADER_BYTES;
  for (const fn of parts.functions) {
    view.setUint16(at, fn.pc, true);
    view.setUint16(at + 2, fn.base, true);
    bytes[at + 4] = fn.args;
    bytes[at + 5] = fn.locals;
    bytes[at + 6] = fn.rets;
    at += VM_FN_BYTES;
  }
  for (const [event, fn] of entries) {
    bytes[at] = event;
    bytes[at + 1] = fn;
    at += VM_ENTRY_BYTES;
  }
  for (const [slot, k] of parts.init) {
    view.setUint16(at, slot, true);
    view.setUint16(at + 2, k, true);
    at += VM_INIT_BYTES;
  }
  for (const node of parts.nodes) {
    bytes[at] = node.op;
    bytes[at + 1] = node.flags;
    view.setUint16(at + 2, node.slot, true);
    at += VM_NODE_BYTES;
  }
  for (const s of strings) {
    bytes[at] = s.length;
    bytes.set(s, at + 1);
    bytes[at + 1 + s.length] = 0;
    at += s.length + 2;
  }
  parts.consts.forEach((value, i) => view.setFloat32(constsAt + i * 4, value, true));
  bytes.set(parts.code, codeAt);
  return bytes;
}

/** A refused image; `message` is the reason code. */
export class VmImageError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "VmImageError";
    this.code = code;
  }
}

/**
 * @param {boolean} ok
 * @param {string} code
 * @returns {asserts ok}
 */
function need(ok, code) {
  if (!ok) throw new VmImageError(code);
}

/**
 * Parses an image's tables. Checks the layout, not the code (verifyImage).
 * @param {Uint8Array} bytes
 * @returns {VmImage}
 */
export function decodeImage(bytes) {
  need(bytes.length >= VM_HEADER_BYTES, "image_truncated");
  need(bytes[0] === VM_IMAGE_MAGIC[0] && bytes[1] === VM_IMAGE_MAGIC[1], "image_bad_magic");
  need(bytes[2] === VM_IMAGE_VERSION, "image_unsupported_version");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codeLen = view.getUint16(4, true);
  const constCount = view.getUint16(6, true);
  const arena = view.getUint16(8, true);
  const stack = view.getUint16(10, true);
  const fnCount = bytes[12];
  const entryCount = bytes[13];
  const initCount = bytes[14];
  const stringCount = bytes[15];
  const nodeCount = bytes[16];
  const stringBytes = view.getUint16(18, true);
  need(codeLen > 0 && codeLen <= VM_MAX_CODE, "image_code_size");
  need(constCount <= VM_MAX_CONSTS, "image_too_many_consts");
  need(arena <= VM_MAX_ARENA, "image_arena_size");
  need(stack > 0 && stack <= VM_MAX_STACK, "image_stack_size");
  need(fnCount > 0 && fnCount <= VM_MAX_FUNCTIONS, "image_functions");
  need(stringCount <= VM_MAX_STRINGS, "image_too_many_strings");
  need(nodeCount <= VM_MAX_NODES, "image_too_many_nodes");
  const tablesEnd = VM_HEADER_BYTES + fnCount * VM_FN_BYTES + entryCount * VM_ENTRY_BYTES
    + initCount * VM_INIT_BYTES + nodeCount * VM_NODE_BYTES + stringBytes;
  const constsAt = align4(tablesEnd);
  const codeAt = constsAt + constCount * 4;
  need(bytes.length === codeAt + codeLen, "image_size_mismatch");
  for (let i = tablesEnd; i < constsAt; i += 1) need(bytes[i] === 0, "image_bad_padding");

  let at = VM_HEADER_BYTES;
  /** @type {VmFunction[]} */
  const functions = [];
  for (let i = 0; i < fnCount; i += 1) {
    functions.push({
      pc: view.getUint16(at, true),
      base: view.getUint16(at + 2, true),
      args: bytes[at + 4],
      locals: bytes[at + 5],
      rets: bytes[at + 6],
    });
    need(bytes[at + 7] === 0, "image_bad_function");
    at += VM_FN_BYTES;
  }
  /** @type {Map<number, number>} */
  const entries = new Map();
  for (let i = 0; i < entryCount; i += 1) {
    const event = bytes[at];
    const fn = bytes[at + 1];
    need(event <= VM_EVENTS.idle_tick && !entries.has(event), "image_bad_entry");
    need(fn < fnCount, "image_bad_entry");
    entries.set(event, fn);
    at += VM_ENTRY_BYTES;
  }
  /** @type {[number, number][]} */
  const init = [];
  for (let i = 0; i < initCount; i += 1) {
    const slot = view.getUint16(at, true);
    const k = view.getUint16(at + 2, true);
    need(slot < arena && k < constCount, "image_bad_init");
    init.push([slot, k]);
    at += VM_INIT_BYTES;
  }
  /** @type {VmNodeInfo[]} */
  const nodes = [];
  for (let i = 0; i < nodeCount; i += 1) {
    const op = bytes[at];
    const slot = view.getUint16(at + 2, true);
    need(op >= 1 && op <= Object.keys(OPS).length && slot < arena && (bytes[at + 1] & ~3) === 0, "image_bad_node");
    nodes.push({ op, flags: bytes[at + 1], slot });
    at += VM_NODE_BYTES;
  }
  /** @type {string[]} */
  const strings = [];
  const stringsEnd = at + stringBytes;
  for (let i = 0; i < stringCount; i += 1) {
    need(at < stringsEnd, "image_bad_strings");
    const len = bytes[at];
    need(len <= VM_MAX_STRING && at + len + 2 <= stringsEnd, "image_bad_strings");
    let text = "";
    for (let c = 0; c < len; c += 1) {
      const ch = bytes[at + 1 + c];
      need(ch >= 0x20 && ch <= 0x7e, "image_bad_strings");
      text += String.fromCharCode(ch);
    }
    need(bytes[at + 1 + len] === 0, "image_bad_strings");
    strings.push(text);
    at += len + 2;
  }
  need(at === stringsEnd, "image_bad_strings");
  const consts = new Float32Array(constCount);
  for (let i = 0; i < constCount; i += 1) consts[i] = view.getFloat32(constsAt + i * 4, true);
  return {
    bytes,
    code: bytes.subarray(codeAt, codeAt + codeLen),
    consts,
    strings,
    functions,
    entries,
    init,
    nodes,
    arena,
    stack,
  };
}

// --- verifier --------------------------------------------------------------------

/**
 * @typedef {object} VmVerified
 * @property {VmImage} image
 * @property {boolean} loopFree no backward jump: the static estimate is a bound
 * @property {number} estimatedNs worst case per run, when loopFree (cellCount cells)
 * @property {number} maxStack deepest operand stack any handler can reach
 * @property {number} poolBytes RAM the image takes on the device
 * @property {number} capabilities mask the code needs
 */

/** @param {readonly string[]|number} caps */
function capMask(caps) {
  if (typeof caps === "number") return caps;
  let mask = 0;
  const all = { ...CAPABILITIES, ...DEVICE_CAPABILITIES };
  for (const name of caps) mask |= /** @type {Record<string, number>} */ (all)[name] ?? 0;
  return mask;
}

const NATIVE_BY_NUMBER = new Map(Object.keys(NATIVE_LAYOUT).map((name) => [flowOpNumber(name), name]));
const ALL_CAPS = /** @type {Record<string, number>} */ ({ ...CAPABILITIES, ...DEVICE_CAPABILITIES });

/**
 * Decodes one instruction at `pc`.
 * @param {Uint8Array} code
 * @param {number} pc
 */
export function decodeInsn(code, pc) {
  const opcode = code[pc];
  const spec = VM_OPCODES[opcode];
  if (!spec) return null;
  const size = 1 + OPERAND_BYTES[/** @type {keyof typeof OPERAND_BYTES} */ (spec.operands)];
  if (pc + size > code.length) return null;
  const u16 = (/** @type {number} */ at) => code[at] | (code[at + 1] << 8);
  /** @type {number[]} */
  let args = [];
  switch (spec.operands) {
    case "u8": args = [code[pc + 1]]; break;
    case "u16": args = [u16(pc + 1)]; break;
    case "i16": args = [(u16(pc + 1) << 16) >> 16]; break;
    case "u16u16": args = [u16(pc + 1), u16(pc + 3)]; break;
    case "nat": args = [code[pc + 1], u16(pc + 2), u16(pc + 4)]; break;
    default: break;
  }
  return { spec, size, args };
}

/**
 * The device's install-time checks (docs/vm.md §9). Throws VmImageError.
 * @param {Uint8Array} bytes
 * @param {{capabilities?: readonly string[]|number, cellCount?: number}} [options]
 * @returns {VmVerified}
 */
export function verifyImage(bytes, options = {}) {
  const image = decodeImage(bytes);
  const declared = capMask(options.capabilities ?? []);
  const cellCount = options.cellCount ?? 225;
  const { code, consts, functions, arena } = image;
  const constCount = consts.length;
  need(functions[0].pc === 0, "image_bad_function");
  for (let f = 0; f < functions.length; f += 1) {
    const fn = functions[f];
    need(f === 0 || fn.pc > functions[f - 1].pc, "image_bad_function");
    need(fn.pc < code.length, "image_bad_function");
    need(fn.args <= fn.locals && fn.rets <= 1 && fn.base + fn.locals <= arena, "image_bad_function");
  }
  for (const fn of image.entries.values()) {
    need(functions[fn].args === 0 && functions[fn].rets === 0, "image_bad_entry");
  }

  let loopFree = true;
  let estimatedNs = 0;
  let used = 0;
  /** @type {number[]} max stack depth relative to entry, per function (callee depth folded in later) */
  const ownMax = [];
  /** @type {{at: number, callee: number, depth: number}[][]} */
  const callSites = [];

  for (let f = 0; f < functions.length; f += 1) {
    const start = functions[f].pc;
    const end = f + 1 < functions.length ? functions[f + 1].pc : code.length;
    const fn = functions[f];
    /** @type {Map<number, NonNullable<ReturnType<typeof decodeInsn>>>} */
    const insns = new Map();
    for (let pc = start; pc < end;) {
      const insn = decodeInsn(code, pc);
      if (insn === null) throw new VmImageError("bad_opcode");
      need(pc + insn.size <= end, "insn_crosses_function");
      insns.set(pc, insn);
      pc += insn.size;
    }
    // Linear checks of every operand.
    let last = null;
    for (const [pc, insn] of insns) {
      last = insn;
      const name = insn.spec.name;
      const [a, b, c] = insn.args;
      switch (name) {
        case "pushk": need(a < constCount, "const_out_of_range"); break;
        case "loadg": case "storeg": need(a < arena, "arena_out_of_range"); break;
        case "loadl": case "storel": need(a < fn.locals, "local_out_of_range"); break;
        case "aload": case "astore": need(b >= 1 && a + b <= arena, "arena_out_of_range"); break;
        case "jmp": case "jz": case "jnz": {
          const target = pc + insn.size + a;
          need(target >= start && target < end && insns.has(target), "bad_jump");
          if (target <= pc) loopFree = false;
          break;
        }
        case "call": need(a < functions.length, "bad_call"); break;
        case "ret": need(a === fn.rets, "bad_return"); break;
        case "sys": {
          const sys = VM_SYSCALLS[a];
          need(sys !== undefined, "unknown_syscall");
          need(sys.cap === null || (declared & (ALL_CAPS[sys.cap] ?? 0)) !== 0, "capability_not_declared");
          if (sys.cap) used |= ALL_CAPS[sys.cap] ?? 0;
          break;
        }
        case "nat": {
          checkNative(image, a, b, c, declared);
          const opName = /** @type {string} */ (flowOpName(a));
          const capability = OPS[opName].capability;
          if (capability) used |= ALL_CAPS[capability] ?? 0;
          break;
        }
        default: break;
      }
      if (name === "nat") estimatedNs += nodeCostNs({ op: flowOpName(insn.args[0]) }, cellCount);
      else estimatedNs += VM_INSN_NS;
    }
    need(last !== null && ["end", "ret", "jmp"].includes(last.spec.name), "falls_off_function");

    // Stack depth: one depth per instruction on every path.
    /** @type {Map<number, number>} */
    const depthAt = new Map([[start, 0]]);
    const work = [start];
    let max = 0;
    /** @type {{at: number, callee: number, depth: number}[]} */
    const sites = [];
    while (work.length > 0) {
      const pc = /** @type {number} */ (work.pop());
      const insn = /** @type {NonNullable<ReturnType<typeof decodeInsn>>} */ (insns.get(pc));
      const depth = /** @type {number} */ (depthAt.get(pc));
      const name = insn.spec.name;
      let pops = insn.spec.pops;
      let pushes = insn.spec.pushes;
      if (name === "call") {
        const callee = functions[insn.args[0]];
        pops = callee.args;
        pushes = callee.rets;
        sites.push({ at: pc, callee: insn.args[0], depth });
      } else if (name === "ret") {
        pops = insn.args[0];
        pushes = 0;
        need(depth === pops, "stack_unbalanced_at_return");
      } else if (name === "nat") {
        pops = OPS[/** @type {string} */ (flowOpName(insn.args[0]))].inputs;
      } else if (name === "sys") {
        pops = VM_SYSCALLS[insn.args[0]].args;
        pushes = VM_SYSCALLS[insn.args[0]].results;
      } else if (name === "end") {
        need(depth === 0, "stack_unbalanced_at_end");
      }
      need(depth >= pops, "stack_underflow");
      const after = depth - pops + pushes;
      max = Math.max(max, after, depth);
      /** @type {number[]} */
      const next = [];
      if (name === "jmp") next.push(pc + insn.size + insn.args[0]);
      else if (name === "jz" || name === "jnz") next.push(pc + insn.size + insn.args[0], pc + insn.size);
      else if (name !== "end" && name !== "ret") next.push(pc + insn.size);
      for (const target of next) {
        need(insns.has(target), "falls_off_function");
        const known = depthAt.get(target);
        if (known === undefined) {
          depthAt.set(target, after);
          work.push(target);
        } else {
          need(known === after, "stack_inconsistent");
        }
      }
    }
    ownMax.push(max);
    callSites.push(sites);
  }

  // Call graph: acyclic, at most VM_MAX_CALL_DEPTH deep; fold callee depth in.
  /** @type {(number|null)[]} */
  const total = functions.map(() => null);
  /** @type {number[]} */
  const level = functions.map(() => 0);
  const onStack = new Set();
  /** @param {number} f @returns {number} */
  const visit = (f) => {
    const known = total[f];
    if (known !== null) return known;
    need(!onStack.has(f), "recursion");
    onStack.add(f);
    let deepest = ownMax[f];
    let callLevel = 0;
    for (const site of callSites[f]) {
      const inner = visit(site.callee);
      deepest = Math.max(deepest, site.depth - functions[site.callee].args + inner);
      callLevel = Math.max(callLevel, level[site.callee] + 1);
    }
    need(callLevel <= VM_MAX_CALL_DEPTH, "call_too_deep");
    onStack.delete(f);
    level[f] = callLevel;
    total[f] = deepest;
    return deepest;
  };
  let maxStack = 0;
  for (let f = 0; f < functions.length; f += 1) maxStack = Math.max(maxStack, visit(f));
  need(maxStack <= image.stack, "stack_too_small");

  return {
    image,
    loopFree,
    estimatedNs: loopFree ? estimatedNs : 0,
    maxStack,
    poolBytes: vmPoolBytes(image),
    capabilities: used,
  };
}

/** RAM an image takes from the device's app pool. @param {VmImage} image */
export function vmPoolBytes(image) {
  return align4(image.bytes.length) + image.arena * 4 + image.stack * 4;
}

/**
 * @param {VmImage} image
 * @param {number} op FlowOp number
 * @param {number} state
 * @param {number} param
 * @param {number} declared
 */
function checkNative(image, op, state, param, declared) {
  const name = NATIVE_BY_NUMBER.get(op);
  need(name !== undefined, "unknown_native");
  const layout = NATIVE_LAYOUT[name];
  const spec = OPS[name];
  need(!spec.capability || (declared & (ALL_CAPS[spec.capability] ?? 0)) !== 0, "capability_not_declared");
  need(param + layout.params.length <= image.consts.length, "const_out_of_range");
  /** @param {string} key */
  const p = (key) => image.consts[param + layout.params.indexOf(key)];
  const isInt = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Number.isInteger(v) && v >= lo && v <= hi;
  let slots = layout.state;
  for (const key of layout.params) {
    const v = p(key);
    switch (key) {
      case "window": need(isInt(v, 1, MAX_WINDOW), "invalid_window"); slots += v; break;
      case "event": need(isInt(v, 0, image.strings.length - 1) && image.strings[v].length > 0, "invalid_string"); break;
      case "label": need(isInt(v, 0, image.strings.length - 1), "invalid_string"); break;
      case "row": need(isInt(v, 0, OLED_ROWS - 1), "invalid_oled_row"); break;
      case "digits": need(isInt(v, 0, MAX_OLED_DIGITS), "invalid_oled_digits"); break;
      case "index": need(isInt(v, 0, MAX_EXT_LEDS - 1), "invalid_ext_led_index"); break;
      case "r": case "g": case "b": need(isInt(v, 0, 255), "invalid_colour"); break;
      case "ms": need(isInt(v, 0, 65535), "invalid_ms"); break;
      case "persist": case "fall": need(v === 0 || v === 1, "invalid_flag"); break;
      case "r0": case "c0": case "r1": case "c1": need(isInt(v, 0, 255), "invalid_region"); break;
      case "rel": need(isInt(v, 0, REL_ROWS | REL_COLS), "invalid_region_rel"); break;
      case "field": {
        const count = name === "imu" ? IMU_FIELDS.length : MAG_FIELDS.length;
        need(isInt(v, 0, count - 1), "invalid_field");
        break;
      }
      default: need(Number.isFinite(v), "invalid_param"); break;
    }
  }
  if (layout.params.includes("rel")) {
    const rel = p("rel");
    need(((rel & REL_ROWS) === 0 || (p("r1") <= MAX_REL_PERCENT && p("r0") <= p("r1")))
      && ((rel & REL_COLS) === 0 || (p("c1") <= MAX_REL_PERCENT && p("c0") <= p("c1"))), "invalid_region_percent");
  }
  if (name === "oled_bar" || name === "ext_meter") need(p("hi") > p("lo"), "invalid_range");
  need(state + slots <= image.arena, "arena_out_of_range");
}

// --- lowering: flow graph -> image -------------------------------------------------

/** @param {unknown} raw */
function inputsOf(raw) {
  if (raw === undefined || raw === null) return [];
  return Array.isArray(raw) ? raw.map(Number) : [Number(raw)];
}

const PURE_BINARY = { add: "add", sub: "sub", mul: "mul", div: "div", min: "min", max: "max", mod: "mod", atan2: "atan2" };
const PURE_UNARY = { abs: "abs", sqrt: "sqrt", not: "not" };

class Assembler {
  constructor() {
    /** @type {number[]} */
    this.bytes = [];
    /** @type {{at: number, label: number}[]} */
    this.fixups = [];
    /** @type {Map<number, number>} */
    this.labels = new Map();
    this.nextLabel = 0;
  }

  newLabel() {
    this.nextLabel += 1;
    return this.nextLabel;
  }

  /** @param {number} label */
  bind(label) {
    this.labels.set(label, this.bytes.length);
  }

  /** @param {string} name @param {...number} args */
  op(name, ...args) {
    const spec = VM_OPS[name];
    if (!spec) throw new Error(`unknown instruction ${name}`);
    this.bytes.push(spec.code);
    const u16 = (/** @type {number} */ v) => this.bytes.push(v & 0xff, (v >> 8) & 0xff);
    switch (spec.operands) {
      case "u8": this.bytes.push(args[0] & 0xff); break;
      case "u16": u16(args[0]); break;
      case "u16u16": u16(args[0]); u16(args[1]); break;
      case "nat": this.bytes.push(args[0] & 0xff); u16(args[1]); u16(args[2]); break;
      default: break;
    }
  }

  /** @param {"jmp"|"jz"|"jnz"} name @param {number} label */
  jump(name, label) {
    this.bytes.push(VM_OPS[name].code, 0, 0);
    this.fixups.push({ at: this.bytes.length - 2, label });
  }

  finish() {
    for (const { at, label } of this.fixups) {
      const target = this.labels.get(label);
      if (target === undefined) throw new Error("unbound label");
      const rel = target - (at + 2);
      this.bytes[at] = rel & 0xff;
      this.bytes[at + 1] = (rel >> 8) & 0xff;
    }
    return Uint8Array.from(this.bytes);
  }
}

/**
 * Compiles a flow graph into an NHVM/1 image that evaluates it exactly as
 * FlowApp::evaluate did: node by node in array order, every node's value in
 * an arena slot (held when a gate skips it), state-keeping and I/O ops as
 * native instructions, gates as forward jumps.
 * @param {Record<string, any>} pkg a flow package (nodes + manifest)
 * @returns {Uint8Array}
 */
export function lowerGraph(pkg) {
  /** @type {Record<string, any>[]} */
  const nodes = Array.isArray(pkg.nodes) ? pkg.nodes : [];
  const caps = new Set(Array.isArray(pkg.manifest?.capabilities) ? pkg.manifest.capabilities : []);
  if (nodes.length === 0) throw new Error("empty_graph");
  if (nodes.length > VM_MAX_NODES) throw new Error("too_many_nodes");
  /** @type {number[]} */
  const consts = [];
  /** @type {Map<string, number>} */
  const constIndex = new Map();
  /** @param {number} value */
  const constant = (value) => {
    const v = f32(value);
    const key = Object.is(v, -0) ? "-0" : String(v);
    let index = constIndex.get(key);
    if (index === undefined) {
      index = consts.length;
      consts.push(v);
      constIndex.set(key, index);
    }
    return index;
  };
  /** @param {number[]} values a parameter record, kept contiguous */
  const record = (values) => {
    // Reuse an identical run already in the pool, else append.
    for (let i = 0; values.length > 0 && i + values.length <= consts.length; i += 1) {
      if (values.every((v, k) => Object.is(consts[i + k], f32(v)))) return i;
    }
    const at = consts.length;
    for (const v of values) consts.push(f32(v));
    return at;
  };
  /** @type {string[]} */
  const strings = [];
  /** @param {string} text */
  const string = (text) => {
    let index = strings.indexOf(text);
    if (index < 0) {
      index = strings.length;
      strings.push(text);
    }
    return index;
  };

  // Arena: one value slot per node; a native op's value is its state slot 0.
  let arena = 0;
  /** @type {number[]} */
  const slot = [];
  for (const node of nodes) {
    const layout = NATIVE_LAYOUT[node.op];
    slot.push(arena);
    arena += layout ? layout.state + (OPS[node.op].windowKey ? Math.trunc(Number(node.window ?? 0)) : 0) : 1;
  }

  const asm = new Assembler();
  const nodeLabel = nodes.map(() => asm.newLabel());
  const endLabel = asm.newLabel();
  /** @type {[number, number][]} */
  const init = [];
  nodes.forEach((node, i) => {
    asm.bind(nodeLabel[i]);
    const refs = inputsOf(node.in);
    const load = (/** @type {number} */ k) => asm.op("loadg", slot[refs[k]]);
    const op = String(node.op);
    if (op === "const") {
      asm.op("pushk", constant(Number(node.value ?? 0)));
      asm.op("storeg", slot[i]);
    } else if (op in PURE_BINARY) {
      load(0);
      load(1);
      asm.op(PURE_BINARY[/** @type {keyof typeof PURE_BINARY} */ (op)]);
      asm.op("storeg", slot[i]);
    } else if (op in PURE_UNARY) {
      load(0);
      asm.op(PURE_UNARY[/** @type {keyof typeof PURE_UNARY} */ (op)]);
      asm.op("storeg", slot[i]);
    } else if (op === "clamp") {
      load(0);
      asm.op("pushk", constant(Number(node.lo ?? 0)));
      asm.op("pushk", constant(Number(node.hi ?? 0)));
      asm.op("clamp");
      asm.op("storeg", slot[i]);
    } else if (op === "feature_get") {
      const field = FEATURE_FIELDS.indexOf(String(node.field));
      if (field < 0 || nodes[refs[0]]?.op !== "features") throw new Error("feature_get_input_must_be_features");
      asm.op("loadg", slot[refs[0]] + 1 + field);
      asm.op("storeg", slot[i]);
    } else if (op === "select") {
      const otherwise = asm.newLabel();
      const done = asm.newLabel();
      load(0);
      asm.jump("jz", otherwise);
      load(1);
      asm.jump("jmp", done);
      asm.bind(otherwise);
      load(2);
      asm.bind(done);
      asm.op("storeg", slot[i]);
    } else if (op === "gate") {
      load(0);
      asm.op("storeg", slot[i]);
      const span = Number(node.span ?? 0) & 0xff;
      const until = Math.min(i + 1 + span, nodes.length);
      if (span > 0 && until > i + 1) {
        const open = asm.newLabel();
        asm.op("loadg", slot[i]);
        asm.jump("jnz", open);
        asm.op("degraded");
        asm.jump("jmp", until < nodes.length ? nodeLabel[until] : endLabel);
        asm.bind(open);
      }
    } else if (NATIVE_LAYOUT[op]) {
      const layout = NATIVE_LAYOUT[op];
      for (let k = 0; k < OPS[op].inputs; k += 1) load(k);
      const values = layout.params.map((key) => nativeParam(node, key, string));
      const param = values.length > 0 ? record(values) : 0;
      asm.op("nat", flowOpNumber(op), slot[i], param);
      asm.op("pop");
      if (op === "delta" && Number(node.value ?? 0) !== 0) init.push([slot[i] + 1, constant(Number(node.value))]);
    } else {
      throw new Error(`cannot lower op ${op}`);
    }
  });
  asm.bind(endLabel);
  asm.op("end");
  const code = asm.finish();

  /** @type {Record<string, number>} */
  const entries = { frame: 0 };
  if (caps.has("tick")) entries.idle_tick = 0;
  /** @type {VmImageParts} */
  const parts = {
    code,
    consts,
    strings,
    functions: [{ pc: 0, base: 0, args: 0, locals: 0, rets: 0 }],
    entries,
    init,
    nodes: nodes.map((node, i) => ({
      op: flowOpNumber(String(node.op)),
      flags: (node.persist ? 1 : 0) | (isBooleanNode(node) ? 2 : 0),
      slot: slot[i],
    })),
    arena,
    stack: VM_MAX_STACK,
  };
  // Size the stack to what the verifier proves is needed.
  const draft = encodeImage(parts);
  const verified = verifyImage(draft, { capabilities: [...caps] });
  parts.stack = Math.max(1, verified.maxStack);
  return encodeImage(parts);
}

/** @param {Record<string, any>} node */
function isBooleanNode(node) {
  if (node.op === "feature_get") return true;
  return OPS[node.op]?.boolean === true || node.op === "gate" || node.op === "ext_pixel";
}

/**
 * @param {Record<string, any>} node
 * @param {string} key
 * @param {(text: string) => number} string
 */
function nativeParam(node, key, string) {
  switch (key) {
    case "event": return string(String(node.event ?? ""));
    case "label": return string(String(node.label ?? ""));
    case "persist": return node.persist ? 1 : 0;
    case "fall": return node.fall ? 1 : 0;
    case "r": case "g": case "b": {
      const rgb = LED_COLOURS[String(node.rgb)];
      if (!rgb) throw new Error(`unknown_colour:${String(node.rgb)}`);
      return rgb["rgb".indexOf(key)];
    }
    case "field": {
      const names = node.op === "imu" ? IMU_FIELDS : MAG_FIELDS;
      const index = names.indexOf(String(node.field));
      if (index < 0) throw new Error(`unknown_field:${String(node.field)}`);
      return index;
    }
    case "rel": return Number(node.rel ?? 0);
    case "ms": return Number(node.ms ?? 0) > 0 ? Number(node.ms) & 0xffff : 0;
    case "r0": case "c0": case "r1": case "c1": return Number(node[key] ?? 0) & 0xff;
    case "index": return Number(node.index ?? 0);
    case "row": return Number(node.row ?? 0);
    case "digits": return Number(node.digits ?? 0);
    case "window": return Math.trunc(Number(node.window ?? 0));
    default: return Number(node[key] ?? 0);
  }
}

// --- base64 ------------------------------------------------------------------------

/** @param {Uint8Array} bytes */
export function toBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** @param {string} text */
export function fromBase64(text) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new VmImageError("image_bad_base64");
  const binary = atob(text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// --- interpreter -----------------------------------------------------------------

/**
 * What one run of a handler sees. Mirrors AppEvent.
 * @typedef {object} VmContext
 * @property {number} nowMs
 * @property {number} frameSeq
 * @property {{values: ArrayLike<number>, rows: number, cols: number}|null} frame
 * @property {ArrayLike<number>|null} imu
 * @property {ArrayLike<number>|null} mag
 * @property {number} battery
 * @property {boolean} linked
 */

/**
 * Where a run's side effects go.
 * @typedef {object} VmHost
 * @property {(event: string, detail: string) => void} emitEvent
 * @property {(event: string, value: number) => void} emitValue
 * @property {(text: string, value: number) => void} log
 * @property {(on: boolean, rgb: readonly [number, number, number], state: number) => void} led
 */

const RUN_DONE = "done";
const RUN_SUSPENDED = "suspended";
const RUN_FAULT = "fault";

/** Truncation to uint32 the way the bit ops define it. @param {number} x */
function toU32(x) {
  if (!(x > 0)) return 0;
  if (x >= 4294967295) return 4294967295;
  return Math.floor(x) >>> 0;
}

export class VmMachine {
  /**
   * @param {Uint8Array} bytes a verified image
   * @param {{capabilities?: readonly string[]|number}} [options]
   */
  constructor(bytes, options = {}) {
    const verified = verifyImage(bytes, options);
    this.image = verified.image;
    this.verified = verified;
    this.caps = capMask(options.capabilities ?? []);
    const buffer = new ArrayBuffer(this.image.arena * 4);
    this.f = new Float32Array(buffer);
    this.u = new Uint32Array(buffer);
    this.stack = new Float32Array(this.image.stack);
    this.reset();
  }

  /** Clears every value and state, then applies the image's initialisers. */
  reset() {
    this.f.fill(0);
    for (const [slot, k] of this.image.init) this.f[slot] = this.image.consts[k];
    this.pc = 0;
    this.sp = 0;
    this.fn = 0;
    /** @type {{pc: number, fn: number}[]} */
    this.calls = [];
    this.suspended = false;
    this.fault = 0;
    this.runDegraded = false;
    this.pressed = false;
    this.budgetLoad = 0;
    this.graceLeft = 0;
    this.persistDirty = false;
    /** @type {number[]} */
    this.displayPc = new Array(OLED_ROWS).fill(NO_PC);
    /** @type {number[]} */
    this.pixelPc = new Array(MAX_EXT_LEDS).fill(NO_PC);
    this.meterPc = NO_PC;
    this.ledHeld = false;
    /** @type {[number, number, number]} */
    this.ledRgb = [0, 0, 0];
  }

  /** @param {number} event @returns {boolean} */
  hasEntry(event) {
    return this.image.entries.has(event);
  }

  /**
   * Starts a handler (a fresh run): resets pc/sp and the per-run outputs.
   * @param {number} event
   * @param {boolean} pressed the button value this run reads
   */
  begin(event, pressed) {
    const fn = /** @type {number} */ (this.image.entries.get(event));
    this.fn = fn;
    this.pc = this.image.functions[fn].pc;
    this.sp = 0;
    this.calls = [];
    this.runDegraded = false;
    this.pressed = pressed;
    this.displayPc.fill(NO_PC);
    this.pixelPc.fill(NO_PC);
    this.meterPc = NO_PC;
    this.suspended = true;
  }

  /**
   * Runs the current handler until it ends, faults, or spends `fuelLimit`.
   * @param {VmContext} ctx
   * @param {VmHost} host
   * @param {number} [fuelLimit]
   * @returns {"done"|"suspended"|"fault"}
   */
  run(ctx, host, fuelLimit = Infinity) {
    const { code, consts, functions } = this.image;
    const f = this.f;
    const u = this.u;
    const st = this.stack;
    let pc = this.pc;
    let sp = this.sp;
    let fuel = 0;
    const cells = ctx.frame ? ctx.frame.values.length : 0;
    const u16 = (/** @type {number} */ at) => code[at] | (code[at + 1] << 8);
    const stop = (/** @type {number} */ fault) => {
      this.fault = fault;
      this.suspended = false;
      this.pc = pc;
      this.sp = sp;
      return RUN_FAULT;
    };
    for (;;) {
      if (fuel >= fuelLimit) {
        this.pc = pc;
        this.sp = sp;
        return RUN_SUSPENDED;
      }
      const opcode = code[pc];
      fuel += 1;
      switch (opcode) {
        case 0: { // end
          this.pc = pc;
          this.sp = 0;
          this.calls = [];
          this.suspended = false;
          return RUN_DONE;
        }
        case 1: st[sp++] = consts[u16(pc + 1)]; pc += 3; break;
        case 2: st[sp++] = 0; pc += 1; break;
        case 3: st[sp++] = 1; pc += 1; break;
        case 4: sp -= 1; pc += 1; break;
        case 5: st[sp] = st[sp - 1]; sp += 1; pc += 1; break;
        case 6: { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; pc += 1; break; }
        case 7: st[sp++] = f[u16(pc + 1)]; pc += 3; break;
        case 8: f[u16(pc + 1)] = st[--sp]; pc += 3; break;
        case 9: st[sp++] = f[functions[this.fn].base + code[pc + 1]]; pc += 2; break;
        case 10: f[functions[this.fn].base + code[pc + 1]] = st[--sp]; pc += 2; break;
        case 11: { // aload base len: i -> v
          const base = u16(pc + 1);
          const len = u16(pc + 3);
          const i = st[sp - 1];
          if (!(i >= 0 && i < len) || i !== Math.floor(i)) return stop(1);
          st[sp - 1] = f[base + i];
          pc += 5;
          break;
        }
        case 12: { // astore base len: i v ->
          const base = u16(pc + 1);
          const len = u16(pc + 3);
          const v = st[--sp];
          const i = st[--sp];
          if (!(i >= 0 && i < len) || i !== Math.floor(i)) return stop(1);
          f[base + i] = v;
          pc += 5;
          break;
        }
        case 13: sp -= 1; st[sp - 1] = st[sp - 1] + st[sp]; pc += 1; break;
        case 14: sp -= 1; st[sp - 1] = st[sp - 1] - st[sp]; pc += 1; break;
        case 15: sp -= 1; st[sp - 1] = st[sp - 1] * st[sp]; pc += 1; break;
        case 16: sp -= 1; st[sp - 1] = st[sp] !== 0 ? st[sp - 1] / st[sp] : 0; pc += 1; break;
        case 17: sp -= 1; st[sp - 1] = st[sp] !== 0 ? st[sp - 1] % st[sp] : 0; pc += 1; break;
        case 18: st[sp - 1] = -st[sp - 1]; pc += 1; break;
        case 19: st[sp - 1] = Math.abs(st[sp - 1]); pc += 1; break;
        case 20: { sp -= 1; const a = st[sp - 1]; const b = st[sp]; st[sp - 1] = a < b ? a : b; pc += 1; break; }
        case 21: { sp -= 1; const a = st[sp - 1]; const b = st[sp]; st[sp - 1] = a > b ? a : b; pc += 1; break; }
        case 22: st[sp - 1] = Math.floor(st[sp - 1]); pc += 1; break;
        case 23: st[sp - 1] = sqrtSafe(st[sp - 1]); pc += 1; break;
        case 24: sp -= 1; st[sp - 1] = atan2Deg(st[sp - 1], st[sp]); pc += 1; break;
        case 25: { // clamp v lo hi
          sp -= 2;
          let v = st[sp - 1];
          const lo = st[sp];
          const hi = st[sp + 1];
          if (v < lo) v = lo;
          if (v > hi) v = hi;
          st[sp - 1] = v;
          pc += 1;
          break;
        }
        case 26: sp -= 1; st[sp - 1] = st[sp - 1] < st[sp] ? 1 : 0; pc += 1; break;
        case 27: sp -= 1; st[sp - 1] = st[sp - 1] <= st[sp] ? 1 : 0; pc += 1; break;
        case 28: sp -= 1; st[sp - 1] = st[sp - 1] > st[sp] ? 1 : 0; pc += 1; break;
        case 29: sp -= 1; st[sp - 1] = st[sp - 1] >= st[sp] ? 1 : 0; pc += 1; break;
        case 30: sp -= 1; st[sp - 1] = st[sp - 1] === st[sp] ? 1 : 0; pc += 1; break;
        case 31: sp -= 1; st[sp - 1] = st[sp - 1] !== st[sp] ? 1 : 0; pc += 1; break;
        case 32: st[sp - 1] = st[sp - 1] !== 0 ? 0 : 1; pc += 1; break;
        case 33: sp -= 1; st[sp - 1] = st[sp - 1] !== 0 && st[sp] !== 0 ? 1 : 0; pc += 1; break;
        case 34: sp -= 1; st[sp - 1] = st[sp - 1] !== 0 || st[sp] !== 0 ? 1 : 0; pc += 1; break;
        case 35: sp -= 1; st[sp - 1] = (toU32(st[sp - 1]) & toU32(st[sp])) >>> 0; pc += 1; break;
        case 36: sp -= 1; st[sp - 1] = (toU32(st[sp - 1]) | toU32(st[sp])) >>> 0; pc += 1; break;
        case 37: sp -= 1; st[sp - 1] = (toU32(st[sp - 1]) ^ toU32(st[sp])) >>> 0; pc += 1; break;
        case 38: sp -= 1; st[sp - 1] = (toU32(st[sp - 1]) << (toU32(st[sp]) & 31)) >>> 0; pc += 1; break;
        case 39: sp -= 1; st[sp - 1] = toU32(st[sp - 1]) >>> (toU32(st[sp]) & 31); pc += 1; break;
        case 40: pc += 3 + ((u16(pc + 1) << 16) >> 16); break;
        case 41: { const v = st[--sp]; pc += v === 0 ? 3 + ((u16(pc + 1) << 16) >> 16) : 3; break; }
        case 42: { const v = st[--sp]; pc += v !== 0 ? 3 + ((u16(pc + 1) << 16) >> 16) : 3; break; }
        case 43: { // call
          const callee = functions[u16(pc + 1)];
          if (this.calls.length >= VM_MAX_CALL_DEPTH) return stop(2);
          this.calls.push({ pc: pc + 3, fn: this.fn });
          for (let k = 0; k < callee.locals; k += 1) f[callee.base + k] = 0;
          for (let k = callee.args - 1; k >= 0; k -= 1) f[callee.base + k] = st[--sp];
          this.fn = u16(pc + 1);
          pc = callee.pc;
          break;
        }
        case 44: { // ret
          const back = this.calls.pop();
          if (!back) return stop(3);
          this.fn = back.fn;
          pc = back.pc;
          break;
        }
        case 45: { // nat
          const op = code[pc + 1];
          const state = u16(pc + 2);
          const param = u16(pc + 4);
          const name = /** @type {string} */ (flowOpName(op));
          const inputs = OPS[name].inputs;
          sp -= inputs;
          fuel += nativeFuel(name, cells) - 1;
          this.native(name, state, param, st, sp, ctx, host, pc);
          st[sp++] = f[state];
          pc += 6;
          break;
        }
        case 46: { // sys
          const sys = VM_SYSCALLS[u16(pc + 1)];
          sp -= sys.args;
          const result = this.syscall(sys.name, st, sp, ctx, host);
          if (result === null) return stop(4);
          if (sys.results > 0) st[sp++] = result;
          fuel += sys.fuel - 1;
          pc += 3;
          break;
        }
        case 47: this.runDegraded = true; pc += 1; break;
        default:
          return stop(8);
      }
    }
  }

  /**
   * @param {string} name
   * @param {Float32Array} st
   * @param {number} sp first argument
   * @param {VmContext} ctx
   * @param {VmHost} host
   * @returns {number|null} null on a bad argument
   */
  syscall(name, st, sp, ctx, host) {
    switch (name) {
      case "now_ms": return ctx.nowMs % 16777216;
      case "frame_seq": return ctx.frameSeq % 16777216;
      case "rows": return ctx.frame ? ctx.frame.rows : 0;
      case "cols": return ctx.frame ? ctx.frame.cols : 0;
      case "cell": {
        const r = st[sp];
        const c = st[sp + 1];
        const frame = ctx.frame;
        if (!frame) return 0;
        if (!(r >= 0 && r < frame.rows && c >= 0 && c < frame.cols) || r !== Math.floor(r) || c !== Math.floor(c)) return null;
        const index = r * frame.cols + c;
        return index < frame.values.length ? f32(frame.values[index]) : 0;
      }
      case "emit_value": {
        const s = st[sp];
        if (!(Number.isInteger(s) && s >= 0 && s < this.image.strings.length)) return null;
        host.emitValue(this.image.strings[s], st[sp + 1]);
        return 0;
      }
      case "log": {
        const s = st[sp];
        if (!(Number.isInteger(s) && s >= 0 && s < this.image.strings.length)) return null;
        host.log(this.image.strings[s], st[sp + 1]);
        return 0;
      }
      default: return null;
    }
  }

  /**
   * One native operator: FlowApp::evaluate's case for `name`, on its state
   * record. Inputs are st[sp], st[sp+1], st[sp+2].
   * @param {string} name
   * @param {number} s state slot
   * @param {number} p parameter record
   * @param {Float32Array} st
   * @param {number} sp
   * @param {VmContext} ctx
   * @param {VmHost} host
   * @param {number} pc the NAT instruction, which the outputs record
   */
  native(name, s, p, st, sp, ctx, host, pc) {
    const f = this.f;
    const u = this.u;
    const k = this.image.consts;
    const frame = ctx.frame;
    const a = st[sp];
    const b = st[sp + 1];
    const now = ctx.nowMs >>> 0;
    // On a tick there is no frame: every read of the matrix holds its value.
    if (!frame && OPS[name].sweep) return;
    const values = frame ? frame.values : [];
    const cells = values.length;
    switch (name) {
      case "total": {
        let sum = 0;
        for (let c = 0; c < cells; c += 1) sum = f32(sum + values[c]);
        f[s] = sum;
        break;
      }
      case "peak": {
        let peak = 0;
        for (let c = 0; c < cells; c += 1) if (f32(values[c]) > peak) peak = f32(values[c]);
        f[s] = peak;
        break;
      }
      case "region_sum":
      case "region_peak":
      case "region_active":
      case "region_row_centroid":
      case "region_col_centroid": {
        const fr = /** @type {NonNullable<typeof frame>} */ (frame);
        const rel = k[p + 4];
        const rs = resolveSpan(k[p], k[p + 2], (rel & REL_ROWS) !== 0, fr.rows);
        const cs = resolveSpan(k[p + 1], k[p + 3], (rel & REL_COLS) !== 0, fr.cols);
        const limit = k[p + 5];
        let sum = 0;
        let peak = 0;
        let active = 0;
        let weighted = 0;
        for (let r = rs.lo; r <= rs.hi && r < fr.rows; r += 1) {
          for (let c = cs.lo; c <= cs.hi && c < fr.cols; c += 1) {
            const index = r * fr.cols + c;
            if (index >= cells) continue;
            const value = f32(values[index]);
            if (name === "region_sum") sum = f32(sum + value);
            else if (name === "region_peak") { if (value > peak) peak = value; }
            else if (name === "region_active") { if (value >= limit) active += 1; }
            else if (value >= ACTIVE) {
              sum = f32(sum + value);
              weighted = f32(weighted + f32(value * (name === "region_row_centroid" ? r : c)));
            }
          }
        }
        if (name === "region_sum") f[s] = sum;
        else if (name === "region_peak") f[s] = peak;
        else if (name === "region_active") f[s] = active;
        else f[s] = sum > 0 ? f32(weighted / sum) : 0;
        break;
      }
      case "active_cells": {
        const limit = k[p];
        let active = 0;
        for (let c = 0; c < cells; c += 1) if (f32(values[c]) >= limit) active += 1;
        f[s] = active;
        break;
      }
      case "arg_max": {
        let peak = 0;
        let index = 0;
        for (let c = 0; c < cells; c += 1) {
          if (f32(values[c]) > peak) { peak = f32(values[c]); index = c; }
        }
        f[s] = index;
        break;
      }
      case "row_centroid":
      case "col_centroid": {
        const cols = frame && frame.cols ? frame.cols : 1;
        let total = 0;
        let weighted = 0;
        for (let c = 0; c < cells; c += 1) {
          const value = f32(values[c]);
          if (value < ACTIVE) continue;
          total = f32(total + value);
          weighted = f32(weighted + f32(value * (name === "row_centroid" ? Math.floor(c / cols) : c % cols)));
        }
        f[s] = total > 0 ? f32(weighted / total) : 0;
        break;
      }
      case "features": {
        const cols = frame && frame.cols ? frame.cols : 1;
        let total = 0;
        let peak = 0;
        let peakIndex = 0;
        let active = 0;
        let weightedRow = 0;
        let weightedCol = 0;
        for (let i = 0; i < cells; i += 1) {
          const value = f32(values[i]);
          total = f32(total + value);
          if (value > peak) { peak = value; peakIndex = i; }
          if (value >= ACTIVE) {
            active += 1;
            weightedRow = f32(weightedRow + f32(value * Math.floor(i / cols)));
            weightedCol = f32(weightedCol + f32(value * (i % cols)));
          }
        }
        let peak01 = f32(peak / FULL_SCALE);
        if (peak01 > 1) peak01 = 1;
        f[s + 1] = total;
        f[s + 2] = peak;
        f[s + 3] = peak01;
        f[s + 4] = peakIndex;
        f[s + 5] = active;
        f[s + 6] = total > 0 ? f32(weightedRow / total) : 0;
        f[s + 7] = total > 0 ? f32(weightedCol / total) : 0;
        f[s + 8] = active > 0 ? 1 : 0;
        f[s] = total;
        break;
      }
      case "threshold": {
        const releaseAt = f32(k[p] - k[p + 1]);
        const latched = f[s] !== 0;
        f[s] = (latched ? a > releaseAt : a >= k[p]) ? 1 : 0;
        break;
      }
      case "debounce": {
        // s: value, s+1: last raw, s+2: since (uint32)
        const raw = a !== 0 ? 1 : 0;
        if (raw !== f[s + 1]) {
          f[s + 1] = raw;
          u[s + 2] = now;
        } else if (raw !== f[s] && ((now - u[s + 2]) >>> 0) >= k[p]) {
          f[s] = raw;
        }
        break;
      }
      case "emit": {
        const current = a !== 0 ? 1 : 0;
        if (current !== f[s + 1]) {
          f[s + 1] = current;
          host.emitEvent(this.image.strings[k[p]], current ? "rise" : "fall");
        }
        break;
      }
      case "emit_value": {
        const current = a !== 0;
        const last = f[s + 1] !== 0;
        const edge = k[p + 1] !== 0 ? !current && last : current && !last;
        if (edge) host.emitValue(this.image.strings[k[p]], b);
        f[s + 1] = current ? 1 : 0;
        break;
      }
      case "led": {
        const current = a !== 0 ? 1 : 0;
        if (current !== f[s + 1]) {
          f[s + 1] = current;
          this.ledHeld = current === 1;
          this.ledRgb = [k[p], k[p + 1], k[p + 2]];
          host.led(current === 1, this.ledRgb, s);
        }
        break;
      }
      case "mean":
      case "max_hold":
      case "integrate": {
        // s: value, s+1: cursor, s+2: filled, s+3..: ring
        const window = k[p];
        const ring = s + 3;
        let cursor = u[s + 1];
        let filled = u[s + 2];
        f[ring + cursor] = a;
        cursor = (cursor + 1) % window;
        if (filled < window) filled += 1;
        u[s + 1] = cursor;
        u[s + 2] = filled;
        if (name === "max_hold") {
          let peak = f[ring];
          for (let i = 1; i < filled; i += 1) if (f[ring + i] > peak) peak = f[ring + i];
          f[s] = peak;
        } else {
          let sum = 0;
          for (let i = 0; i < filled; i += 1) sum = f32(sum + f[ring + i]);
          f[s] = name === "integrate" ? sum : filled > 0 ? f32(sum / filled) : 0;
        }
        break;
      }
      case "delta": {
        f[s] = f32(a - f[s + 1]);
        f[s + 1] = a;
        break;
      }
      case "counter": {
        const current = a !== 0 ? 1 : 0;
        if (current && !f[s + 1]) {
          f[s] = f32(f[s] + 1);
          if (k[p]) this.persistDirty = true;
        }
        f[s + 1] = current;
        break;
      }
      case "counter_reset": {
        // s+1: last a, s+2: last b. The reset first, so an edge that arrives
        // with it still counts.
        const reset = b !== 0 ? 1 : 0;
        if (reset && !f[s + 2] && f[s] !== 0) {
          f[s] = 0;
          if (k[p]) this.persistDirty = true;
        }
        f[s + 2] = reset;
        const current = a !== 0 ? 1 : 0;
        if (current && !f[s + 1]) {
          f[s] = f32(f[s] + 1);
          if (k[p]) this.persistDirty = true;
        }
        f[s + 1] = current;
        break;
      }
      case "duration": {
        const current = a !== 0 ? 1 : 0;
        if (current && !f[s + 1]) u[s + 2] = now;
        f[s + 1] = current;
        f[s] = current ? f32((now - u[s + 2]) >>> 0) : 0;
        break;
      }
      case "interval": {
        // s+3: a first rise has been seen
        const current = a !== 0 ? 1 : 0;
        if (current && !f[s + 1]) {
          if (f[s + 3] !== 0) f[s] = f32((now - u[s + 2]) >>> 0);
          u[s + 2] = now;
          f[s + 3] = 1;
        }
        f[s + 1] = current;
        break;
      }
      case "peak_since": {
        // s+1: last reset, s+2: filled
        const reset = b !== 0 ? 1 : 0;
        if ((reset && !f[s + 1]) || f[s + 2] === 0) {
          f[s] = a;
          f[s + 2] = 1;
        } else if (a > f[s]) {
          f[s] = a;
        }
        f[s + 1] = reset;
        break;
      }
      case "imu":
        if (ctx.imu) f[s] = imuField(ctx.imu, k[p]);
        break;
      case "mag":
        if (ctx.mag) f[s] = magField(ctx.mag, k[p]);
        break;
      case "battery": f[s] = ctx.battery; break;
      case "linked": f[s] = ctx.linked ? 1 : 0; break;
      case "uptime": f[s] = f32(f32(now) / 1000); break;
      case "budget_load": f[s] = this.budgetLoad; break;
      case "grace_left": f[s] = this.graceLeft; break;
      case "button": f[s] = this.pressed ? 1 : 0; break;
      case "oled_text":
      case "oled_bar":
        // Only recorded; the display pulls it. The later of two on a row wins.
        f[s] = a;
        this.displayPc[k[p]] = pc;
        break;
      case "ext_pixel":
        f[s] = a !== 0 ? 1 : 0;
        if (a !== 0) this.pixelPc[k[p]] = pc;
        break;
      case "ext_meter":
        f[s] = a;
        this.meterPc = pc;
        break;
      default:
        break;
    }
  }

  /** The parameter record of the native op whose state starts at `state`. @param {number} state */
  nativeAt(state) {
    const code = this.image.code;
    for (let pc = 0; pc < code.length;) {
      const insn = decodeInsn(code, pc);
      if (!insn) break;
      if (insn.spec.name === "nat" && insn.args[1] === state) {
        return { name: /** @type {string} */ (flowOpName(insn.args[0])), param: insn.args[2] };
      }
      pc += insn.size;
    }
    return null;
  }
}

/**
 * A readable listing of an image's code, for authors and for debugging.
 * @param {Uint8Array} bytes
 */
export function disassemble(bytes) {
  const image = decodeImage(bytes);
  const lines = [];
  for (let pc = 0; pc < image.code.length;) {
    const insn = decodeInsn(image.code, pc);
    if (!insn) {
      lines.push(`${String(pc).padStart(4)}  ??`);
      break;
    }
    let text = insn.spec.name;
    if (insn.spec.name === "nat") text += ` ${flowOpName(insn.args[0])} state=${insn.args[1]} param=${insn.args[2]}`;
    else if (insn.spec.name === "pushk") text += ` ${insn.args[0]} (${image.consts[insn.args[0]]})`;
    else if (["jmp", "jz", "jnz"].includes(insn.spec.name)) text += ` -> ${pc + insn.size + insn.args[0]}`;
    else if (insn.args.length > 0) text += ` ${insn.args.join(" ")}`;
    lines.push(`${String(pc).padStart(4)}  ${text}`);
    pc += insn.size;
  }
  return lines.join("\n");
}

export { RUN_DONE, RUN_FAULT, RUN_SUSPENDED, NO_PC, VM_FUEL_CHECK };
