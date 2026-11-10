// App Studio's "AI prompt": a self-contained brief an author pastes into an
// external language model (ChatGPT, Claude, ...) to have it write an app.
//
// Nothing is sent anywhere from here. The prompt is built from the same SDK
// the compiler and validator run on -- limits, ops, functions, fields -- plus
// the App Library's authoring guide and example apps, vendored beside the SDK
// by ../sdk/sync.mjs, so it cannot describe a language the page
// would then refuse. It is in English whatever the UI language: models follow
// English instructions best, and are told to answer in the user's language.

import authoringGuide from "../sdk/docs/authoring.md?raw";
import matViewExample from "../sdk/examples/mat_view.nhs?raw";
import sensorsExample from "../sdk/examples/sensors.readout.json?raw";
import stepsExample from "../sdk/examples/steps.nhs?raw";
import sysmonPanelExample from "../sdk/examples/sysmon.panel.json?raw";
import tiltExample from "../sdk/examples/tilt.nhs?raw";
import {
  CAPABILITIES,
  CELL_OP_NS_PER_CELL,
  DEFAULT_BUDGET_US,
  FEATURES_NS_PER_CELL,
  FEATURE_FIELDS,
  IMU_FIELDS,
  LANGUAGE,
  LED_COLOURS,
  MAG_FIELDS,
  MAX_APP_ID,
  MAX_DEBOUNCE_MS,
  MAX_EVENT_NAME,
  MAX_EXT_LEDS,
  MAX_NODES,
  MAX_OLED_DIGITS,
  MAX_OLED_LABEL,
  MAX_PACKAGE_BYTES,
  MAX_PENDING_PRESSES,
  MAX_REGION_INDEX,
  MAX_REL_PERCENT,
  MAX_WINDOW,
  OLED_COLS,
  OLED_ROWS,
  OPS,
  PERSIST_INTERVAL_MS,
  PRESSURE_ACTIVE_THRESHOLD,
  PRESSURE_FULL_SCALE,
  SCALAR_OP_NS,
  TICK_FALLBACK_MS,
  TICK_PERIOD_MS,
  WINDOW_POOL,
  panelset,
  readoutset,
  type Diagnostic,
} from "../sdk/lib/index.mjs";
import { STATEMENT_FORMS, functionDoc } from "./nhsLanguage";
import { MAX_PANEL_ACTIONS, MAX_PANEL_TABS, PANEL_PERMISSIONS } from "./panelRules";
import type { BoardSpec, SdkKind } from "./sdkProject";

/** The shape of each readout section kind, for the Reference tab and the prompt. */
export const READOUT_SECTION_FORMS: readonly (readonly [kind: string, form: string])[] = [
  ["stats", '{ "kind": "stats", "title": "…", "items": [{ "label", "source", "field", "format", "hint" }] }'],
  ["table", '{ "kind": "table", "title": "…", "source": "…", "sort": { "field", "desc" }, "columns": [{ "label", "field", "format", "bar", "bar_max" }] }'],
  ["chart", '{ "kind": "chart", "title": "…", "source": "…", "points": 60, "min", "max", "series": [{ "label", "field" }] }'],
];

/** The flow examples quoted in a prompt, as vendored from the App Library's apps/. */
export const FLOW_EXAMPLES: readonly { id: string; source: string }[] = [
  { id: "steps", source: stepsExample },
  { id: "tilt", source: tiltExample },
  { id: "mat_view", source: matViewExample },
];

/** The readout examples (read-only packages). */
export const READOUT_EXAMPLES: readonly { id: string; source: string }[] = [
  { id: "sensors", source: sensorsExample },
];

/**
 * The panel examples: a readout plus actions. sysmon uses every section kind,
 * tabs, row menus, an input and the Run box.
 */
export const PANEL_EXAMPLES: readonly { id: string; source: string }[] = [
  { id: "sysmon", source: sysmonPanelExample },
];

