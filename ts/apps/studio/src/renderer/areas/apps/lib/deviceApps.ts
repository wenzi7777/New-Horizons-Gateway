/**
 * Reading the device's app state.
 *
 * Shapes follow AppManager::statusJson() and AppRegistry::statusJson(); the
 * parsers are tolerant because the same UI has to cope with a v1.0.0 device
 * (which has neither a registry nor slots) and a mock.
 */

export type AppStateToken = "running" | "installed" | "killed" | "suspended" | "faulted" | "unknown";

export type InstalledApp = {
  name: string;
  version: string;
  state: AppStateToken;
  capabilities: number;
  budgetUs: number;
  lastUs: number;
  maxUs: number;
  overruns: number;
  events: number;
  /** Package bound to this slot, if any. */
  packageId: string;
  graph: string;
  nodes: number;
  estimatedUs: number;
  /** Enabled but with nothing to run (no graph bound). */
  idle: boolean;
  degraded: boolean;
};

export type AppPackageEntry = {
  id: string;
  /** "flow" runs on the device; "readout" is a view the Desktop renders. */
  kind: "flow" | "readout" | string;
  name: string;
  version: string;
  author: string;
  summary: string;
  category: string;
  minOs: string;
  sha256: string;
  size: number;
  estimatedUs: number;
  slot: number;
  state: "active" | "installed" | "load_failed" | "needs_update" | string;
};

export type AppEventEntry = {
  seq: number;
  ms: number;
  frameSeq: number;
  app: string;
  event: string;
  detail: string;
  value?: number;
};

export type AppEventPage = {
  seq: number;
  /** Events overwritten before anyone read them. Shown, never hidden. */
  dropped: number;
  events: AppEventEntry[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

const KNOWN_STATES: readonly string[] = [
  "running", "installed", "killed", "suspended", "faulted",
];

export function appStateToken(raw: unknown): AppStateToken {
  const token = str(raw).toLowerCase();
  return KNOWN_STATES.includes(token) ? (token as AppStateToken) : "unknown";
}

/** A killed app needs an operator; a suspended one comes back by itself. */
export function needsRevive(app: InstalledApp): boolean {
  return app.state === "killed";
}

export function parseAppList(result: Record<string, unknown> | null): InstalledApp[] {
  const data = asRecord(asRecord(result).data);
  const raw = data.apps ?? asRecord(result).apps;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const entry = asRecord(item);
    const detail = asRecord(entry.state_detail);
    return {
      name: str(entry.name),
      version: str(entry.version, "0.0.0"),
      state: appStateToken(entry.state),
      capabilities: num(entry.capabilities),
      budgetUs: num(entry.budget_us),
      lastUs: num(entry.last_us),
      maxUs: num(entry.max_us),
      overruns: num(entry.overruns),
      events: num(entry.events),
      packageId: str(detail.package),
      graph: str(detail.graph),
      nodes: num(detail.nodes),
      estimatedUs: num(detail.estimated_us),
      // v1.2.3+ reports it; before that an empty flow slot shows as zero nodes.
      idle: entry.idle !== undefined ? entry.idle === true
        : detail.nodes !== undefined && num(detail.nodes) === 0,
      degraded: detail.degraded === true,
    };
  });
}

export function parsePackageList(result: Record<string, unknown> | null): AppPackageEntry[] {
  const data = asRecord(asRecord(result).data);
  const raw = data.packages ?? asRecord(asRecord(data).registry).packages;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const entry = asRecord(item);
    return {
      id: str(entry.id),
      kind: str(entry.kind, "flow"),
      name: str(entry.name, str(entry.id)),
      version: str(entry.version, "0.0.0"),
      author: str(entry.author),
      summary: str(entry.summary),
      category: str(entry.category, "other"),
      minOs: str(entry.min_os, "v1.0.0"),
      sha256: str(entry.sha256),
      size: num(entry.size),
      estimatedUs: num(entry.estimated_us),
      slot: num(entry.slot, -1),
      state: str(entry.state, "installed"),
    };
  });
}

export function parseAppEvents(result: Record<string, unknown> | null): AppEventPage {
  const data = asRecord(asRecord(result).data);
  const raw = Array.isArray(data.events) ? data.events : [];
  return {
    seq: num(data.seq),
    dropped: num(data.dropped),
    events: raw.map((item) => {
      const entry = asRecord(item);
      const page: AppEventEntry = {
        seq: num(entry.seq),
        ms: num(entry.ms),
        frameSeq: num(entry.frame_seq),
        app: str(entry.app),
        event: str(entry.event),
        detail: str(entry.detail),
      };
      if (entry.value !== undefined) page.value = num(entry.value);
      return page;
    }),
  };
}

/** Percentage of its current allocation an app used on its last call. */
export function budgetPercent(app: InstalledApp): number {
  if (!app.budgetUs) return 0;
  return Math.round((app.lastUs / app.budgetUs) * 100);
}

