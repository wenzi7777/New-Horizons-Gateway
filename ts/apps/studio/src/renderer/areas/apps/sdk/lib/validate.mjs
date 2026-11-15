// @ts-check
/**
 * Validate a .nha package against everything the device will check, and more.
 *
 * The rule is simple: if this passes, the device must accept the package.
 * Anything the firmware refuses has to be refused here too, with a message
 * that says why -- the device's own errors arrive far too late and say far
 * too little. Error codes reuse the firmware's own spelling where one exists
 * (`unknown_colour`, `window_pool_exhausted`, `over_budget`), so the two sides
 * can be matched up.
 */

import {
  APP_ID_RE,
  CAPABILITIES,
  CAPABILITY_SINCE,
  DEFAULT_BUDGET_US,
  DEFAULT_CELL_COUNT,
  MAX_PACKAGE_BYTES,
  RESERVED_APP_IDS,
  appMemoryBytes,
  compareVersions,
  windowFloats,
} from "./opset.mjs";
import {
  ALLOWED_SOURCES,
  FORMATS,
  MAX_CHART_POINTS,
  MAX_COLUMNS,
  MAX_REFRESH_MS,
  MAX_SERIES,
  MIN_CHART_POINTS,
  MAX_SECTIONS,
  MAX_SOURCES,
  MAX_STATS,
  MIN_REFRESH_MS,
  SECTION_KINDS,
} from "./readoutset.mjs";
import {
  ACTION_COMMANDS,
  FIELD_PATH_RE,
  INPUT_KINDS,
  MAX_ACTIONS,
  MAX_ARGS,
  MAX_ARG_TEXT,
  MAX_CONDITIONS,
  MAX_CONFIRM_TEXT,
  MAX_INPUT_TEXT,
  MAX_LABEL,
  MAX_ROW_ACTIONS,
  MAX_RUN_CANDIDATES,
  MAX_TABS,
  PANEL_MIN_OS,
  PERMISSIONS,
  SECTION_KINDS as PANEL_SECTION_KINDS,
  TAB_SECTION_KINDS,
  TEMPLATE_RE,
  isForbiddenCommand,
} from "./panelset.mjs";
import { canonicalBytes } from "./canonical.mjs";
import { VmImageError, fromBase64, verifyImage } from "./vm.mjs";
import { VM_TS_MIN_OS } from "./vmset.mjs";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const MIN_OS_RE = /^v?\d+\.\d+\.\d+$/;
const SOURCE_ID_RE = /^[a-z][a-z0-9_]*$/;
const MANIFEST_REQUIRED = ["id", "name", "version", "author", "summary"];
// A package's flow graph is read with the same flat key scan the firmware
// uses, so a manifest field named like a top-level key would shadow it.
const MANIFEST_FORBIDDEN_KEYS = ["nodes", "kind", "nhapp", "vm", "symbols"];

/** A package the device would refuse. `code` is `reason:detail`. */
export class PackageError extends Error {
  /**
   * @param {string} code
   * @param {number|null} [node] the offending node's index, when there is one
   */
  constructor(code, node = null) {
    super(code);
    this.name = "PackageError";
    this.code = code;
    this.node = node;
  }
}

/**
 * @param {unknown} condition
 * @param {string} code
 * @param {number|null} [node]
 * @returns {asserts condition}
 */
function require(condition, code, node = null) {
  if (!condition) throw new PackageError(code, node);
}

/**
 * Where validate() checks an op's capability. The rule itself comes from
 * opset.mjs; the position keeps the order errors have always come in: emit
 * ops after their event name, imu/mag after their field, battery/linked after
 * the region checks, sweeps last before the window, the rest straight away.
 * @param {string} name
 * @param {{sweep: boolean}} op
 */
