// Which PocketStore the screens talk to, and the hooks they read it with.
//
// To run on the real host, change the one line marked below (or call
// setStore(hostStore) from the host before/after the first render: every
// screen re-renders against the new store, and the previous one is stopped).

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { LiveFrame, PocketStore } from '../host/contract';
import { createPocketStore, getPocketSync } from '../host';
import { createMockSync } from '../host/mockSync';
import { createMockStore } from '../host/mockStore';
import type { PocketSync } from '../host/sync';
import { getPocketUpdater } from '../host/updates';
import type { PocketUpdater } from '../host/updater';
import { shareData } from './shareData';

// The real host on Android; the mock where the native module is missing
// (Expo Go, iOS, web), so the screens still run there for review.
let current: PocketStore = createPocketStore() ?? createMockStore();

const swapListeners = new Set<() => void>();

/** Replace the store the UI uses (the host calls this once it is ready). */
export function setStore(store: PocketStore): void {
  if (store === current) return;
  const previous = current;
  current = store;
  void previous.stop().catch(() => undefined);
  for (const listener of [...swapListeners]) listener();
}

export function getStore(): PocketStore {
  return current;
}

function subscribeSwap(listener: () => void): () => void {
  swapListeners.add(listener);
  return () => {
    swapListeners.delete(listener);
  };
}

const StoreContext = createContext<PocketStore | null>(null);

/**
 * Provides the current store. Screens read it through selector hooks
 * (useStoreSelector), which re-render only when what they select changed:
 * the host notifies about 4 Hz while a device streams, mostly with nothing
 * new for a given screen.
 */
export function StoreProvider({ children }: { children: ReactNode }) {
  const store = useSyncExternalStore(subscribeSwap, getStore, getStore);

  useEffect(() => {
    // The service keeps running when the UI goes away (background relaying
    // and recording), so unmounting does not stop it; setStore() does.
    void store.start().catch(() => undefined);
  }, [store]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): PocketStore {
  const value = useContext(StoreContext);
  if (!value) throw new Error('StoreProvider missing');
  return value;
}

/**
 * `select(store)`, re-read on every store notification but returned as the
 * previous value (or with its unchanged parts reused, see shareData) when it
 * is equal, so the caller re-renders only on a real change.
 */
export function useStoreSelector<T>(select: (store: PocketStore) => T): T {
  const store = useStore();
  const selectRef = useRef(select);
  selectRef.current = select;
  const cache = useRef<{ store: PocketStore; value: T } | null>(null);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback((): T => {
    const prev = cache.current;
    const value = shareData(prev && prev.store === store ? prev.value : undefined, selectRef.current(store));
    if (!prev || prev.store !== store || prev.value !== value) cache.current = { store, value };
    return value;
  }, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const selectStatus = (store: PocketStore) => store.status();
const selectSettings = (store: PocketStore) => store.settings();
const selectDevices = (store: PocketStore) => store.devices();
const selectNearby = (store: PocketStore) => store.nearby();
const selectRecordings = (store: PocketStore) => store.recordings();

export function useStatus() {
  return useStoreSelector(selectStatus);
}

export function useSettings() {
  return useStoreSelector(selectSettings);
}

export function useDevices() {
  return useStoreSelector(selectDevices);
}

export function useDevice(uid: string | undefined) {
  return useStoreSelector((store) => store.devices().find((d) => d.uid === uid) ?? null);
}

/** One device's scan rate, read on its own: it changes several times a second. */
export function useDeviceFps(uid: string | undefined): number {
  return useStoreSelector((store) => store.devices().find((d) => d.uid === uid)?.fps ?? 0);
}

export function useNearby() {
  return useStoreSelector(selectNearby);
}

export function useRecordings() {
  return useStoreSelector(selectRecordings);
}

/** The latest live frame of one device (null until the first arrives); paused while `enabled` is false. */
export function useLiveFrame(uid: string | undefined, enabled = true): LiveFrame | null {
  const store = useStore();
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  useEffect(() => {
    setFrame(null);
    if (!uid || !enabled) return undefined;
    return store.subscribeLive(uid, setFrame);
  }, [store, uid, enabled]);
  return frame;
}

/** A clock that ticks every `intervalMs` (elapsed times, "last seen"). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  const tick = useCallback(() => setNow(Date.now()), []);
  useEffect(() => {
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [tick, intervalMs]);
  return now;
}

let syncCurrent: PocketSync | null = null;

/** Server sync (sign-in, upload queue): the real client on Android, a mock elsewhere. */
export function usePocketSync(): { sync: PocketSync; status: ReturnType<PocketSync['status']> } {
  if (syncCurrent === null) syncCurrent = getPocketSync() ?? createMockSync();
  const sync = syncCurrent;
  const status = useSyncExternalStore(sync.subscribe, sync.status, sync.status);
  return { sync, status };
}

/** In-app update (check, download, install). */
export function usePocketUpdater(): { updater: PocketUpdater; state: ReturnType<PocketUpdater['snapshot']> } {
  const updater = getPocketUpdater();
  const state = useSyncExternalStore(
    (listener) => updater.subscribe(listener),
    () => updater.snapshot(),
    () => updater.snapshot(),
  );
  return { updater, state };
}
