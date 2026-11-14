// @ts-check
/**
 * NHVM/1: the instruction set, the native operators' layouts, the system
 * calls and the image format -- the single source of truth for the app VM
 * (docs/vm.md). `vm.mjs` (the JavaScript VM, verifier and assembler) and the
 * firmware's `AppVm` read these tables; `contract.mjs` generates the
 * firmware's copy into AppContract.h, so the two cannot drift.
 *
 * Every number here is append-only once a firmware that knows it has shipped:
 * opcodes, system-call ids and event ids are written into packages.
 */

import { OPS } from "./opset.mjs";

export const VM_IMAGE_MAGIC = [0x4e, 0x56]; // "NV"
export const VM_IMAGE_VERSION = 1;
export const VM_HEADER_BYTES = 20;
export const VM_FN_BYTES = 8;
export const VM_ENTRY_BYTES = 2;
export const VM_INIT_BYTES = 4;
export const VM_NODE_BYTES = 4;

// Hard limits, mirrored in the firmware (AppVm.h).
export const VM_MAX_CODE = 8192;
export const VM_MAX_CONSTS = 512;
export const VM_MAX_ARENA = 1536; // slots of 4 bytes
export const VM_MAX_STACK = 64;
export const VM_MAX_FUNCTIONS = 32;
export const VM_MAX_STRINGS = 32;
export const VM_MAX_STRING = 23;
export const VM_MAX_CALL_DEPTH = 8;
export const VM_MAX_NODES = 32;
// The interpreter reads the clock every this many fuel units.
export const VM_FUEL_CHECK = 64;
// A frame handler that has not finished for this long is stopped (`starved`).
export const VM_STARVED_MS = 5000;
// Static cost of one plain instruction, for the loop-free estimate. Deliberate
// over-estimate, like the op costs in opset.mjs.
export const VM_INSN_NS = 80;
// The first version that runs NHVM/1 images. A package carrying an image needs it.
export const VM_MIN_OS = "v2.0.0";
// The first version that runs packages from the TypeScript compiler (no
// `nodes`, message handlers, the v2.1.0 system calls).
export const VM_TS_MIN_OS = "v2.1.0";

/** Handler entry points, by event. Numbers are written into images. */
export const VM_EVENTS = Object.freeze({
  start: 0,
  frame: 1,
  tick: 2,
  button: 3,
  message: 4,
  budget: 5,
  stop: 6,
  // The legacy `background yes`: the 10 Hz tick, but only while no frame has
  // arrived for TICK_FALLBACK_MS, so it never runs twice per frame.
  idle_tick: 7,
});

/**
 * @typedef {object} VmOpSpec
 * @property {string} name
 * @property {number} code
 * @property {string} operands "", "u16", "u8", "i16", "u16u16", "nat"
 * @property {number} pops
 * @property {number} pushes
 */

/** @param {string} name @param {string} operands @param {number} pops @param {number} pushes */
const insn = (name, operands, pops, pushes) => ({ name, operands, pops, pushes });

/**
 * In opcode order: the index is the opcode byte. APPEND only.
 * Stack effects of CALL, RET and NAT depend on their operands (-1 here).
 */
