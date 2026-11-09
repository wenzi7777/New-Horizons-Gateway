// Desktop -> Gateway management commands (remote_commands.py).
//
// The Desktop Backend sends {"type":"gateway_command","request_id","payload":
// {"command", ...args}} over the upstream WebSocket -- the same pair it uses
// for a Hub -- and expects {"type":"gateway_command_result","request_id",
// "result":{"ok","message",...}} back.
//
// Anything that cuts the connection the reply travels on (set_config,
// restart, factory_reset) replies first and acts REPLY_GRACE_MS later. Python
// slept on a worker thread for that; here the deferred action is queued and
// service() (ticked by the runtime) runs it once its time has come.
import { validateGatewayId } from '../config';
import type { Json } from '../contracts';
import type { Clock, Logger } from '../ports';
import { silentLogger } from '../ports';
import { pyTruthy } from '../py';
import { dictOr, pyGet, pyOr, setDefault, strOr } from './pyCompat';
import { type GatewayOperations, type OpResult, isWsUrl } from './operations';

export const GATEWAY_COMMANDS = [
  'set_config',
  'check_update',
  'apply_update',
  'set_update_channel',
  'restart',
  'factory_reset',
  'discover',
  'device_reject',
  'device_allow',
  'device_serve',
] as const;
export type GatewayCommand = (typeof GATEWAY_COMMANDS)[number];

export { CAPABILITIES } from '../contracts';

export const REPLY_GRACE_MS = 1000;

type Deferred = () => unknown;
type CommandOutcome = [Json, Deferred | null];

export interface GatewayCommandHandlerOptions {
  /** A fresh GatewayOperations per command (it reads the current upstream link). */
  operations: () => GatewayOperations;
  sendResult: (requestId: string, result: Json) => void;
  restart: () => unknown;
  updateBlock: () => Json;
  afterCommand?: () => void;
  clock: Clock;
  graceMs?: number;
  logger?: Logger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GatewayCommandHandler {
  private readonly options: GatewayCommandHandlerOptions;
  private readonly graceMs: number;
  private readonly logger: Logger;
  private readonly deferred: { dueAt: number; action: Deferred }[] = [];
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: GatewayCommandHandlerOptions) {
    this.options = options;
    this.graceMs = options.graceMs ?? REPLY_GRACE_MS;
    this.logger = options.logger ?? silentLogger;
  }

  /** True when `message` was a gateway_command (now being handled). */
  handleMessage(message: Json): boolean {
    if (message.type !== 'gateway_command') return false;
    const payload = dictOr(message.payload);
    const requestId = strOr(pyOr(message.request_id, payload.request_id));
    // Only sendResult itself can still throw here (a closed link); there is nobody left to tell.
    const work = this.handle(requestId, { ...payload }).catch((error: unknown) => {
      this.logger.warn(`gateway_command reply failed: ${errorMessage(error)}`);
    });
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
    return true;
  }

  /** Resolves once every command started so far has replied (deferred actions excluded). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }

  /** Deferred actions still waiting out their grace period. */
  pendingDeferred(): number {
    return this.deferred.length;
  }

  /** Runs the deferred actions whose grace period is over. */
  async service(): Promise<void> {
    const now = this.options.clock.monotonicMs();
    const due = this.deferred.filter((item) => item.dueAt <= now);
    if (!due.length) return;
    for (const item of due) this.deferred.splice(this.deferred.indexOf(item), 1);
    for (const item of due) await this.runDeferred(item.action);
  }

  async handle(requestId: string, payload: Json): Promise<void> {
    const command = strOr(payload.command);
    let result: Json;
    let deferred: Deferred | null = null;
    try {
      if (!(GATEWAY_COMMANDS as readonly string[]).includes(command)) {
        result = { ok: false, message: 'unknown_command' };
      } else if (!this.remoteManagementEnabled()) {
        result = { ok: false, message: 'remote_management_disabled' };
      } else {
        [result, deferred] = await this.dispatch(command as GatewayCommand, payload);
      }
    } catch (error) {
      // Never leave the Desktop waiting.
      result = { ok: false, message: 'command_failed', error: errorMessage(error) };
      deferred = null;
    }
    setDefault(result, 'command', command);
    this.options.sendResult(requestId, result);
    if (deferred !== null) {
      if (this.graceMs > 0) {
        this.deferred.push({ dueAt: this.options.clock.monotonicMs() + this.graceMs, action: deferred });
        return; // afterCommand runs once the deferred action has
      }
      await this.runDeferred(deferred, false);
    }
    this.runAfterCommand();
  }

