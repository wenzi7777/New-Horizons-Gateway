// Giving an unsynced device a wall clock (gateway_ws.py _maybe_push_time).
// A device that reports clock.synced === false is sent an ordinary `set_time`
// command, at most once per TIME_PUSH_INTERVAL_MS. Only an explicit false
// counts: firmware before v1.0.0 has no `clock` block and no set_time, and
// pushing to it would send a doomed command every interval.
import { type Dict, isDict, truthy } from './py';

export const TIME_PUSH_INTERVAL_MS = 600_000;

/** True/false when the device reported its clock state, null when it did not. */
export function clockIsSynced(payload: Dict): boolean | null {
  for (const container of [payload, payload.status, payload.data]) {
    if (!isDict(container)) continue;
    const clock = container.clock;
    if (isDict(clock) && 'synced' in clock) return truthy(clock.synced);
  }
  return null;
}

/** Remembers when each device was last pushed the time. Times are monotonic ms. */
export class TimePushThrottle {
  private readonly lastPush = new Map<string, number>();

  constructor(private readonly intervalMs = TIME_PUSH_INTERVAL_MS) {}

  /** Whether to push now; when true, the push is recorded (before it is sent, as in Python). */
  take(deviceUid: string, nowMono: number): boolean {
    const last = this.lastPush.get(deviceUid);
    if (last !== undefined && nowMono - last < this.intervalMs) return false;
    this.lastPush.set(deviceUid, nowMono);
    return true;
  }
}
