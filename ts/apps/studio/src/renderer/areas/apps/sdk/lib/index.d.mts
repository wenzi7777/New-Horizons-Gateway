// Types for @nhos/app-sdk. The implementation is plain JavaScript in lib/;
// these declarations describe its public surface for TypeScript callers.

// --- op set ------------------------------------------------------------------

export const MAX_NODES: number;
export const LEGACY_MAX_NODES: number;
export const MIN_OS_FOR_LARGE_GRAPHS: string;
export const MAX_PACKAGE_BYTES: number;
export const MAX_EVENT_NAME: number;
export const MAX_WINDOW: number;
export const WINDOW_POOL: number;
export const DEFAULT_BUDGET_US: number;
export const GOVERNOR_CEILING_PERMILLE: number;
export const POOL_BYTES: number;
export const APP_CONTROL_BYTES: number;
export const APP_STORE_BYTES: number;
export const TYPICAL_RUNNING_APPS: number;
export const MAX_DEBOUNCE_MS: number;
export const MAX_REGION_INDEX: number;
export const MAX_APP_ID: number;
export const APP_ID_RE: RegExp;
export const RESERVED_APP_IDS: ReadonlySet<string>;
export const DEFAULT_CELL_COUNT: number;
export const CELL_OP_NS_PER_CELL: number;
export const SCALAR_OP_NS: number;
export const FEATURES_NS_PER_CELL: number;
export const PRESSURE_ACTIVE_THRESHOLD: number;
export const PRESSURE_FULL_SCALE: number;
export const CAPABILITIES: Readonly<Record<string, number>>;
export const FEATURE_FIELDS: readonly string[];
export const LED_COLOURS: Readonly<Record<string, readonly [number, number, number]>>;
export const FLOAT_FIELDS: readonly string[];
export const OLED_ROWS: number;
export const OLED_COLS: number;
export const OLED_ROW_PX: number;
export const OLED_WIDTH_PX: number;
export const MAX_OLED_LABEL: number;
export const MAX_OLED_DIGITS: number;
export const MAX_PENDING_PRESSES: number;
export const OLED_LABEL_RE: RegExp;
/** the most external LED pixels any board has; a pixel past a board's own count is never shown */
export const MAX_EXT_LEDS: number;
/** v1.6.0: the oldest firmware that honours each capability (it would otherwise be silently ignored) */
export const CAPABILITY_SINCE: Readonly<Record<string, string>>;
/** v2.1.0: capabilities an install must ask the operator for (`app_install` `grant`) */
export const DANGEROUS_CAPABILITIES: readonly string[];
/** v2.1.0: capabilities only some boards have, by capability -> board names */
export const BOARD_CAPABILITIES: Readonly<Record<string, readonly string[]>>;
/** v1.6.0: the oldest firmware that honours each optional node field */
export const FIELD_SINCE: Readonly<Record<string, string>>;
/** `rel` bit: a region's rows are percentages */
export const REL_ROWS: number;
/** `rel` bit: a region's columns are percentages */
export const REL_COLS: number;
export const MAX_REL_PERCENT: number;
/** imu(field) names, in firmware order */
export const IMU_FIELDS: readonly string[];
/** mag(field) names, in firmware order */
export const MAG_FIELDS: readonly string[];
/** a background graph runs on ticks only after this long without a frame */
export const TICK_FALLBACK_MS: number;
export const TICK_PERIOD_MS: number;
/** a persisted counter is written at most this often */
export const PERSIST_INTERVAL_MS: number;

export interface OpSpec {
  readonly name: string;
  /** how many earlier nodes this op consumes */
  readonly inputs: number;
  /** true when the op sweeps the whole matrix (cost scales with cell count) */
  readonly sweep: boolean;
  readonly nsPerCell: number;
  readonly nsFlat: number;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly windowKey: string | null;
  /** introduced in this OS version */
  readonly since: string;
  readonly boolean: boolean;
  /** one line for a reference table */
  readonly summary: string;
}

