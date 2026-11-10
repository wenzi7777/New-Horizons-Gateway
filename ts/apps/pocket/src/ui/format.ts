// Formatting shared by the screens: sizes, durations, times, day groups.
// Pure functions; locale-dependent parts take the BCP 47 tag.

import type { Locale } from '@nhgw/ui-tokens';

/** Bytes as "512 B", "1.2 KB", "34 MB", "1.05 GB" (SI units, as Android shows storage). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = value < 10 ? 2 : value < 100 ? 1 : 0;
  const text = digits > 0 ? value.toFixed(digits).replace(/\.?0+$/, '') : value.toFixed(0);
  return `${text} ${units[unit]}`;
}

/** A duration as a clock: "0:07", "12:05", "1:02:03". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** A pressure value for display (no decimals above 100). */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return Math.abs(value) >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

/** Local calendar day of a timestamp, "YYYY-MM-DD" (the grouping key of the recordings list). */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "today" / "yesterday" relative to `now`, else null (the caller formats the date). */
export function relativeDay(ms: number, now: number): 'today' | 'yesterday' | null {
  const key = dayKey(ms);
  if (key === dayKey(now)) return 'today';
  const n = new Date(now);
  const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1, 12).getTime();
  return key === dayKey(yesterday) ? 'yesterday' : null;
}

export function formatTime(ms: number, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toTimeString().slice(0, 5);
  }
}

export function formatDate(ms: number, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' }).format(new Date(ms));
  } catch {
    return dayKey(ms);
  }
}

export function formatDateTime(ms: number, locale: Locale): string {
  return `${formatDate(ms, locale)} ${formatTime(ms, locale)}`;
}

export type DayGroup<T> = { key: string; startMs: number; items: T[] };

/** Items grouped by local day, newest day first, newest item first within a day. */
export function groupByDay<T>(items: readonly T[], at: (item: T) => number): DayGroup<T>[] {
  const groups = new Map<string, DayGroup<T>>();
  for (const item of [...items].sort((a, b) => at(b) - at(a))) {
    const key = dayKey(at(item));
    let group = groups.get(key);
    if (!group) {
      group = { key, startMs: at(item), items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

/** Max and mean of a frame's values (0 for an empty frame). */
export function frameStats(values: readonly number[]): { max: number; mean: number } {
  if (values.length === 0) return { max: 0, mean: 0 };
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v > max) max = v;
    sum += v;
  }
  return { max, mean: sum / values.length };
}

/** Pocket/Gateway ID rule: letters, digits, dot, dash, underscore; 1..64. */
export function isValidPocketId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(id);
}

export function isValidServerUrl(url: string): boolean {
  return /^wss?:\/\/[^\s/]+/.test(url.trim());
}
