// The SDK page's projects: what an author is editing, where it came from, and
// how it leaves the page.
//
// Ported from the Desktop's lib/sdkProject.ts. In NH Studio projects are files
// under <dataFolder>/apps/<project>/ (the apps area's main process saves them),
// not localStorage; only the virtual device and the chosen target are
// remembered per window. What an author means to publish leaves through
// export -- a source file and a package, the files the App Library takes in a
// pull request.

import type { DeviceView } from "../../../../shared/contract";
import { MAX_SLOTS, appShareUs, type Analysis } from "../sdk/lib/index.mjs";

/** "VD-CTL/R …" and "TIA-CTL/R …" are older names of "TIA-CTL …" (the Desktop's boardProfile.ts). */
export function normalizeHardwareModel(value: string) {
  return value.trim().toLowerCase().replace(/^(vd|tia)-ctl\/r\b/, "tia-ctl");
}

export type SdkKind = "flow" | "readout" | "panel";

/** Readouts and panels are both JSON documents the Desktop draws. */
export function isViewKind(kind: SdkKind): boolean {
  return kind === "readout" || kind === "panel";
}

/** The source file a project exports as, and the App Library keeps. */
export function sourceFilename(kind: SdkKind): string {
  return kind === "flow" ? "app.nhs" : kind === "panel" ? "panel.json" : "readout.json";
}

export type SdkProject = {
  id: string;
  kind: SdkKind;
  source: string;
  /** Set when the project was opened from the App Library. */
  origin?: { appId: string; version: string; packageSha256?: string };
  updatedAt: number;
};

/**
 * A board an app can run on, as the firmware builds it: BoardConfig.h is the
 * source of these numbers -- keep the two in step when a board is added.
 * rows x cols is the largest matrix the board scans; a device may be set to
 * scan fewer (set_matrix_layout).
 */
export type BoardSpec = {
  id: string;
  hardwareModel: string;
  name: string;
  rows: number;
  cols: number;
  oled: boolean;
  button: boolean;
  /** External LEDs on the board's header; 0 where there are none. */
  externalLeds: number;
  /** A magnetometer, which mag() reads (NHOS_BOARD_HAS_MAG). */
  magnetometer: boolean;
  /** A fuel gauge, which battery() reads (NHOS_BOARD_HAS_MAX17048); -1 without one. */
  fuelGauge: boolean;
};

/** Largest first: the first is what a new virtual device starts as. */
export const BOARDS: BoardSpec[] = [
  { id: "v23d", hardwareModel: "TIA-CTL v2.3.D GCU LTS", name: "v2.3.D GCU LTS", rows: 15, cols: 15, oled: false, button: false, externalLeds: 0, magnetometer: true, fuelGauge: false },
  { id: "v10f", hardwareModel: "TIA-CTL v1.0.F 2026.4", name: "v1.0.F", rows: 10, cols: 21, oled: true, button: true, externalLeds: 3, magnetometer: false, fuelGauge: false },
  { id: "v15f", hardwareModel: "TIA-CTL v1.5.F 2026.7", name: "v1.5.F", rows: 14, cols: 14, oled: true, button: true, externalLeds: 9, magnetometer: true, fuelGauge: true },
  { id: "v22c", hardwareModel: "TIA-CTL v2.2.C GCU LTS", name: "v2.2.C GCU LTS", rows: 10, cols: 12, oled: false, button: false, externalLeds: 0, magnetometer: true, fuelGauge: false },
  { id: "v21", hardwareModel: "TIA-CTL v2.1 GCU LTS", name: "v2.1 GCU LTS", rows: 10, cols: 12, oled: false, button: false, externalLeds: 0, magnetometer: true, fuelGauge: false },
];

export function boardById(id: string | undefined): BoardSpec {
  return BOARDS.find((board) => board.id === id) ?? BOARDS[0]!;
}

export function boardForHardwareModel(hardwareModel: string | undefined): BoardSpec | undefined {
  if (!hardwareModel) return undefined;
  const normalized = normalizeHardwareModel(hardwareModel);
  return BOARDS.find((board) => normalizeHardwareModel(board.hardwareModel) === normalized);
}