function capabilityCheckPoint(name, op) {
  if (name === "emit" || name === "emit_value") return "after_event";
  if (name === "imu" || name === "mag") return "after_field";
  if (name === "battery" || name === "linked") return "after_sensors";
  if (op.sweep) return "late";
  return "early";
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const text = (value) => (value === null || value === undefined ? "" : String(value));
/** @param {unknown} value */
const isInt = (value) => typeof value === "number" && Number.isInteger(value);

/** @param {Record<string, unknown>} manifest */
export function validateManifest(manifest) {
  for (const key of MANIFEST_REQUIRED) {
    require(text(manifest[key]).trim(), `missing_manifest_field:${key}`);
  }

  const appId = text(manifest.id);
  require(APP_ID_RE.test(appId), `invalid_id:${appId}`);
  require(!RESERVED_APP_IDS.has(appId), `reserved_id:${appId}`);

  require(SEMVER_RE.test(text(manifest.version)), `invalid_version:${text(manifest.version)}`);
  if ("min_os" in manifest) {
    require(MIN_OS_RE.test(text(manifest.min_os)), `invalid_min_os:${text(manifest.min_os)}`);
  }
  if ("budget_us" in manifest) {
    require(isInt(manifest.budget_us) && /** @type {number} */ (manifest.budget_us) > 0,
      `invalid_budget_us:${text(manifest.budget_us)}`);
  }
  // v2.1.0: may borrow time other apps leave unused. Older firmware ignores it.
  if ("burst" in manifest) {
    require(typeof manifest.burst === "boolean", `invalid_burst:${text(manifest.burst)}`);
  }

  for (const key of MANIFEST_FORBIDDEN_KEYS) {
    require(!(key in manifest), `manifest_key_shadows_package_key:${key}`);
  }

  const caps = manifest.capabilities ?? [];
  require(Array.isArray(caps), "capabilities_must_be_a_list");
  for (const cap of caps) require(Object.hasOwn(CAPABILITIES, String(cap)), `unknown_capability:${cap}`);
}

/**
 * @typedef {object} ValidateOptions
 * @property {number} [cellCount] cells on the target board (default 225, the largest)
 */


/**
 * The sources a readout or panel polls. Read-only by construction.
 * @param {unknown} sources
 * @param {boolean} panel
 * @returns {Set<string>} the declared source ids
 */
function validateSources(sources, panel) {
  require(Array.isArray(sources) && sources.length > 0, "missing_sources");
  require(sources.length <= MAX_SOURCES, `too_many_sources:${sources.length}`);
  /** @type {Set<string>} */
  const ids = new Set();
  for (const source of sources) {
    require(isObject(source), "invalid_source");
    const sourceId = text(source.id);
    require(SOURCE_ID_RE.test(sourceId), `invalid_source_id:${sourceId}`);
    require(!ids.has(sourceId), `duplicate_source_id:${sourceId}`);
    ids.add(sourceId);
    const command = text(source.command);
    // A readout is read-only by construction: it cannot be used to
    // reconfigure or write to a device, whatever its author intended. A
    // panel's sources obey the same rule; what it may SEND is its actions.
    require(ALLOWED_SOURCES.has(command), `readout_source_not_allowed:${command}`);
    if (panel && "path" in source) require(FIELD_PATH_RE.test(text(source.path)), `invalid_source_path:${text(source.path)}`);
  }
  return ids;
}

/**
 * @typedef {object} SectionContext
 * @property {Set<string>} ids declared source ids
 * @property {Set<string>} kinds section kinds allowed here
 * @property {Map<string, Record<string, any>>|null} actions a panel's actions; null for a readout
 * @property {Set<string>} used action ids referenced so far
 */

/**
 * @param {unknown} value
 * @param {SectionContext} ctx
 * @param {string} what
 */
function requireField(value, ctx, what) {
  require(text(value), `missing_${what}_field`);
  if (ctx.actions) require(FIELD_PATH_RE.test(text(value)), `invalid_field_path:${text(value)}`);
}

/**
 * @param {unknown} sections
 * @param {SectionContext} ctx
 */
function validateSections(sections, ctx) {
  require(Array.isArray(sections) && sections.length > 0, "missing_sections");
  require(sections.length <= MAX_SECTIONS, `too_many_sections:${sections.length}`);
  for (const section of sections) {
    require(isObject(section), "invalid_section");
    const kind = text(section.kind);
    if (kind === "tabs" && ctx.actions && !ctx.kinds.has(kind)) require(false, "nested_tabs");
    require(ctx.kinds.has(kind), `unknown_section_kind:${kind}`);
    require(text(section.title).trim(), "missing_section_title");

    if (kind === "chart") {
      require(ctx.ids.has(text(section.source)), `unknown_source:${text(section.source)}`);
      const series = section.series;
      require(Array.isArray(series) && series.length > 0, "missing_series");
      require(series.length <= MAX_SERIES, `too_many_series:${series.length}`);
      for (const line of series) {
        require(isObject(line), "invalid_series");
        requireField(line.field, ctx, "series");
      }
      const points = section.points ?? 60;
      require(isInt(points) && /** @type {number} */ (points) >= MIN_CHART_POINTS && /** @type {number} */ (points) <= MAX_CHART_POINTS,
        `invalid_chart_points:${text(points)}`);
      for (const key of ["min", "max"]) {
        if (key in section) require(typeof section[key] === "number" && Number.isFinite(section[key]), `invalid_chart_${key}:${text(section[key])}`);
      }
      if ("min" in section && "max" in section) {
        require(/** @type {number} */ (section.max) > /** @type {number} */ (section.min), "invalid_chart_range");
      }
    } else if (kind === "stats") {
      const items = section.items;
      require(Array.isArray(items) && items.length > 0, "missing_stats_items");
      require(items.length <= MAX_STATS, `too_many_stats:${items.length}`);
      for (const item of items) {
        require(isObject(item), "invalid_stat");
        require(ctx.ids.has(text(item.source)), `unknown_source:${text(item.source)}`);
        requireField(item.field, ctx, "stat");
        require(FORMATS.has(text(item.format ?? "raw")), `unknown_format:${text(item.format)}`);
      }
    } else if (kind === "tabs") {
      const tabs = section.tabs;
      require(Array.isArray(tabs) && tabs.length > 0, "missing_tabs");
      require(tabs.length <= MAX_TABS, `too_many_tabs:${tabs.length}`);
      for (const tab of tabs) {
        require(isObject(tab), "invalid_tab");
        require(text(tab.title).trim(), "missing_tab_title");
        validateSections(tab.sections, { ...ctx, kinds: TAB_SECTION_KINDS });
      }
    } else if (kind === "run") {
      const actions = /** @type {Map<string, Record<string, any>>} */ (ctx.actions);
      const candidates = section.candidates;
      require(Array.isArray(candidates) && candidates.length > 0, "missing_run_candidates");
      require(candidates.length <= MAX_RUN_CANDIDATES, `too_many_run_candidates:${candidates.length}`);
      for (const candidate of candidates) {
        require(isObject(candidate), "invalid_run_candidate");
        require(ctx.ids.has(text(candidate.source)), `unknown_source:${text(candidate.source)}`);
        requireField(candidate.field, ctx, "run");
        const actionId = text(candidate.action);
        require(actions.has(actionId), `unknown_action:${actionId}`);
        ctx.used.add(actionId);
      }
    } else {
      require(ctx.ids.has(text(section.source)), `unknown_source:${text(section.source)}`);
      const columns = section.columns;
      require(Array.isArray(columns) && columns.length > 0, "missing_columns");
      require(columns.length <= MAX_COLUMNS, `too_many_columns:${columns.length}`);
      for (const column of columns) {
        require(isObject(column), "invalid_column");
        requireField(column.field, ctx, "column");
        require(FORMATS.has(text(column.format ?? "raw")), `unknown_format:${text(column.format)}`);
      }
      if ("row_actions" in section) {
        require(ctx.actions, "readout_must_not_declare_actions");
        const rowActions = section.row_actions;
        require(Array.isArray(rowActions) && rowActions.length > 0, "invalid_row_actions");
        require(rowActions.length <= MAX_ROW_ACTIONS, `too_many_row_actions:${rowActions.length}`);
        require(new Set(rowActions).size === rowActions.length, "duplicate_row_action");
        for (const id of rowActions) {
          require(ctx.actions.has(text(id)), `unknown_action:${text(id)}`);
          ctx.used.add(text(id));
        }
      }
    }
  }
}

/**
 * A readout names commands to read and widgets to draw. Nothing else.
 * @param {unknown} readout
 */
export function validateReadout(readout) {
  require(isObject(readout), "missing_readout");

  const refresh = readout.refresh_ms ?? 1000;
  require(isInt(refresh) && /** @type {number} */ (refresh) >= MIN_REFRESH_MS && /** @type {number} */ (refresh) <= MAX_REFRESH_MS,
    `invalid_refresh_ms:${text(refresh)}`);
  require(!("actions" in readout), "readout_must_not_declare_actions");

  const ids = validateSources(readout.sources, false);
  const sections = /** @type {unknown[]} */ (readout.sections);
  validateSections(sections, { ids, kinds: SECTION_KINDS, actions: null, used: new Set() });

  return { sources: ids.size, sections: sections.length, refreshMs: /** @type {number} */ (refresh) };
}

/**
 * A constant: a string, a finite number or a boolean.
 * @param {unknown} value
 */
const isConstant = (value) => typeof value === "boolean"
  || (typeof value === "number" && Number.isFinite(value))
  || (typeof value === "string" && value.length <= MAX_ARG_TEXT && !value.startsWith("$"));

/**
 * `when` / `hidden_when`: one condition or a list. Each compares one field of
 * the row to a constant -- equal or not equal, nothing else.
 * @param {unknown} value
 * @param {string} key
 */
function validateConditions(value, key) {
  const list = Array.isArray(value) ? value : [value];
  require(list.length > 0 && list.length <= MAX_CONDITIONS, `invalid_${key}`);
  for (const condition of list) {
    require(isObject(condition), `invalid_${key}`);
    require(FIELD_PATH_RE.test(text(condition.field)), `invalid_${key}`);
    const ops = ["eq", "ne"].filter((op) => op in condition);
    require(ops.length === 1, `invalid_${key}`);
    require(isConstant(condition[ops[0]]), `invalid_${key}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} what
 * @param {number} max
 */
function optionalText(value, what, max) {
  if (value === undefined) return;
  require(typeof value === "string" && value.length <= max, `invalid_${what}`);
}

/**
 * One action: a command its permissions allow, with argument templates that
 * are data, never code.
 * @param {Record<string, any>} action
 * @param {Set<string>} granted commands the declared permissions unlock
 */
function validateAction(action, granted) {
  const id = text(action.id);
  require(text(action.label).trim() && text(action.label).length <= MAX_LABEL, `missing_action_label:${id}`);

  const command = text(action.command);
  // Two locks: the forbidden list first, so that the reason given for, say,
  // `reboot` is that it is never allowed -- not merely that it is unlisted.
  require(!isForbiddenCommand(command), `panel_command_forbidden:${command}`);
  require(ACTION_COMMANDS.has(command), `panel_command_unknown:${command}`);
  require(granted.has(command), `panel_permission_missing:${command}`);

  const input = action.input;
  /** @type {string|null} */
  let inputField = null;
  if (input !== undefined) {
    require(isObject(input), `invalid_action_input:${id}`);
    inputField = text(input.field);
    require(SOURCE_ID_RE.test(inputField), `invalid_action_input:${id}`);
    const kind = text(input.kind ?? "number");
    require(INPUT_KINDS.has(kind), `invalid_action_input:${id}`);
    optionalText(input.label, "action_input", MAX_LABEL);
    if (kind === "number") {
      for (const key of ["min", "max", "step"]) {
        if (key in input) require(typeof input[key] === "number" && Number.isFinite(input[key]), `invalid_action_input:${id}`);
      }
      if ("min" in input && "max" in input) require(input.max >= input.min, `invalid_action_input:${id}`);
    } else if ("max_length" in input) {
      require(isInt(input.max_length) && input.max_length > 0 && input.max_length <= MAX_INPUT_TEXT, `invalid_action_input:${id}`);
    }
    if ("default" in input) {
      const fallback = input.default;
      const template = typeof fallback === "string" ? TEMPLATE_RE.exec(fallback) : null;
      // A default may come from the row, never from another input.
      require(isConstant(fallback) || (template !== null && template[1] === "row"), `invalid_arg_template:${text(fallback)}`);
    }
  }

  const args = action.args ?? {};
  require(isObject(args), `invalid_action_args:${id}`);
  const keys = Object.keys(args);
  require(keys.length <= MAX_ARGS, `too_many_args:${id}`);
  for (const key of keys) {
    require(SOURCE_ID_RE.test(key), `invalid_arg_name:${key}`);
    const value = args[key];
    if (typeof value === "string" && value.startsWith("$")) {
      const template = TEMPLATE_RE.exec(value);
      require(template, `invalid_arg_template:${value}`);
      if (template[1] === "input") require(template[2] === inputField, `unknown_input_field:${template[2]}`);
    } else {
      require(isConstant(value), `invalid_arg_value:${key}`);
    }
  }

  for (const key of ["when", "hidden_when"]) {
    if (key in action) validateConditions(action[key], key);
  }

  if ("confirm" in action) {
    const confirm = action.confirm;
    require(isObject(confirm), `invalid_confirm:${id}`);
    optionalText(confirm.title, "confirm", MAX_CONFIRM_TEXT);
    optionalText(confirm.message, "confirm", MAX_CONFIRM_TEXT);
    if ("destructive" in confirm) require(typeof confirm.destructive === "boolean", `invalid_confirm:${id}`);
  }
}

/**
 * A panel: a readout that may also act, within the permissions its manifest
 * declares.
 * @param {unknown} panel
 * @param {Record<string, unknown>} manifest
 */
export function validatePanel(panel, manifest) {
  require(isObject(panel), "missing_panel");

  const refresh = panel.refresh_ms ?? 1000;
  require(isInt(refresh) && /** @type {number} */ (refresh) >= MIN_REFRESH_MS && /** @type {number} */ (refresh) <= MAX_REFRESH_MS,
    `invalid_refresh_ms:${text(refresh)}`);

  const permissions = manifest.permissions ?? [];
  require(Array.isArray(permissions), "permissions_must_be_a_list");
  /** @type {Set<string>} */
  const declared = new Set();
  for (const permission of permissions) {
    const name = text(permission);
    require(Object.hasOwn(PERMISSIONS, name), `unknown_permission:${name}`);
    require(!declared.has(name), `duplicate_permission:${name}`);
    declared.add(name);
  }
  const granted = new Set([...declared].flatMap((name) => PERMISSIONS[/** @type {keyof typeof PERMISSIONS} */ (name)]));

  const ids = validateSources(panel.sources, true);

  const list = panel.actions ?? [];
  require(Array.isArray(list), "actions_must_be_a_list");
  require(list.length <= MAX_ACTIONS, `too_many_actions:${list.length}`);
  /** @type {Map<string, Record<string, any>>} */
  const actions = new Map();
  for (const action of list) {
    require(isObject(action), "invalid_action");
    const id = text(action.id);
    require(SOURCE_ID_RE.test(id), `invalid_action_id:${id}`);
    require(!actions.has(id), `duplicate_action_id:${id}`);
    validateAction(action, granted);
    actions.set(id, action);
  }

  /** @type {Set<string>} */
  const used = new Set();
  const sections = /** @type {unknown[]} */ (panel.sections);
  validateSections(sections, { ids, kinds: PANEL_SECTION_KINDS, actions, used });

  // Least privilege: an action nothing can trigger, or a permission no action
  // uses, is a grant the operator is asked to accept for nothing.
  for (const id of actions.keys()) require(used.has(id), `unused_action:${id}`);
  const commands = new Set([...actions.values()].map((action) => text(action.command)));
  for (const name of declared) {
    require(PERMISSIONS[/** @type {keyof typeof PERMISSIONS} */ (name)].some((command) => commands.has(command)), `unused_permission:${name}`);
  }

  const declaredMinOs = text(manifest.min_os) || "v1.0.0";
  require(compareVersions(declaredMinOs, PANEL_MIN_OS) >= 0,
    `min_os_too_low:declares_v${declaredMinOs.replace(/^v/, "")}_needs_v${PANEL_MIN_OS.replace(/^v/, "")}`);

  return {
    sources: ids.size,
    sections: sections.length,
    refreshMs: /** @type {number} */ (refresh),
    actions: actions.size,
    permissions: [...declared],
  };
}

/**
 * @typedef {object} PackageReport
 * @property {"flow"|"readout"|"panel"} kind
 * @property {string} id
 * @property {string} version
 * @property {number} size canonical bytes
 * @property {number} nodes
 * @property {number} estimatedUs
 * @property {number} memoryBytes
 * @property {string} minOs
 * @property {number} [budgetUs]
 * @property {number} [cellCount]
 * @property {number} [windowFloats]
 * @property {number} [sources]
 * @property {number} [sections]
 * @property {number} [refreshMs]
 * @property {number} [actions] a panel's action count
 * @property {string[]} [permissions] a panel's declared permissions
 * @property {number} [vmBytes] a flow package's image size
 * @property {number} [poolBytes] RAM the image takes from the device's app pool
 */

/**
 * Validate a whole package. Throws PackageError on the first problem.
 * @param {unknown} doc
 * @param {Uint8Array|null} [raw] the bytes that will be uploaded (default: canonical)
 * @param {ValidateOptions} [options]
 * @returns {PackageReport}
 */
/**
 * A flow package's NHVM/1 image: present, well formed, passes the device's
 * verifier with the declared capabilities, and fits the budget when its cost
 * has a bound (an image with loops is time-sliced instead).
 * @param {Record<string, any>} doc
 * @param {Record<string, any>} manifest
 * @param {ValidateOptions} options
 */
function validateImage(doc, manifest, options) {
  const cellCount = options.cellCount ?? DEFAULT_CELL_COUNT;
  require(!("nodes" in doc), "nodes_not_supported:rebuild_with_sdk_3");
  require(typeof doc.vm === "string" && doc.vm.length > 0, "missing_vm:rebuild_with_sdk_3");
  /** @type {Uint8Array} */
  let image;
  try {
    image = fromBase64(doc.vm);
  } catch {
    throw new PackageError("invalid_vm_base64");
  }
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  /** @type {import("./vm.mjs").VmVerified} */
  let verified;
  try {
    verified = verifyImage(image, { capabilities, cellCount });
  } catch (error) {
    if (error instanceof VmImageError) throw new PackageError(`invalid_vm:${error.message}`);
    throw error;
  }
  if ("symbols" in doc) {
    require(Array.isArray(doc.symbols) && doc.symbols.length <= verified.image.nodes.length
      && doc.symbols.every((/** @type {any} */ s) => isObject(s) && typeof s.name === "string"), "invalid_symbols");
  }
  // The device only saves counters for an app that declares persist; one
  // that does not would silently start from zero on every boot.
  require(!verified.image.nodes.some((node) => (node.flags & 1) !== 0) || capabilities.includes("persist"),
    "capability_not_declared:persist");
  let needed = VM_TS_MIN_OS;
  for (const cap of capabilities) {
    const since = CAPABILITY_SINCE[String(cap)];
    if (since && compareVersions(since, needed) > 0) needed = since;
  }
  const declaredMinOs = text(manifest.min_os) || "v1.0.0";
  require(compareVersions(declaredMinOs, needed) >= 0,
    `min_os_too_low:declares_v${declaredMinOs.replace(/^v/, "")}_needs_v${needed.replace(/^v/, "")}`);
  const estimatedUs = verified.loopFree ? Math.ceil(verified.estimatedNs / 1000) : 0;
  const declaredBudget = isInt(manifest.budget_us) ? /** @type {number} */ (manifest.budget_us) : DEFAULT_BUDGET_US;
  const budgetUs = Math.min(declaredBudget, DEFAULT_BUDGET_US);
  require(estimatedUs <= budgetUs, `over_budget:${estimatedUs}us>${budgetUs}us`);
  return {
    nodes: verified.image.nodes.length,
    estimatedUs,
    budgetUs,
    cellCount,
    memoryBytes: appMemoryBytes(verified.poolBytes, Array.isArray(manifest.capabilities) ? manifest.capabilities : []),
    loopFree: verified.loopFree,
    vmBytes: image.length,
    poolBytes: verified.poolBytes,
    minOs: compareVersions(needed, declaredMinOs) > 0 ? needed : declaredMinOs,
  };
}

/**
 * Validate a whole package. Throws PackageError on the first problem.
 * @param {unknown} doc
 * @param {Uint8Array|null} [raw] the bytes that will be uploaded (default: canonical)
 * @param {ValidateOptions} [options]
 * @returns {PackageReport}
 */
export function validatePackage(doc, raw = null, options = {}) {
  require(isObject(doc), "not_a_package");
  require(doc.nhapp === 1, `unsupported_package_version:${text(doc.nhapp)}`);
  const kind = text(doc.kind) || "flow";
  require(kind === "flow" || kind === "readout" || kind === "panel", `unsupported_kind:${text(doc.kind)}`);

  const manifest = doc.manifest;
  require(isObject(manifest), "missing_manifest");
  validateManifest(manifest);
  // Permissions unlock commands a panel may send; nothing else sends any.
  require(kind === "panel" || !("permissions" in manifest), "permissions_only_for_panel");

  /** @type {Omit<PackageReport, "id"|"version"|"size">} */
  let report;
  if (kind === "readout" || kind === "panel") {
    // Stored by the device but never dispatched: it holds a registry entry
    // and nothing else -- no nodes, no budget, no slot.
    require(!("nodes" in doc), `${kind}_must_not_declare_nodes`);
    const other = kind === "readout" ? "panel" : "readout";
    require(!(other in doc), `${kind}_must_not_declare_a_${other}`);
    report = {
      ...(kind === "readout" ? validateReadout(doc.readout) : validatePanel(doc.panel, manifest)),
      kind,
      nodes: 0,
      estimatedUs: 0,
      memoryBytes: 0,
      minOs: text(manifest.min_os) || "v1.0.0",
    };
  } else {
    require(!("readout" in doc), "flow_must_not_declare_a_readout");
    require(!("panel" in doc), "flow_must_not_declare_a_panel");
    report = { ...validateImage(doc, manifest, options), kind: "flow" };
  }

  const bytes = raw ?? canonicalBytes(doc);
  require(bytes.length <= MAX_PACKAGE_BYTES, `package_too_large:${bytes.length}>${MAX_PACKAGE_BYTES}`);

  return { ...report, id: text(manifest.id), version: text(manifest.version), size: bytes.length };
}
