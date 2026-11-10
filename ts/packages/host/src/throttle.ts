// At most one live frame per interval per subscriber: the first frame of a
// quiet period goes out at once, later ones are held and only the newest is
// sent when the interval is up (a 60-90 fps stream becomes ~20 fps on screen
// without lagging behind it).

export const LIVE_FRAME_INTERVAL_MS = 50;

export interface TimerPort {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: TimerPort = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class LatestThrottle<T> {
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private pending: { value: T } | null = null;
  private timer: unknown = null;
  private closed = false;

  constructor(
    private readonly deliver: (value: T) => void,
    private readonly intervalMs = LIVE_FRAME_INTERVAL_MS,
    private readonly timers: TimerPort = realTimers,
  ) {}

  push(value: T): void {
    if (this.closed) return;
    const now = this.timers.now();
    if (this.timer === null && now - this.lastSentAt >= this.intervalMs) {
      this.send(value, now);
      return;
    }
    this.pending = { value };
    if (this.timer === null) {
      this.timer = this.timers.setTimeout(() => this.flush(), Math.max(0, this.lastSentAt + this.intervalMs - now));
    }
  }

  private flush(): void {
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    if (pending !== null && !this.closed) this.send(pending.value, this.timers.now());
  }

  private send(value: T, now: number): void {
    this.lastSentAt = now;
    try {
      this.deliver(value);
    } catch {
      // a subscriber's problem
    }
  }

  close(): void {
    this.closed = true;
    this.pending = null;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}
