/**
 * Reading the device's app state.
 *
 * Shapes follow AppManager::statusJson() and AppRegistry::statusJson(); the
 * parsers are tolerant because the same UI has to cope with a v1.0.0 device
 * (which has neither a registry nor slots), a v2.0.x one (four fixed slots,
 * apps named flow..flow3) and a mock.
 *
 * Firmware v2.1.0 has no slots: every app is named by its package id, and
 * how many run is whatever fits the app pool and the time budget. The UI
 * models every device that way (mergeDeviceApps); an older one's slots are
 * simply not shown.
 */

export type AppStateToken =
  | "running" | "installed" | "killed" | "suspended" | "faulted" | "stopped" | "unknown";

export type AppLoadLevel = "low" | "medium" | "high" | "overloaded";

/** How busy a running app has been lately (firmware v2.1.0, AppLoad). */
export type AppLoadStats = {
  /** 0..100: how close it ran to its allocation, ~10 s. */
  load: number;
  level: AppLoadLevel;
  /** Permille of wall time: last second, ~10 s, ~60 s. */
  cpu1: number;
  cpu10: number;
  cpu60: number;
  /** Microseconds per delivery: guaranteed share, borrowed, lent. */
  baseUs: number;
  borrowedUs: number;
  lentUs: number;
};

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
  /** v2.1.0: position in the run order; whose output wins. */
  order: number;
  burst: boolean;
  memoryBytes: number;
  suspensions: number;
  framesSkipped: number;
  /** null on firmware before v2.1.0. */
  load: AppLoadStats | null;
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
  /** Firmware before v2.1.0 only; -1 otherwise. */
  slot: number;
  /** Running (and at every boot). */
  active: boolean;
  order: number;
  /** What it takes of the app pool while active; 0 when unknown. */
  memoryBytes: number;
  burst: boolean;
  capabilities: number;
  granted: number;
  state: "active" | "installed" | "load_failed" | "needs_update" | string;
};

/**
 * The two resources apps are admitted against (v2.1.0): the app pool and
 * the time the loop-free ones are estimated to take. null before v2.1.0.
 */
export type AppResources = {
  poolBytes: number;
  poolUsed: number;
  poolFree: number;
  controlBytes: number;
  /** The governor's ceiling per delivery, µs; 0 until it has measured. */
  budgetUs: number;
  /** Sum of the active loop-free apps' estimates, µs. */
  usedUs: number;
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
  "running", "installed", "killed", "suspended", "faulted", "stopped",
];

const LEVELS: readonly string[] = ["low", "medium", "high", "overloaded"];

/** The load fields AppManager writes per app (appendLoad); null when absent. */
export function parseLoadStats(raw: unknown): AppLoadStats | null {
  const entry = asRecord(raw);
  if (entry.load === undefined || entry.level === undefined) return null;
  const level = str(entry.level);
  return {
    load: num(entry.load),
    level: (LEVELS.includes(level) ? level : "low") as AppLoadLevel,
    cpu1: num(entry.cpu1),
    cpu10: num(entry.cpu10),
    cpu60: num(entry.cpu60),
    baseUs: num(entry.base_us),
    borrowedUs: num(entry.borrowed_us),
    lentUs: num(entry.lent_us),
  };
}

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
    const vm = asRecord(detail.vm);
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
      order: num(entry.order, -1),
      burst: entry.burst === true,
      memoryBytes: num(entry.memory_bytes),
      suspensions: num(vm.suspensions),
      framesSkipped: num(vm.frames_skipped),
      load: parseLoadStats(entry),
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
      // v2.1.0 says so; before, a slot meant it was bound (and so running).
      active: entry.active !== undefined ? entry.active === true : num(entry.slot, -1) >= 0,
      order: num(entry.order, num(entry.slot, -1)),
      memoryBytes: num(entry.memory_bytes),
      burst: entry.burst === true,
      capabilities: num(entry.capabilities),
      granted: num(entry.granted),
      state: str(entry.state, "installed"),
    };
  });
}

export function parseAppResources(result: Record<string, unknown> | null): AppResources | null {
  const data = asRecord(asRecord(result).data);
  const registry = data.pool_bytes !== undefined ? data : asRecord(data.registry);
  if (registry.pool_bytes === undefined) return null;
  return {
    poolBytes: num(registry.pool_bytes),
    poolUsed: num(registry.pool_used),
    poolFree: num(registry.pool_free),
    controlBytes: num(registry.control_bytes),
    budgetUs: num(registry.budget_us),
    usedUs: num(registry.used_us),
  };
}

/**
 * One app as the UI shows it: a package and, while it runs, what the runtime
 * says about it. Keyed by package id on every firmware.
 */
export type DeviceApp = {
  id: string;
  kind: string;
  name: string;
  version: string;
  summary: string;
  size: number;
  estimatedUs: number;
  memoryBytes: number;
  burst: boolean;
  capabilities: number;
  granted: number;
  active: boolean;
  order: number;
  /** load_failed / needs_update from the registry, else installed / active. */
  packageState: string;
  /** The runtime's record while active; null otherwise. */
  runtime: InstalledApp | null;
};

/** The name the runtime knows it by: its id, or its slot before v2.1.0. */
export function runtimeName(app: DeviceApp): string {
  return app.runtime?.name || app.id;
}

/**
 * Packages joined to the runtime's apps. Before v2.1.0 the runtime named
 * slots ("flow1"), so the join is through the package each slot reports.
 * Active apps first, in run order; then the rest by name.
 */
