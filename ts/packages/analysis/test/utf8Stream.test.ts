import { describe, expect, it } from 'vitest';

import { completeUtf8Length, Utf8StreamDecoder } from '../src/utf8Stream';

describe('Utf8StreamDecoder', () => {
  const text = 'time,label\n1,按下 button あ 😀\n2,終わり\n';
  const bytes = new TextEncoder().encode(text);

  it('decodes to the same text whatever the slice size', () => {
    for (const size of [1, 2, 3, 4, 5, 7, 64]) {
      const decoder = new Utf8StreamDecoder();
      let out = '';
      for (let i = 0; i < bytes.length; i += size) out += decoder.push(bytes.subarray(i, i + size));
      out += decoder.flush();
      expect(out, `slice ${size}`).toBe(text);
    }
  });

  it('holds back an unfinished character only', () => {
    const smile = new TextEncoder().encode('a😀'); // 1 + 4 bytes
    expect(completeUtf8Length(smile)).toBe(5);
    expect(completeUtf8Length(smile.subarray(0, 4))).toBe(1);
    expect(completeUtf8Length(smile.subarray(0, 2))).toBe(1);
    expect(completeUtf8Length(new Uint8Array(0))).toBe(0);
  });
});
