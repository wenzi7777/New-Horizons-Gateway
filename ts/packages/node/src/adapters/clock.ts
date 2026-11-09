// Clock on Node: wall time from the OS clock (NTP-disciplined), µs from the
// high-resolution timer anchored at process start, monotonic from performance.now().
import { performance } from 'node:perf_hooks';

import type { Clock } from '@nhgw/core';

export class NodeClock implements Clock {
  nowMs(): number {
    return Date.now();
  }

  /**
   * performance.timeOrigin + performance.now() keeps sub-ms precision (the
   * time service's t2/t3). It follows the wall clock as of process start, so
   * it drifts from Date.now() if the OS clock is stepped later; it is
   * re-anchored whenever the two disagree by more than `maxSkewMs`.
   */
  private offsetMs = 0;
  private readonly maxSkewMs: number;

  constructor(options: { maxSkewMs?: number } = {}) {
    this.maxSkewMs = options.maxSkewMs ?? 50;
  }

  nowEpochUs(): number {
    let epochMs = performance.timeOrigin + performance.now() + this.offsetMs;
    const wall = Date.now();
    if (Math.abs(epochMs - wall) > this.maxSkewMs) {
      // The OS clock was stepped (NTP sync, manual change): follow it.
      this.offsetMs = wall - (performance.timeOrigin + performance.now());
      epochMs = wall;
    }
    return Math.round(epochMs * 1000);
  }

  monotonicMs(): number {
    return performance.now();
  }
}
