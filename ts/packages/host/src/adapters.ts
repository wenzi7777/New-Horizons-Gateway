// core's ports (ports.ts) on a HostNative and the platform's WebSocket: clock, UDP
// sockets, the upstream WebSocket, HTTP, and the update hooks the apps do
// not use (Pocket is updated through its app store / EAS, Studio by its own updater).
import {
  type Address,
  bytesToBase64,
  type Clock,
  type Http,
  type Json,
  type UpdateControl,
  type AutoApplier,
  UpstreamClient,
  type UpstreamClientOptions,
  type WsConnection,
  type WsConnector,
  type WsHandlers,
} from '@nhgw/core';

import type { HostNative } from './nativeApi';

/**
 * Wall clock from the native µs clock (Date when there is no native module),
 * monotonic from performance.now(). While a datagram is handed to the engine
 * the wall clock reads the datagram's arrival time (withWallUs), so the live
 * CSV is stamped with the same times the native `.nhraw` capture records.
 */
export class HostClock implements Clock {
  private wallOverrideUs: number | null = null;

  constructor(private readonly nativeNowUs: (() => number) | null) {}

  nowEpochUs(): number {
    if (this.wallOverrideUs !== null) return this.wallOverrideUs;
    return this.nativeNowUs ? this.nativeNowUs() : Date.now() * 1000;
  }

  nowMs(): number {
    return this.nowEpochUs() / 1000;
  }

  monotonicMs(): number {
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    return perf?.now ? perf.now() : Date.now();
  }

  /** Runs fn with the wall clock pinned to `us` (a datagram's rxEpochUs). */
  withWallUs<T>(us: number, fn: () => T): T {
    const previous = this.wallOverrideUs;
    this.wallOverrideUs = us;
    try {
      return fn();
    } finally {
      this.wallOverrideUs = previous;
    }
  }
}

/** One of the native module's two sockets (13250 or 22346), by its local port. */
export class NativeUdpSocket {
  constructor(
    private readonly native: Pick<HostNative, 'send'>,
    readonly localPort: number,
  ) {}

  send(data: Uint8Array, to: Address): void {
    this.native.send(this.localPort, to.ip, to.port, bytesToBase64(data));
  }

  /** The native sockets have SO_BROADCAST on. */
  broadcast(data: Uint8Array, port: number): void {
    this.native.send(this.localPort, '255.255.255.255', port, bytesToBase64(data));
  }
}

type RnWebSocket = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(): void;
};

type RnWebSocketCtor = new (url: string, protocols?: string | string[] | null, options?: { headers?: Record<string, string> }) => RnWebSocket;

/** WsConnector on React Native's WebSocket (which also takes headers, unlike the browser's). */
export class RnWsConnector implements WsConnector {
  constructor(private readonly Ctor: RnWebSocketCtor = (globalThis as unknown as { WebSocket: RnWebSocketCtor }).WebSocket) {}

  connect(url: string, headers: Record<string, string>, handlers: WsHandlers): WsConnection {
    const ws = Object.keys(headers).length ? new this.Ctor(url, null, { headers }) : new this.Ctor(url);
    let closed = false;
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (event) => {
      const data = event.data;
      if (typeof data === 'string') handlers.onMessage(data);
      else if (data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(data));
    };
    ws.onerror = (event) => {
      const message = (event as { message?: unknown } | null)?.message;
      handlers.onError(typeof message === 'string' && message ? message : 'websocket error');
    };
    ws.onclose = (event) => {
      if (closed) return;
      closed = true;
      handlers.onClose(event?.reason || `closed (${event?.code ?? '?'})`);
    };
    return {
      send: (text: string) => ws.send(text),
      close: () => {
        closed = true;
        ws.close();
      },
      // UpstreamClient pauses its drain while this is high (core upstream/client.ts).
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
    } as WsConnection & { readonly bufferedAmount: number };
  }
}

/** Http on fetch, with a timeout. */
export class FetchHttp implements Http {
  async getText(url: string, timeoutMs: number): Promise<string> {
    const response = await this.fetchWithTimeout(url, timeoutMs);
    return response.text();
  }

  async getBytes(url: string, timeoutMs: number, onProgress?: (received: number, total: number | null) => void): Promise<Uint8Array> {
    const response = await this.fetchWithTimeout(url, timeoutMs);
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.(bytes.length, bytes.length);
    return bytes;
  }

  private async fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The apps are not updated by the Gateway updater (Pocket: its app store; Studio: its installer):
 * no checks, no required update (the server's latest_gateway_version names
 * a Gateway release and must not lock a Studio or a Pocket).
 */
export class NoUpdateControl implements UpdateControl {
  readonly requiredUpdate = false;
  /** The runtime checks no more often than every minute anyway; this just keeps it idle. */
  readonly autoCheckIntervalMs = 24 * 3600_000;
  private channel = 'stable';

  manifestUrl(): string {
    return '';
  }
  setChannel(channel: string): Json {
    this.channel = channel;
    return this.state();
  }
  state(): Json {
    return { supported: false, channel: this.channel, required_update: false, status: 'unsupported' };
  }
  updateBlock(): Json {
    return { supported: false };
  }
  setServerLatestVersion(): Json {
    return this.state();
  }
  async maybeRefresh(): Promise<Json> {
    return this.state();
  }
  async check(): Promise<Json> {
    return this.state();
  }
  async startUpdate(): Promise<Json> {
    throw new Error('self_update_unavailable');
  }
  restart(): Json {
    return { ok: false, message: 'restart_unavailable' };
  }
  setRestartCallback(): void {}
}

export const noAutoApplier: AutoApplier = { status: () => '', service: () => {} };

/**
 * The upstream link with the app's relay switch in front: the runtime
 * starts and stops it as usual, but it only connects while relay() is true.
 */
export class RelayUpstream extends UpstreamClient {
  private wanted = false;

  constructor(
    options: UpstreamClientOptions,
    private readonly relay: () => boolean,
  ) {
    super(options);
  }

  override start(): void {
    this.wanted = true;
    if (this.relay()) super.start();
  }

  override stop(): void {
    this.wanted = false;
    super.stop();
  }

  /** Call after the relay switch changed. */
  applyRelay(): void {
    if (this.wanted && this.relay()) super.start();
    else super.stop();
  }
}
