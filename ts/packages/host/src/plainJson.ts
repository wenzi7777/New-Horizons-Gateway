// Engine records keep Python's int/float distinction by wrapping floats in
// PyFloat (and may hold undefined); the UI gets plain JSON values.
import { PyFloat } from '@nhgw/engine';

/** A deep copy with every PyFloat unwrapped, undefined fields dropped and non-finite numbers as null. */
export function plainJson(value: unknown): unknown {
  if (value instanceof PyFloat) return Number.isFinite(value.value) ? value.value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : plainJson(item)));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined || typeof item === 'function') continue;
      out[key] = plainJson(item);
    }
    return out;
  }
  return null;
}

/** A number from a plain number or a PyFloat; null otherwise. */
export function num(value: unknown): number | null {
  if (value instanceof PyFloat) return Number.isFinite(value.value) ? value.value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function dict(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof PyFloat)
    ? (value as Record<string, unknown>)
    : {};
}