export function mergeDeviceApps(apps: InstalledApp[], packages: AppPackageEntry[]): DeviceApp[] {
  const byName = new Map(apps.map((app) => [app.name, app]));
  const byPackage = new Map(apps.filter((app) => app.packageId).map((app) => [app.packageId, app]));
  const merged = packages.map<DeviceApp>((entry) => {
    const runtime = entry.active ? byName.get(entry.id) ?? byPackage.get(entry.id) ?? null : null;
    return {
      id: entry.id,
      kind: entry.kind,
      name: entry.name || entry.id,
      version: entry.version,
      summary: entry.summary,
      size: entry.size,
      estimatedUs: entry.estimatedUs || runtime?.estimatedUs || 0,
      memoryBytes: runtime?.memoryBytes || entry.memoryBytes,
      burst: entry.burst || runtime?.burst === true,
      capabilities: entry.capabilities || runtime?.capabilities || 0,
      granted: entry.granted,
      active: entry.active,
      order: runtime && runtime.order >= 0 ? runtime.order : entry.order,
      packageState: entry.state,
      runtime,
    };
  });
  return merged.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.active) return a.order - b.order;
    return a.name.localeCompare(b.name);
  });
}

/** Whether an app is doing work now: running and not idle. */
export function isRunning(app: DeviceApp): boolean {
  return Boolean(app.runtime && app.runtime.state === "running" && !app.runtime.idle);
}

/**
 * Why an inactive app would not be admitted right now, or null when it
 * would (as far as the Desktop can tell: the device decides). `memoryBytes`
 * 0 means unknown, which is not a reason to refuse.
 */
export function admissionBlocker(
  app: DeviceApp,
  resources: AppResources | null,
): { kind: "memory"; needBytes: number } | { kind: "time"; needUs: number } | null {
  if (!resources || app.active) return null;
  if (app.memoryBytes > 0 && app.memoryBytes > resources.poolFree) {
    return { kind: "memory", needBytes: app.memoryBytes - resources.poolFree };
  }
  if (resources.budgetUs > 0 && app.estimatedUs > 0 &&
      resources.usedUs + app.estimatedUs > resources.budgetUs) {
    return { kind: "time", needUs: resources.usedUs + app.estimatedUs - resources.budgetUs };
  }
  return null;
}

/** How many more apps of about `bytes` the pool can still hold. */
export function moreThatFit(resources: AppResources | null, bytes: number): number | null {
  if (!resources || bytes <= 0) return null;
  return Math.floor(resources.poolFree / bytes);
}

/** "1.2 KB" / "640 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  return bytes < 1024 ? `${Math.round(bytes)} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Permille of wall time as a percentage, one decimal under 10%. */
export function formatCpu(permille: number): string {
  const percent = permille / 10;
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
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

/**
 * Device error strings this UI can explain. Anything else is shown verbatim
 * rather than swallowed -- an unrecognised code is still information.
 */
export const APP_ERROR_KEYS: Record<string, string> = {
  no_free_slot: "appError_no_free_slot",
  slot_occupied: "appError_slot_occupied",
  app_budget_exhausted: "appError_app_budget_exhausted",
  app_not_active: "appError_app_not_active",
  app_not_running: "appError_app_not_running",
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
  capability_not_granted: "appError_capability_not_granted",
  capability_unsupported: "appError_capability_unsupported",
  missing_vm: "appError_graph_invalid",
  invalid_vm: "appError_graph_invalid",
};

/** Device errors are `code` or `code:detail`; match on the code alone. */
export function appErrorKey(raw: string): string | null {
  const code = String(raw || "").split(":")[0] ?? "";
  return APP_ERROR_KEYS[code] ?? null;
}

// --- app_view (firmware v1.7.0) ---------------------------------------------

export type Rgb = [number, number, number];

/** One OLED row as the device's app page draws it, and which app drew it. */
export type AppViewRow = {
  kind: "text" | "bar";
  label: string;
  text?: string;
  bar?: { x0: number; width: number; fillPx: number };
  /** The app id (v2.1.0), or the slot name before it. */
  app: string;
  /** Other running apps that drew this row too, and lost to `app`. */
  contended: string[];
};

/** One app's load as app_view reports it (v2.1.0). */
export type AppViewLoad = AppLoadStats & { name: string; state: string; memoryBytes: number };

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
    /** "system", or the app whose colour the pixel shows. */
    owner: string;
    request: { app: string; rgb: Rgb; suppressed: boolean; contended: string[] } | null;
  };
  extLed: {
    count: number;
    /** "app" while an app holds the strip, else the preset drawing it. */
    owner: string;
    pixels: Rgb[] | null;
  };
  /** Per-app load and the apps' total CPU (v2.1.0); null before. */
  load: { cpu10: number; budgetUs: number; throttled: boolean; apps: AppViewLoad[] } | null;
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
      app: str(entry.app ?? entry.slot),
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
  const load = data.load ? asRecord(data.load) : null;
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
            app: str(request.app ?? request.slot),
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
    load: load
      ? {
          cpu10: num(load.cpu10),
          budgetUs: num(load.budget_us),
          throttled: load.throttled === true,
          apps: (Array.isArray(load.apps) ? load.apps : []).flatMap((item) => {
            const entry = asRecord(item);
            const stats = parseLoadStats(entry);
            return stats
              ? [{ ...stats, name: str(entry.name), state: str(entry.state), memoryBytes: num(entry.memory_bytes) }]
              : [];
          }),
        }
      : null,
  };
}

/** True when the device answered app_view with "no such command" (pre-v1.7.0). */
export function isUnknownCommand(result: Record<string, unknown> | null): boolean {
  const record = asRecord(result);
  return (record.status === "error" || record.ok === false) &&
    /unknown_command|unsupported/.test(str(record.error ?? record.message));
}
