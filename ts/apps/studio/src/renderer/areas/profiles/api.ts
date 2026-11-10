// Typed client for the "profiles" area (see ../../../shared/areas/profiles.ts).
import type { StudioApi } from '../../../shared/contract';
import type { Profile, ProfileAssignments, ProfileListEntry, ProfilesAreaApi, ProfilesAreaEvents } from '../../../shared/areas/profiles';

export function profilesApi(api: StudioApi) {
  const c = <T,>(method: keyof ProfilesAreaApi, ...args: unknown[]) => api.call<T>('profiles', method, ...args);
  return {
    call: <T = unknown>(method: string, ...args: unknown[]) => api.call<T>('profiles', method, ...args),
    on: <E extends keyof ProfilesAreaEvents>(event: E, listener: (payload: ProfilesAreaEvents[E]) => void) =>
      api.onAreaEvent('profiles', event, listener as (payload: unknown) => void),
    list: () => c<ProfileListEntry[]>('list'),
    get: (name: string) => c<Profile>('get', name),
    editable: () => c<boolean>('editable'),
    save: (name: string, profile: Profile) => c<string>('save', name, profile),
    create: (name: string) => c<string>('create', name),
    duplicate: (name: string, newName?: string) => c<string>('duplicate', name, newName),
    rename: (name: string, newName: string) => c<string>('rename', name, newName),
    remove: (name: string) => c<void>('remove', name),
    importFile: () => c<string | null>('importFile'),
    exportFile: (name: string) => c<string | null>('exportFile', name),
    chooseImage: () => c<string | null>('chooseImage'),
    assignments: () => c<ProfileAssignments>('assignments'),
    assign: (uid: string, name: string | null) => c<ProfileAssignments>('assign', uid, name),
  };
}

export type ProfilesClient = ReturnType<typeof profilesApi>;
