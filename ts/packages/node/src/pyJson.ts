// JSON text exactly as the Python Gateway wrote it, so files and HTTP bodies
// stay byte-compatible with what it produced:
//  - files: json.dump(value, indent=2, sort_keys=True, ensure_ascii=False)
//    (config_store.py), or ensure_ascii=True (console_runtime.py);
//  - HTTP: Flask's jsonify (sort_keys=True, ensure_ascii=True, compact
//    separators, trailing newline).
// JS has one number type, so a float that happens to be whole (16.0) would
// come out as 16; keys listed in `floatKeys` keep Python's "16.0".

export interface PyJsonOptions {
  /** Pretty-print with this many spaces (Python indent=); compact when omitted. */
  indent?: number;
  sortKeys?: boolean;
  /** Escape every non-ASCII character as \uXXXX (Python's default). */
  ensureAscii?: boolean;
  /** Object keys whose whole-number values are Python floats ("16.0"). */
  floatKeys?: ReadonlySet<string>;
}

/** Python sorts str keys by code point; JS sorts by UTF-16 code unit. */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const x = left[i]!.codePointAt(0)!;
    const y = right[i]!.codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return left.length - right.length;
}

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

function hex4(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

export function pyJsonString(text: string, ensureAscii: boolean): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code = text.charCodeAt(i);
    const short = SHORT_ESCAPES[ch];
    if (short !== undefined) out += short;
    else if (code < 0x20) out += hex4(code);
    // ensure_ascii escapes everything outside ' '..'~' (UTF-16 units, as Python does for astral chars).
    else if (ensureAscii && code > 0x7e) out += hex4(code);
    else out += ch;
  }
  return `${out}"`;
}

function pyNumber(value: number, asFloat: boolean): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (asFloat && Number.isInteger(value)) return `${value}.0`;
  return String(value);
}

export function pyJsonDumps(value: unknown, options: PyJsonOptions = {}): string {
  const indent = options.indent;
  const ensureAscii = options.ensureAscii ?? true;
  const floatKeys = options.floatKeys ?? new Set<string>();
  const itemSep = ',';
  const keySep = indent === undefined ? ':' : ': ';

  const encode = (item: unknown, depth: number, asFloat: boolean): string => {
    if (item === null || item === undefined) return 'null';
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') return pyNumber(item, asFloat);
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'string') return pyJsonString(item, ensureAscii);
    const open = (text: string[], start: string, end: string): string => {
      if (text.length === 0) return start + end;
      if (indent === undefined) return start + text.join(itemSep) + end;
      const pad = '\n' + ' '.repeat(indent * (depth + 1));
      return start + pad + text.join(itemSep + pad) + '\n' + ' '.repeat(indent * depth) + end;
    };
    if (Array.isArray(item)) return open(item.map((entry) => encode(entry, depth + 1, false)), '[', ']');
    if (typeof item === 'object') {
      const record = item as Record<string, unknown>;
      let keys = Object.keys(record).filter((key) => record[key] !== undefined);
      if (options.sortKeys) keys = keys.sort(compareCodePoints);
      return open(
        keys.map((key) => pyJsonString(key, ensureAscii) + keySep + encode(record[key], depth + 1, floatKeys.has(key))),
        '{',
        '}',
      );
    }
    return pyJsonString(String(item), ensureAscii);
  };
  return encode(value, 0, false);
}

/** The Gateway config's float-valued keys (config_store.DEFAULT_CONFIG). */
export const CONFIG_FLOAT_KEYS: ReadonlySet<string> = new Set(['control_stale_sec']);
