// The App Library's package contract, as the Desktop's app_contract.py has it
// (GENERATED there by `node sdk/bin/nhos.mjs gen-contract` from the
// NHOS-App-Library's sdk/lib/opset.mjs). Restated by hand because this
// package must not import the SDK's .mjs; Studio's
// test/main/appsContract.test.ts compares it with the vendored SDK's opset,
// so a new op or capability in the library fails a test until it is added here.

/** Every op a flow package may use. */
export const KNOWN_OPS: ReadonlySet<string> = new Set([
  'abs', 'active_cells', 'add', 'arg_max', 'atan2', 'battery', 'budget_load',
  'button', 'clamp', 'col_centroid', 'const', 'counter', 'counter_reset', 'debounce',
  'delta', 'div', 'duration', 'emit', 'emit_value', 'ext_meter', 'ext_pixel',
  'feature_get', 'features', 'gate', 'grace_left', 'imu', 'integrate', 'interval',
  'led', 'linked', 'mag', 'max', 'max_hold', 'mean', 'min', 'mod', 'mul', 'not',
  'oled_bar', 'oled_text', 'peak', 'peak_since', 'region_active',
  'region_col_centroid', 'region_peak', 'region_row_centroid', 'region_sum',
  'row_centroid', 'select', 'sqrt', 'sub', 'threshold', 'total', 'uptime',
]);

/** Capabilities a package may declare. */
export const CAPABILITIES: ReadonlySet<string> = new Set([
  'button', 'display', 'drive_ext_led', 'drive_led', 'emit_event', 'link', 'persist',
  'power', 'read_imu', 'read_mag', 'read_matrix', 'tick', 'write_file',
]);

export const MAX_NODES = 24;
export const MAX_PACKAGE_BYTES = 8192;
export const MAX_EVENT_NAME = 23;
