// Main-process handlers of the "sync" area (see ../../shared/areas/sync.ts):
// one @nhgw/host SyncClient on the controller's current host and data
// folder, rebuilt when the data folder moves (the controller swaps hosts).
// Studio counts wired and Wi-Fi alike: the network is never metered here.
import { FetchSyncHttp, SyncClient, SyncError, type SyncHttp } from '@nhgw/host';

import type { SyncAreaStatus } from '../../shared/areas/sync';
import type { AreaContext, AreaModule } from './registry';

const REBIND_MS = 5_000;

export interface SyncAreaOptions {
  http?: SyncHttp;
  /** Start the client's queue timer (default true; tests drive tick() themselves). */
  autoStart?: boolean;
}

export function createSyncArea(options: SyncAreaOptions = {}): AreaModule & { client(): SyncClient | null } {
  let client: SyncClient | null = null;
  let off: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let context: AreaContext | null = null;
  const http = options.http ?? new FetchSyncHttp();

  const plain = (status: unknown) => JSON.parse(JSON.stringify(status)) as SyncAreaStatus;

  async function ensure(): Promise<SyncClient> {
    const ctx = context!;
    const host = ctx.controller.host;
    if (client && client.host === host) return client;
    if (client) {
      off?.();
      await client.stop();
    }
    const next = new SyncClient({ host, files: ctx.controller.native, http, logger: ctx.logger, network: () => ({ online: true, metered: false }) });
    client = next;
    off = next.on((event) => {
      if (event.type === 'progress') ctx.emit('progress', { id: event.id, sentBytes: event.sentBytes, totalBytes: event.totalBytes });
      else ctx.emit('state', plain(next.status()));
    });
    if (options.autoStart === false) await next.reload();
    else await next.start();
    return next;
  }

  /** Errors reach the renderer as plain codes. */
  async function guarded<T>(run: (c: SyncClient) => Promise<T>): Promise<T> {
    try {
      return await run(await ensure());
    } catch (error) {
      throw new Error(error instanceof SyncError ? error.code : error instanceof Error ? error.message : String(error));
    }
  }

  return {
    area: 'sync',
    client: () => client,
    register(ctx) {
      context = ctx;
      timer = setInterval(() => void ensure().catch(() => undefined), REBIND_MS);
      (timer as { unref?: () => void }).unref?.();
      return {
        status: () => guarded(async (c) => plain(c.status())),
        setToken: (token: string) => guarded((c) => c.setToken(typeof token === 'string' ? token : '')),
        clearToken: () => guarded(async (c) => (await c.clearToken(), plain(c.status()))),
        testConnection: () => guarded((c) => c.testConnection()),
        uploadNow: (id?: string) => guarded(async (c) => (await c.uploadNow(typeof id === 'string' ? id : undefined), plain(c.status()))),
        retry: (id?: string) => guarded(async (c) => (await c.retry(typeof id === 'string' ? id : undefined), plain(c.status()))),
        pause: () => guarded(async (c) => (await c.pause(), plain(c.status()))),
        resume: () => guarded(async (c) => (await c.resume(), plain(c.status()))),
        syncLabelsNow: () => guarded((c) => c.syncLabelsNow()),
        syncProfilesNow: () => guarded((c) => c.syncProfilesNow()),
      };
    },
    async dispose() {
      if (timer) clearInterval(timer);
      off?.();
      await client?.stop();
    },
  };
}

export const syncArea = createSyncArea();
