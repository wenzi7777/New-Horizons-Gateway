// @ts-check
/**
 * What a panel package may declare.
 *
 * A panel is a readout that can also ACT: a table row can carry a "..." menu,
 * a page can have tabs, and a Run box can start something that is stopped.
 * Every readout is a valid panel with no actions; `kind: "readout"` packages
 * keep working unchanged.
 *
 * The safety rule is the readout's, extended rather than relaxed:
 *
 * - It stays DECLARATIVE. A panel names commands, argument templates and
 *   widgets; it carries no code, and an argument is a constant, a field of the
 *   row it was invoked on, or a value the operator typed -- never an
 *   expression. Values are data and never become code.
 * - What it may SEND is fixed by the permissions its manifest declares. Each
 *   permission maps to a short, fixed list of commands below. A panel cannot
 *   name a command outside the permissions it declared, and some commands are
 *   off limits whatever it declares.
 * - What it may POLL is exactly what a readout may poll.
 *
 * This table is the one definition; the firmware does not read panels, but
 * the Desktop's renderer and backend gate mirror it and are tested against it.
 */

import { ALLOWED_SOURCES as READOUT_SOURCES } from "./readoutset.mjs";

/**
 * Permission -> the commands it unlocks. All of them act on this boot only:
 * nothing a panel can send is persisted, so a reboot undoes it.
 */
export const PERMISSIONS = Object.freeze({
  task_control: Object.freeze(["task_stop", "task_start", "task_set_period"]),
  service_control: Object.freeze(["service_stop", "service_start", "service_restart"]),
  app_control: Object.freeze(["app_stop", "app_start", "app_revive"]),
});

/** Every command any permission unlocks. */
export const ACTION_COMMANDS = Object.freeze(new Set(Object.values(PERMISSIONS).flat()));

/**
 * Commands a panel may never send, whatever it declares: anything that writes
 * configuration or files, reboots, or changes what is installed. The list in
 * PERMISSIONS already excludes them; this is the second lock, so that widening
 * a permission by mistake still cannot let one through.
 */
export const FORBIDDEN_COMMAND_PREFIXES = Object.freeze(["set_", "file_write", "file_delete", "reboot"]);
export const FORBIDDEN_COMMANDS = Object.freeze(new Set([
  "app_install",
  "app_uninstall",
  "app_activate",
  "app_enable",
  "app_disable",
  "config_set",
  "enter_maintenance",
  "exit_maintenance",
  "factory_reset",
  "ota_update",
]));

/** @param {string} command */
export function isForbiddenCommand(command) {
  return FORBIDDEN_COMMANDS.has(command) || FORBIDDEN_COMMAND_PREFIXES.some((prefix) => command.startsWith(prefix));
}

/** Read-only commands a panel may poll: the same list a readout has. */
export const ALLOWED_SOURCES = READOUT_SOURCES;

/** A readout's widgets, plus tabs (pages of sections) and run (the Run box). */
export const SECTION_KINDS = Object.freeze(new Set(["stats", "table", "chart", "tabs", "run"]));

/** Section kinds a tab may hold: no tabs inside tabs. */
export const TAB_SECTION_KINDS = Object.freeze(new Set(["stats", "table", "chart", "run"]));

/** What the operator is asked for when an action takes input. */
export const INPUT_KINDS = Object.freeze(new Set(["number", "text"]));

/**
 * An argument value is a constant (string, number, boolean) or exactly one of
 * these templates. Nothing is computed: `$row.period_us` is the value of that
 * field, `$input.period_us` is what the operator typed.
 */
export const TEMPLATE_RE = /^\$(row|input)\.([a-z_][a-z0-9_]*)$/;

/**
 * A field a panel reads. Panels may reach into nested results with a dotted
 * path (`cpu.cores`, `cores.0.busy_permille`): each step is an object key or
 * an array index, nothing more.
 */
export const FIELD_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

/** The first firmware that stores a `kind: "panel"` package (older ones refuse it as unsupported_kind). */
export const PANEL_MIN_OS = "v1.19.0";

export const MAX_ACTIONS = 16;
export const MAX_TABS = 8;
export const MAX_ROW_ACTIONS = 8;
export const MAX_RUN_CANDIDATES = 8;
export const MAX_ARGS = 8;
export const MAX_CONDITIONS = 4;
export const MAX_ARG_TEXT = 64;
export const MAX_LABEL = 48;
export const MAX_CONFIRM_TEXT = 200;
export const MAX_INPUT_TEXT = 64;
/** Steps in a dotted field path the renderer will follow. */
export const MAX_PATH_DEPTH = 6;

