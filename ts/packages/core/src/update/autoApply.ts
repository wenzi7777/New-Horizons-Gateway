// Applies a required update by itself once the Gateway is idle (auto_update.py).
//
// Mirrors the Hub's serviceRequiredUpdate(): after a boot grace period, a
// required update is applied once no device has been served for IDLE_SEC. An
// attempt that leaves the Gateway running (download/apply error, or the
// manifest not actually newer yet) blocks further tries for RETRY_SEC, so a
// broken release cannot make the Gateway restart-loop.
//
// status() (reported as update_block's auto_apply, same values as the Hub):
//   ""                  no required update
//   "waiting_for_idle"  required, will apply once idle
//   "retry_later"       a try failed; waiting out RETRY_SEC
import type { AutoApplier, UpdateControl } from '../contracts';
import type { Clock, Logger } from '../ports';
import { silentLogger } from '../ports';

export const BOOT_GRACE_SEC = 60;
export const IDLE_SEC = 60;
export const RETRY_SEC = 30 * 60;

export interface AutoApplierOptions {
  /** Idle = no device being served (main.py: state.serving_count() == 0). */
  isIdle: () => boolean;
  clock: Pick<Clock, 'monotonicMs'>;
  bootGraceSec?: number;
  idleSec?: number;
  retrySec?: number;
  logger?: Logger;
}

export class RequiredUpdateAutoApplier implements AutoApplier {
  readonly bootGraceMs: number;
  readonly idleMs: number;
  readonly retryMs: number;
  private readonly manager: UpdateControl;
  private readonly isIdle: () => boolean;
  private readonly clock: Pick<Clock, 'monotonicMs'>;
  private readonly logger: Logger;
  private readonly startedAtMs: number;
  private idleSinceMs: number | null = null;
  private blockedUntilMs = 0;
  private attempted = false;

  constructor(manager: UpdateControl, options: AutoApplierOptions) {
    this.manager = manager;
    this.isIdle = options.isIdle;
    this.clock = options.clock;
    this.logger = options.logger ?? silentLogger;
    this.bootGraceMs = (options.bootGraceSec ?? BOOT_GRACE_SEC) * 1000;
    this.idleMs = (options.idleSec ?? IDLE_SEC) * 1000;
    this.retryMs = (options.retrySec ?? RETRY_SEC) * 1000;
    this.startedAtMs = this.clock.monotonicMs();
  }

  status(): string {
    if (!this.manager.state().required_update) return '';
    return this.clock.monotonicMs() < this.blockedUntilMs ? 'retry_later' : 'waiting_for_idle';
  }

  service(): void {
    const manager = this.manager;
    const state = manager.state();
    if (state.busy) return; // an update (ours or a manual one) is running
    const now = this.clock.monotonicMs();
    if (this.attempted) {
      // Still alive after our attempt finished: it did not restart us.
      this.attempted = false;
      this.blockedUntilMs = now + this.retryMs;
    }
    if (!state.required_update) {
      this.idleSinceMs = null;
      return;
    }
    if (now < this.blockedUntilMs || now - this.startedAtMs < this.bootGraceMs) return;
    if (!this.isIdle()) {
      this.idleSinceMs = null;
      return;
    }
    if (this.idleSinceMs === null) {
      this.idleSinceMs = now;
      return;
    }
    if (now - this.idleSinceMs >= this.idleMs) {
      this.idleSinceMs = null;
      this.attempted = true;
      this.logger.info('applying required gateway update (idle)');
      manager.startUpdate().catch((exc: unknown) => {
        this.logger.error(`auto update failed to start: ${exc instanceof Error ? exc.message : String(exc)}`);
      });
    }
  }
}