export const OPS: Readonly<Record<string, OpSpec>>;
export const V1_0_OPS: ReadonlySet<string>;
export function opSpec(name: unknown): OpSpec;
export function nodeCostNs(node: { op?: unknown }, cellCount: number): number;
export function graphCostUs(nodes: ReadonlyArray<{ op?: unknown }>, cellCount: number): number;
export function graphMemoryBytes(nodes: ReadonlyArray<Record<string, unknown>>): number;
export function windowFloats(nodes: ReadonlyArray<Record<string, unknown>>): number;
export function appShareUs(fps: number, runningApps: number): number;
/** what an app takes of the device's app pool while it runs (v2.1.0) */
export function appMemoryBytes(poolBytes: number, capabilities?: readonly unknown[]): number;
export function minOsFor(nodes: ReadonlyArray<Record<string, unknown>>, capabilities?: readonly unknown[]): string;
export function capabilitiesMask(names: readonly string[]): number;
export function compareVersions(a: string, b: string): number;

export namespace readoutset {
  const ALLOWED_SOURCES: ReadonlySet<string>;
  const SECTION_KINDS: ReadonlySet<string>;
  const FORMATS: ReadonlySet<string>;
  const MAX_SOURCES: number;
  const MAX_SECTIONS: number;
  const MAX_COLUMNS: number;
  const MAX_STATS: number;
  const MAX_SERIES: number;
  const MIN_CHART_POINTS: number;
  const MAX_CHART_POINTS: number;
  const MIN_REFRESH_MS: number;
  const MAX_REFRESH_MS: number;
}

export namespace panelset {
  const PERMISSIONS: Readonly<Record<"task_control" | "service_control" | "app_control", readonly string[]>>;
  const ACTION_COMMANDS: ReadonlySet<string>;
  const FORBIDDEN_COMMAND_PREFIXES: readonly string[];
  const FORBIDDEN_COMMANDS: ReadonlySet<string>;
  function isForbiddenCommand(command: string): boolean;
  const ALLOWED_SOURCES: ReadonlySet<string>;
  const SECTION_KINDS: ReadonlySet<string>;
  const TAB_SECTION_KINDS: ReadonlySet<string>;
  const INPUT_KINDS: ReadonlySet<string>;
  const TEMPLATE_RE: RegExp;
  const FIELD_PATH_RE: RegExp;
  const PANEL_MIN_OS: string;
  const MAX_ACTIONS: number;
  const MAX_TABS: number;
  const MAX_ROW_ACTIONS: number;
  const MAX_RUN_CANDIDATES: number;
  const MAX_ARGS: number;
  const MAX_CONDITIONS: number;
  const MAX_ARG_TEXT: number;
  const MAX_LABEL: number;
  const MAX_CONFIRM_TEXT: number;
  const MAX_INPUT_TEXT: number;
  const MAX_PATH_DEPTH: number;
  /** `{field, eq}` or `{field, ne}`; a missing/null field satisfies neither. */
  type Condition = { field: string; eq?: unknown; ne?: unknown };
  type Conditions = Condition | Condition[];
  function fieldValue(row: unknown, path: string): unknown;
  function conditionHolds(condition: unknown, row: unknown): boolean;
  /** `when`: every condition holds (AND); none declared means enabled. */
  function actionEnabled(when: Conditions | undefined, row: unknown): boolean;
  /** `hidden_when`: any condition holds (OR); none declared means shown. */
  function actionHidden(hiddenWhen: Conditions | undefined, row: unknown): boolean;
  /** [description, when, hidden_when, row, enabled, hidden] */
  const CONDITION_CASES: ReadonlyArray<readonly [string, Conditions | undefined, Conditions | undefined, Record<string, unknown>, boolean, boolean]>;
}

// --- packages ------------------------------------------------------------------

export interface Manifest {
  id: string;
  name: string;
  version: string;
  author: string;
  summary: string;
  category?: string;
  icon?: string;
  min_os?: string;
  capabilities?: string[];
  budget_us?: number;
  /** panel only: task_control | service_control | app_control */
  permissions?: string[];
  [field: string]: unknown;
}

/** A stateful object or top-level `let` of an app.ts, in node-table order. */
export interface AppSymbol {
  name: string;
  /** the class (Threshold, Counter, ...) or "let" */
  kind: string;
  type: "number" | "boolean";
}

export interface FlowPackage {
  nhapp: 1;
  kind: "flow";
  name: string;
  manifest: Manifest;
  /** base64 NHVM/1 image (docs/vm.md) */
  vm: string;
  symbols: AppSymbol[];
}

export interface ReadoutPackage {
  nhapp: 1;
  kind: "readout";
  manifest: Manifest;
  readout: Record<string, unknown>;
}

export interface PanelPackage {
  nhapp: 1;
  kind: "panel";
  manifest: Manifest;
  panel: Record<string, unknown>;
}