  private async runDeferred(action: Deferred, thenAfterCommand = true): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.logger.warn(`gateway_command deferred action failed: ${errorMessage(error)}`);
    }
    if (thenAfterCommand) this.runAfterCommand();
  }

  private runAfterCommand(): void {
    try {
      this.options.afterCommand?.();
    } catch {
      // A status push is best effort.
    }
  }

  private remoteManagementEnabled(): boolean {
    return pyTruthy(pyGet(this.options.operations().configStore.snapshot(), 'remote_management', true));
  }

  private static fromOp(result: OpResult, okMessage: string): Json {
    const out: Json = result.ok ? { ok: true, message: okMessage } : { ok: false, message: result.error };
    for (const key of ['denied_devices', 'claim']) {
      if (key in result.data) out[key] = result.data[key];
    }
    return out;
  }

  private async dispatch(command: GatewayCommand, payload: Json): Promise<CommandOutcome> {
    const ops = this.options.operations();
    switch (command) {
      case 'set_config': {
        if (ops.isLocked()) return [{ ok: false, message: 'update_required' }, null];
        const body: Json = {};
        for (const key of ['gateway_id', 'target_mode', 'manual_url']) if (key in payload) body[key] = payload[key];
        if (!Object.keys(body).length) return [{ ok: false, message: 'nothing_to_change' }, null];
        // Validate now so the reply is honest, apply after it has left: a new
        // ID or URL reconnects the socket this reply travels on.
        const preview: Json = { ...ops.configStore.snapshot(), ...body };
        try {
          validateGatewayId(preview.gateway_id);
        } catch (error) {
          return [{ ok: false, message: errorMessage(error) }, null];
        }
        if (!['production', 'local', 'manual'].includes(preview.target_mode as string)) {
          return [{ ok: false, message: 'invalid_target_mode' }, null];
        }
        if (preview.target_mode === 'manual' && !isWsUrl(preview.manual_url)) {
          return [{ ok: false, message: 'invalid_manual_url' }, null];
        }
        return [{ ok: true, message: 'config_saved_reconnecting' }, () => ops.saveSettings(body, false)];
      }
      case 'check_update': {
        const state = await ops.updateControl.check(true);
        let message: string;
        if (state.phase === 'error') message = 'update_check_failed';
        else if (pyTruthy(state.update_available)) message = 'update_available';
        else message = 'up_to_date';
        return [
          {
            ok: message !== 'update_check_failed',
            message,
            current_version: currentVersion(ops),
            update: this.options.updateBlock(),
          },
          null,
        ];
      }
      case 'apply_update': {
        if (pyTruthy(ops.updateControl.state().busy)) {
          return [{ ok: true, message: 'update_in_progress', update: this.options.updateBlock() }, null];
        }
        // The updater restarts the Gateway when it is done, so it starts right
        // away -- the download alone outlasts the reply.
        await ops.updateControl.startUpdate();
        return [{ ok: true, message: 'update_started', current_version: currentVersion(ops) }, null];
      }
      case 'set_update_channel': {
        const out = GatewayCommandHandler.fromOp(await ops.setUpdateChannel(payload.channel), 'update_channel_set');
        out.update = this.options.updateBlock();
        return [out, null];
      }
      case 'restart':
        return [{ ok: true, message: 'restarting' }, this.options.restart];
      case 'factory_reset':
        return [{ ok: true, message: 'factory_reset_disconnecting' }, () => ops.factoryReset()];
      case 'discover':
        return [GatewayCommandHandler.fromOp(ops.discover(), 'discover_sent'), null];
      case 'device_reject':
        return [GatewayCommandHandler.fromOp(await ops.deny(payload.device_uid), 'device_rejected'), null];
      case 'device_allow':
        return [GatewayCommandHandler.fromOp(await ops.allow(payload.device_uid), 'device_allowed'), null];
      case 'device_serve':
        return [GatewayCommandHandler.fromOp(ops.serve(payload.device_uid), 'claim_requested'), null];
    }
  }
}

/** Python reported its own __version__; here the updater knows the running version. */
function currentVersion(ops: GatewayOperations): string {
  return strOr(ops.updateControl.state().current_version);
}
