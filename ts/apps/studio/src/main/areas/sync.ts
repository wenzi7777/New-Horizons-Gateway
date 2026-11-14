// Main-process handlers of the "sync" area (see ../../shared/areas/sync.ts):
// one @nhgw/host SyncClient on the controller's current host and data
// folder, rebuilt when the data folder moves (the controller swaps hosts).
// Studio counts wired and Wi-Fi alike: the network is never metered here.
import { hostname } from 'node:os';

import { estimateCapacity, FetchSyncHttp, runCpuBench, SyncClient, SyncError, type CredentialStore, type SyncHttp } from '@nhgw/host';

import type { SyncAreaStatus } from '../../shared/areas/sync';
import { electronCipher, fileCredentialStore } from './credentialStore';
import type { AreaContext, AreaModule } from './registry';

const REBIND_MS = 5_000;

export interface SyncAreaOptions {
  http?: SyncHttp;
  /** Start the client's queue timer (default true; tests drive tick() themselves). */
  autoStart?: boolean;
  /** Where the account is remembered (default: userData, encrypted with safeStorage). */
  credentials?: (context: AreaContext) => CredentialStore;
}

export function createSyncArea(options: SyncAreaOptions = {}): AreaModule & { client(): SyncClient | null } {
  let client: SyncClient | null = null;
  let off: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let context: AreaContext | null = null;
  const http = options.http ?? new FetchSyncHttp();

  const plain = (status: unknown) => JSON.parse(JSON.stringify(status)) as SyncAreaStatus;

  /** The rebind in flight: callers during it (the 5 s timer, a handler) share it, so one client is ever built per host. */
  let rebinding: Promise<SyncClient> | null = null;

  function ensure(): Promise<SyncClient> {
    const host = context!.controller.host;
    if (client && client.host === host && rebinding === null) return Promise.resolve(client);
    if (rebinding === null) {
      rebinding = rebind().finally(() => {
        rebinding = null;
      });
    }
    return rebinding;
  }

  async function rebind(): Promise<SyncClient> {
    const ctx = context!;
    // The controller may swap hosts again while the old client stops: build for the latest.
    for (;;) {
      const host = ctx.controller.host;
      if (client && client.host === host) return client;
      if (client) {
        const old = client;
        off?.();
        off = null;
        client = null;
        await old.stop();
        continue;
      }
      return build(ctx, host);
    }
  }

  async function build(ctx: AreaContext, host: AreaContext['controller']['host']): Promise<SyncClient> {
    const credentials = options.credentials?.(ctx) ?? fileCredentialStore(ctx.userDataDir, electronCipher);
    const next = new SyncClient({
      host,
      files: ctx.controller.native,
      http,
      logger: ctx.logger,
      network: () => ({ online: true, metered: false }),
      credentials,
      deviceName: () => hostname().replace(/\.local$/, ''),
    });
    client = next;
    off = next.on((event) => {
      if (event.type === 'progress') ctx.emit('progress', { id: event.id, sentBytes: event.sentBytes, totalBytes: event.totalBytes });
      else ctx.emit('state', plain(next.status()));
    });
    try {
      if (options.autoStart === false) await next.reload();
      else await next.start();
    } catch (error) {
      // Not left half-built: the next call tries again.
      off?.();
      off = null;
      client = null;
      await next.stop().catch(() => undefined);
      throw error;
    }
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
      timer = setInterval(
        () =>
          void ensure()
            .then((c) => {
              // The relay link was refused (its token ended): the remembered account signs in again.
              if (ctx.controller.host.status().authRejected) c.relayRefused();
            })
            .catch(() => undefined),
        REBIND_MS,
      );
      (timer as { unref?: () => void }).unref?.();
      return {
        status: () => guarded(async (c) => plain(c.status())),
        login: (username: string, password: string) =>
          guarded((c) => c.login(typeof username === 'string' ? username : '', typeof password === 'string' ? password : '', hostname().replace(/\.local$/, ''))),
        logout: () => guarded(async (c) => (await c.logout(), plain(c.status()))),
        testConnection: () => guarded((c) => c.testConnection()),
        uploadNow: (id?: string) => guarded(async (c) => (await c.uploadNow(typeof id === 'string' ? id : undefined), plain(c.status()))),
        retry: (id?: string) => guarded(async (c) => (await c.retry(typeof id === 'string' ? id : undefined), plain(c.status()))),
        pause: () => guarded(async (c) => (await c.pause(), plain(c.status()))),
        resume: () => guarded(async (c) => (await c.resume(), plain(c.status()))),
        syncLabelsNow: () => guarded((c) => c.syncLabelsNow()),
        syncProfilesNow: () => guarded((c) => c.syncProfilesNow()),
        relayBench: () =>
          guarded(async (c) => {
            const cpu = await runCpuBench({ durationMs: 3000 });
            const link = await c.benchLink();
            return { framesPerSecond: cpu.framesPerSecond, packetBytes: cpu.packetBytes, link, estimate: estimateCapacity({ cpu, link }) };
          }),
      };
    },
    async dispose() {
      if (timer) clearInterval(timer);
      await rebinding?.catch(() => undefined);
      off?.();
      await client?.stop();
    },
  };
}

export const syncArea = createSyncArea();
