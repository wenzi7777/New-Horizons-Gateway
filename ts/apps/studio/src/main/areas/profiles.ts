// Main-process handlers of the "profiles" area (see ../../shared/areas/profiles.ts).
// Profiles live on the server; <dataFolder>/profiles is the app's read-only
// mirror (refreshed by the sync area). Every edit is done on the mirror, sent
// to the server, and undone if the server refuses or cannot be reached --
// without a server they cannot be edited ('server_unavailable'). The device →
// profile mapping (which layout this app draws for a device) lives in
// <userData>/profile-assignments.json. Electron's dialog is loaded lazily so
// this module stays testable without Electron.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import {
  emptyProfile,
  isProfileName,
  normalizeUid,
  parseAssignments,
  ProfileStore,
  type ProfileAssignments,
  type ProfileFs,
} from '../../../../../packages/host/src/profiles';
import type { AreaContext, AreaHandlers, AreaModule } from './registry';
import { syncArea } from './sync';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, text, 'utf8');
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // nothing left to clean
    }
    throw error;
  }
}

export const nodeProfileFs: ProfileFs = {
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  readText: (path) => readFileSync(path, 'utf8'),
  writeAtomic,
  remove: (path) => unlinkSync(path),
  exists: (path) => existsSync(path),
  mtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  },
  join: (...parts) => join(...parts),
};

/** The dialogs the area needs (Electron's in the app, fakes in tests). */
export interface ProfileDialogs {
  openJson(): Promise<string | null>;
  saveJson(defaultName: string): Promise<string | null>;
  openImage(): Promise<string | null>;
}