const OPCODE_LIST = [
  insn("end", "", 0, 0),
  insn("pushk", "u16", 0, 1),
  insn("push0", "", 0, 1),
  insn("push1", "", 0, 1),
  insn("pop", "", 1, 0),
  insn("dup", "", 1, 2),
  insn("swap", "", 2, 2),
  insn("loadg", "u16", 0, 1),
  insn("storeg", "u16", 1, 0),
  insn("loadl", "u8", 0, 1),
  insn("storel", "u8", 1, 0),
  insn("aload", "u16u16", 1, 1),
  insn("astore", "u16u16", 2, 0),
  insn("add", "", 2, 1),
  insn("sub", "", 2, 1),
  insn("mul", "", 2, 1),
  insn("div", "", 2, 1),
  insn("mod", "", 2, 1),
  insn("neg", "", 1, 1),
  insn("abs", "", 1, 1),
  insn("min", "", 2, 1),
  insn("max", "", 2, 1),
  insn("floor", "", 1, 1),
  insn("sqrt", "", 1, 1),
  insn("atan2", "", 2, 1),
  insn("clamp", "", 3, 1),
  insn("lt", "", 2, 1),
  insn("le", "", 2, 1),
  insn("gt", "", 2, 1),
  insn("ge", "", 2, 1),
  insn("eq", "", 2, 1),
  insn("ne", "", 2, 1),
  insn("not", "", 1, 1),
  insn("and", "", 2, 1),
  insn("or", "", 2, 1),
  insn("band", "", 2, 1),
  insn("bor", "", 2, 1),
  insn("bxor", "", 2, 1),
  insn("shl", "", 2, 1),
  insn("shr", "", 2, 1),
  insn("jmp", "i16", 0, 0),
  insn("jz", "i16", 1, 0),
  insn("jnz", "i16", 1, 0),
  insn("call", "u16", -1, -1),
  insn("ret", "u8", -1, -1),
  insn("nat", "nat", -1, 1),
  insn("sys", "u16", -1, -1),
  // Marks this run as degraded: a gate skipped work. Recorded as the
  // `degraded` rise/fall event when the handler ends.
  insn("degraded", "", 0, 0),
];

/** @type {Readonly<Record<string, VmOpSpec>>} */
export const VM_OPS = Object.freeze(Object.fromEntries(
  OPCODE_LIST.map((spec, code) => [spec.name, Object.freeze({ ...spec, code })]),
));
/** @type {readonly VmOpSpec[]} */
export const VM_OPCODES = Object.freeze(OPCODE_LIST.map((spec, code) => Object.freeze({ ...spec, code })));

/** Operand bytes after the opcode. */
export const OPERAND_BYTES = Object.freeze({ "": 0, u8: 1, u16: 2, i16: 2, u16u16: 4, nat: 5 });

/**
 * Native operators: the flow ops that keep state, sweep the matrix, read a
 * sensor or drive an output, run as one `NAT op state param` instruction.
 * `op` is the FlowOp number (opset.mjs order, 1-based), so the numbering the
 * device persists with counter values carries over.
 *
 * `params` names the parameter record the op reads from the constants, in
 * order; `state` is the arena slots it keeps (its result is always slot 0),
 * plus `window` more for a windowed op. Ops not listed here are compiled into
 * plain instructions and are not valid as NAT.
 */
const REGION_PARAMS = ["r0", "c0", "r1", "c1", "rel", "value"];
/** @type {Readonly<Record<string, {params: readonly string[], state: number}>>} */
export const NATIVE_LAYOUT = Object.freeze({
  total: { params: [], state: 1 },
  peak: { params: [], state: 1 },
  region_sum: { params: REGION_PARAMS, state: 1 },
  active_cells: { params: ["value"], state: 1 },
  threshold: { params: ["value", "hysteresis"], state: 1 },
  debounce: { params: ["ms"], state: 3 },
  emit: { params: ["event"], state: 2 },
  mean: { params: ["window"], state: 3 },
  max_hold: { params: ["window"], state: 3 },
  delta: { params: [], state: 2 },
  integrate: { params: ["window"], state: 3 },
  counter: { params: ["persist"], state: 2 },
  features: { params: [], state: 9 },
  arg_max: { params: [], state: 1 },
  row_centroid: { params: [], state: 1 },
  col_centroid: { params: [], state: 1 },
  led: { params: ["r", "g", "b"], state: 2 },
  emit_value: { params: ["event", "fall"], state: 2 },
  budget_load: { params: [], state: 1 },
  grace_left: { params: [], state: 1 },
  button: { params: [], state: 1 },
  oled_text: { params: ["row", "label", "digits"], state: 1 },
  oled_bar: { params: ["row", "label", "lo", "hi"], state: 1 },
  ext_pixel: { params: ["index", "r", "g", "b"], state: 1 },
  ext_meter: { params: ["lo", "hi"], state: 1 },
  duration: { params: [], state: 3 },
  interval: { params: [], state: 4 },
  peak_since: { params: [], state: 3 },
  counter_reset: { params: ["persist"], state: 3 },
  region_peak: { params: REGION_PARAMS, state: 1 },
  region_active: { params: REGION_PARAMS, state: 1 },
  region_row_centroid: { params: REGION_PARAMS, state: 1 },
  region_col_centroid: { params: REGION_PARAMS, state: 1 },
  imu: { params: ["field"], state: 1 },
  mag: { params: ["field"], state: 1 },
  battery: { params: [], state: 1 },
  linked: { params: [], state: 1 },
  uptime: { params: [], state: 1 },
});

