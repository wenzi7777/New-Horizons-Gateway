// The recordings browser: walks recordings/<UID>/<YYYYMMDD>/<folder>/ and
// reads each folder's meta.json (cached by its mtime).
import { computeTimeline } from '@nhgw/engine';

import type { RecordingSummary, RecordingTimeline } from './contract';
import { PATHS } from './files';
import type { NativeFileInfo, HostFiles } from './nativeApi';
import { recordingSummary, timelineView } from './views';

type Cached = { metaMtime: number; meta: Record<string, unknown> | null };

/** `recordings/<id>`; ids are folder paths under the data root and may not climb out of it. */
export function recordingDirectory(id: string): string {
  const parts = id.split('/');
  if (!id || parts.length !== 3 || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('invalid_recording_id');
  }
  return `${PATHS.dataRoot}/${id}`;
}

/** The id of a recording folder path (as the engine names it: `recordings/<UID>/<day>/<folder>`), or null. */
export function recordingIdOf(directory: string): string | null {
  const prefix = `${PATHS.dataRoot}/`;
  return directory.startsWith(prefix) ? directory.slice(prefix.length) : null;
}

export class RecordingCatalog {
  private readonly cache = new Map<string, Cached>();
  private items: RecordingSummary[] = [];
  private totalBytes = 0;

  constructor(private readonly native: HostFiles) {}

  list(): RecordingSummary[] {
    return this.items;
  }

  bytes(): number {
    return this.totalBytes;
  }

  /** Rescans. `inProgress`: ids being written now. Returns whether the list changed. */
  refresh(inProgress: ReadonlySet<string>, nowMs: number): boolean {
    const found: RecordingSummary[] = [];
    let total = 0;
    const seen = new Set<string>();
    for (const uid of this.dirs(PATHS.dataRoot)) {
      for (const day of this.dirs(`${PATHS.dataRoot}/${uid.name}`)) {
        for (const folder of this.dirs(`${PATHS.dataRoot}/${uid.name}/${day.name}`)) {
          const id = `${uid.name}/${day.name}/${folder.name}`;
          const directory = `${PATHS.dataRoot}/${id}`;
          let files: NativeFileInfo[];
          try {
            files = this.native.listDir(directory);
          } catch {
            continue;
          }
          const metaFile = files.find((file) => !file.isDirectory && file.name.endsWith('.meta.json'));
          if (!metaFile) continue;
          seen.add(id);
          const bytes = files.reduce((sum, file) => sum + (file.isDirectory ? 0 : file.size), 0);
          total += bytes;
          found.push(recordingSummary(id, this.meta(id, `${directory}/${metaFile.name}`, metaFile.mtimeMs), bytes, inProgress.has(id), nowMs));
        }
      }
    }
    for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id);
    found.sort((a, b) => b.startedAtMs - a.startedAtMs || (a.id < b.id ? 1 : -1));
    this.totalBytes = total;
    const changed = JSON.stringify(found) !== JSON.stringify(this.items);
    if (changed) this.items = found;
    return changed;
  }

  private dirs(path: string): NativeFileInfo[] {
    try {
      return this.native.listDir(path).filter((entry) => entry.isDirectory && !entry.name.startsWith('.'));
    } catch {
      return [];
    }
  }

  private meta(id: string, path: string, mtime: number): Record<string, unknown> | null {
    const cached = this.cache.get(id);
    if (cached && cached.metaMtime === mtime) return cached.meta;
    let meta: Record<string, unknown> | null = null;
    try {
      const text = this.native.readText(path);
      const parsed = text === null ? null : (JSON.parse(text) as unknown);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    } catch {
      meta = null;
    }
    this.cache.set(id, { metaMtime: mtime, meta });
    return meta;
  }

  /** The folder's data / events files (named in meta.files, else by the folder's own name). */
  files(id: string): { data: string; events: string } {
    const directory = recordingDirectory(id);
    const base = id.split('/')[2]!;
    const meta = this.cache.get(id)?.meta ?? null;
    const named = (meta?.files ?? {}) as Record<string, unknown>;
    const data = typeof named.data === 'string' && named.data ? named.data : `${base}.data.csv`;
    const events = typeof named.events === 'string' && named.events ? named.events : `${base}.events.csv`;
    return { data: `${directory}/${data}`, events: `${directory}/${events}` };
  }

  timeline(id: string): RecordingTimeline {
    const { data, events } = this.files(id);
    const dataText = this.native.readText(data);
    if (dataText === null) throw new Error('recording_not_found');
    return timelineView(computeTimeline(dataText, this.native.readText(events)));
  }
}