const electronDialogs: ProfileDialogs = {
  async openJson() {
    const { dialog } = await import('electron');
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  async saveJson(defaultName) {
    const { dialog } = await import('electron');
    const r = await dialog.showSaveDialog({ defaultPath: defaultName, filters: [{ name: 'JSON', extensions: ['json'] }] });
    return r.canceled || !r.filePath ? null : r.filePath;
  },
  async openImage() {
    const { dialog } = await import('electron');
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
};

export interface ProfilesAreaOptions {
  fs?: ProfileFs;
  dialogs?: ProfileDialogs;
  /** Watch the folder for changes from outside (sync); off in tests. */
  watch?: boolean;
  /** Where edits go (the sync area's client). Absent: edits are refused. */
  remote?: () => ProfileRemote | null;
}

/** The server side of profile edits (SyncClient implements it). */
export interface ProfileRemote {
  serverEditable(): boolean;
  saveProfile(name: string, profile: Record<string, unknown>): Promise<void>;
  deleteProfile(name: string): Promise<void>;
}

function str(value: unknown, error: string): string {
  if (typeof value !== 'string') throw new Error(error);
  return value;
}

export function createProfilesArea(options: ProfilesAreaOptions = {}): AreaModule {
  const fs = options.fs ?? nodeProfileFs;
  const dialogs = options.dialogs ?? electronDialogs;
  let watcher: FSWatcher | null = null;
  let watchedDir = '';
  let debounce: ReturnType<typeof setTimeout> | null = null;

  return {
    area: 'profiles',
    register(context: AreaContext): AreaHandlers {
      const store = new ProfileStore(fs, () => context.controller.settings().dataFolder);
      const assignmentsPath = join(context.userDataDir, 'profile-assignments.json');
      let assignments: ProfileAssignments | null = null;

      const loadAssignments = (): ProfileAssignments => {
        if (assignments) return assignments;
        try {
          assignments = parseAssignments(JSON.parse(fs.readText(assignmentsPath)));
        } catch {
          assignments = {};
        }
        return assignments;
      };
      const saveAssignments = (next: ProfileAssignments): ProfileAssignments => {
        assignments = next;
        fs.writeAtomic(assignmentsPath, `${JSON.stringify({ version: 1, assignments: next }, null, 2)}\n`);
        context.emit('assignments', next);
        return next;
      };
      const changed = (...names: string[]) => context.emit('changed', { names });

      /**
       * Runs a local edit, then sends every touched profile to the server (or
       * deletes it there); on any failure the mirror is put back as it was.
       */
      const serverFirst = async <T>(touched: (result: T) => string[], edit: () => T, before: string[] = []): Promise<T> => {
        const remote = options.remote?.() ?? null;
        if (!remote || !remote.serverEditable()) throw new Error('server_unavailable');
        const snapshot = new Map<string, string | null>();
        const keep = (name: string) => {
          if (snapshot.has(name)) return;
          const path = fs.join(store.dir(), `${name}.json`);
          snapshot.set(name, fs.exists(path) ? fs.readText(path) : null);
        };
        for (const name of before) keep(name);
        const result = edit();
        const names = touched(result);
        try {
          for (const name of names) {
            if (store.has(name)) await remote.saveProfile(name, JSON.parse(store.exportText(name)) as Record<string, unknown>);
            else await remote.deleteProfile(name);
          }
        } catch (error) {
          for (const [name, text] of snapshot) {
            const path = fs.join(store.dir(), `${name}.json`);
            if (text === null) {
              if (fs.exists(path)) fs.remove(path);
            } else fs.writeAtomic(path, text);
          }
          for (const name of names) {
            if (!snapshot.has(name)) {
              const path = fs.join(store.dir(), `${name}.json`);
              if (fs.exists(path)) fs.remove(path);
            }
          }
          changed(...names);
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(/network|server_unavailable|no_token|no_server/.test(message) ? 'server_unavailable' : message);
        }
        changed(...names);
        return result;
      };

      const ensureWatch = () => {
        if (!options.watch) return;
        const dir = store.dir();
        if (dir === watchedDir) return;
        watcher?.close();
        watcher = null;
        watchedDir = dir;
        try {
          mkdirSync(dir, { recursive: true });
          watcher = watch(dir, (_event, file) => {
            if (file && !String(file).endsWith('.json')) return;
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => changed(), 300);
          });
        } catch (error) {
          context.logger.warn(`profiles watch: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      ensureWatch();
      context.controller.subscribe?.(() => ensureWatch());

      return {
        list: async () => {
          ensureWatch();
          return store.list();
        },
        get: async (name: unknown) => store.get(str(name, 'invalid_profile_name')),
        /** Whether profiles can be edited now (only on the server). */
        editable: async () => options.remote?.()?.serverEditable() === true,
        save: async (name: unknown, profile: unknown) => {
          if (!profile || typeof profile !== 'object') throw new Error('invalid_profile');
          const target = str(name, 'invalid_profile_name');
          return serverFirst((stored: string) => [stored], () => store.save(target, profile), [target]);
        },
        create: async (name: unknown) => {
          const target = store.uniqueName(str(name, 'invalid_profile_name') || 'new_profile');
          return serverFirst((stored: string) => [stored], () => store.save(target, emptyProfile(target)), [target]);
        },
        duplicate: async (name: unknown, newName?: unknown) =>
          serverFirst((stored: string) => [stored], () => store.duplicate(str(name, 'invalid_profile_name'), typeof newName === 'string' ? newName : undefined)),
        rename: async (name: unknown, newName: unknown) => {
          const from = str(name, 'invalid_profile_name');
          const to = await serverFirst((next: string) => (next === from ? [from] : [next, from]), () => store.rename(from, str(newName, 'invalid_profile_name')), [from]);
          const current = loadAssignments();
          if (to !== from && Object.values(current).includes(from)) {
            saveAssignments(Object.fromEntries(Object.entries(current).map(([uid, n]) => [uid, n === from ? to : n])));
          }
          return to;
        },
        remove: async (name: unknown) => {
          const target = str(name, 'invalid_profile_name');
          await serverFirst(() => [target], () => store.remove(target), [target]);
          const current = loadAssignments();
          if (Object.values(current).includes(target)) saveAssignments(Object.fromEntries(Object.entries(current).filter(([, n]) => n !== target)));
        },
        importFile: async () => {
          if (options.remote?.()?.serverEditable() !== true) throw new Error('server_unavailable');
          const path = await dialogs.openJson();
          if (!path) return null;
          const text = fs.readText(path);
          return serverFirst((stored: string) => [stored], () => store.importText(text, basename(path)));
        },
        exportFile: async (name: unknown) => {
          const target = str(name, 'invalid_profile_name');
          const text = store.exportText(target);
          const path = await dialogs.saveJson(`${target}.json`);
          if (!path) return null;
          writeAtomic(path, text);
          return path;
        },
        chooseImage: async () => {
          const path = await dialogs.openImage();
          if (!path) return null;
          const type = IMAGE_TYPES[extname(path).toLowerCase()];
          if (!type) throw new Error('unsupported_image');
          const bytes = readFileSync(path);
          if (bytes.length > MAX_IMAGE_BYTES) throw new Error('image_too_large');
          return `data:${type};base64,${bytes.toString('base64')}`;
        },
        assignments: async () => loadAssignments(),
        assign: async (uid: unknown, name: unknown) => {
          const key = normalizeUid(uid);
          if (!key) throw new Error('invalid_uid');
          const next = { ...loadAssignments() };
          if (name === null || name === '' || name === undefined) delete next[key];
          else if (isProfileName(name)) next[key] = name;
          else throw new Error('invalid_profile_name');
          return saveAssignments(next);
        },
      };
    },
    dispose() {
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      watcher = null;
    },
  };
}

export const profilesArea: AreaModule = createProfilesArea({ watch: true, remote: () => syncArea.client() });