/** FlowOp number of an op name (1-based; 0 is Invalid). @param {string} name */
export function flowOpNumber(name) {
  const index = Object.keys(OPS).indexOf(name);
  if (index < 0) throw new Error(`unknown op ${name}`);
  return index + 1;
}

/** Op name of a FlowOp number, or null. @param {number} number */
export function flowOpName(number) {
  return Object.keys(OPS)[number - 1] ?? null;
}

/**
 * Fuel one NAT costs: a sweep one unit per cell (features two), anything else 4.
 * @param {string} name
 * @param {number} cells
 */
export function nativeFuel(name, cells) {
  if (name === "features") return 2 * cells;
  return OPS[name]?.sweep ? cells : 4;
}

/**
 * System calls, by id. APPEND only. `cap` is the capability a package must
 * declare to use one, or null.
 * @type {readonly {name: string, id: number, cap: string|null, args: number, results: number, fuel: number}[]}
 */
export const VM_SYSCALLS = Object.freeze([
  { name: "now_ms", cap: null, args: 0, results: 1, fuel: 1 },
  { name: "frame_seq", cap: null, args: 0, results: 1, fuel: 1 },
  { name: "rows", cap: "read_matrix", args: 0, results: 1, fuel: 1 },
  { name: "cols", cap: "read_matrix", args: 0, results: 1, fuel: 1 },
  { name: "cell", cap: "read_matrix", args: 2, results: 1, fuel: 2 },
  { name: "emit_value", cap: "emit_event", args: 2, results: 0, fuel: 16 },
  { name: "log", cap: null, args: 2, results: 0, fuel: 16 },
  // v2.1.0. Strings are string-table indices; a key or file is matched on
  // the device by its FNV-1a hash, so a new version keeps its values.
  // store_get(key) -> value (0 if unset); store_set(key, v).
  { name: "store_get", cap: "storage", args: 1, results: 1, fuel: 8 },
  { name: "store_set", cap: "storage", args: 2, results: 0, fuel: 8 },
  // store_append(file, a, b, c, d) -> 1 written, 0 the 16 KB quota is full
  // (a NaN argument is an empty column).
  { name: "store_append", cap: "storage", args: 5, results: 1, fuel: 32 },
  { name: "store_clear", cap: "storage", args: 1, results: 0, fuel: 16 },
  // app_publish(topic, v): to every running app with a handler for topic.
  { name: "app_publish", cap: "app_ipc", args: 2, results: 0, fuel: 16 },
  // In a message handler: the value, and whether the topic is this string.
  { name: "msg_value", cap: "app_ipc", args: 0, results: 1, fuel: 1 },
  { name: "msg_is", cap: "app_ipc", args: 1, results: 1, fuel: 2 },
  // device_config_get(key) -> value; device_config_set(key, v) -> 1 applied,
  // 0 refused (not whitelisted, out of range, or more than once a second).
  // key is a string: a ConfigRegistry key on the whitelist.
  { name: "device_config_get", cap: "device_config", args: 1, results: 1, fuel: 8 },
  { name: "device_config_set", cap: "device_config", args: 2, results: 1, fuel: 32 },
  { name: "device_stream", cap: "device_stream", args: 1, results: 0, fuel: 8 },
  // I2C: addr, reg are 7-bit address and register. -1 on a NACK, a timeout or
  // a refused (system) address. read/write move n <= 32 bytes between the bus
  // and arena slots [base, base + n) of a Float32Array, one byte per slot.
  { name: "i2c_read8", cap: "io_i2c", args: 2, results: 1, fuel: 32 },
  { name: "i2c_read16", cap: "io_i2c", args: 2, results: 1, fuel: 32 },
  { name: "i2c_write8", cap: "io_i2c", args: 3, results: 1, fuel: 32 },
  { name: "i2c_read", cap: "io_i2c", args: 4, results: 1, fuel: 64 },
  { name: "i2c_write", cap: "io_i2c", args: 3, results: 1, fuel: 64 },
  // UART0 on the FPC. open(baud) -> 1 / 0; write -> bytes queued; read -> a
  // byte or -1; write_buf(base, n) like i2c_write.
  { name: "uart_open", cap: "io_uart", args: 1, results: 1, fuel: 32 },
  { name: "uart_close", cap: "io_uart", args: 0, results: 0, fuel: 16 },
  { name: "uart_write", cap: "io_uart", args: 1, results: 1, fuel: 4 },
  { name: "uart_write_buf", cap: "io_uart", args: 2, results: 1, fuel: 32 },
  { name: "uart_available", cap: "io_uart", args: 0, results: 1, fuel: 2 },
  { name: "uart_read", cap: "io_uart", args: 0, results: 1, fuel: 2 },
].map((spec, id) => Object.freeze({ ...spec, id })));

