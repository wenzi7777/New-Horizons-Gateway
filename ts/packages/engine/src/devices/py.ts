// Python idioms the Desktop service was written in (`a or b`, `str(x or "")`,
// `int(x or 0)` under try, `isinstance(x, dict)`), so the port keeps its
// semantics. Python's None is null or undefined here. Device JSON is read
// with parsePyJson, so a Python float may be a PyFloat (a number that prints
// as 1.0): every helper here treats it as the number it is. Internal to devices/.
import { PyFloat } from '../parse/pyJson';
import { pyFloatRepr } from '../parse/pyNumber';

export type Dict = Record<string, unknown>;

/** Python truthiness. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (typeof value === 'number' && Number.isNaN(value)) return true;
  if (value instanceof PyFloat) return value.value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return true;
}

export function isDict(value: unknown): value is Dict {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof PyFloat)
  );
}

/** `value if isinstance(value, dict) else {}`. */
export function dictOr(value: unknown): Dict {
  return isDict(value) ? value : {};
}

/** Python `str(value)` for the values JSON can hold. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  return JSON.stringify(value);
}

/** `str(value or "")`. */
export function strOr(value: unknown): string {
  return truthy(value) ? pyStr(value) : '';
}

/** Python `a or b or ...`: the first truthy value, else the last one. */
export function or(...values: unknown[]): unknown {
  for (const value of values) if (truthy(value)) return value;
  return values[values.length - 1];
}

/** `d.get(key, fallback)`: only a missing key falls back. */
export function get(d: Dict, key: string, fallback: unknown = undefined): unknown {
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : fallback;
}

export function has(d: Dict, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(d, key);
}

export function setDefault(d: Dict, key: string, value: unknown): void {
  if (!has(d, key)) d[key] = value;
}

/** `int(value or 0)` inside try/except (TypeError, ValueError): `fallback` when it would raise. */
export function toInt(value: unknown, fallback = 0): number {
  if (!truthy(value)) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof PyFloat) return Number.isFinite(value.value) ? Math.trunc(value.value) : fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) return parseInt(value, 10);
  return fallback;
}

/** Python `x is None`. */
export function isNone(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** Shallow copy (Python `dict(d)`). */
export function copy<T extends Dict>(d: T): T {
  return { ...d };
}

/** Python's `json` key order is insertion order; sorted() on str keys is code-point order. */
export function sortedKeys(d: Dict): string[] {
  return Object.keys(d).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * datetime.fromisoformat for the stamps the service writes and reads
 * ("2026-11-09T01:02:03.456000+00:00", optional fraction, "Z", or no zone =
 * UTC). Returns epoch ms, or null when it does not parse.
 */
export function parseIsoMs(value: unknown): number | null {
  const text = strOr(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  if (frac) ms += Number(frac.padEnd(6, '0')) / 1000;
  if (zone && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
  }
  return Number.isNaN(ms) ? null : ms;
}

/** uuid4().hex, from the platform CSPRNG when there is one. */
export function randomHex32(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** A number, or the number in a PyFloat; null otherwise. */
export function num(value: unknown): number | null {
  if (value instanceof PyFloat) return value.value;
  return typeof value === 'number' ? value : null;
}

/** The value with every PyFloat replaced by its number (for a UI that wants plain JSON values). */
export function plainJson<T>(value: T): T {
  if (value instanceof PyFloat) return value.value as T;
  if (Array.isArray(value)) return value.map(plainJson) as T;
  if (isDict(value)) {
    const out: Dict = {};
    for (const [key, item] of Object.entries(value)) out[key] = plainJson(item);
    return out as T;
  }
  return value;
}