export type Package = FlowPackage | ReadoutPackage | PanelPackage;

export function pythonFloatRepr(value: number): string;
export function canonicalText(doc: unknown): string;
export function canonicalBytes(doc: unknown): Uint8Array;

// --- compiler ------------------------------------------------------------------

export class CompileError extends Error {
  readonly reason: string;
  /** 1-based; null when the error applies to the whole program */
  readonly line: number | null;
  readonly col: number | null;
  readonly endCol: number | null;
}

export interface Token {
  kind: "name" | "number" | "string" | "punct" | "eof";
  text: string;
  value?: number | string;
  line: number;
  col: number;
  endCol: number;
}

/** The app.ts lexer; comments and whitespace are dropped. */
export function tokenize(source: string): Token[];

/** What an editor needs to highlight and complete app.ts. */
export const LANGUAGE: {
  readonly name: string;
  readonly extension: string;
  readonly keywords: readonly string[];
  /** on("...") event names */
  readonly events: readonly string[];
  /** top-level names: functions and namespaces */
  readonly globals: readonly string[];
  /** classes an app may construct */
  readonly classes: readonly string[];
  /** members by namespace or class */
  readonly members: Readonly<Record<string, readonly string[]>>;
  readonly featureFields: readonly string[];
  readonly deviceConfigKeys: readonly string[];
};

export interface Note {
  message: string;
  line: number | null;
  col: number | null;
}

export interface CompileReport {
  codeBytes: number;
  /** arena slots (4 bytes each): objects, globals, arrays, native state */
  arenaSlots: number;
  /** bytes the image takes from the device's app pool */
  poolBytes: number;
  /** all the app takes of the pool while it runs: control block, image, store */
  memoryBytes: number;
  maxStack: number;
  /** true when no handler has a loop, so a worst case is known */
  loopFree: boolean;
  /** worst-case microseconds per run at `cellCount`, null with a loop */
  estimatedUs: number | null;
  cellCount: number;
  minOs: string;
  capabilities: string[];
  /** the capabilities an install must ask for */
  dangerous: string[];
  notes: Note[];
  symbols: AppSymbol[];
}

export function compileSource(source: string, options?: { cellCount?: number }): { package: FlowPackage; report: CompileReport };

// --- validator -----------------------------------------------------------------

export class PackageError extends Error {
  /** `reason:detail`, using the firmware's own spelling where one exists */
  readonly code: string;
  /** index of the offending node, when there is one */
  readonly node: number | null;
}

export interface ValidateOptions {
  /** cells on the target board (default 225, the largest) */
  cellCount?: number;
}

export interface PackageReport {
  kind: "flow" | "readout" | "panel";
  id: string;
  version: string;
  /** canonical bytes */
  size: number;
  /** entries in the image's node table */
  nodes: number;
  /** worst case; 0 when the code has a loop */
  estimatedUs: number;
  memoryBytes: number;
  minOs: string;
  loopFree?: boolean;
  vmBytes?: number;
  poolBytes?: number;
  budgetUs?: number;
  cellCount?: number;
  windowFloats?: number;
  sources?: number;
  sections?: number;
  refreshMs?: number;
  actions?: number;
  permissions?: string[];
}

export function validateManifest(manifest: Record<string, unknown>): void;
export function validateReadout(readout: unknown): { sources: number; sections: number; refreshMs: number };
export function validatePanel(panel: unknown, manifest: Record<string, unknown>): {
  sources: number; sections: number; refreshMs: number; actions: number; permissions: string[];
};
export function validatePackage(doc: unknown, raw?: Uint8Array | null, options?: ValidateOptions): PackageReport;

// --- simulator -----------------------------------------------------------------

export interface Frame {
  /** frame sequence number (the device's frame_seq) */
  seq: number;
  timestampMs: number;
  /** row-major cell values */
  values: ArrayLike<number>;
  rows: number;
  cols: number;
  /** ax, ay, az (g), gx, gy, gz (deg/s) */
  imu?: ArrayLike<number>;
  /** mx, my, mz (microtesla) */
  mag?: ArrayLike<number>;
  /** battery percent for this frame, overriding setBattery() */
  battery?: number;
  /** link state for this frame, overriding setLinked() */
  linked?: boolean;
}

export interface SimEvent {
  seq: number;
  frameSeq: number;
  timestampMs: number;
  app: string;
  event: string;
  /** rise/fall, or the formatted value for emit_value */
  detail: string;
  value: number | null;
}

