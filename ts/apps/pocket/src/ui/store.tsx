// Which PocketStore the screens talk to, and the hooks they read it with.
//
// To run on the real host, change the one line marked below (or call
// setStore(hostStore) from the host before/after the first render: every
// screen re-renders against the new store, and the previous one is stopped).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { LiveFrame, PocketStore } from '../host/contract';
import { createPocketStore, getPocketSync } from '../host';
import { createMockSync } from '../host/mockSync';
import { createMockStore } from '../host/mockStore';
import type { PocketSync } from '../host/sync';

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

type StoreContextValue = { store: PocketStore; version: number };
const StoreContext = createContext<StoreContextValue | null>(null);

/**
 * Provides the current store and a version that changes with every store
 * notification. Snapshots are re-read per version, so hosts need not keep
 * their arrays referentially stable.
 */
export function StoreProvider({ children }: { children: ReactNode }) {
  const store = useSyncExternalStore(subscribeSwap, getStore, getStore);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setVersion((v) => v + 1);
    const unsubscribe = store.subscribe(() => setVersion((v) => v + 1));
    // The service keeps running when the UI goes away (background relaying
    // and recording), so unmounting does not stop it; setStore() does.
    void store.start().catch(() => undefined);
    return unsubscribe;
  }, [store]);

  const value = useMemo(() => ({ store, version }), [store, version]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

function useStoreContext(): StoreContextValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('StoreProvider missing');
  return value;
}

export function useStore(): PocketStore {
  return useStoreContext().store;
}

export function useStatus() {
  const { store, version } = useStoreContext();
  return useMemo(() => store.status(), [store, version]);
}

export function useSettings() {
  const { store, version } = useStoreContext();
  return useMemo(() => store.settings(), [store, version]);
}

export function useDevices() {
  const { store, version } = useStoreContext();
  return useMemo(() => store.devices(), [store, version]);
}

export function useDevice(uid: string | undefined) {
  const devices = useDevices();
  return useMemo(() => devices.find((d) => d.uid === uid) ?? null, [devices, uid]);
}

export function useNearby() {
  const { store, version } = useStoreContext();
  return useMemo(() => store.nearby(), [store, version]);
}

export function useRecordings() {
  const { store, version } = useStoreContext();
  return useMemo(() => store.recordings(), [store, version]);
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
