// JSON and value semantics as Python has them, for files that must match the
// Desktop backend's byte for byte.
//
// JS has one number type; Python has int and float, and prints them
// differently (1 vs 1.0). Here a plain JS number prints as an int when it is
// integral and as a float otherwise; a value that is a Python float however
// it looks is wrapped in PyFloat. parsePyJson() reads JSON text the way
// json.loads() does, wrapping every literal with a fraction or exponent, so a
// device's `"scale": 1.0` survives the round trip.
import { pyInt as coreInt, pyStr as coreStr, pyTruthy as coreTruthy } from '../../../core/src/py';
import { pyFloatRepr, pyIntRepr } from './pyNumber';

/** A Python float, even when integral (prints as "1.0"). Immutable. */
export class PyFloat {
  constructor(readonly value: number) {}
  valueOf(): number {
    return this.value;
  }
  toJSON(): number {
    return this.value;
  }
}

export const pyFloat = (value: number): PyFloat => new PyFloat(value);

/** The number in a plain number or a PyFloat; otherwise null. */
export function numericValue(value: unknown): number | null {
  if (value instanceof PyFloat) return value.value;
  if (typeof value === 'number') return value;
  return null;
}

/** Whether a value is a Python float under this module's convention. */
export function isPyFloat(value: unknown): boolean {
  return value instanceof PyFloat || (typeof value === 'number' && !Number.isInteger(value));
}

export function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof PyFloat);
}

/** copy.deepcopy for JSON-shaped values (PyFloat is immutable and shared). */
export function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(deepCopy) as T;
  if (isDict(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepCopy(item);
    return out as T;
  }
  return value;
}

/** Python `==` for JSON-shaped values (True == 1 == 1.0; dicts by content). */
export function pyEquals(a: unknown, b: unknown): boolean {
  const toNum = (v: unknown): number | null => (typeof v === 'boolean' ? (v ? 1 : 0) : numericValue(v));
  const x = toNum(a);
  const y = toNum(b);
  if (x !== null || y !== null) return x !== null && y !== null && x === y;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => pyEquals(item, b[index]));
  }
  if (isDict(a) && isDict(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => key in b && pyEquals(a[key], b[key]));
  }
  return false;
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

function jsonString(text: string, ensureAscii: boolean): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code = text.charCodeAt(i);
    const short = SHORT_ESCAPES[ch];
    if (short !== undefined) out += short;
    else if (code < 0x20 || (ensureAscii && code > 0x7e)) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function jsonFloat(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return pyFloatRepr(value);
}

export type PyJsonOptions = {
  /** json.dumps(indent=...); compact separators (",", ":") when omitted, unless `separators` says otherwise. */
  indent?: number;
  /** Python's default is true. */
  ensureAscii?: boolean;
  sortKeys?: boolean;
  /** [item, key] separators; default ", "/": " like Python, or ","/": " with indent. */
  separators?: [string, string];
};

/** Python's code-point order for str keys. */
function compareCodePoints(a: string, b: string): number {
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

/** json.dumps(value, ...) with Python's int/float distinction (see PyFloat). */
export function pyJsonDumps(value: unknown, options: PyJsonOptions = {}): string {
  const ensureAscii = options.ensureAscii ?? true;
  const indent = options.indent;
  const [itemSep, keySep] = options.separators ?? (indent === undefined ? [', ', ': '] : [',', ': ']);
  const encode = (item: unknown, depth: number): string => {
    if (item === null || item === undefined) return 'null';
    if (item === true) return 'true';
    if (item === false) return 'false';
    if (item instanceof PyFloat) return jsonFloat(item.value);
    if (typeof item === 'number') return Number.isInteger(item) ? pyIntRepr(item) : jsonFloat(item);
    if (typeof item === 'string') return jsonString(item, ensureAscii);
    const open = (inner: string[], l: string, r: string): string => {
      if (inner.length === 0) return `${l}${r}`;
      if (indent === undefined) return `${l}${inner.join(itemSep)}${r}`;
      const pad = '\n' + ' '.repeat(indent * (depth + 1));
      return `${l}${pad}${inner.join(itemSep + pad)}\n${' '.repeat(indent * depth)}${r}`;
    };
    if (Array.isArray(item)) return open(item.map((entry) => encode(entry, depth + 1)), '[', ']');
    if (isDict(item)) {
      let keys = Object.keys(item).filter((key) => item[key] !== undefined);
      if (options.sortKeys) keys = keys.sort(compareCodePoints);
      return open(
        keys.map((key) => `${jsonString(key, ensureAscii)}${keySep}${encode(item[key], depth + 1)}`),
        '{',
        '}',
      );
    }
    throw new Error(`Object of type ${typeof item} is not JSON serializable`);
  };
  return encode(value, 0);
}

/**
 * json.loads(text), keeping Python's int/float distinction: numbers written
 * with a fraction or exponent (and NaN/Infinity) come back as PyFloat.
 */
export function parsePyJson(text: string): unknown {
  let i = 0;
  const fail = (): never => {
    throw new SyntaxError(`invalid JSON at ${i}`);
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const literal = (word: string, value: unknown): unknown => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return value;
    }
    return fail();
  };
  const parseValue = (): unknown => {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++;
      const out: Record<string, unknown> = {};
      ws();
      if (text[i] === '}') {
        i++;
        return out;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const key = parseString();
        ws();
        if (text[i] !== ':') fail();
        i++;
        out[key] = parseValue();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return out;
        }
        fail();
      }
    }
    if (ch === '[') {
      i++;
      const out: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return out;
      }
      for (;;) {
        out.push(parseValue());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return out;
        }
        fail();
      }
    }
    if (ch === '"') return parseString();
    if (ch === 't') return literal('true', true);
    if (ch === 'f') return literal('false', false);
    if (ch === 'n') return literal('null', null);
    if (ch === 'N') return literal('NaN', new PyFloat(NaN));
    if (ch === 'I') return literal('Infinity', new PyFloat(Infinity));
    if (ch === '-' && text.startsWith('-Infinity', i)) return literal('-Infinity', new PyFloat(-Infinity));
    const match = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/.exec(text.slice(i, i + 400));
    if (!match) return fail();
    i += match[0].length;
    const number = Number(match[0]);
    return match[1] !== undefined || match[2] !== undefined ? new PyFloat(number) : number;
  };
  const parseString = (): string => {
    // Delegate escapes to JSON.parse on the exact string token.
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail();
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = parseValue();
  ws();
  if (i !== text.length) fail();
  return value;
}

// ── Python built-ins over values that may hold PyFloat ─────────────────────
// (core's py.ts helpers see a PyFloat as an object.)

const unwrap = (value: unknown): unknown => (value instanceof PyFloat ? value.value : value);

/** Python truthiness. */
export function pyTruthyOf(value: unknown): boolean {
  return coreTruthy(unwrap(value));
}

/** Python str(). */
export function pyStrOf(value: unknown): string {
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  if (typeof value === 'number') return Number.isInteger(value) ? pyIntRepr(value) : pyFloatRepr(value);
  return coreStr(value);
}

/** Python int(): throws where Python raises. */
export function pyIntOf(value: unknown): number {
  return coreInt(unwrap(value));
}

/** `str(value or "")`, the idiom the backend uses everywhere. */
export function pyStrOr(value: unknown): string {
  return pyTruthyOf(value) ? pyStrOf(value) : '';
}
