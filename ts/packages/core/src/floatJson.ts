// JSON that keeps Python's int/float distinction through the relay. The
// Python Gateway forwarded device frames as json.dumps(json.loads(frame)), so
// a device's `"scale": 1.0` reached the Backend as 1.0 (a float) and `1e16`
// as 1e+16; JSON.parse + JSON.stringify turned both into ints. Control
// frames are read with parseJsonKeepFloats (every literal with a fraction or
// exponent becomes a JsonFloat) and the upstream link writes them back with
// stringifyKeepFloats, which prints a JsonFloat as Python's repr() does.
// Python's NaN / Infinity / -Infinity literals are accepted too.

/** A Python float, even when integral. Reads as a number (valueOf/toJSON). */
export class JsonFloat {
  constructor(readonly value: number) {}
  valueOf(): number {
    return this.value;
  }
  toJSON(): number {
    return this.value;
  }
}

const MARK = '\u0000pyf:';

/** float.__repr__ (json.dumps writes NaN / Infinity / -Infinity for the non-finite ones). */
export function pyFloatJsonRepr(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  const [mantissa, exp] = Math.abs(x).toExponential().split('e') as [string, string];
  const digits = mantissa.replace('.', '');
  const decpt = Number(exp) + 1;
  if (decpt <= -4 || decpt > 16) {
    const e = decpt - 1;
    const body = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${body}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

/**
 * json.loads with floats kept: float literals become JsonFloat, NaN /
 * Infinity / -Infinity are accepted. Throws SyntaxError like JSON.parse.
 */
export function parseJsonKeepFloats(text: string): unknown {
  let out = '';
  let last = 0;
  let floats = false;
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === '"') {
      // Skip the string (escapes included).
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    let literal: string | null = null;
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (m && (m[1] !== undefined || m[2] !== undefined)) {
        literal = m[0];
      } else if (text.startsWith('-Infinity', i)) {
        literal = '-Infinity';
      } else if (m) {
        i += m[0].length;
        continue;
      }
    } else if (text.startsWith('NaN', i)) {
      literal = 'NaN';
    } else if (text.startsWith('Infinity', i)) {
      literal = 'Infinity';
    }
    if (literal === null) {
      i++;
      continue;
    }
    out += `${text.slice(last, i)}"\\u0000pyf:${literal}"`;
    i += literal.length;
    last = i;
    floats = true;
  }
  if (!floats) return JSON.parse(text);
  out += text.slice(last);
  return JSON.parse(out, (_key, v) => (typeof v === 'string' && v.startsWith(MARK) ? new JsonFloat(Number(v.slice(MARK.length))) : v));
}

/** JSON.stringify, except that a JsonFloat is written as Python wrote the float. */
export function stringifyKeepFloats(value: unknown): string {
  let floats = false;
  const text = JSON.stringify(value, function (this: unknown, key: string, v: unknown) {
    const raw = (this as Record<string, unknown>)[key];
    if (raw instanceof JsonFloat) {
      floats = true;
      return `${MARK}${pyFloatJsonRepr(raw.value)}`;
    }
    return v;
  });
  if (!floats) return text;
  return text.replace(/"\\u0000pyf:([^"\\]*)"/g, '$1');
}
