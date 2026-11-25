// The live screen's frame feed without React (see liveFeed.ts): what it
// holds, how a frame is added, the render-FPS window and the throttle delay.

import { ImuHistory } from '@nhgw/host';

import type { LiveFrame } from '../host/contract';

export type LiveFeed = {
  latest: LiveFrame | null;
  /** Frames received since the feed started. */
  samples: number;
  /** When the map drew its recent frames (ms), for the render FPS. */
  renders: number[];
  imu: ImuHistory;
  listeners: Set<() => void>;
};

export function createLiveFeed(): LiveFeed {
  return { latest: null, samples: 0, renders: [], imu: new ImuHistory(), listeners: new Set() };
}

/** Adds a frame to the feed and tells its readers (exported for tests). */
export function pushLiveFrame(feed: LiveFeed, frame: LiveFrame, nowMs = Date.now()): void {
  feed.latest = frame;
  feed.samples += 1;
  feed.imu.push(nowMs, frame);
  for (const listener of [...feed.listeners]) listener();
}

/** Notes a drawn frame; returns how many were drawn in the last second. */
export function noteRender(feed: LiveFeed, nowMs = Date.now()): number {
  const cutoff = nowMs - 1000;
  let drop = 0;
  while (drop < feed.renders.length && feed.renders[drop]! <= cutoff) drop += 1;
  if (drop) feed.renders.splice(0, drop);
  feed.renders.push(nowMs);
  return feed.renders.length;
}

/** Frames drawn in the last second. */
export function renderFps(feed: LiveFeed, nowMs = Date.now()): number {
  const cutoff = nowMs - 1000;
  return feed.renders.filter((at) => at > cutoff).length;
}

/** Milliseconds to wait before the next render, given the last one and a rate cap. */
export function throttleDelay(lastMs: number, nowMs: number, hz: number): number {
  return Math.max(0, 1000 / hz - (nowMs - lastMs));
}
