import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, utf8Decode, utf8Encode } from '../src/bytes';

describe('bytes', () => {
  it('base64 round-trips every length and matches Node', () => {
    for (let n = 0; n < 70; n++) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const b64 = bytesToBase64(data);
      expect(b64).toBe(Buffer.from(data).toString('base64'));
      expect([...base64ToBytes(b64)]).toEqual([...data]);
    }
  });

  it('utf-8 matches Node for ASCII, CJK and emoji', () => {
    for (const text of ['{"type":"hello"}', '研究室 テスト', '😀 ok', '']) {
      expect([...utf8Encode(text)]).toEqual([...Buffer.from(text, 'utf-8')]);
      expect(utf8Decode(Buffer.from(text, 'utf-8'))).toBe(text);
    }
  });

  it('utf-8 decode replaces invalid bytes instead of throwing', () => {
    expect(utf8Decode(Uint8Array.from([0x41, 0xff, 0x42]))).toBe('A�B');
    expect(utf8Decode(Uint8Array.from([0xe3, 0x81]))).toBe('��');
    expect(utf8Decode(Uint8Array.from([0xf4, 0x90, 0x80, 0x80]))).toBe('�');
  });

  it('hex is uppercase and round-trips', () => {
    expect(bytesToHex(Uint8Array.from([0x0a, 0xbc]))).toBe('0ABC');
    expect([...hexToBytes('0abc')]).toEqual([0x0a, 0xbc]);
  });
});