// --- conditions ------------------------------------------------------------
//
// The one definition of how `when` and `hidden_when` are read. The Desktop's
// renderer is tested against CONDITION_CASES below, so the two cannot drift.
//
// - `when` ENABLES an action: every condition must hold (AND). No `when`
//   means always enabled.
// - `hidden_when` HIDES it: any condition holding is enough (OR). No
//   `hidden_when` means never hidden. Hidden wins over enabled.
// - A condition is `{field, eq}` or `{field, ne}` against a constant.
//   Comparison is by value, with numbers, booleans and strings compared as
//   text, because the firmware's hand-built JSON reports `3` and `"3"`,
//   `true` and `"true"` interchangeably.
// - A field the row does not report (missing or null) satisfies NO condition,
//   `ne` included: nothing reported, nothing matched. So an action gated on a
//   field an older firmware lacks is disabled rather than guessed at, and a
//   `hidden_when` on such a field does not hide it.
// - Anything else (an unknown operator, a malformed condition) never holds.

/** Walks a dotted path (object keys, array indices) through a row. */
export function fieldValue(row, path) {
  if (typeof path !== "string" || !path) return undefined;
  const keys = path.split(".");
  // Deeper than MAX_PATH_DEPTH is "not reported", never a value part-way down.
  if (keys.length > MAX_PATH_DEPTH) return undefined;
  let value = row;
  for (const key of keys) {
    if (Array.isArray(value)) {
      value = /^\d+$/.test(key) ? value[Number(key)] : undefined;
    } else if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key)) {
      value = value[key];
    } else {
      return undefined;
    }
  }
  return value;
}

/** Whether one condition holds for a row. */
export function conditionHolds(condition, row) {
  if (!condition || typeof condition !== "object" || typeof condition.field !== "string") return false;
  const value = fieldValue(row, condition.field);
  if (value === undefined || value === null) return false;
  if ("eq" in condition) return String(value) === String(condition.eq);
  if ("ne" in condition) return String(value) !== String(condition.ne);
  return false;
}

/** `when`: enabled when every condition holds (none declared: enabled). */
export function actionEnabled(when, row) {
  if (when === undefined || when === null) return true;
  const list = Array.isArray(when) ? when : [when];
  return list.every((condition) => conditionHolds(condition, row));
}

/** `hidden_when`: hidden when any condition holds (none declared: shown). */
export function actionHidden(hiddenWhen, row) {
  if (hiddenWhen === undefined || hiddenWhen === null) return false;
  const list = Array.isArray(hiddenWhen) ? hiddenWhen : [hiddenWhen];
  return list.some((condition) => conditionHolds(condition, row));
}

/**
 * The executable form of the rules above: [description, when, hidden_when,
 * row, enabled, hidden]. Any renderer of panels must agree with every case.
 */
export const CONDITION_CASES = Object.freeze([
  ["no conditions", undefined, undefined, { state: "running" }, true, false],
  ["eq holds", { field: "state", eq: "running" }, undefined, { state: "running" }, true, false],
  ["eq fails", { field: "state", eq: "stopped" }, undefined, { state: "running" }, false, false],
  ["ne holds", { field: "state", ne: "stopped" }, undefined, { state: "running" }, true, false],
  ["ne fails", { field: "state", ne: "running" }, undefined, { state: "running" }, false, false],
  ["when is AND: one fails",
    [{ field: "state", eq: "running" }, { field: "protected", eq: false }], undefined,
    { state: "running", protected: true }, false, false],
  ["when is AND: all hold",
    [{ field: "state", eq: "running" }, { field: "protected", eq: false }], undefined,
    { state: "running", protected: false }, true, false],
  ["hidden_when is OR: one holds", undefined,
    [{ field: "protected", eq: true }, { field: "always_run", eq: true }],
    { protected: false, always_run: true }, true, true],
  ["hidden_when is OR: none holds", undefined,
    [{ field: "protected", eq: true }, { field: "always_run", eq: true }],
    { protected: false, always_run: false }, true, false],
  ["hidden and enabled are independent", { field: "state", eq: "running" },
    { field: "protected", eq: true }, { state: "running", protected: true }, true, true],
  ["number vs text compares as text", { field: "core", eq: 1 }, undefined, { core: "1" }, true, false],
  ["boolean vs text compares as text", { field: "protected", eq: true }, undefined, { protected: "true" }, true, false],
  ["missing field fails eq", { field: "state", eq: "running" }, undefined, {}, false, false],
  ["missing field fails ne too", { field: "state", ne: "stopped" }, undefined, {}, false, false],
  ["null field fails ne too", { field: "state", ne: "stopped" }, undefined, { state: null }, false, false],
  ["missing field does not hide", undefined, { field: "protected", eq: true }, {}, true, false],
  ["dotted path", { field: "cpu.cores.0.busy_permille", ne: 0 }, undefined,
    { cpu: { cores: [{ busy_permille: 12 }] } }, true, false],
  ["unknown operator never holds", { field: "state", in: ["running"] }, undefined, { state: "running" }, false, false],
  ["deeper than MAX_PATH_DEPTH is not reported", { field: "a.b.c.d.e.f.g", ne: "x" }, undefined,
    { a: { b: { c: { d: { e: { f: { g: "y" } } } } } } }, false, false],
  ["inherited keys are not fields", { field: "constructor", ne: "x" }, undefined, {}, false, false],
]);
