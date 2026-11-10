// recording_session.py: one recording in progress -- its sample file (kept
// open, flushed about once a second), how far behind real time the frames
// being written are, and how a stop waits for frames still queued. See the
// Python module docstring for why.
import { monotonicSec, type RecordingClock, type RecordingMeta } from './meta';
import type { RecordingPaths } from './paths';
import { dirname, type RecordingFileHandle, type RecordingFileSink } from './sink';

export class RecordingWriter {
  static readonly FLUSH_EVERY_SEC = 1.0;

  private handle: RecordingFileHandle | null = null;
  private flushedAt: number;
  closed = false;

  constructor(
    readonly path: string,
    private readonly sink: RecordingFileSink,
    private readonly clock: RecordingClock,
  ) {
    this.flushedAt = monotonicSec(clock);
  }

  /** Appends a row (the header first, if the file is empty). Throws on a sink failure. */
  write(header: () => string, row: string): void {
    if (this.closed) return;
    if (this.handle === null) {
      this.sink.mkdirp(dirname(this.path));
      this.handle = this.sink.open(this.path);
      if (this.handle.size === 0) this.handle.append(header());
    }
    this.handle.append(row);
    const now = monotonicSec(this.clock);
    if (now - this.flushedAt >= RecordingWriter.FLUSH_EVERY_SEC) {
      this.handle.flush();
      this.flushedAt = now;
    }
  }

  flush(): void {
    if (this.handle !== null && !this.closed) {
      this.handle.flush();
      this.flushedAt = monotonicSec(this.clock);
    }
  }

  close(): void {
    this.closed = true;
    const handle = this.handle;
    this.handle = null;
    if (handle !== null) {
      try {
        handle.close();
      } catch {
        // as Python: a failed close is not reported
      }
    }
  }
}

/** How far behind real time the frames being handled are, in ms. */
export class LagTracker {
  /** A device clock that jumps back by more than this restarted. */
  static readonly RESTART_JUMP_MS = 1000.0;

  private baseServer: number | null = null;
  private baseDevice = 0.0;
  private minOffset = 0.0;
  private lastDevice = 0.0;
  lagMs = 0.0;
  maxLagMs = 0.0;

  constructor(private readonly clock: RecordingClock) {}

  observe(deviceMs: number): number {
    const now = monotonicSec(this.clock);
    if (this.baseServer === null || deviceMs < this.lastDevice - LagTracker.RESTART_JUMP_MS) {
      this.baseServer = now;
      this.baseDevice = deviceMs;
      this.minOffset = 0.0;
      this.lastDevice = deviceMs;
      this.lagMs = 0.0;
      return 0.0;
    }
    const offset = (now - this.baseServer) * 1000.0 - (deviceMs - this.baseDevice);
    if (offset < this.minOffset) this.minOffset = offset;
    this.lastDevice = Math.max(this.lastDevice, deviceMs);
    this.lagMs = offset - this.minOffset;
    this.maxLagMs = Math.max(this.maxLagMs, this.lagMs);
    return this.lagMs;
  }

  /** The device time being scanned right now, as the least-delayed frames place it. */
  deviceMsNow(): number | null {
    if (this.baseServer === null) return null;
    return this.baseDevice + (monotonicSec(this.clock) - this.baseServer) * 1000.0 - this.minOffset;
  }
}

export type StopReason = 'user' | 'user_drain_timeout' | 'server_stopped' | `write_error: ${string}` | (string & {});

export class RecordingSession {
  /** Below this a stop is immediate: nothing worth waiting for is queued. */
  static readonly MIN_DRAIN_LAG_MS = 250.0;
  static readonly MAX_DRAIN_SEC = 600.0;

  readonly writer: RecordingWriter;
  readonly lag: LagTracker;
  drainUntilDeviceMs: number | null = null;
  drainDeadline: number | null = null;

  constructor(
    readonly paths: RecordingPaths,
    readonly meta: RecordingMeta,
    sink: RecordingFileSink,
    private readonly clock: RecordingClock,
  ) {
    this.writer = new RecordingWriter(paths.data, sink, clock);
    this.lag = new LagTracker(clock);
  }

  get draining(): boolean {
    return this.drainUntilDeviceMs !== null;
  }

  /**
   * Writes a frame. Once a stop's last frame has been written, the reason to
   * finish with ("user", or "user_drain_timeout"); otherwise null.
   */
  write(header: () => string, row: string, frameSeq: number, timestampMs: number, deviceClock: boolean): StopReason | null {
    this.writer.write(header, row);
    const lag = deviceClock ? this.lag.observe(timestampMs) : null;
    this.meta.onFrame(frameSeq, timestampMs, lag, deviceClock ? this.lag.maxLagMs : null);
    if (this.drainUntilDeviceMs === null) return null;
    if (timestampMs >= this.drainUntilDeviceMs) return 'user';
    return this.drainExpired() ? 'user_drain_timeout' : null;
  }

  drainExpired(): boolean {
    return this.drainDeadline !== null && monotonicSec(this.clock) >= this.drainDeadline;
  }

  /** Stop pressed. The seconds to wait for frames still queued, or null to finish now. */
  beginDrain(): number | null {
    const target = this.lag.deviceMsNow();
    if (target === null || this.lag.lagMs < RecordingSession.MIN_DRAIN_LAG_MS) return null;
    const wait = Math.min(RecordingSession.MAX_DRAIN_SEC, 10.0 + (2.0 * this.lag.lagMs) / 1000.0);
    this.drainUntilDeviceMs = target;
    this.drainDeadline = monotonicSec(this.clock) + wait;
    this.meta.requestStop();
    return wait;
  }

  finish(reason: StopReason): void {
    this.writer.close();
    this.meta.stop(reason);
  }
}
