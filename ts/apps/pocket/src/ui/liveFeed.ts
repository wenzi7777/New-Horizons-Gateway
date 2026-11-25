// One device's live frames for the live screen, read by each part at its own
// pace. The host delivers up to 20 frames a second; re-rendering the whole
// screen for each was what made it crawl on a Pixel 4a. The feed takes every
// frame (counting samples, filling the IMU history) without rendering, and
// each part subscribes for what it needs: the map at 15 fps, the stats at
// 4 Hz, the IMU panels at 8 Hz, the screen itself only when the shape changes.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { LiveFrame } from '../host/contract';
import { createLiveFeed, pushLiveFrame, throttleDelay, type LiveFeed } from './liveFeedCore';
import { useStore } from './store';

export { noteRender, renderFps, type LiveFeed } from './liveFeedCore';

/** A new feed per device, receiving frames while `enabled` (the screen is in front). */
export function useLiveFeed(uid: string | undefined, enabled: boolean): LiveFeed {
  const store = useStore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const feed = useMemo(createLiveFeed, [uid, store]);
  useEffect(() => {
    if (!uid || !enabled) return undefined;
    return store.subscribeLive(uid, (frame) => pushLiveFrame(feed, frame));
  }, [store, uid, enabled, feed]);
  return feed;
}

/**
 * `select(feed.latest)`, re-rendering at most `hz` times a second and only
 * when `isEqual` says the selection changed (default: always, i.e. every
 * new frame).
 */
export function useFeed<T>(feed: LiveFeed, hz: number, select: (frame: LiveFrame | null) => T, isEqual?: (a: T, b: T) => boolean): T {
  const selectRef = useRef(select);
  selectRef.current = select;
  const equalRef = useRef(isEqual);
  equalRef.current = isEqual;
  const [value, setValue] = useState(() => select(feed.latest));
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const flush = () => {
      timer = null;
      last = Date.now();
      const next = selectRef.current(feed.latest);
      const same = equalRef.current ? equalRef.current(valueRef.current, next) : false;
      if (!same) setValue(() => next);
    };
    const listener = () => {
      if (timer !== null) return;
      timer = setTimeout(flush, throttleDelay(last, Date.now(), hz));
    };
    feed.listeners.add(listener);
    // A new feed (another device): start from what it has.
    flush();
    return () => {
      feed.listeners.delete(listener);
      if (timer !== null) clearTimeout(timer);
    };
  }, [feed, hz]);

  return value;
}

const identity = (frame: LiveFrame | null) => frame;

/** The latest frame, at most `hz` renders a second. */
export function useFeedFrame(feed: LiveFeed, hz: number): LiveFrame | null {
  return useFeed(feed, hz, identity);
}