export type MatrixTarget = {
  rows: number;
  cols: number;
  /** "device:<uid>", or VIRTUAL_TARGET_KEY. */
  key: string;
  label: string;
  /** The device's firmware, when the target is a device. */
  firmware?: string;
  /** The board, when it is known: always for the virtual device. */
  board?: BoardSpec;
};

export const VIRTUAL_TARGET_KEY = "virtual";

/** Where a virtual device's frames come from. */
export type VirtualSource = "generated" | "recording";

export const SYNTH_PATTERNS = ["none", "tap", "hold", "swipe", "ramp"] as const;
export type SynthPattern = (typeof SYNTH_PATTERNS)[number];

/** The board a Studio author runs an app on when no real device is at hand. */
export type VirtualDevice = {
  boardId: string;
  rows: number;
  cols: number;
  source: VirtualSource;
  pattern: SynthPattern;
  /** Background noise, 0..1 of the noise ceiling. */
  noise: number;
};

export function defaultVirtualDevice(): VirtualDevice {
  const board = BOARDS[0]!;
  return { boardId: board.id, rows: board.rows, cols: board.cols, source: "generated", pattern: "tap", noise: 0.1 };
}

/** Shapes a virtual device may take: at least one cell, at most the board. */
export function clampShape(board: BoardSpec, rows: number, cols: number): { rows: number; cols: number } {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(1, Math.trunc(Number(value) || 1)));
  return { rows: clamp(rows, board.rows), cols: clamp(cols, board.cols) };
}

export function virtualTarget(device: VirtualDevice, label: string): MatrixTarget {
  const board = boardById(device.boardId);
  return { key: VIRTUAL_TARGET_KEY, rows: device.rows, cols: device.cols, label: `${label} · ${board.name} · ${device.rows} × ${device.cols}`, board };
}

const VIRTUAL_KEY = "nhos.sdk.virtual.v1";
const TARGET_KEY = "nhos.sdk.target.v1";

