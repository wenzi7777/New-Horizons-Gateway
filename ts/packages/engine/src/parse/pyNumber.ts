// Python float semantics the recording files depend on, reproduced exactly:
//
// - round(x, n): CPython rounds the float's *exact binary value* to n decimals
//   (dtoa mode 3, ties to even) and reads that decimal back as the nearest
//   double. Not Math.round(x * 10**n) / 10**n, which differs on ties and on
//   values whose product rounds across .5.
// - round(x): ties to even, returning an int.
// - repr(float) / str(float): the shortest round-trip digits (same digits JS
//   picks), but laid out the Python way: '1.0', '1e-05', '1e+16', 'nan'.
// - int / int true division: correctly rounded from the exact quotient, even
//   when the operands exceed 2**53.
//
// Pure arithmetic: runs the same on Node and Hermes (BigInt only on the rare
// slow paths).

const TWO_52 = 2 ** 52;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

/**
 * The double nearest to num/den (both positive), ties to even. Exact for any
 * result in the normal range; the recording code never produces subnormals.
 */
export function ratioToDouble(num: bigint, den: bigint): number {
  if (num === 0n) return 0;
  const shift = 55 - (bitLength(num) - bitLength(den)); // quotient lands in [2^54, 2^56)
  let n = num;
  let d = den;
  if (shift >= 0) n <<= BigInt(shift);
  else d <<= BigInt(-shift);
  const q = n / d;
  const rem = n % d;
  const extra = bitLength(q) - 53;
  const low = q & ((1n << BigInt(extra)) - 1n);
  const half = 1n << BigInt(extra - 1);
  let m = q >> BigInt(extra);
  if (low > half || (low === half && (rem !== 0n || (m & 1n) === 1n))) m += 1n;
  let exponent = extra - shift;
  let result = Number(m);
  // Split the scaling so 2**exponent never overflows/underflows on its own.
  while (exponent > 1000) {
    result *= 2 ** 1000;
    exponent -= 1000;
  }
  while (exponent < -1000) {
    result *= 2 ** -1000;
    exponent += 1000;
  }
  return result * 2 ** exponent;
}

/** A finite double as exact mantissa * 2**exponent (mantissa >= 0). */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biased === 0) return { mantissa: frac, exponent: -1074 };
  return { mantissa: frac | (1n << 52n), exponent: biased - 1075 };
}

/** Python round(x, ndigits) for a float and ndigits >= 0. */
export function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const negative = x < 0;
  const ax = Math.abs(x);
  if (Number.isInteger(ax)) return x;
  const scale = 10 ** ndigits;
  const y = ax * scale;
  let magnitude: number | null = null;
  if (ndigits <= 22 && y < TWO_52) {
    // y is within half an ulp of the exact product; only a fraction that
    // close to .5 needs the exact arithmetic.
    const floor = Math.floor(y);
    const frac = y - floor;
    const tolerance = Math.max(y, 1) * 2 ** -50;
    if (Math.abs(frac - 0.5) > tolerance) {
      const q = frac < 0.5 ? floor : floor + 1;
      magnitude = q / scale; // q and scale exact: one correctly rounded division
    }
  }
  if (magnitude === null) {
    const { mantissa, exponent } = decompose(ax);
    const pow = 10n ** BigInt(ndigits);
    // exponent < 0 here: ax is not an integer.
    const num = mantissa * pow;
    const den = 1n << BigInt(-exponent);
    let q = num / den;
    const twice = (num % den) * 2n;
    if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
    magnitude = ndigits <= 22 && q <= BigInt(MAX_SAFE) ? Number(q) / scale : ratioToDouble(q, pow);
  }
  return negative ? -magnitude : magnitude;
}

/** Python round(x) on a float: nearest int, ties to even. */
export function pyRoundInt(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor; // exact for every double
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor === 0 ? 0 : floor; // never -0: Python ints have no sign of zero
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python repr()/str() of a float. */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  // toExponential() without an argument gives the shortest round-trip digits.
  const [mantissa, exp] = Math.abs(x).toExponential().split('e') as [string, string];
  const digits = mantissa.replace('.', '');
  const decpt = Number(exp) + 1; // value = 0.<digits> * 10**decpt
  if (decpt <= -4 || decpt > 16) {
    const e = decpt - 1;
    const body = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const eAbs = String(Math.abs(e)).padStart(2, '0');
    return `${sign}${body}e${e < 0 ? '-' : '+'}${eAbs}`;
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

/** Python str() of an int held in a double (no '-0'). */
export function pyIntRepr(x: number): string {
  if (x === 0) return '0';
  if (Math.abs(x) <= MAX_SAFE) return String(x);
  return BigInt(x).toString();
}

/** Python `a / b` for ints: the exact quotient, correctly rounded. */
export function pyTrueDivInt(a: number | bigint, b: number | bigint): number {
  if (typeof a === 'number' && typeof b === 'number' && Math.abs(a) <= MAX_SAFE && Math.abs(b) <= MAX_SAFE) {
    return a / b;
  }
  const num = BigInt(a);
  const den = BigInt(b);
  if (den === 0n) throw new Error('division by zero');
  const negative = num < 0n !== den < 0n;
  const magnitude = ratioToDouble(num < 0n ? -num : num, den < 0n ? -den : den);
  return negative ? -magnitude : magnitude;
}
