// Small Python-semantics helpers the runtime modules share. The Python
// Gateway built its dicts with `a or b`, `d.get(k, default)` and
// json.dumps(separators=(",", ":")); the Backend and the web UI read the
// results, so the TS port reproduces those idioms rather than JS's.
// Internal: not exported from runtime/index.ts.
import { isPlainObject, pyStr, pyStrip, pyTruthy } from '../py';

export type Dict = Record<string, unknown>;

/** Python `a or b or ...`: the first truthy value, else the last one. */
export function pyOr(...values: unknown[]): unknown {
  for (const value of values) if (pyTruthy(value)) return value;
  return values[values.length - 1];
}

/** Python `d.get(key, fallback)`: only a missing key falls back (an explicit null does not). */
export function pyGet(d: Dict, key: string, fallback: unknown = undefined): unknown {
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : fallback;
}

/** Python `d.setdefault(key, value)`. */
export function setDefault(d: Dict, key: string, value: unknown): void {
  if (!Object.prototype.hasOwnProperty.call(d, key)) d[key] = value;
}

/** `str(value or "")`. */
export function strOr(value: unknown): string {
  return pyTruthy(value) ? pyStr(value) : '';
}

/** `str(value or "").strip().upper()`: how state/discovery/operations key a device. */
export function upperUid(value: unknown): string {
  return pyStrip(strOr(value)).toUpperCase();
}

/** `value if isinstance(value, dict) else {}`. */
export function dictOr(value: unknown): Dict {
  return isPlainObject(value) ? value : {};
}

/**
 * datetime.now(timezone.utc).isoformat(): "2026-11-09T01:02:03.456000+00:00",
 * with the fraction omitted when it is zero, as Python does. Claims are
 * sorted by this string, so the format must stay fixed-width otherwise.
 */
export function utcIsoFormat(epochMs: number): string {
  const ms = Math.floor(epochMs);
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const base =
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const micros = d.getUTCMilliseconds() * 1000;
  return `${base}${micros ? `.${pad(micros, 6)}` : ''}+00:00`;
}

/**
 * json.dumps(value, separators=(",", ":")) -- insertion order (no sort_keys)
 * and ensure_ascii escapes, so device-bound frames match the Python bytes.
 */
export function pyJsonDumpsCompact(value: unknown): string {
  return dumps(value).replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function dumps(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(dumps).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${dumps(value[key])}`).join(',')}}`;
  }
  throw new Error(`Object of type ${typeof value} is not JSON serializable`);
}

/** uuid.uuid4().hex. Uses the platform CSPRNG when there is one (Node, modern Hermes). */
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

/** bytes.lstrip().startswith(b"{"): bytes.lstrip strips ASCII whitespace only. */
export function looksLikeJson(payload: Uint8Array): boolean {
  for (const b of payload) {
    if (b === 0x20 || (b >= 0x09 && b <= 0x0d)) continue;
    return b === 0x7b;
  }
  return false;
}
