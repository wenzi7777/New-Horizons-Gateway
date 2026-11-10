// Per-device command catalogs, as the device reports them (device_commands.py).
// Firmware v1.15.0 answers `commands` with its whole dispatch table: name,
// flags (maintenance, heavy, quiet, internal, status_snapshot) and a summary.
// With a catalog the device's own flags gate commands; without one the static
// tables (commandTables.ts) do. Times are monotonic ms (Python: seconds).

/** First firmware that answers `commands` (its betas count). */
export const CATALOG_MIN_FIRMWARE: readonly [number, number, number] = [1, 15, 0];
/** A `commands` request that got no reply is retried after this long. */
export const CATALOG_RETRY_MS = 30_000;
/** A request that failed outright is retried sooner: 4 s, 8 s, 16 s ... up to 5 min. */
export const FAILURE_BACKOFF_MIN_MS = 4_000;
export const FAILURE_BACKOFF_MAX_MS = 300_000;

export function failureBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_MIN_MS * 2 ** (failures - 1));
}

const VERSION_RE = /^\s*[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?/;

function versionCore(version: unknown): [number, number, number] | null {
  const text = version === null || version === undefined || version === false ? '' : String(version);
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function firmwareHasCatalog(firmwareVersion: unknown): boolean {
  const core = versionCore(firmwareVersion);
  if (core === null) return false;
  for (let i = 0; i < 3; i++) {
    if (core[i]! !== CATALOG_MIN_FIRMWARE[i]) return core[i]! > CATALOG_MIN_FIRMWARE[i]!;
  }
  return true;
}

export interface CommandSpec {
  maintenance: boolean;
  heavy: boolean;
  quiet: boolean;
  internal: boolean;
  status_snapshot: boolean;
  summary: string;
}

export class CommandCatalog {
  constructor(
    readonly firmware: string,
    readonly hash: number,
    readonly commands: ReadonlyMap<string, CommandSpec>,
  ) {}

  publicNames(): Set<string> {
    const out = new Set<string>();
    for (const [name, spec] of this.commands) if (!spec.internal) out.add(name);
    return out;
  }

  /** as_json(): {firmware, hash, commands: [{...flags, name}]}. */
  asJson(): { firmware: string; hash: number; commands: (CommandSpec & { name: string })[] } {
    return {
      firmware: this.firmware,
      hash: this.hash,
      commands: [...this.commands].map(([name, spec]) => ({ ...spec, name })),
    };
  }
}

function pyBool(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export class CommandCatalogStore {
  private readonly catalogs = new Map<string, CommandCatalog>();
  /** (firmware, when) of the `commands` request already out per device. */
  private readonly requested = new Map<string, [string, number]>();
  /** When each device was last probed for its firmware version. */
  private readonly probed = new Map<string, number>();
  private readonly fetchFailures = new Map<string, number>();
  /** The firmware each device last reported in any reply. */
  private readonly firmwares = new Map<string, string>();

  constructor(private readonly nowMs: () => number) {}

  get(deviceUid: string): CommandCatalog | null {
    return this.catalogs.get(deviceUid) ?? null;
  }

  needsFetch(deviceUid: string, firmwareVersion: unknown, now: number = this.nowMs()): boolean {
    const firmware = pyBool(firmwareVersion) ? String(firmwareVersion) : '';
    if (!deviceUid || !firmwareHasCatalog(firmware)) return false;
    const catalog = this.catalogs.get(deviceUid);
    if (catalog !== undefined && catalog.firmware === firmware) return false;
    const requested = this.requested.get(deviceUid);
    if (requested === undefined || requested[0] !== firmware) return true;
    return now - requested[1] >= CATALOG_RETRY_MS;
  }

  noteFirmware(deviceUid: string, firmwareVersion: unknown): void {
    const version = pyBool(firmwareVersion) ? String(firmwareVersion) : '';
    if (deviceUid && version) this.firmwares.set(deviceUid, version);
  }

  firmware(deviceUid: string): string {
    return this.firmwares.get(deviceUid) ?? '';
  }

  /** Whether to ask a device of unknown firmware for it (`capabilities`), at most once per CATALOG_RETRY_MS. Marks the probe. */
  needsProbe(deviceUid: string, now: number = this.nowMs()): boolean {
    const last = this.probed.get(deviceUid);
    if (last !== undefined && now - last < CATALOG_RETRY_MS) return false;
    this.probed.set(deviceUid, now);
    return true;
  }

  markRequested(deviceUid: string, firmwareVersion: unknown, now: number = this.nowMs()): void {
    this.requested.set(deviceUid, [pyBool(firmwareVersion) ? String(firmwareVersion) : '', now]);
  }

  noteFetchFailed(deviceUid: string, now: number = this.nowMs()): void {
    const failures = (this.fetchFailures.get(deviceUid) ?? 0) + 1;
    this.fetchFailures.set(deviceUid, failures);
    const requested = this.requested.get(deviceUid);
    if (requested !== undefined) {
      // needsFetch() retries CATALOG_RETRY_MS after the stamp.
      this.requested.set(deviceUid, [requested[0], now - CATALOG_RETRY_MS + failureBackoffMs(failures)]);
    }
  }

  /** The probe failed: allow the next one FAILURE_BACKOFF_MIN_MS later (no growing backoff). */
  noteProbeFailed(deviceUid: string, now: number = this.nowMs()): void {
    this.probed.set(deviceUid, now - CATALOG_RETRY_MS + FAILURE_BACKOFF_MIN_MS);
  }

  /** `capabilities` carries command_schema_hash: a mismatch drops the cached catalog. True when dropped. */
  invalidateIfHashDiffers(deviceUid: string, schemaHash: unknown): boolean {
    const value = typeof schemaHash === 'number' ? Math.trunc(schemaHash) : typeof schemaHash === 'string' && /^\s*[+-]?\d+\s*$/.test(schemaHash) ? parseInt(schemaHash, 10) : NaN;
    if (Number.isNaN(value)) return false;
    const catalog = this.catalogs.get(deviceUid);
    if (catalog === undefined || catalog.hash === value) return false;
    this.catalogs.delete(deviceUid);
    this.requested.delete(deviceUid);
    return true;
  }

  /** Stores a `commands` reply's data; null when it is malformed. */
  record(deviceUid: string, firmwareVersion: unknown, data: unknown): CommandCatalog | null {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const list = (data as Record<string, unknown>).commands;
    if (!Array.isArray(list)) return null;
    const commands = new Map<string, CommandSpec>();
    for (const item of list) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const name = pyBool(row.name) ? String(row.name) : '';
      if (!name) continue;
      commands.set(name, {
        maintenance: pyBool(row.maintenance),
        heavy: pyBool(row.heavy),
        quiet: pyBool(row.quiet),
        internal: pyBool(row.internal),
        status_snapshot: pyBool(row.status_snapshot),
        summary: pyBool(row.summary) ? String(row.summary) : '',
      });
    }
    if (commands.size === 0) return null;
    const rawHash = (data as Record<string, unknown>).hash;
    let schemaHash = 0;
    if (typeof rawHash === 'number' && Number.isFinite(rawHash)) schemaHash = Math.trunc(rawHash);
    else if (typeof rawHash === 'string' && /^\s*[+-]?\d+\s*$/.test(rawHash)) schemaHash = parseInt(rawHash, 10);
    const catalog = new CommandCatalog(pyBool(firmwareVersion) ? String(firmwareVersion) : '', schemaHash, commands);
    this.catalogs.set(deviceUid, catalog);
    this.requested.delete(deviceUid);
    this.fetchFailures.delete(deviceUid);
    return catalog;
  }

  publicNames(deviceUid: string): Set<string> | null {
    return this.get(deviceUid)?.publicNames() ?? null;
  }

  /**
   * The device's own answer to "may `command` run now": null without a
   * catalog (the static tables decide), "unknown_command" for a command it
   * does not list, "maintenance_required" for a maintenance command outside
   * maintenance mode, else "".
   */
  modeError(deviceUid: string, command: string, maintenance: boolean): string | null {
    const catalog = this.get(deviceUid);
    if (catalog === null) return null;
    const spec = catalog.commands.get(command);
    if (spec === undefined) return 'unknown_command';
    if (spec.maintenance && !maintenance) return 'maintenance_required';
    return '';
  }
}
