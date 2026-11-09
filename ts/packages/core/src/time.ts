// Time service for WiFi-mode devices (time_service.py). A device sends
// TIME_REQ (12 bytes) to the stream port; the Gateway answers TIME_RESP (32
// bytes) with its wall clock on receipt (t2) and just before sending (t3), the
// NTP four-timestamp exchange. The layout is shared with the firmware and the
// Hub (EspNowTimeWire.h), so it must not change on this side alone.
import {
  TIME_FLAG_SYNCED,
  TIME_REQ_LEN,
  TIME_REQ_MAGIC,
  TIME_RESP_LEN,
  TIME_RESP_MAGIC,
  TIME_WIRE_VERSION,
} from './wire';

/** High nibble of TIME_RESP flags: the server's time source (ClockCore.h TimeSource). 1 = sntp,
 * because the host OS clock is assumed NTP-disciplined, which the Gateway cannot verify. */
export const TIME_SERVER_SOURCE_SNTP = 1;

/** ~2020-09-13, as in the firmware: a host clock earlier than this is unset. */
export const MIN_VALID_EPOCH_US = 1_600_000_000 * 1_000_000;

export function isTimeRequest(payload: Uint8Array): boolean {
  return payload.length === TIME_REQ_LEN && payload[0] === TIME_REQ_MAGIC && payload[1] === TIME_WIRE_VERSION;
}

/**
 * Reply to a TIME_REQ received at `rxEpochUs` (t2), or null if `request` is
 * not one. `nowEpochUs` is read for t3 as the very last step, so the reply's
 * own build time counts as turnaround (which the device subtracts), not as
 * path delay. It is read even when the clock is unset, as in Python.
 */
export function buildTimeResponse(
  request: Uint8Array,
  rxEpochUs: number,
  nowEpochUs: () => number,
): Uint8Array | null {
  if (!isTimeRequest(request)) return null;
  const req = new DataView(request.buffer, request.byteOffset, request.byteLength);
  const seq = request[2]!;
  // t1 is the device's own clock; echoed as raw int64 so values past 2^53 survive.
  const t1 = req.getBigInt64(4, true);
  const synced = rxEpochUs >= MIN_VALID_EPOCH_US;
  const flags = (synced ? TIME_FLAG_SYNCED : 0) | (TIME_SERVER_SOURCE_SNTP << 4);

  const out = new Uint8Array(TIME_RESP_LEN);
  const view = new DataView(out.buffer);
  out[0] = TIME_RESP_MAGIC;
  out[1] = TIME_WIRE_VERSION;
  out[2] = seq;
  out[3] = flags;
  view.setBigInt64(4, t1, true);
  view.setBigInt64(12, synced ? toInt64(rxEpochUs) : 0n, true);
  // uncertainty_ms@28 and reserved@30 stay 0.
  const t3 = nowEpochUs();
  view.setBigInt64(20, synced ? toInt64(t3) : 0n, true);
  return out;
}

// Python's clock is integer µs (time_ns() // 1000); a host clock may hand a
// fractional value (performance.now based), so floor it the same way.
function toInt64(us: number): bigint {
  return BigInt(Math.floor(us));
}
