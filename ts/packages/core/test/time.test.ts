import { describe, expect, it } from 'vitest';

import { looseDeviceUid } from '../src/protocol';
import { MIN_VALID_EPOCH_US, buildTimeResponse, isTimeRequest } from '../src/time';
import { TIME_RESP_LEN } from '../src/wire';

const EPOCH_US = 1_760_000_000 * 1_000_000;

// Byte for byte what the firmware's encodeEspNowTimeRequest() emits:
// magic 0xE8, version 1, seq, flags 0, t1 (int64 little-endian).
function timeRequest(seq: number, t1: number | bigint): Uint8Array {
  const out = new Uint8Array(12);
  out.set([0xe8, 1, seq, 0]);
  new DataView(out.buffer).setBigInt64(4, BigInt(t1), true);
  return out;
}

const i64 = (bytes: Uint8Array, offset: number) =>
  Number(new DataView(bytes.buffer, bytes.byteOffset).getBigInt64(offset, true));

describe('time service', () => {
  it('reply layout matches the firmware', () => {
    const reply = buildTimeResponse(timeRequest(7, 123456789), EPOCH_US + 1000, () => EPOCH_US + 1300)!;
    expect(reply.length).toBe(TIME_RESP_LEN);
    // Offsets from EspNowTimeWire.h: magic, version, seq, flags, t1@4, t2@12, t3@20, uncertainty_ms@28, reserved@30.
    expect(reply[0]).toBe(0xe9);
    expect(reply[1]).toBe(1);
    expect(reply[2]).toBe(7);
    expect(reply[3]).toBe(0x01 | (1 << 4));
    expect(i64(reply, 4)).toBe(123456789);
    expect(i64(reply, 12)).toBe(EPOCH_US + 1000);
    expect(i64(reply, 20)).toBe(EPOCH_US + 1300);
    expect([...reply.subarray(28)]).toEqual([0, 0, 0, 0]);
  });

  it('lets the device recover the Gateway time', () => {
    const t1 = 10_000_000;
    const t2 = EPOCH_US + t1 + 2000;
    const reply = buildTimeResponse(timeRequest(1, t1), t2, () => t2 + 400)!;
    const echoed = i64(reply, 4);
    const rt2 = i64(reply, 12);
    const rt3 = i64(reply, 20);
    const t4 = rt3 - EPOCH_US + 2000;
    expect(Math.floor((rt2 - echoed + (rt3 - t4)) / 2)).toBe(EPOCH_US);
    expect(t4 - echoed - (rt3 - rt2)).toBe(4000);
  });

  it('answers only exact requests', () => {
    expect(isTimeRequest(timeRequest(0, 0))).toBe(true);
    expect(isTimeRequest(timeRequest(0, 0).subarray(0, 11))).toBe(false);
    expect(isTimeRequest(Uint8Array.from([0x7b, ...timeRequest(0, 0).subarray(1)]))).toBe(false);
    const wrongVersion = timeRequest(0, 0);
    wrongVersion[1] = 2;
    expect(isTimeRequest(wrongVersion)).toBe(false);
    expect(buildTimeResponse(Uint8Array.from([0xa5, 0x5a, ...new Uint8Array(10)]), EPOCH_US, () => EPOCH_US)).toBeNull();
  });

  it('reports an unset host clock instead of serving it', () => {
    let reads = 0;
    const reply = buildTimeResponse(timeRequest(3, 5), 1000, () => {
      reads++;
      return 2000;
    })!;
    expect(reply[3]! & 0x01).toBe(0);
    expect(reply[3]! >> 4).toBe(1);
    expect(i64(reply, 12)).toBe(0);
    expect(i64(reply, 20)).toBe(0);
    expect(reads).toBe(1); // Python reads t3 regardless
    expect(MIN_VALID_EPOCH_US).toBe(1_600_000_000_000_000);
  });

  it('echoes t1 bit for bit, even past 2^53 or negative', () => {
    for (const t1 of [2n ** 62n + 1n, -5n]) {
      const reply = buildTimeResponse(timeRequest(0, t1), EPOCH_US, () => EPOCH_US)!;
      expect(new DataView(reply.buffer).getBigInt64(4, true)).toBe(t1);
    }
  });

  it('floors a fractional host clock to whole microseconds', () => {
    const reply = buildTimeResponse(timeRequest(0, 0), EPOCH_US + 0.75, () => EPOCH_US + 7.5)!;
    expect(i64(reply, 12)).toBe(EPOCH_US);
    expect(i64(reply, 20)).toBe(EPOCH_US + 7);
  });

  it('a time request never looks like a sensor packet', () => {
    expect(looseDeviceUid(timeRequest(9, EPOCH_US))).toBe('');
  });
});