/** The shape of the sections and actions only a panel has. */
export const PANEL_FORMS: readonly (readonly [kind: string, form: string])[] = [
  ["tabs", '{ "kind": "tabs", "title": "…", "tabs": [{ "title": "…", "sections": [ … ] }] }'],
  ["run", '{ "kind": "run", "title": "…", "placeholder": "…", "candidates": [{ "source", "field", "action" }] }'],
  ["row_actions", '"row_actions": ["<action id>", …]   (on a table section)'],
  ["action", '{ "id", "label", "command", "args": { "name": "$row.name", "period_us": "$input.period_us" }, "when": [{ "field", "eq" | "ne": <constant> }] (AND: every condition must hold to enable; a missing field matches nothing), "hidden_when": [ … ] (OR: any condition hides), "input": { "field", "kind": "number", "label", "unit", "min", "max", "default": "$row.<field>" }, "confirm": { "title", "message": "… {name} …", "destructive" } }'],
];

/** What the prompt says about the device the app is meant for. */
export type PromptTarget = {
  rows: number;
  cols: number;
  /** Known for the virtual device and for a device whose model is in BOARDS. */
  board?: BoardSpec;
  /** The device's firmware version, when the target is a real device. */
  firmware?: string;
  /** Shown when the board is not known. */
  label?: string;
};

export type PromptDiagnostic = Pick<Diagnostic, "severity" | "message" | "line" | "col" | "code">;

export type AiPromptOptions = {
  kind: SdkKind;
  /** What the app should do, in the author's own words (any language). */
  request: string;
  board: PromptTarget;
  /** Quote the editor's program and its diagnostics, and ask for a fix. */
  includeCurrent: boolean;
  source?: string;
  diagnostics?: readonly PromptDiagnostic[];
  /** The manifest author to use; the model picks a placeholder without it. */
  author?: string;
};

/** A fence that no backtick run inside `text` can close early. */
function fenced(language: string, text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text.replace(/\s+$/, "")}\n${fence}`;
}

function bullets(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

function code(values: Iterable<string>): string {
  return [...values].map((value) => `\`${value}\``).join(", ");
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatDiagnostic(diagnostic: PromptDiagnostic): string {
  const where = diagnostic.line == null ? "whole app" : `line ${diagnostic.line}${diagnostic.col == null ? "" : `:${diagnostic.col}`}`;
  return `${where} — ${diagnostic.severity}: ${diagnostic.message}${diagnostic.code ? ` [${diagnostic.code}]` : ""}`;
}

