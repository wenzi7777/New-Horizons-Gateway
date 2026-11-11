// Decoding a file read in slices. The slices cut at arbitrary byte offsets, so one may end inside a
// multi-byte character. TextDecoder's `stream` option would handle that, but Hermes (React Native)
// does not support it; this keeps the unfinished tail bytes for the next slice instead.

/** How many leading bytes of `bytes` hold only complete UTF-8 characters. */
export function completeUtf8Length(bytes: Uint8Array): number {
  const n = bytes.length;
  // Look back at most 3 bytes for the start of a character that has not ended.
  for (let back = 1; back <= Math.min(3, n); back += 1) {
    const b = bytes[n - back]!;
    if ((b & 0xc0) === 0x80) continue; // a continuation byte: keep looking for its lead byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? n - back : n;
  }
  return n;
}

export class Utf8StreamDecoder {
  private tail: Uint8Array = new Uint8Array(0);
  private readonly decoder = new TextDecoder('utf-8');

  /** The text of everything pushed so far that is complete; call `flush()` after the last slice. */
  push(bytes: Uint8Array): string {
    let joined = bytes;
    if (this.tail.length > 0) {
      joined = new Uint8Array(this.tail.length + bytes.length);
      joined.set(this.tail, 0);
      joined.set(bytes, this.tail.length);
    }
    const end = completeUtf8Length(joined);
    this.tail = joined.slice(end);
    return end > 0 ? this.decoder.decode(joined.subarray(0, end)) : '';
  }

  flush(): string {
    const rest = this.tail;
    this.tail = new Uint8Array(0);
    return rest.length > 0 ? this.decoder.decode(rest) : '';
  }
}
