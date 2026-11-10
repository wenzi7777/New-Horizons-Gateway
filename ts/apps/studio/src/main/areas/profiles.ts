// Main-process handlers of the "profiles" area (see ../../shared/areas/profiles.ts).
// Profiles live in <dataFolder>/profiles (synced by modification time; see
// @nhgw/host profiles/store.ts); the device → profile mapping lives in
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
        save: async (name: unknown, profile: unknown) => {
          if (!profile || typeof profile !== 'object') throw new Error('invalid_profile');
          const stored = store.save(str(name, 'invalid_profile_name'), profile);
          changed(stored);
          return stored;
        },
        create: async (name: unknown) => {
          const target = store.uniqueName(str(name, 'invalid_profile_name') || 'new_profile');
          const stored = store.save(target, emptyProfile(target));
          changed(stored);
          return stored;
        },
        duplicate: async (name: unknown, newName?: unknown) => {
          const stored = store.duplicate(str(name, 'invalid_profile_name'), typeof newName === 'string' ? newName : undefined);
          changed(stored);
          return stored;
        },
        rename: async (name: unknown, newName: unknown) => {
          const from = str(name, 'invalid_profile_name');
          const to = store.rename(from, str(newName, 'invalid_profile_name'));
          const current = loadAssignments();
          if (to !== from && Object.values(current).includes(from)) {
            saveAssignments(Object.fromEntries(Object.entries(current).map(([uid, n]) => [uid, n === from ? to : n])));
          }
          changed(from, to);
          return to;
        },
        remove: async (name: unknown) => {
          const target = str(name, 'invalid_profile_name');
          store.remove(target);
          const current = loadAssignments();
          if (Object.values(current).includes(target)) saveAssignments(Object.fromEntries(Object.entries(current).filter(([, n]) => n !== target)));
          changed(target);
        },
        importFile: async () => {
          const path = await dialogs.openJson();
          if (!path) return null;
          const stored = store.importText(fs.readText(path), basename(path));
          changed(stored);
          return stored;
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

export const profilesArea: AreaModule = createProfilesArea({ watch: true });