function targetSection(kind: SdkKind, target: PromptTarget): string {
  const cells = target.rows * target.cols;
  const board = target.board;
  const lines: string[] = [];
  if (board) {
    lines.push(`Board: ${board.name} (hardware model "${board.hardwareModel}").`);
  } else {
    lines.push(`Board: ${target.label?.trim() || "unknown"} (not a board this prompt has details for).`);
  }
  if (target.firmware) lines.push(`Firmware on the device: ${target.firmware}. Do not use anything that needs a newer OS.`);
  if (kind === "readout" || kind === "panel") {
    lines.push(kind === "panel"
      ? "A panel runs in the Desktop app, not on the device: it polls the device's read-only commands, draws widgets from the answers, and sends the few commands its permissions allow when the operator picks an action."
      : "A readout runs in the Desktop app, not on the device: it polls the device's read-only commands and draws widgets from the answers.");
    if (board) {
      lines.push(`Sensors: magnetometer ${yesNo(board.magnetometer)}, fuel gauge ${yesNo(board.fuelGauge)}.`);
    }
    return bullets(lines);
  }
  lines.push(
    `Pressure matrix: ${target.rows} rows x ${target.cols} columns (${cells} cells), rows 0..${target.rows - 1}, columns 0..${target.cols - 1}. `
      + "Prefer percent regions (`rows 0%..50%`) so the app also fits other matrices.",
  );
  lines.push(
    `Cell values run 0..${PRESSURE_FULL_SCALE}; a cell at or above ${PRESSURE_ACTIVE_THRESHOLD} counts as in contact. `
      + "Thresholds on sums grow with the region's size: say in a comment that they need tuning.",
  );
  lines.push(
    `Cost on this matrix: each sweep (sum, total, peak, active, centroids, ...) is about ${((CELL_OP_NS_PER_CELL * cells) / 1000).toFixed(1)} µs, `
      + `one features sweep ${((FEATURES_NS_PER_CELL * cells) / 1000).toFixed(1)} µs, any scalar node ${(SCALAR_OP_NS / 1000).toFixed(1)} µs; `
      + `the whole graph must stay within ${DEFAULT_BUDGET_US} µs per frame.`,
  );
  if (board) {
    lines.push(board.oled
      ? `OLED: yes, ${OLED_ROWS} rows (0..${OLED_ROWS - 1}) of ${OLED_COLS} characters; \`show\` and \`bar\` draw on it.`
      : "OLED: none. `show` and `bar` compile but nothing displays them on this board; do not rely on them.");
    lines.push(board.button
      ? `Action button: yes. \`button()\` is true for one frame per short press (up to ${MAX_PENDING_PRESSES} presses queue).`
      : "Action button: none. `button()` never fires on this board.");
    lines.push(board.externalLeds > 0
      ? `External LED strip: ${board.externalLeds} pixels (\`pixel 0\`..\`pixel ${board.externalLeds - 1}\`, \`meter\` spans them all).`
      : "External LED strip: none. `pixel` and `meter` show nothing on this board.");
    lines.push("Status LED (`led <colour> when <event>`): yes.");
    lines.push(`Magnetometer (\`mag()\`): ${board.magnetometer ? "yes" : "none, mag() reads 0"}. Fuel gauge (\`battery()\`): ${board.fuelGauge ? "yes" : "none, battery() reads -1"}.`);
  }
  return bullets(lines);
}

function flowLimits(): string {
  return bullets([
    `At most ${MAX_NODES} nodes after compilation. Every function call, constant, arithmetic operator, comparison and output statement is (at least) one node; identical sub-expressions are shared. Keep the program small.`,
    `Package size at most ${MAX_PACKAGE_BYTES} bytes.`,
    `App id: lowercase letters, digits and \`_\`, starting with a letter, at most ${MAX_APP_ID} characters, not \`index\`.`,
    `Event and emit names at most ${MAX_EVENT_NAME} characters.`,
    `Window length (mean/max_hold/integrate frames) at most ${MAX_WINDOW}; all windows in one app together at most ${WINDOW_POOL} frames.`,
    `\`for <n>ms\` at most ${MAX_DEBOUNCE_MS} ms.`,
    `Absolute region indices at most ${MAX_REGION_INDEX}; percent regions 0..${MAX_REL_PERCENT}.`,
    `OLED rows 0..${OLED_ROWS - 1}; labels at most ${MAX_OLED_LABEL} printable ASCII characters (the font draws nothing else); \`digits\` 0..${MAX_OLED_DIGITS}.`,
    `External pixels 0..${MAX_EXT_LEDS - 1}. LED colours: ${code(Object.keys(LED_COLOURS))} only.`,
    `\`background yes\` keeps the app running at ${1000 / TICK_PERIOD_MS} Hz after ${TICK_FALLBACK_MS} ms without frames. A \`persist\` signal is written to flash at most every ${PERSIST_INTERVAL_MS / 1000} s.`,
    "No loops, no recursion, no user-defined functions: a name may only be used after it is declared.",
  ]);
}

