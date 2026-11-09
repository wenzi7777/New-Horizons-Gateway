// Byte helpers that work the same on Node and Hermes (no Buffer, and no
// reliance on TextDecoder, which Hermes does not guarantee).

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '==';
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=';
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    buffer = (buffer << 6) | B64_LOOKUP[clean.charCodeAt(i)]!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      c = 0;
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 decode; invalid sequences become U+FFFD instead of throwing. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    let cp = 0xfffd;
    let len = 1;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b < 0xe0) len = 2;
    else if (b >= 0xe0 && b < 0xf0) len = 3;
    else if (b >= 0xf0 && b < 0xf5) len = 4;
    if (len > 1) {
      if (i + len > bytes.length) {
        len = 1;
      } else {
        cp = b & (0xff >> (len + 1));
        for (let k = 1; k < len; k++) {
          const cb = bytes[i + k]!;
          if ((cb & 0xc0) !== 0x80) {
            cp = 0xfffd;
            len = k;
            break;
          }
          cp = (cp << 6) | (cb & 63);
        }
      }
    }
    // F4 90..BF decodes past U+10FFFF, where fromCodePoint throws.
    out += String.fromCodePoint(cp > 0x10ffff ? 0xfffd : cp);
    i += len;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out.toUpperCase();
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Compact JSON as UTF-8, the encoding every device frame uses. */
export function jsonBytes(value: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(value));
}