export interface LedChange {
  frameSeq: number;
  timestampMs: number;
  colour: string;
  rgb: readonly [number, number, number];
  node: number;
}

export interface OledBarGeometry {
  /** left edge of the outline, in pixels */
  x0: number;
  /** outline width, reaching the right edge of the panel */
  width: number;
  /** filled pixels inside the outline, 0..width-2 */
  fillPx: number;
}

/** One OLED row as the device's "app" page draws it. */
export interface OledRow {
  kind: "text" | "bar";
  label: string;
  value: number;
  /** the node-table entry whose state drew it, -1 for a call site */
  node: number;
  /** the whole row, for a text row (OLED_COLS characters) */
  text?: string;
  bar?: OledBarGeometry;
}

export interface NodeValue {
  /** the source name, from the package's symbols */
  name: string;
  op: string;
  result: number;
  bool: boolean;
}

/** The device's side of storage, settings, streaming, I2C and UART, simulated. */
export class SimDevice {
  constructor(options?: { uartLoopback?: boolean; i2c?: Record<number, number[]> });
  /** current device settings an app may change */
  readonly config: Record<string, number>;
  readonly streaming: boolean;
  readonly uartBaud: number;
  /** bytes apps wrote to the UART */
  readonly uartTx: number[];
  /** store.get/set values of one app */
  valuesOf(app: string): Map<string, number>;
  /** store.append files of one app, by name */
  filesOf(app: string): Map<string, { bytes: number; rows: string[] }>;
  /** a file's CSV text, as /appdata/<app>/<file>.csv holds it */
  fileText(app: string, file: string): string;
  usedBytes(app: string): number;
  /** undo what `app` changed (settings, stream, UART), as the device does when it stops */
  release(app: string): void;
}

/** Delivers app.publish() between simulators. */
export class SimBus {
  constructor();
}

export interface SimulatorOptions {
  appName?: string;
  /** persisted counters to start from, by node index */
  restore?: Record<number, number>;
  /** fuel one call may spend before the handler is suspended (default: unlimited) */
  fuelLimit?: number;
  device?: SimDevice;
  bus?: SimBus;
}

/** Runs a package's NHVM/1 image, as the device does. */
export class VmSimulator {
  constructor(pkg: Record<string, any>, options?: SimulatorOptions);
  readonly appName: string;
  readonly symbols: AppSymbol[];
  readonly device: SimDevice;
  readonly canEmit: boolean;
  readonly canDriveLed: boolean;
  readonly canDisplay: boolean;
  /** true when the package declares `button`, so presses reach it */
  readonly hearsButton: boolean;
  /** true when the package declares `drive_ext_led`, so it takes the external strip over while it runs */
  readonly canDriveExtLed: boolean;
  readonly events: SimEvent[];
  readonly ledChanges: LedChange[];
  /** the LED colour the app is driving now */
  readonly led: readonly [number, number, number];
  /** a Features object's fields, zero without one */
  readonly features: Record<string, number>;
  /** true when the app reads the matrix per cell */
  readonly sweeps: boolean;
  readonly frames: number;
  /** idle runs the tick drove */
  readonly ticks: number;
  /** the fault that stopped the app (array_bounds, ...), null while it runs */
  readonly fault: string | null;
  /** frames that arrived while a handler was suspended */
  readonly framesSkipped: number;
  readonly messagesDropped: number;
  readonly degraded: boolean;
  readonly degradations: number;
  /** forget all state, as a fresh load on the device would */
  reset(): void;
  /** latch budget pressure, as a Budget event does on the device */
  setBudget(load: number, graceLeft: number): void;
  /** run the frame handler; returns the events it produced */
  step(frame: Frame): SimEvent[];
  run(frames: Iterable<Frame>): this;
  /** every stateful object and global, by node-table order */
  nodeValues(): NodeValue[];
  /** a short press of the action button */
  pressButton(nowMs?: number): void;
  /** what battery() reads from now on: percent, or -1 for no gauge reading */
  setBattery(percent: number): void;
  /** what linked() reads from now on */
  setLinked(linked: boolean): void;
  /** the device's 10 Hz tick: runs on("tick"), and on("idle") while frames are absent */
  tick(nowMs: number, sensors?: { imu?: ArrayLike<number>; mag?: ArrayLike<number>; battery?: number; linked?: boolean }): SimEvent[];
  /** queue a message, as another app's app.publish() would */
  enqueueMessage(topic: string, value: number): void;
  /** run on("stop") and undo what the app changed on the device */
  stop(nowMs: number): SimEvent[];
  /** persisted counters by node index, as the device writes them to NVS */
  persisted(): Record<number, number>;
  /** the OLED rows the last frame drew, null where it drew nothing */
  oledRows(): (OledRow | null)[];
  /** what the last frame put on the external strip, null without `drive_ext_led` */
  extLedFrame(): ExtLedFrame | null;
  /** the strip as a board of `count` external pixels shows it (before brightness), null without `drive_ext_led` */
  extLeds(count: number): [number, number, number][] | null;
}