function flowReference(): string {
  const statements = STATEMENT_FORMS.map(([, form]) => form).join("\n");
  const functions = LANGUAGE.functions.map((name) => {
    const doc = functionDoc(name);
    // "() or (region)" reads as `peak()` or `peak(region)`.
    const forms = (doc?.args ?? "()").split(" or ").map((args) => `\`${name}${args}\``).join(" or ");
    return `- ${forms} — ${doc?.info ?? ""}`.trimEnd();
  }).join("\n");
  const ops = Object.values(OPS).map((op) => {
    const cost = op.sweep ? `${op.nsPerCell} ns/cell` : `${op.nsFlat} ns`;
    return `- \`${op.name}\` (${cost}, OS ${op.since}) — ${op.summary}`;
  }).join("\n");
  return [
    "### Statements",
    fenced("", statements),
    "Expressions use numbers, declared names, the functions below, `+ - * / %` and parentheses. "
      + "`>` and `>=` both mean \"at or above\"; `<` and `<=` cost two extra nodes. An event's name is also a value: 1 while it holds, 0 when not.",
    "",
    "### Functions",
    functions,
    "",
    "### Names",
    bullets([
      `\`feature(<field>)\`: ${code(FEATURE_FIELDS)}`,
      `\`imu(<field>)\`: ${code(IMU_FIELDS)}`,
      `\`mag(<field>)\`: ${code(MAG_FIELDS)}`,
      `Colours: ${code(Object.keys(LED_COLOURS))}`,
      `Keywords: ${code(LANGUAGE.keywords)}`,
      `Capabilities (the compiler derives them, and \`min_os\`, from what the program uses; never declare them): ${code(Object.keys(CAPABILITIES))}`,
    ]),
    "",
    "### Device ops",
    "What the compiler emits, for counting nodes and cost. These are not .nhs syntax: write the functions above.",
    ops,
  ].join("\n");
}

function readoutReference(): string {
  const r = readoutset;
  return [
    "### Package",
    fenced("json", `{
  "nhapp": 1,
  "kind": "readout",
  "manifest": { "id": "…", "name": "…", "version": "1.0.0", "author": "…", "summary": "…", "category": "diagnostics", "min_os": "v1.2.0", "icon": "…" },
  "readout": { "refresh_ms": 1000, "sources": [ … ], "sections": [ … ] }
}`),
    bullets([
      `\`manifest.id\`: lowercase letters, digits and \`_\`, starting with a letter, at most ${MAX_APP_ID} characters, not \`index\`. \`version\` is semver. \`id\`, \`name\`, \`version\`, \`author\` and \`summary\` are required.`,
      "Set `min_os` to `v1.6.0` when a source uses `sensor_sample`, otherwise `v1.2.0`.",
      "No `nodes` key: a readout carries no code.",
      `\`refresh_ms\`: ${r.MIN_REFRESH_MS}..${r.MAX_REFRESH_MS} (default 1000).`,
    ]),
    "",
    "### Sources",
    `Each source is \`{ "id": "<lowercase name>", "command": "<command>", "path": "<optional key>" }\`. Ids are unique. At most ${r.MAX_SOURCES} sources.`,
    `Allowed commands (read-only): ${code(r.ALLOWED_SOURCES)}.`,
    "Without `path` a source is the command's result object (one row); with `path` it is the list (rows for a table) or object under that key, e.g. `sensor_sample` with `path` `imu`, `mag` or `battery`. Several sources may poll the same command with different paths.",
    "Only use field names that appear in the examples below. If you must guess a field of another command, list the guesses in your note so the user can check them in the Desktop Terminal page.",
    "",
    "### Sections",
    `At most ${r.MAX_SECTIONS} sections, each with a non-empty \`title\`; kinds: ${code(r.SECTION_KINDS)}.`,
    fenced("", READOUT_SECTION_FORMS.map(([, form]) => form).join("\n")),
    bullets([
      `stats: up to ${r.MAX_STATS} items, each naming its own source.`,
      `table: one list source, up to ${r.MAX_COLUMNS} columns; \`bar: true\` draws the value as a bar up to \`bar_max\`; \`sort\` is optional.`,
      `chart: plots up to ${r.MAX_SERIES} numeric fields of one source over the last \`points\` polls (${r.MIN_CHART_POINTS}..${r.MAX_CHART_POINTS}, default 60); \`min\`/\`max\` fix the axis (max > min).`,
      `Formats: ${code(r.FORMATS)} (default \`raw\`). \`permille\` shows 996 as 99.6%, \`micros\` 1234 as 1.23 ms, \`bytes\` as KB/MB, \`percent\` 0.42 as 42%.`,
    ]),
  ].join("\n");
}

