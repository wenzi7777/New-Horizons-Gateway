// <folder>/profiles/<name>.json, one file per profile, in the Desktop
// backend's format (see ./format.ts). Writes are atomic (temp + rename) so a
// sync agent comparing modification times never sees half a file, and a
// save starts from the file's current JSON so fields this app does not know
// survive. Platform-independent: the platform supplies ProfileFs.

import { isProfileName, normalizeProfile, parseProfileText, sanitizeProfileName, stringifyProfile, type Profile } from './format';

export interface ProfileFs {
  /** File names (not paths) in the folder; [] when it does not exist. */
  list(dir: string): string[];
  readText(path: string): string;
  /** Whole-file replace via a temp file + rename; creates the folder. */
  writeAtomic(path: string, text: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
  /** Modification time in ms, or 0. */
  mtimeMs(path: string): number;
  join(...parts: string[]): string;
}

export interface ProfileListEntry {
  /** File stem: what every call names the profile by. */
  name: string;
  /** The "name" inside the file (the Desktop shows this). */
  displayName: string;
  deviceType: string;
  rows: number;
  cols: number;
  sensorCount: number;
  hasBackground: boolean;
  modifiedMs: number;
}

export const PROFILES_DIR = 'profiles';

export class ProfileStore {
  constructor(
    private readonly fs: ProfileFs,
    /** The data folder (the store uses <root>/profiles). */
    private readonly root: () => string,
  ) {}

  dir(): string {
    return this.fs.join(this.root(), PROFILES_DIR);
  }

  private path(name: string): string {
    if (!isProfileName(name)) throw new Error('invalid_profile_name');
    return this.fs.join(this.dir(), `${name}.json`);
  }

  list(): ProfileListEntry[] {
    const out: ProfileListEntry[] = [];
    for (const file of this.fs.list(this.dir()).sort()) {
      if (!file.endsWith('.json')) continue;
      const name = file.slice(0, -5);
      if (!isProfileName(name)) continue;
      try {
        const p = parseProfileText(this.fs.readText(this.path(name)), name);
        out.push({
          name,
          displayName: p.name || name,
          deviceType: p.deviceType,
          rows: p.matrix.rows,
          cols: p.matrix.cols,
          sensorCount: p.sensors.length,
          hasBackground: Boolean(p.background.imageData),
          modifiedMs: this.fs.mtimeMs(this.path(name)),
        });
      } catch {
        // Unreadable files are skipped, like the Desktop backend.
      }
    }
    return out;
  }

  has(name: string): boolean {
    return isProfileName(name) && this.fs.exists(this.path(name));
  }

  get(name: string): Profile {
    const path = this.path(name);
    if (!this.fs.exists(path)) throw new Error('profile_not_found');
    return parseProfileText(this.fs.readText(path), name);
  }

  private readRaw(name: string): Record<string, unknown> | null {
    try {
      const data: unknown = JSON.parse(this.fs.readText(this.path(name)));
      return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /**
   * Writes the profile under `name` (sanitised). Unknown top-level fields of
   * the file already there are kept unless the profile sets them. Returns
   * the stored name.
   */
  save(name: string, profile: unknown): string {
    const stem = sanitizeProfileName(name);
    if (!isProfileName(stem)) throw new Error('invalid_profile_name');
    const incoming = normalizeProfile(profile);
    const existing = this.has(stem) ? this.readRaw(stem) : null;
    const merged = existing ? normalizeProfile({ ...existing, ...incoming }) : incoming;
    this.fs.writeAtomic(this.path(stem), `${stringifyProfile(merged)}\n`);
    return stem;
  }

  remove(name: string): void {
    const path = this.path(name);
    if (!this.fs.exists(path)) throw new Error('profile_not_found');
    this.fs.remove(path);
  }

  /** A free name based on `base`: base, base_2, base_3, … */
  uniqueName(base: string): string {
    const stem = sanitizeProfileName(base).slice(0, 120);
    if (!this.has(stem)) return stem;
    for (let i = 2; ; i++) {
      const candidate = `${stem}_${i}`;
      if (!this.has(candidate)) return candidate;
    }
  }

  duplicate(name: string, newName?: string): string {
    const source = this.get(name);
    const target = this.uniqueName(newName || `${name}_copy`);
    return this.save(target, { ...source, name: target });
  }

  /** Renames the file (and the name inside it when it matched the old one). */
  rename(name: string, newName: string): string {
    const source = this.get(name);
    const target = sanitizeProfileName(newName);
    if (target === name) return name;
    if (this.has(target)) throw new Error('profile_exists');
    const displayName = source.name === name || !source.name ? target : source.name;
    const raw = this.readRaw(name) ?? {};
    this.save(target, { ...raw, ...source, name: displayName });
    this.fs.remove(this.path(name));
    return target;
  }

  /** Text of an import: legacy layouts converted; stored under a free name. */
  importText(text: string, fileStem: string): string {
    const stem = sanitizeProfileName(fileStem.replace(/\.json$/i, ''));
    const profile = parseProfileText(text, stem);
    const target = this.uniqueName(stem);
    return this.save(target, profile);
  }

  exportText(name: string): string {
    return `${stringifyProfile(this.get(name))}\n`;
  }
}

/** Device → profile mapping (uid upper-case hex → profile name), kept per computer. */
export type ProfileAssignments = Record<string, string>;

export function normalizeUid(value: unknown): string {
  return String(value ?? '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

export function parseAssignments(data: unknown): ProfileAssignments {
  const source = data && typeof data === 'object' ? ((data as { assignments?: unknown }).assignments ?? data) : {};
  const out: ProfileAssignments = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [uid, name] of Object.entries(source as Record<string, unknown>)) {
      const key = normalizeUid(uid);
      if (key && isProfileName(name)) out[key] = name;
    }
  }
  return out;
}
