// Structural sharing for store snapshots. The host hands out fresh objects on
// every notification (about 4 Hz while a device streams), so comparing by
// reference would re-render every screen each time. shareData keeps the
// previous object wherever nothing changed, down to each device / field, so
// React.memo and effect dependencies see a change only where there is one.

/** Fields that tick on their own and are not shown while they tick (a device's lastSeenMs while online). */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set(['lastSeenMs']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deep equality of plain data (objects, arrays, primitives), skipping `ignore` keys of objects. */
export function sameData(a: unknown, b: unknown, ignore: ReadonlySet<string> = VOLATILE_KEYS): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i], ignore)) return false;
    return true;
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keysA = Object.keys(a).filter((k) => !ignore.has(k) && a[k] !== undefined);
    const keysB = Object.keys(b).filter((k) => !ignore.has(k) && b[k] !== undefined);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) if (!sameData(a[key], b[key], ignore)) return false;
    return true;
  }
  return false;
}

/**
 * `next`, reusing `prev` (or the parts of it) that are equal by sameData:
 * returns `prev` itself when nothing changed, otherwise a new container whose
 * unchanged children are the previous ones. Arrays of objects with a `uid`
 * are matched by uid, other arrays by index.
 */
export function shareData<T>(prev: T | undefined, next: T, ignore: ReadonlySet<string> = VOLATILE_KEYS): T {
  if (prev === undefined) return next;
  if (sameData(prev, next, ignore)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const byUid = new Map<unknown, unknown>();
    for (const item of prev) if (isPlainObject(item) && 'uid' in item) byUid.set(item.uid, item);
    return next.map((item, i) => {
      const old = isPlainObject(item) && 'uid' in item ? byUid.get(item.uid) : prev[i];
      return shareData(old, item, ignore);
    }) as T;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(next)) out[key] = shareData(prev[key], next[key], ignore);
    return out as T;
  }
  return next;
}