export function loadVirtualDevice(): VirtualDevice {
  const fallback = defaultVirtualDevice();
  try {
    const raw = JSON.parse(window.localStorage.getItem(VIRTUAL_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return fallback;
    const board = boardById(raw.boardId);
    // Rows and columns are not clamped: a recording may have set them past
    // the board's own matrix, and that is what the author last ran.
    const rows = Number.isInteger(raw.rows) && raw.rows > 0 ? raw.rows : board.rows;
    const cols = Number.isInteger(raw.cols) && raw.cols > 0 ? raw.cols : board.cols;
    return {
      boardId: board.id,
      rows,
      cols,
      source: raw.source === "recording" ? "recording" : "generated",
      pattern: SYNTH_PATTERNS.includes(raw.pattern) ? raw.pattern : fallback.pattern,
      noise: Number.isFinite(raw.noise) ? Math.min(1, Math.max(0, raw.noise)) : fallback.noise,
    };
  } catch {
    return fallback;
  }
}

export function saveVirtualDevice(device: VirtualDevice): void {
  try {
    window.localStorage.setItem(VIRTUAL_KEY, JSON.stringify(device));
  } catch {
    // Remembering is a convenience; the page works without it.
  }
}

export function loadTargetKey(): string {
  try {
    return window.localStorage.getItem(TARGET_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveTargetKey(key: string): void {
  try {
    window.localStorage.setItem(TARGET_KEY, key);
  } catch {
    // As above.
  }
}

/** "TIA-CTL v1.5.F 2026.7" (or the older "VD-CTL/R ..." / "TIA-CTL/R ...") -> "v1.5.F", for a board this list does not know. */
function shortBoardName(hardwareModel: string | undefined): string | undefined {
  if (!hardwareModel || hardwareModel === "unknown") return undefined;
  const name = hardwareModel.replace(/^(VD-CTL\/R|TIA-CTL(\/R)?)\s+/, "").replace(/\s+\d{4}\.\d{1,2}$/, "").trim();
  return name || undefined;
}


export function flowTemplate(appId: string, author: string): string {
  return `# A flow app: a small graph the device runs on every scanned frame.
# Everything after '#' is a comment. The Reference tab lists every function.
app ${appId} {
  name    "${titleCase(appId)}"
  version 0.1.0
  author  ${safeWord(author)}
  summary "What this app does, in one line."
}

# A rectangle of cells. Rows and columns count from 0.
region front = rows 0..6, cols 0..14

signal load = sum(front)

# 'pressed' rises when load reaches 40, falls once it drops to 34 or below
# (hyst 6), and ignores changes that last less than 30 ms.
event pressed when load > 40 hyst 6 for 30ms

led green when pressed
`;
}

export function readoutTemplate(appId: string, author: string): string {
  const doc = {
    nhapp: 1,
    kind: "readout",
    manifest: {
      id: appId,
      name: titleCase(appId),
      version: "0.1.0",
      author: safeWord(author),
      summary: "What this readout shows, in one line.",
      category: "diagnostics",
      min_os: "v1.2.0",
    },
    readout: {
      refresh_ms: 1000,
      sources: [{ id: "scan", command: "scan_health" }],
      sections: [
        {
          kind: "stats",
          title: "Scanning",
          items: [
            { label: "Scan rate", source: "scan", field: "actual_scan_fps", format: "int" },
            { label: "Missed deadlines", source: "scan", field: "overrun_frames", format: "int" },
          ],
        },
      ],
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * A panel is a readout that can act. The template is the smallest useful one:
 * the device's task table with stop and start on each row, and a Run box --
 * enough to show permissions, row actions, a confirmation and a condition.
 */
export function panelTemplate(appId: string, author: string): string {
  const doc = {
    nhapp: 1,
    kind: "panel",
    manifest: {
      id: appId,
      name: titleCase(appId),
      version: "0.1.0",
      author: safeWord(author),
      summary: "What this panel shows and does, in one line.",
      category: "diagnostics",
      min_os: "v1.19.0",
      permissions: ["task_control"],
    },
    panel: {
      refresh_ms: 1000,
      sources: [{ id: "tasks", command: "task_list", path: "tasks" }],
      actions: [
        {
          id: "stop",
          label: "End task",
          command: "task_stop",
          args: { name: "$row.name" },
          // when: every condition must hold. hidden_when: any one hides it.
          when: { field: "state", eq: "running" },
          hidden_when: { field: "protected", eq: true },
          confirm: { title: "End task", message: "Stop {name} until the next reboot?", destructive: true },
        },
        {
          id: "start",
          label: "Start",
          command: "task_start",
          args: { name: "$row.name" },
          when: { field: "state", eq: "stopped" },
        },
      ],
      sections: [
        { kind: "run", title: "Run", candidates: [{ source: "tasks", field: "name", action: "start" }] },
        {
          kind: "table",
          title: "Tasks",
          source: "tasks",
          sort: { field: "cpu_permille", desc: true },
          row_actions: ["stop", "start"],
          columns: [
            { label: "Task", field: "name", format: "text" },
            { label: "State", field: "state", format: "text" },
            { label: "CPU", field: "cpu_permille", format: "permille", bar: true, bar_max: 1000 },
          ],
        },
      ],
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** @returns a name the .nhs lexer reads as one word. */
function safeWord(value: string): string {
  const word = value.trim().replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[^A-Za-z_]+/, "");
  return word || "author";
}

function titleCase(appId: string): string {
  return appId.split("_").filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ") || appId;
}

/** A fresh app id that no existing project uses: my_app, my_app2, ... */
export function freshAppId(projects: SdkProject[], base = "my_app"): string {
  const taken = new Set(projects.map((project) => appIdOf(project)));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}${n}`.slice(0, 15);
    if (!taken.has(candidate)) return candidate;
  }
}

/** The app id a project declares, read without compiling it. */
export function appIdOf(project: Pick<SdkProject, "kind" | "source">): string {
  if (project.kind === "flow") {
    return /(?:^|\n)\s*app\s+([A-Za-z_][A-Za-z0-9_.-]*)/.exec(project.source)?.[1] ?? "";
  }
  try {
    const id = JSON.parse(project.source)?.manifest?.id;
    return typeof id === "string" ? id : "";
  } catch {
    return /"id"\s*:\s*"([^"]*)"/.exec(project.source)?.[1] ?? "";
  }
}

/** The manifest fields the Studio lets an author edit outside the code. */
export type EditableManifestField = "name" | "author" | "summary";
export type EditableManifest = Record<EditableManifestField, string>;

const EDITABLE_FIELDS: EditableManifestField[] = ["name", "author", "summary"];

/** The `app <id> { ... }` header block of a flow app, as [start, end) offsets. */
function flowHeaderRange(source: string): [number, number] | null {
  const open = /(?:^|\n)\s*app\s+[A-Za-z_][A-Za-z0-9_.-]*\s*\{/.exec(source);
  if (!open) return null;
  const start = open.index + open[0].length;
  const close = source.indexOf("}", start);
  return close < 0 ? null : [start, close];
}

const FLOW_FIELD_LINE = (field: string) => new RegExp(`(^|\\n)([ \\t]*)${field}([ \\t]+)([^\\n]*)`);

/**
 * name / author / summary as the source currently states them. The source is
 * the only place an app's metadata lives, so this is read from it.
 */
export function readManifestFields(project: Pick<SdkProject, "kind" | "source">): EditableManifest {
  const out: EditableManifest = { name: "", author: "", summary: "" };
  if (project.kind === "flow") {
    const range = flowHeaderRange(project.source);
    if (!range) return out;
    const header = project.source.slice(range[0], range[1]);
    for (const field of EDITABLE_FIELDS) {
      const match = FLOW_FIELD_LINE(field).exec(header);
      if (!match) continue;
      const raw = (match[4] ?? "").trim();
      out[field] = raw.startsWith('"') ? raw.replace(/^"|"$/g, "") : raw;
    }
    return out;
  }
  try {
    const manifest = JSON.parse(project.source)?.manifest ?? {};
    for (const field of EDITABLE_FIELDS) {
      if (typeof manifest[field] === "string") out[field] = manifest[field];
    }
  } catch {
    // Unparseable while being typed: nothing to show.
  }
  return out;
}

/**
 * The source with one manifest field set. The author is one word (the .nhs
 * lexer splits on spaces), so it goes through the same safeWord() as the
 * templates. Returns the source unchanged when the field cannot be located
 * (e.g. a flow header without that line, or JSON mid-edit).
 */
export function writeManifestField(
  project: Pick<SdkProject, "kind" | "source">,
  field: EditableManifestField,
  value: string,
): string {
  const clean = field === "author" ? safeWord(value) : value.replace(/["\\\n]/g, "").trim();
  if (project.kind === "flow") {
    const range = flowHeaderRange(project.source);
    if (!range) return project.source;
    const header = project.source.slice(range[0], range[1]);
    const pattern = FLOW_FIELD_LINE(field);
    if (!pattern.test(header)) return project.source;
    const literal = field === "author" ? clean : `"${clean}"`;
    const next = header.replace(pattern, (_all, lead, indent, gap) => `${lead}${indent}${field}${gap}${literal}`);
    return project.source.slice(0, range[0]) + next + project.source.slice(range[1]);
  }
  try {
    const doc = JSON.parse(project.source);
    if (!doc || typeof doc !== "object" || typeof doc.manifest !== "object" || doc.manifest === null) return project.source;
    doc.manifest[field] = clean;
    return `${JSON.stringify(doc, null, 2)}\n`;
  } catch {
    return project.source;
  }
}

/** One-word author name as the .nhs lexer reads it (spaces become `_`). */
export function normalizeAuthor(value: string): string {
  return value.trim() ? safeWord(value) : "";
}

export function newProject(kind: SdkKind, source: string, origin?: SdkProject["origin"]): SdkProject {
  return {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    kind,
    source,
    origin,
    updatedAt: Date.now(),
  };
}

export function isProject(value: unknown): value is SdkProject {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && (record.kind === "flow" || record.kind === "readout" || record.kind === "panel")
    && typeof record.source === "string";
}

/** "readout" or "panel" as a JSON source declares it; null when it does not parse or says neither. */
export function viewKindOfSource(source: string): "readout" | "panel" | null {
  try {
    const kind = JSON.parse(source)?.kind;
    return kind === "readout" || kind === "panel" ? kind : null;
  } catch {
    return null;
  }
}

/** Kind of a file an author opens, from its name and content. */
export function kindOfFile(name: string, text: string): SdkKind | null {
  if (name.endsWith(".nhs")) return "flow";
  if (name.endsWith(".json")) {
    return viewKindOfSource(text);
  }
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copied so the view is over a plain ArrayBuffer, which is what digest() takes.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ExportFile = { filename: string; mime: string; content: string | Uint8Array };

/**
 * The files an app needs in the App Library: apps/<id>/{app.nhs|readout.json|panel.json,
 * app.nha, meta.json, README.md}. The package bytes are the canonical ones
 * the library's own build would produce.
 */
export function exportFiles(project: SdkProject, analysis: Analysis): ExportFile[] {
  if (!analysis.ok || !analysis.bytes || !analysis.package) return [];
  const manifest = analysis.package.manifest as Record<string, string>;
  const files: ExportFile[] = [
    {
      filename: sourceFilename(project.kind),
      mime: project.kind === "flow" ? "text/plain" : "application/json",
      content: project.source,
    },
    { filename: "app.nha", mime: "application/json", content: analysis.bytes },
  ];
  const meta = {
    name: { en: manifest.name, ja: manifest.name, "zh-CN": manifest.name },
    summary: { en: manifest.summary, ja: manifest.summary, "zh-CN": manifest.summary },
    license: "MPL-2.0",
  };
  files.push({ filename: "meta.json", mime: "application/json", content: `${JSON.stringify(meta, null, 2)}\n` });
  files.push({ filename: "README.md", mime: "text/markdown", content: readmeFor(manifest, analysis) });
  return files;
}

function readmeFor(manifest: Record<string, string>, analysis: Analysis): string {
  const lines = [`# ${manifest.name}`, "", manifest.summary, ""];
  if (analysis.kind === "flow" && analysis.package) {
    const events = (analysis.package.nodes as { op: string; event?: string }[])
      .filter((node) => node.op === "emit" || node.op === "emit_value")
      .map((node) => node.event);
    if (events.length) {
      lines.push("## Events", "", ...events.map((event) => `- \`${event}\``), "");
    }
    lines.push(
      "## Cost",
      "",
      `${analysis.validation?.nodes} nodes, about ${analysis.validation?.estimatedUs} us per frame on a ${analysis.validation?.cellCount}-cell board; needs ${analysis.validation?.minOs}.`,
      "",
    );
  }
  if (analysis.kind === "panel" && analysis.package) {
    const manifestPermissions = (analysis.package.manifest as { permissions?: string[] }).permissions ?? [];
    const actions = ((analysis.package.panel as { actions?: { label: string; command: string }[] })?.actions) ?? [];
    if (manifestPermissions.length) {
      lines.push("## Permissions", "", ...manifestPermissions.map((permission) => `- \`${permission}\``), "");
    }
    if (actions.length) {
      lines.push("## Actions", "", ...actions.map((action) => `- ${action.label} (\`${action.command}\`)`), "",
        "Everything a panel can do lasts until the device reboots.", "");
    }
  }
  return `${lines.join("\n")}`;
}

/** Per-app run-time share the Build tab shows, for one to four running apps. */
export function runtimeShares(fps: number): { apps: number; us: number }[] {
  return Array.from({ length: MAX_SLOTS }, (_, index) => ({ apps: index + 1, us: appShareUs(fps, index + 1) }));
}

/**
 * Matrix shapes of the devices Studio knows, so an app is judged against
 * the board it will run on rather than the largest one.
 */
export function deviceTargets(devices: readonly Pick<DeviceView, "uid" | "displayName" | "firmwareVersion" | "hardwareModel" | "matrix">[]): MatrixTarget[] {
  const targets: MatrixTarget[] = [];
  for (const device of devices) {
    const rows = Number(device.matrix?.rows);
    const cols = Number(device.matrix?.cols);
    if (Number.isInteger(rows) && Number.isInteger(cols) && rows > 0 && cols > 0) {
      const firmware = device.firmwareVersion && device.firmwareVersion !== "unknown" ? device.firmwareVersion : undefined;
      const board = boardForHardwareModel(device.hardwareModel);
      const label = [device.displayName, board?.name ?? shortBoardName(device.hardwareModel), `${rows} × ${cols}`].filter(Boolean).join(" · ");
      targets.push({ key: `device:${device.uid}`, rows, cols, label, firmware, board });
    }
  }
  return targets;
}
