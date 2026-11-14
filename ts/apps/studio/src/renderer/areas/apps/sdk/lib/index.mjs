// @ts-check
/**
 * NHOS App SDK: compiler (app.ts -> NHVM/1), validator and simulator for
 * New Horizons OS apps.
 * Zero dependencies and no I/O, so the same files run in Node and in the
 * browser. File handling lives in `bin/nhos.mjs`.
 */

export * from "./opset.mjs";
export * as readoutset from "./readoutset.mjs";
export * as panelset from "./panelset.mjs";
export { canonicalBytes, canonicalText, pythonFloatRepr } from "./canonical.mjs";
export { CompileError, LANGUAGE, compileSource, tokenize } from "./compile.mjs";
export { PackageError, validateManifest, validatePackage, validatePanel, validateReadout } from "./validate.mjs";
export { SimBus, SimDevice, Simulator, VmSimulator, computeFeatures, simulate } from "./vmsim.mjs";
export { DANGEROUS_CAPABILITIES } from "./opset.mjs";
export { VM_DEVICE_CONFIG_KEYS, VM_STORE_QUOTA_BYTES, VM_TS_MIN_OS } from "./vmset.mjs";
export { VmImageError, disassemble, fnv1a, fromBase64, verifyImage } from "./vm.mjs";
export { formatOledTextLine, formatOledValue, oledBarGeometry } from "./oled.mjs";
export { extMeterColour, extMeterLit, renderExtLeds } from "./extled.mjs";
export { EVENT_COLUMNS, IMU_COLUMNS, MAG_COLUMNS, compareEvents, formatEventsCsv, inferShape, parseCsvRows, parseEventsCsv, parseSamplesCsv } from "./csv.mjs";
export { analyzeFlow, analyzePanel, analyzeReadout, describeCode } from "./analyze.mjs";