/**
 * Device settings an app with `device_config` may read and change, all
 * ConfigRegistry keys (spec/config.md). Changes are never saved and are
 * undone when the app stops; ranges are ConfigRegistry's own.
 */
export const VM_DEVICE_CONFIG_KEYS = Object.freeze([
  "scan.target_fps",
  "scan.send_every_n_frames",
  "filter.enabled",
  "filter.median",
  "filter.alpha",
  "imu.enabled",
]);
// device_config_set is accepted at most once per this many ms per app.
export const VM_DEVICE_CONFIG_INTERVAL_MS = 1000;
// store_append: per-app flash quota, RAM buffer, and the flush period.
export const VM_STORE_QUOTA_BYTES = 16384;
export const VM_STORE_BUFFER_BYTES = 256;
export const VM_STORE_FLUSH_MS = 10000;
// store_get/store_set: named values per app.
export const VM_STORE_MAX_KEYS = 16;
// app_publish: messages held per receiving app.
export const VM_MESSAGE_QUEUE = 4;
// A store file name: becomes <id>/<name>.csv in the device's appdata scope
// (/a/<id>/<name>.csv on flash; SPIFFS names stop at 31 characters, so 8 here
// with a 15-character id).
export const VM_STORE_FILE_RE = /^[a-z0-9_]{1,8}$/;

// I2C on the exposed bus: 7-bit addresses 0x08-0x77, except the board's own
// chips (BMM350 0x14, MAX17048 0x36, OLED 0x3C/0x3D, PCA9536 0x41, MCP4725
// 0x60, BMI270 0x68, BQ25180 0x6A).
export const I2C_DENIED = Object.freeze([0x14, 0x36, 0x3c, 0x3d, 0x41, 0x60, 0x68, 0x6a]);
export const I2C_MAX_TRANSFER = 32;
export const UART_MIN_BAUD = 1200;
export const UART_MAX_BAUD = 921600;

/** Why a running app stopped itself. Indexed by fault code (0 = none). */
export const VM_FAULTS = Object.freeze([
  "none",
  "array_bounds",
  "stack_overflow",
  "stack_underflow",
  "bad_syscall_arg",
  "capability_denied",
  "native_fault",
  "starved",
  "bad_opcode",
]);
