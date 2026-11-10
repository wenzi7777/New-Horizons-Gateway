// Wires the feature areas (../../shared/areas.ts) to IPC. Each area module
// returns its handlers once at start-up; a request names (area, method) and
// is refused unless that exact method was registered, so the renderer can
// never reach anything an area did not choose to expose. Electron-free like
// ../ipc.ts, so it is testable with a fake ipcMain.

import { AREA_CALL, AREA_EVENT, AREA_METHOD_PATTERN, isAreaName, type AreaName } from '../../shared/areas';
import type { IpcEventLike, IpcMainLike, SenderLike } from '../ipc';
import type { StudioController } from '../studioController';

export type AreaHandler = (...args: never[]) => unknown;
export type AreaHandlers = Record<string, AreaHandler>;

export interface AreaContext {
  controller: StudioController;
  /** Push an event to every window (renderer: api.onAreaEvent(area, event, …)). */
  emit(event: string, payload?: unknown): void;
  logger:{ info(message: string): void; warn(message: string): void; error(message: string): void };
  /** Absolute userData folder (config, caches that are not recordings). */
  userDataDir: string;
  /** Packaged app version, e.g. "v2.0.0". */
  version: string;
}

export interface AreaModule {
  area: AreaName;
  register(context: AreaContext): AreaHandlers;
  /** Called on quit; may be async (flush, close). */
  dispose?(): void | Promise<void>;
}

export interface AreaRegistryOptions {
  isTrustedSender?: (event: IpcEventLike) => boolean;
  /** Every window's sender, for broadcasts. */
  senders: () => SenderLike[];
}

export class AreaRegistry {
  private readonly handlers = new Map<AreaName, AreaHandlers>();
  private readonly modules: AreaModule[] = [];

  constructor(
    private readonly base: Omit<AreaContext, 'emit'>,
    private readonly options: AreaRegistryOptions,
  ) {}

  add(module: AreaModule): void {
    if (this.handlers.has(module.area)) throw new Error(`area ${module.area} registered twice`);
    const context: AreaContext = { ...this.base, emit: (event, payload) => this.emit(module.area, event, payload) };
    const handlers = module.register(context);
    for (const name of Object.keys(handlers)) {
      if (!AREA_METHOD_PATTERN.test(name)) throw new Error(`area ${module.area}: bad method name ${name}`);
    }
    this.handlers.set(module.area, handlers);
    this.modules.push(module);
  }

  emit(area: AreaName, event: string, payload?: unknown): void {
    for (const sender of this.options.senders()) {
      try {
        sender.send(AREA_EVENT, area, event, payload);
      } catch {
        // A window that is closing; the next broadcast skips it.
      }
    }
  }

  /** The ipcMain.handle body, exposed for tests. */
  async call(event: IpcEventLike, area: unknown, method: unknown, args: unknown): Promise<unknown> {
    if (this.options.isTrustedSender && !this.options.isTrustedSender(event)) throw new Error('untrusted_sender');
    if (!isAreaName(area)) throw new Error('unknown_area');
    if (typeof method !== 'string' || !AREA_METHOD_PATTERN.test(method)) throw new Error('unknown_method');
    const handlers = this.handlers.get(area);
    const handler = handlers && Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined;
    if (!handler) throw new Error('unknown_method');
    const list = Array.isArray(args) ? (args as never[]) : [];
    return handler(...list);
  }

  attach(ipc: IpcMainLike): () => void {
    ipc.handle(AREA_CALL, (event: IpcEventLike, area: unknown, method: unknown, args: unknown) => this.call(event, area, method, args));
    return () => ipc.removeHandler(AREA_CALL);
  }

  async dispose(): Promise<void> {
    for (const module of this.modules) {
      try {
        await module.dispose?.();
      } catch (error) {
        this.base.logger.warn(`area ${module.area} dispose: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