/** Free slots, given the slot hosts and what is bound to them. */
export function freeSlots(apps: InstalledApp[], packages: AppPackageEntry[]): number[] {
  const taken = new Set(packages.filter((p) => p.slot >= 0).map((p) => p.slot));
  return apps.map((_, index) => index).filter((index) => !taken.has(index));
}

/**
 * Device error strings this UI can explain. Anything else is shown verbatim
 * rather than swallowed -- an unrecognised code is still information.
 */
export const APP_ERROR_KEYS: Record<string, string> = {
  no_free_slot: "appError_no_free_slot",
  slot_occupied: "appError_slot_occupied",
  already_installed: "appError_already_installed",
  already_active: "appError_already_active",
  registry_full: "appError_registry_full",
  unknown_package: "appError_unknown_package",
  package_not_found: "appError_package_not_found",
  package_too_large: "appError_package_too_large",
  checksum_mismatch: "appError_checksum_mismatch",
  file_checksum_mismatch: "appError_checksum_mismatch",
  os_too_old: "appError_os_too_old",
  id_path_mismatch: "appError_id_path_mismatch",
  maintenance_required: "appError_maintenance_required",
  app_state_change_rejected: "appError_state_change_rejected",
  index_write_failed: "appError_index_write_failed",
  graph_invalid: "appError_graph_invalid",
  needs_update: "appError_needs_update",
  app_pool_exhausted: "appError_app_pool_exhausted",
  path_too_long: "appError_path_too_long",
};

/** Device errors are `code` or `code:detail`; match on the code alone. */
export function appErrorKey(raw: string): string | null {
  const code = String(raw || "").split(":")[0] ?? "";
  return APP_ERROR_KEYS[code] ?? null;
}

// --- app_view (firmware v1.7.0) ---------------------------------------------

export type Rgb = [number, number, number];

/** One OLED row as the device's app page draws it, and which slot drew it. */
export type AppViewRow = {
  kind: "text" | "bar";
  label: string;
  text?: string;
  bar?: { x0: number; width: number; fillPx: number };
  slot: string;
  /** Other running slots that drew this row too, and lost to `slot`. */
  contended: string[];
};

/**
 * The apps' outputs as the device shows them, after every composition rule.
 * Shape follows ControlServer::appViewJson().
 */
export type AppViewState = {
  oled: {
    /** The board has a panel at all. */
    hw: boolean;
    page: string;
    /** App rows are on the physical panel right now. */
    onScreen: boolean;
    rows: (AppViewRow | null)[];
  };
  statusLed: {
    rgb: Rgb;
    signal: string;
    /** "system", or the slot whose colour the pixel shows. */
    owner: string;
    request: { slot: string; rgb: Rgb; suppressed: boolean; contended: string[] } | null;
  };
  extLed: {
    count: number;
    /** "app" while an app holds the strip, else the preset drawing it. */
    owner: string;
    pixels: Rgb[] | null;
  };
};

function rgb(value: unknown): Rgb {
  const list = Array.isArray(value) ? value : [];
  return [num(list[0]), num(list[1]), num(list[2])];
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => str(item)).filter(Boolean) : [];
}

export function parseAppView(result: Record<string, unknown> | null): AppViewState {
  const data = asRecord(asRecord(result).data);
  const oled = asRecord(data.oled);
  const led = asRecord(data.status_led);
  const ext = asRecord(data.ext_led);
  const rawRows = Array.isArray(oled.rows) ? oled.rows : [];
  const rows: (AppViewRow | null)[] = [0, 1, 2, 3].map((index) => {
    const raw = rawRows[index];
    if (!raw || typeof raw !== "object") return null;
    const entry = asRecord(raw);
    const row: AppViewRow = {
      kind: entry.kind === "bar" ? "bar" : "text",
      label: str(entry.label),
      slot: str(entry.slot),
      contended: names(entry.contended),
    };
    if (row.kind === "bar") {
      row.bar = { x0: num(entry.x0), width: num(entry.width), fillPx: num(entry.fill_px) };
    } else {
      row.text = str(entry.text);
    }
    return row;
  });
  const request = asRecord(led.app_request);
  return {
    oled: {
      hw: oled.hw !== false,
      page: str(oled.page),
      onScreen: oled.on_screen === true,
      rows,
    },
    statusLed: {
      rgb: rgb(led.rgb),
      signal: str(led.signal),
      owner: str(led.owner, "system"),
      request: led.app_request
        ? {
            slot: str(request.slot),
            rgb: rgb(request.rgb),
            suppressed: request.suppressed === true,
            contended: names(request.contended),
          }
        : null,
    },
    extLed: {
      count: num(ext.count),
      owner: str(ext.owner),
      pixels: Array.isArray(ext.pixels) ? ext.pixels.map(rgb) : null,
    },
  };
}

/** True when the device answered app_view with "no such command" (pre-v1.7.0). */
export function isUnknownCommand(result: Record<string, unknown> | null): boolean {
  const record = asRecord(result);
  return (record.status === "error" || record.ok === false) &&
    /unknown_command|unsupported/.test(str(record.error ?? record.message));
}
