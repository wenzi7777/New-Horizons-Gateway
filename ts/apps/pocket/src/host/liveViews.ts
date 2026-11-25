// The live screen's per-device view (the Desktop Visualization card's
// settings: 3D / 2D, sensor-layout profile, Row / Col Mirror, Transpose, dot
// size), kept in the data folder so a device opens as it was left -- the
// Desktop keeps the same in localStorage. Profiles are read from
// <data>/profiles/, where server sync mirrors them (@nhgw/host SyncClient);
// Pocket never edits them.
import { parseProfileText, type HostFiles, type Profile } from '@nhgw/host';

export type LiveViewMode = '3d' | '2d';

export type LiveViewState = {
  mode: LiveViewMode;
  /** Profile file stem, or null for the standard grid. */
  profile: string | null;
  rowMirror: boolean;
  colMirror: boolean;
  transpose: boolean;
  dotSize: number;
};

export const DEFAULT_LIVE_VIEW: LiveViewState = { mode: '2d', profile: null, rowMirror: false, colMirror: false, transpose: false, dotSize: 1 };

export type LiveProfileEntry = { name: string; displayName: string };

export interface LiveViews {
  view(uid: string): LiveViewState;
  setView(uid: string, patch: Partial<LiveViewState>): LiveViewState;
  profiles(): LiveProfileEntry[];
  profile(name: string): Profile | null;
}

export const LIVE_VIEWS_PATH = '.pocket/live-views.json';
const PROFILES_DIR = 'profiles';

function clampDot(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(4, Math.max(0.5, n)) : 1;
}

/** A stored view as a full LiveViewState (unknown / missing fields take the defaults). */
export function normalizeLiveView(data: unknown): LiveViewState {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return {
    mode: d.mode === '3d' ? '3d' : '2d',
    profile: typeof d.profile === 'string' && d.profile ? d.profile : null,
    rowMirror: d.rowMirror === true,
    colMirror: d.colMirror === true,
    transpose: d.transpose === true,
    dotSize: clampDot(d.dotSize ?? 1),
  };
}

function uidKey(uid: string): string {
  return uid.replace(/[^a-fA-F0-9]/g, '').toUpperCase() || uid;
}

/** Views and profiles over a data folder (the native module's files, or a fake in tests). */
export function createLiveViews(files: Pick<HostFiles, 'readText' | 'writeAtomic' | 'listDir' | 'mkdirp'>): LiveViews {
  let views: Record<string, LiveViewState> | null = null;
  const load = (): Record<string, LiveViewState> => {
    if (views) return views;
    views = {};
    try {
      const text = files.readText(LIVE_VIEWS_PATH);
      const parsed = text ? (JSON.parse(text) as unknown) : null;
      if (parsed && typeof parsed === 'object') {
        for (const [uid, view] of Object.entries(parsed as Record<string, unknown>)) views[uid] = normalizeLiveView(view);
      }
    } catch {
      // Unreadable: start over with the defaults.
    }
    return views;
  };
  const cache = new Map<string, { text: string; profile: Profile | null }>();
  return {
    view: (uid) => load()[uidKey(uid)] ?? DEFAULT_LIVE_VIEW,
    setView(uid, patch) {
      const all = load();
      const next = normalizeLiveView({ ...(all[uidKey(uid)] ?? DEFAULT_LIVE_VIEW), ...patch });
      all[uidKey(uid)] = next;
      try {
        files.mkdirp('.pocket');
        files.writeAtomic(LIVE_VIEWS_PATH, JSON.stringify(all));
      } catch {
        // Kept for this run only.
      }
      return next;
    },
    profiles() {
      let listing: { name: string; isDirectory: boolean }[] = [];
      try {
        listing = files.listDir(PROFILES_DIR);
      } catch {
        return [];
      }
      return listing
        .filter((entry) => !entry.isDirectory && entry.name.endsWith('.json'))
        .map((entry) => {
          const name = entry.name.slice(0, -'.json'.length);
          const profile = this.profile(name);
          return profile ? { name, displayName: profile.name || name } : null;
        })
        .filter((entry): entry is LiveProfileEntry => entry !== null)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    },
    profile(name) {
      let text: string | null = null;
      try {
        text = files.readText(`${PROFILES_DIR}/${name}.json`);
      } catch {
        text = null;
      }
      if (!text) return null;
      const hit = cache.get(name);
      if (hit && hit.text === text) return hit.profile;
      let profile: Profile | null = null;
      try {
        profile = parseProfileText(text, name);
      } catch {
        profile = null;
      }
      cache.set(name, { text, profile });
      return profile;
    },
  };
}

/** In-memory folder for the mock store (web / Expo Go review): one demo profile. */
export function memoryFiles(seed: Record<string, string> = {}): Pick<HostFiles, 'readText' | 'writeAtomic' | 'listDir' | 'mkdirp'> {
  const data = new Map(Object.entries(seed));
  return {
    readText: (path) => data.get(path) ?? null,
    writeAtomic: (path, text) => void data.set(path, text),
    mkdirp: () => undefined,
    listDir: (dir) =>
      [...data.keys()]
        .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
        .map((path) => ({ name: path.slice(dir.length + 1), isDirectory: false, size: 0, mtimeMs: 0 })),
  };
}

/** A small ring of 8 sensors, so the profile view can be tried without a server. */
export function demoProfileText(): string {
  const sensors = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return { index: i, x: 0.5 + 0.35 * Math.cos(a), y: 0.5 + 0.35 * Math.sin(a), label: `P${i + 1}`, enabled: true };
  });
  return JSON.stringify({ version: 1, name: 'Demo ring', matrix: { rows: 4, cols: 4 }, sensors, background: { imageData: '', aspectRatio: 1 } });
}
