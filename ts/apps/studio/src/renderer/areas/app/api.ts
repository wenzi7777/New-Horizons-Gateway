// Typed client for the "app" area (see ../../../shared/areas/app.ts).
import type { AppAreaApi, AppAreaEvents } from '../../../shared/areas/app';
import type { StudioApi } from '../../../shared/contract';

type Async<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
export type AppClient = { [K in keyof AppAreaApi]: Async<AppAreaApi[K]> } & {
  on<E extends keyof AppAreaEvents>(event: E, listener: (payload: AppAreaEvents[E]) => void): () => void;
};

const METHODS: readonly (keyof AppAreaApi)[] = [
  'getPrefs',
  'setPrefs',
  'info',
  'connectionInfo',
  'updateState',
  'checkForUpdate',
  'installUpdate',
  'openReleaseNotes',
  'openLogFolder',
  'revealDataFolder',
  'exportDiagnostics',
  'resetSettings',
  'pruneRecordings',
  'splashState',
  'splashAnswer',
];

export function appApi(api: StudioApi): AppClient {
  const client: Record<string, unknown> = {
    on: (event: string, listener: (payload: unknown) => void) => api.onAreaEvent('app', event, listener),
  };
  for (const method of METHODS) client[method] = (...args: unknown[]) => api.call('app', method, ...args);
  return client as AppClient;
}