const PANEL_MIN_OS = panelset.PANEL_MIN_OS;

function panelReference(kind: SdkKind): string {
  const permissions = Object.entries(PANEL_PERMISSIONS)
    .map(([permission, commands]) => `\`${permission}\`: ${code(commands)}`);
  return [
    kind === "panel"
      ? "A panel (`\"kind\": \"panel\"`, key `panel` instead of `readout`) is a readout that may also act on the device. Everything in the readout reference above applies; this is what it adds."
      : "For reference only: this project is a readout, which cannot act. A panel (`\"kind\": \"panel\"`, key `panel` instead of `readout`) is a readout that may also act on the device; App Studio makes one with \"New panel\". If the request needs buttons that change the device, say so in your note and write the read-only part as a readout.",
    bullets([
      "`manifest.permissions` declares what a panel may send; each permission allows exactly these commands, nothing else:",
      ...permissions.map((line) => `  ${line}`),
      `At most ${MAX_PANEL_ACTIONS} actions and ${MAX_PANEL_TABS} tabs. An argument is a constant, \`$row.<field>\` or \`$input.<field>\`; nothing is computed.`,
      "`when` enables an action only when EVERY condition holds; `hidden_when` hides it when ANY condition holds. A condition is exactly `{ \"field\", \"eq\" }` or `{ \"field\", \"ne\" }` against a constant (compared as text); a field the row does not report matches nothing, `ne` included.",
      "Every permission declared must be used by an action, and every action must be reachable from a table's `row_actions` or a `run` section.",
      `\`min_os\` must be at least \`${PANEL_MIN_OS}\`.`,
      "Stops last until reboot; the device refuses protected tasks and services itself.",
    ]),
    fenced("", PANEL_FORMS.map(([, form]) => form).join("\n")),
  ].join("\n");
}

/**
 * Builds the prompt. Deterministic: the same options give the same text, so
 * it can be tested and diffed.
 */
