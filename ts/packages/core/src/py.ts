// Python built-in semantics the ported modules lean on (str(), int(),
// float(), truthiness, str.strip(), sorted() of str). Config files and device
// frames are untyped JSON, and the Python Gateway coerced them with these
// built-ins, so an old config.json or an odd frame must come out the same.
// Internal: not exported from index.ts.

/** The characters Python's str.strip()/str.isspace() treat as whitespace. */
const PY_WS = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
export const PY_WS_CLASS = `[${PY_WS}]`;
const STRIP_RE = new RegExp(`^${PY_WS_CLASS}+|${PY_WS_CLASS}+$`, 'g');

export function pyStrip(text: string): string {
  return text.replace(STRIP_RE, '');
}

/** Python truthiness for JSON-shaped values. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0; // NaN is truthy in Python too
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * Python str() for JSON-shaped values. Only what callers observe matters:
 * scalars come out exactly as Python prints them (None, True, ints); lists and
 * dicts come out non-empty and never match an identifier pattern, as in Python.
 */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (value === Infinity) return 'inf';
    if (value === -Infinity) return '-inf';
    return String(value);
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `[${value.map((item) => pyRepr(item)).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`)
      .join(', ')}}`;
  }
  return String(value);
}

function pyRepr(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : pyStr(value);
}

const INT_RE = new RegExp(`^${PY_WS_CLASS}*[+-]?[0-9]+(?:_[0-9]+)*${PY_WS_CLASS}*$`);
const FLOAT_RE = new RegExp(
  `^${PY_WS_CLASS}*[+-]?(?:(?:[0-9]+(?:_[0-9]+)*(?:\\.(?:[0-9]+(?:_[0-9]+)*)?)?|\\.[0-9]+(?:_[0-9]+)*)(?:[eE][+-]?[0-9]+(?:_[0-9]+)*)?|inf|infinity|nan)${PY_WS_CLASS}*$`,
  'i',
);

/** Python int(value): truncates numbers, parses integer strings, else throws (ValueError/TypeError). */
export function pyInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot convert float ${pyStr(value)} to integer`);
    return Math.trunc(value);
  }
  if (typeof value === 'string' && INT_RE.test(value)) return parseInt(pyStrip(value).replace(/_/g, ''), 10);
  throw new Error(`invalid literal for int(): ${pyStr(value)}`);
}

/** Python float(value): numbers, bools and numeric strings (incl. inf/nan), else throws. */
export function pyFloat(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && FLOAT_RE.test(value)) {
    const text = pyStrip(value).replace(/_/g, '').toLowerCase();
    const sign = text.startsWith('-') ? -1 : 1;
    const body = text.replace(/^[+-]/, '');
    if (body === 'inf' || body === 'infinity') return sign * Infinity;
    if (body === 'nan') return NaN;
    return Number(text);
  }
  throw new Error(`could not convert to float: ${pyStr(value)}`);
}

/** Python's str ordering (by code point; JS `<` compares UTF-16 code units). */
export function pyCompareStr(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const x = left[i]!.codePointAt(0)!;
    const y = right[i]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * json.dumps(value, separators=(",", ":"), sort_keys=True): keys sorted at
 * every level, ensure_ascii's \uXXXX escapes (everything outside 0x20-0x7E)
 * and NaN/Infinity written as Python writes them, so the bytes match what the
 * Python Gateway sent. Hand-rolled because JS objects always enumerate
 * integer-like keys first, which would break the sort order.
 */
export function pyJsonDumpsCompactSorted(value: unknown): string {
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
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(pyCompareStr);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${dumps(value[key])}`).join(',')}}`;
  }
  throw new Error(`Object of type ${typeof value} is not JSON serializable`);
}
