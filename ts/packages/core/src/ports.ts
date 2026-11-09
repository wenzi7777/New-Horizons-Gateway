// Everything the core needs from its host, injected so the same code runs on
// Node (packages/node: dgram, ws, fs) and React Native (apps/android: the
// Kotlin module, RN WebSocket). The core itself never touches a socket, a
// file or a timer: hosts call its handlers and tick it, exactly like the
// Python Gateway's main loop (main.py), which ticks every 0.5 s.

/** Clocks. Wall time follows the OS (NTP); monotonic time never jumps. */
export interface Clock {
  /** Wall clock, ms since the Unix epoch (Python `time.time() * 1000`). */
  nowMs(): number;
  /** Wall clock, µs since the Unix epoch, as precise as the host allows (time_service.py). */
  nowEpochUs(): number;
  /** Monotonic ms, for liveness, rates and timeouts (Python `time.monotonic() * 1000`). */
  monotonicMs(): number;
}

export type Address = { ip: string; port: number };

/** One bound UDP socket (13250 stream/control or 22346 FindMe). */
export interface UdpSocket {
  /** Fire and forget; a failure is reported by throwing or via the host's own log. */
  send(data: Uint8Array, to: Address): void;
  /** Sends to 255.255.255.255:port (the host enables SO_BROADCAST). */
  broadcast?(data: Uint8Array, port: number): void;
}

/** Upstream WebSocket connection to the Desktop Backend. */
export interface WsConnection {
  send(text: string): void;
  close(): void;
}

export interface WsHandlers {
  onOpen(): void;
  onMessage(data: string | Uint8Array): void;
  onClose(reason: string): void;
  onError(message: string): void;
}

export interface WsConnector {
  connect(url: string, headers: Record<string, string>, handlers: WsHandlers): WsConnection;
}

/** HTTPS for manifests, release notes and update downloads. */
export interface Http {
  getText(url: string, timeoutMs: number): Promise<string>;
  /** Whole body as bytes; `onProgress(received, total|null)` while it streams. */
  getBytes(url: string, timeoutMs: number, onProgress?: (received: number, total: number | null) => void): Promise<Uint8Array>;
}

/** sha256 of bytes as lowercase hex (Node crypto / a native or JS implementation on RN). */
export type Sha256 = (data: Uint8Array) => Promise<string>;

/** Persistent JSON document (config.json on desktop, app storage on Android). */
export interface JsonStore<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