export function buildAiPrompt(options: AiPromptOptions): string {
  const { kind, board, includeCurrent } = options;
  const request = options.request.trim();
  const source = options.source ?? "";
  const diagnostics = options.diagnostics ?? [];
  const flow = kind === "flow";
  const panel = kind === "panel";
  const noun = panel ? "panel" : "readout";
  const language = flow ? "nhs" : "json";
  const parts: string[] = [];

  parts.push(flow
    ? "# Write an NHOS flow app (.nhs)"
    : `# Write an NHOS ${noun} (${noun}.json)`);
  parts.push(flow
    ? "You are writing an app for New Horizons OS (NHOS), the firmware of the TIA-CTL pressure-sensing boards (ESP32-S3 with a pressure matrix, IMU and, on some boards, an OLED, an action button and LEDs). Apps are written in `.nhs`, a small declarative language that compiles to a flow graph the device evaluates once per scanned frame. It is NOT a general-purpose language: only the statements and functions documented below exist."
    : panel
      ? "You are writing a panel for New Horizons OS (NHOS), the firmware of the TIA-CTL pressure-sensing boards. A panel is a declarative JSON package: it names read-only device commands to poll, widgets the Desktop app draws from their answers, and actions (row menus, a Run box) that send a small, permission-gated set of commands. It carries no code."
      : "You are writing a readout for New Horizons OS (NHOS), the firmware of the TIA-CTL pressure-sensing boards. A readout is a declarative JSON package: it names read-only device commands to poll and widgets (stats, tables, charts) the Desktop app draws from their answers. It carries no code.");
  parts.push("The user will paste your answer into NHOS App Studio, which compiles and validates it immediately, so it must be valid exactly as written.");

  parts.push("## What the user wants");
  if (request) {
    parts.push(request);
  } else if (includeCurrent) {
    parts.push("(No description given.) Fix the current program below so it builds, keeping what it is meant to do.");
  } else {
    parts.push(flow
      ? "(No description given.) Write a small, useful app for this board that shows off what it can do."
      : `(No description given.) Write a small, useful ${noun} for this board.`);
  }

  parts.push("## Output contract");
  parts.push(bullets([
    flow
      ? "Reply with exactly ONE fenced code block tagged `nhs` holding the complete program, starting with the `app <id> { … }` header."
      : panel
        ? "Reply with exactly ONE fenced code block tagged `json` holding the complete package (`nhapp`, `\"kind\": \"panel\"`, `manifest` with `permissions`, `panel`)."
        : "Reply with exactly ONE fenced code block tagged `json` holding the complete package (`nhapp`, `kind`, `manifest`, `readout`).",
    "No text before the block. After it, at most three short lines of notes: assumptions, values to tune, anything the request asked for that this format cannot do.",
    flow
      ? "Use only the statements, functions, field names and colours listed in the reference below. Do not invent syntax, functions or library calls."
      : "Use only the commands, section kinds and formats listed below. JSON only: no comments, no trailing commas.",
    flow
      ? "Comment the program with `#` lines explaining each step. Write comments in the language of the user's request; keep identifiers in English, and OLED labels in printable ASCII."
      : "Write titles, labels and hints in the language of the user's request; keep ids, commands and field names as they are.",
    `Stay within the hard limits. If the request does not fit, implement the most useful part and say what was left out.`,
    ...(options.author?.trim() ? [`Use \`${options.author.trim()}\` as the author.`] : []),
  ]));

  parts.push("## Target device");
  parts.push(targetSection(kind, board));

  if (flow) {
    parts.push("## Hard limits");
    parts.push(flowLimits());
    parts.push("## Language reference");
    parts.push(flowReference());
    parts.push("## Authoring guide");
    parts.push("The language's own guide, from the NHOS App Library. Where it and the reference above disagree, the reference above wins (it is generated from the compiler this program will meet).");
    parts.push(`<authoring_guide>\n${authoringGuide.trim()}\n</authoring_guide>`);
    parts.push("## Example apps");
    parts.push("Published apps from the App Library, all of which compile. Follow their style.");
    for (const example of FLOW_EXAMPLES) {
      parts.push(`### ${example.id}\n${fenced("nhs", example.source)}`);
    }
  } else {
    parts.push("## Readout reference");
    parts.push(readoutReference());
    parts.push("## Example readouts");
    parts.push("Published packages from the App Library. Between them they show the field names the commands they poll return.");
    for (const example of READOUT_EXAMPLES) {
      parts.push(`### ${example.id}\n${fenced("json", example.source)}`);
    }
    parts.push(panel ? "## Panel reference" : "## Panels");
    parts.push(panelReference(kind));
    parts.push("The published System Monitor panel. Its `sysmon` sources show the field names of tasks, services, apps, memory, scan and threads; a readout may poll `sysmon` too, and a dotted `path` (`scheduler.tasks`) walks into its parts.");
    for (const example of PANEL_EXAMPLES) {
      parts.push(`### ${example.id}\n${fenced("json", example.source)}`);
    }
  }

  if (includeCurrent) {
    parts.push(flow ? "## Current program" : `## Current ${noun}`);
    parts.push(source.trim()
      ? `This is what is in the editor now. Build on it: keep its id and whatever already works.\n\n${fenced(language, source)}`
      : "The editor is empty.");
    const problems = diagnostics.filter((diagnostic) => diagnostic.severity !== "info");
    if (problems.length) {
      parts.push("Studio reports these problems with it. Fix every one:");
      parts.push(bullets(problems.map(formatDiagnostic)));
    } else if (source.trim()) {
      parts.push("It currently builds without errors.");
    }
  }

  parts.push("## Now");
  parts.push(flow
    ? "Write the program. Remember: one ```nhs block, nothing before it, at most three short lines after it."
    : `Write the ${noun}. Remember: one \`\`\`json block, nothing before it, at most three short lines after it.`);

  return `${parts.join("\n\n")}\n`;
}
