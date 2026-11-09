// Oversized device command results (e.g. `status`, ~2.5 KB) exceed one UDP
// datagram, so the firmware splits them into `result_chunk` frames keyed by
// request_id, each carrying a slice of the result-JSON string in `data`
// (result_chunks.py).
import { isPlainObject, pyInt, pyStr, pyTruthy } from './py';

export const RESULT_CHUNK_TYPE = 'result_chunk';

export type ReassembledResult = {
  type: 'result';
  device_uid: string;
  request_id: string;
  payload: Record<string, unknown>;
};

type ChunkBuffer = { parts: Map<number, string>; total: number; deviceUid: string; ts: number };

export type ResultChunkReassemblerOptions = {
  /** Partial results older than this are dropped (default 10 s, minimum 1 s). */
  ttlMs?: number;
  /** Monotonic ms (Clock.monotonicMs). */
  nowMs: () => number;
};

export class ResultChunkReassembler {
  private readonly ttlMs: number;
  private readonly nowMs: () => number;
  private readonly buffers = new Map<string, ChunkBuffer>();

  constructor(options: ResultChunkReassemblerOptions) {
    this.ttlMs = Math.max(1000, options.ttlMs ?? 10_000);
    this.nowMs = options.nowMs;
  }

  pendingCount(): number {
    return this.buffers.size;
  }

  purge(): void {
    const cutoff = this.nowMs() - this.ttlMs;
    for (const [requestId, buf] of this.buffers) {
      if (buf.ts < cutoff) this.buffers.delete(requestId);
    }
  }

  /** Feed one `result_chunk` frame; returns the full `result` frame once every chunk is in. */
  add(frame: Record<string, unknown>): ReassembledResult | null {
    const requestId = pyTruthy(frame.request_id) ? pyStr(frame.request_id) : '';
    if (!requestId) return null;
    let index: number;
    let total: number;
    try {
      index = pyInt(frame.chunk);
      total = pyInt(frame.chunks);
    } catch {
      return null;
    }
    if (total <= 0 || index < 0 || index >= total) return null;
    const data = frame.data;
    if (typeof data !== 'string') return null;
    const deviceUid = pyTruthy(frame.device_uid) ? pyStr(frame.device_uid) : '';

    this.purge();
    let buf = this.buffers.get(requestId);
    // A different chunk count means the device restarted this request: start over.
    if (buf === undefined || buf.total !== total) {
      buf = { parts: new Map(), total, deviceUid, ts: this.nowMs() };
      this.buffers.set(requestId, buf);
    }
    buf.parts.set(index, data);
    buf.ts = this.nowMs();
    if (deviceUid) buf.deviceUid = deviceUid;

    if (buf.parts.size < buf.total) return null;

    this.buffers.delete(requestId);
    let payload: unknown;
    try {
      let assembled = '';
      for (let i = 0; i < buf.total; i++) assembled += buf.parts.get(i)!;
      payload = JSON.parse(assembled);
    } catch {
      return null;
    }
    if (!isPlainObject(payload)) return null;
    return { type: 'result', device_uid: buf.deviceUid, request_id: requestId, payload };
  }
}
