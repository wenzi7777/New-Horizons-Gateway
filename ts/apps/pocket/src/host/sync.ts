// Pocket's side of server sync: one @nhgw/host SyncClient on the app host
// and its data folder (the same client NH Studio runs). Signing in uses a
// New Horizons Desktop account; the password goes to the server once and
// only the app token it returns is kept (in the host config).
import { FetchSyncHttp, SyncClient, SyncError, type AppHost, type HostFiles, type LinkBenchResult, type NetworkInfo, type SyncStatus } from '@nhgw/host';

export type { SyncStatus };

export interface PocketSync {
  status(): SyncStatus;
  subscribe(listener: () => void): () => void;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  uploadNow(): Promise<void>;
  retry(): Promise<void>;
  /** Labels are edited on the server only; rejects 'server_unavailable' offline / signed out. */
  setLabel(uid: string, patch: { nickname?: string; group?: string }): Promise<void>;
  /** The server-link half of the relay test. */
  benchLink(): Promise<LinkBenchResult>;
}

/** A SyncError (or anything else) as the plain code the screens translate. */
export function syncErrorCode(error: unknown): string {
  if (error instanceof SyncError) return error.code;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The phone's network as the sync policy needs it ("wifi_only" holds back on
 * a metered network). Unknown (a native without networkState, or an error)
 * counts as online and not known to be metered, as SyncClient treats it.
 */
export function networkReader(native: { networkState?(): { online: boolean; metered: boolean | null } } | null): () => NetworkInfo {
  return () => {
    try {
      const state = native?.networkState?.();
      if (!state) return { online: true, metered: null };
      return { online: state.online !== false, metered: typeof state.metered === 'boolean' ? state.metered : null };
    } catch {
      return { online: true, metered: null };
    }
  };
}

export function createPocketSync(host: AppHost, files: HostFiles, deviceName: string, network?: () => NetworkInfo): PocketSync {
  const client = new SyncClient({ host, files, http: new FetchSyncHttp(), ...(network ? { network } : {}) });
  const listeners = new Set<() => void>();
  // status() builds a fresh object; screens read it through
  // useSyncExternalStore, so hand out one snapshot per change.
  let snapshot = client.status();
  const refresh = () => {
    snapshot = client.status();
    for (const listener of [...listeners]) listener();
  };
  client.on(refresh);
  host.subscribe(refresh);
  void client.start().catch(() => undefined);
  return {
    status: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async login(username, password) {
      const result = await client.login(username, password, deviceName);
      if (!result.ok) throw new SyncError(result.error || 'unexpected', false);
    },
    logout: () => client.logout(),
    uploadNow: () => client.uploadNow(),
    setLabel: (uid, patch) => client.setLabel(uid, patch),
    benchLink: () => client.benchLink(),
    retry: () => client.retry(),
  };
}