/** The name the emulators and older callers use. */
export const Simulator: typeof VmSimulator;
export type Simulator = VmSimulator;

export interface ExtLedFrame {
  meter: { value: number; lo: number; hi: number } | null;
  /** one entry per possible pixel (MAX_EXT_LEDS), null where nothing lit it */
  pixels: (readonly [number, number, number] | null)[];
}

export function extMeterLit(value: number, lo: number, hi: number, count: number): number;
export function extMeterColour(index: number, count: number): [number, number, number];
export function renderExtLeds(frame: ExtLedFrame, count: number): [number, number, number][];

export function computeFeatures(frame: Frame): Record<string, number>;
export function formatOledValue(value: number, digits: number): string;
export function formatOledTextLine(label: string, value: number, digits: number): string;
export function oledBarGeometry(labelLen: number, value: number, lo: number, hi: number): OledBarGeometry;
export function simulate(pkg: Record<string, any>, frames: Iterable<Frame>, options?: SimulatorOptions): VmSimulator;

// --- the VM --------------------------------------------------------------------

export const VM_TS_MIN_OS: string;
/** settings device.configSet may change */
export const VM_DEVICE_CONFIG_KEYS: readonly string[];
/** bytes of files each app may keep */
export const VM_STORE_QUOTA_BYTES: number;
export class VmImageError extends Error {
  readonly code: string;
}
export interface VmVerified {
  loopFree: boolean;
  estimatedNs: number;
  maxStack: number;
  poolBytes: number;
  capabilities: number;
}
export function verifyImage(bytes: Uint8Array, options?: { capabilities?: readonly string[] | number; cellCount?: number }): VmVerified;
export function disassemble(bytes: Uint8Array): string;
export function fromBase64(text: string): Uint8Array;
/** the 32-bit FNV-1a hash the device matches keys and topics with */
export function fnv1a(text: string): number;

// --- recordings ----------------------------------------------------------------

export const EVENT_COLUMNS: readonly string[];
/** recording columns imu() reads */
export const IMU_COLUMNS: readonly string[];
/** recording columns mag() reads */
export const MAG_COLUMNS: readonly string[];
export function parseCsvRows(text: string): string[][];
export function inferShape(count: number, rows?: number, cols?: number): { rows: number; cols: number };
export function parseSamplesCsv(text: string, shape?: { rows?: number; cols?: number }): Frame[];
export function parseEventsCsv(text: string): SimEvent[];
export function formatEventsCsv(events: readonly SimEvent[]): string;

export interface EventComparison {
  matched: { frameSeq: number; event: string; detail: string }[];
  /** fired offline, not on the device */
  onlySimulated: SimEvent[];
  /** fired on the device, not offline */
  onlyRecorded: SimEvent[];
}

export function compareEvents(
  simulated: readonly SimEvent[],
  recorded: readonly SimEvent[],
  options?: { toleranceFrames?: number; events?: ReadonlySet<string> },
): EventComparison;

// --- editor analysis -----------------------------------------------------------

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  /** 1-based, null when it applies to the whole app */
  line: number | null;
  col: number | null;
  endCol: number | null;
  /** validator code, for errors the device would report */
  code: string | null;
}

export interface Analysis {
  /** true when the package would be accepted by the device */
  ok: boolean;
  kind: "flow" | "readout" | "panel";
  package: Record<string, any> | null;
  /** canonical bytes, when ok */
  bytes: Uint8Array | null;
  /** compile report (flow only) */
  report: CompileReport | null;
  validation: PackageReport | null;
  diagnostics: Diagnostic[];
}

export function analyzeFlow(source: string, options?: { cellCount?: number }): Analysis;
export function analyzeReadout(source: string): Analysis;
export function analyzePanel(source: string): Analysis;
export function describeCode(code: string): string;
