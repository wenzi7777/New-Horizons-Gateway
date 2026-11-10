// Browser-preview (mock) implementation of the "profiles" area: the same
// methods as main/areas/profiles.ts, kept in memory.
import type { AreaMock } from '../mockTypes';
import { emptyProfile, normalizeProfile, sanitizeProfileName, sensorLabel, type Profile } from './model';

function demo(): Profile {
  const p = emptyProfile('Demo_Insole_5_7');
  p.matrix = { rows: 5, cols: 7 };
  p.display.mode = '2d';
  p.background.aspectRatio = 0.5;
  p.sensors = Array.from({ length: 35 }, (_, i) => ({ index: i, x: 0.15 + ((i % 7) / 6) * 0.7, y: 0.1 + (Math.floor(i / 7) / 4) * 0.8, label: sensorLabel(i), enabled: true }));
  return p;
}

export const profilesMock: AreaMock = (emit) => {
  const store = new Map<string, { profile: Profile; modifiedMs: number }>([['Demo_Insole_5_7', { profile: demo(), modifiedMs: Date.now() }]]);
  let assignments: Record<string, string> = {};
  const free = (base: string) => {
    const stem = sanitizeProfileName(base);
    if (!store.has(stem)) return stem;
    for (let i = 2; ; i++) if (!store.has(`${stem}_${i}`)) return `${stem}_${i}`;
  };
  const put = (name: string, profile: unknown) => {
    const stem = sanitizeProfileName(name);
    store.set(stem, { profile: normalizeProfile(profile), modifiedMs: Date.now() });
    emit('changed', { names: [stem] });
    return stem;
  };
  const need = (name: string) => {
    const hit = store.get(name);
    if (!hit) throw new Error('profile_not_found');
    return hit.profile;
  };
  const setAssignments = (next: Record<string, string>) => {
    assignments = next;
    emit('assignments', next);
    return next;
  };
  return {
    list: async () =>
      [...store.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, { profile: p, modifiedMs }]) => ({
        name, displayName: p.name || name, deviceType: p.deviceType, rows: p.matrix.rows, cols: p.matrix.cols, sensorCount: p.sensors.length, hasBackground: Boolean(p.background.imageData), modifiedMs,
      })),
    get: async (name: string) => structuredClone(need(name)),
    editable: async () => true,
    save: async (name: string, profile: Profile) => put(name, profile),
    create: async (name: string) => {
      const stem = free(name || 'new_profile');
      return put(stem, emptyProfile(stem));
    },
    duplicate: async (name: string, newName?: string) => {
      const stem = free(newName || `${name}_copy`);
      return put(stem, { ...need(name), name: stem });
    },
    rename: async (name: string, newName: string) => {
      const p = need(name);
      const stem = sanitizeProfileName(newName);
      if (stem === name) return name;
      if (store.has(stem)) throw new Error('profile_exists');
      store.delete(name);
      put(stem, { ...p, name: stem });
      setAssignments(Object.fromEntries(Object.entries(assignments).map(([u, n]) => [u, n === name ? stem : n])));
      return stem;
    },
    remove: async (name: string) => {
      need(name);
      store.delete(name);
      emit('changed', { names: [name] });
      setAssignments(Object.fromEntries(Object.entries(assignments).filter(([, n]) => n !== name)));
    },
    importFile: async () => null,
    exportFile: async () => null,
    chooseImage: async () => null,
    assignments: async () => assignments,
    assign: async (uid: string, name: string | null) => {
      const key = String(uid).replace(/[^a-fA-F0-9]/g, '').toUpperCase();
      const next = { ...assignments };
      if (name) next[key] = name;
      else delete next[key];
      return setAssignments(next);
    },
  };
};
