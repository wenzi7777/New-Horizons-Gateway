// Typed client for the "sync" area (see ../../../shared/areas/sync.ts).
import type { StudioApi } from '../../../shared/contract';
import type { SyncAreaApi, SyncAreaEvents } from '../../../shared/areas/sync';

type Methods = { [K in keyof SyncAreaApi]: (...args: Parameters<SyncAreaApi[K]>) => Promise<ReturnType<SyncAreaApi[K]>> };

export function syncApi(api: StudioApi) {
  const call = <K extends keyof SyncAreaApi>(method: K, ...args: Parameters<SyncAreaApi[K]>) => api.call<ReturnType<SyncAreaApi[K]>>('sync', method, ...args);
  const methods: Methods = {
    status: () => call('status'),
    setToken: (token) => call('setToken', token),
    clearToken: () => call('clearToken'),
    testConnection: () => call('testConnection'),
    uploadNow: (id) => (id === undefined ? call('uploadNow') : call('uploadNow', id)),
    retry: (id) => (id === undefined ? call('retry') : call('retry', id)),
    pause: () => call('pause'),
    resume: () => call('resume'),
    syncLabelsNow: () => call('syncLabelsNow'),
    syncProfilesNow: () => call('syncProfilesNow'),
  };
  return {
    ...methods,
    on: <E extends keyof SyncAreaEvents>(event: E, listener: (payload: SyncAreaEvents[E]) => void) =>
      api.onAreaEvent('sync', event, (payload) => listener(payload as SyncAreaEvents[E])),
  };
}
