// The two upstream queues of upstream_wss.py / queueing.py. Both are bounded
// and drop their *oldest* entry when full: a stale sensor frame or status is
// worth less than a fresh one, and an unbounded queue behind a dead link is
// worse than either.

/** queueing.DropOldestQueue: counts what it drops (reported as data_queue_dropped). */
export class DropOldestQueue<T> {
  private readonly items: T[] = [];
  readonly maxsize: number;
  dropped = 0;

  constructor(maxsize: number) {
    this.maxsize = Math.max(1, Math.trunc(maxsize));
  }

  put(item: T): void {
    while (this.items.length >= this.maxsize) {
      this.items.shift();
      this.dropped += 1;
    }
    this.items.push(item);
  }

  /** The oldest item, or undefined when empty (Python's get raised queue.Empty). */
  get(): T | undefined {
    return this.items.shift();
  }

  qsize(): number {
    return this.items.length;
  }
}

type Typed = { type?: unknown };

/**
 * The control queue: also drop-oldest, but uncounted (Python's _put_control
 * kept no counter), and able to coalesce -- a queued message of the same type
 * is removed before the new one is appended, so only the newest gateway_status
 * ever waits behind a slow or missing link.
 */
export class ControlQueue<T extends Typed> {
  private items: T[] = [];
  readonly maxsize: number;

  constructor(maxsize: number) {
    this.maxsize = Math.max(1, Math.trunc(maxsize));
  }

  put(item: T, coalesceType = ''): void {
    if (coalesceType) this.items = this.items.filter((queued) => queued.type !== coalesceType);
    while (this.items.length >= this.maxsize) this.items.shift();
    this.items.push(item);
  }

  get(): T | undefined {
    return this.items.shift();
  }

  qsize(): number {
    return this.items.length;
  }

  /** Snapshot for tests and diagnostics. */
  peekAll(): readonly T[] {
    return [...this.items];
  }
}
