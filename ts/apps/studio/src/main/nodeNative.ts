// NH Studio's HostNative on Node -- what NH Pocket's Android module does
// (UdpHub.kt, RawCapture.kt, NhFiles.kt), in the Electron main process:
//
// - UDP 13250 (stream/control) and 22346 (FindMe) on node:dgram, through
//   @nhgw/node's NodeUdpSocket (SO_BROADCAST, and an exclusive probe first so
//   a port held by another Gateway / Studio / Desktop is reported instead of
//   silently shared). rxEpochUs is taken first thing in 'message'.
// - TIME_REQ on the stream port is answered here, as natively on Android
//   (core buildTimeResponse: t2 = receive time, t3 just before sending), and
//   never handed to the host.
// - A stream datagram of a device being captured goes to its `.nhraw` before
//   the host sees it, with the same bytes and max(stamp, last) ordering as
//   RawCapture.kt (header and records from @nhgw/engine).
// - startService() binds asynchronously; a bind failure becomes
//   serviceError() and is retried every few seconds until it succeeds or
//   stopService() is called -- the app keeps running, it never crashes.
import { networkInterfaces } from 'node:os';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { base64ToBytes, bytesToBase64, buildTimeResponse, type Clock, type Logger, silentLogger } from '@nhgw/core';
import { encodeNhrawHeader, encodeNhrawRecord, type NhrawSourceName } from '@nhgw/engine';
import {
  type DatagramEvent,
  DISCOVERY_PORT,
  type HostNative,
  type NativeStats,
  type NativeSubscription,
  type NetworkInterfaceInfo,
  RAW_SOURCE,
  type RawCaptureStats,
  STREAM_PORT,
  type TimeServedEvent,
} from '@nhgw/host';

import { NodeClock, NodeUdpSocket, PortInUseError } from './nodeAdapters';
import { NodeFiles } from './nodeFiles';

export const RAW_BUFFER_BYTES = 64 * 1024;
/** How often a failed bind is retried while the service is wanted. */
export const BIND_RETRY_MS = 5_000;
const PACKET_MAGIC_LO = 0x5a;
const PACKET_MAGIC_HI = 0xa5;
const SOURCE_NAMES: Record<number, NhrawSourceName> = { [RAW_SOURCE.stream]: 'stream', [RAW_SOURCE.control]: 'control', [RAW_SOURCE.event]: 'event' };

type RawWriter = {
  uid: string;
  path: string;
  fd: number;
  pending: Uint8Array[];
  pendingBytes: number;
  lastUs: number;
  records: number;
  bytes: number;
  error: string;
};

export interface NodeNativeOptions {
  /** The data folder: recordings/ lives here. */
  root: string;
  /** Where exports are zipped (a temp folder). */
  exportDir: string;
  /** Actual ports to bind (tests use 0 = ephemeral); the host always sees the logical 13250 / 22346. */
  ports?: { stream: number; discovery: number };
  /** Bind address (default 0.0.0.0). */
  host?: string;
  clock?: Clock;
  logger?: Logger;
  bindRetryMs?: number;
  /** Called when the service state or its error changes (bound, failed, stopped). */
  onStateChange?: () => void;
}

function uidHex(data: Uint8Array, offset: number): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += data[offset + i]!.toString(16).padStart(2, '0');
  return out.toUpperCase();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class NodeNative extends NodeFiles implements HostNative {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly ports: { stream: number; discovery: number };
  private readonly bindHost: string;
  private readonly bindRetryMs: number;
  private readonly onStateChange: () => void;
  private readonly sockets = new Map<number, NodeUdpSocket>();
  private readonly datagramListeners = new Set<(event: DatagramEvent) => void>();
  private readonly timeListeners = new Set<(event: TimeServedEvent) => void>();
  private readonly raws = new Map<number, RawWriter>();
  private readonly rawByUid = new Map<string, RawWriter>();
  private nextRawHandle = 1;
  private wanted = false;
  private binding: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private bindError = '';
  private readonly counters = { datagramsIn: 0, datagramsOut: 0, timeRequests: 0, sendErrors: 0, lastError: '' };

  constructor(options: NodeNativeOptions) {
    super(options.root, options.exportDir);
    this.clock = options.clock ?? new NodeClock();
    this.logger = options.logger ?? silentLogger;
    this.ports = options.ports ?? { stream: STREAM_PORT, discovery: DISCOVERY_PORT };
    this.bindHost = options.host ?? '0.0.0.0';
    this.bindRetryMs = options.bindRetryMs ?? BIND_RETRY_MS;
    this.onStateChange = options.onStateChange ?? (() => undefined);
  }

  // -- service / UDP ------------------------------------------------------------

  startService(): boolean {
    this.wanted = true;
    void this.bindAll();
    return true;
  }

  /** Resolves once the current bind attempt finished (tests, and the app waiting for the first bind). */
  whenBound(): Promise<void> {
    return this.binding ?? Promise.resolve();
  }

  private bindAll(): Promise<void> {
    if (this.binding !== null) return this.binding;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.binding = this.doBind().finally(() => {
      this.binding = null;
    });
    return this.binding;
  }

  private socketFor(logical: number): NodeUdpSocket {
    let socket = this.sockets.get(logical);
    if (socket === undefined) {
      const stream = logical === STREAM_PORT;
      socket = new NodeUdpSocket({
        purpose: stream ? 'device stream/control' : 'FindMe discovery',
        configKey: stream ? 'the stream port' : 'the discovery port',
        clock: this.clock,
        logger: this.logger,
        maxDatagramBytes: 8192,
        onMessage: (data, from, rxEpochUs) => this.onMessage(logical, data, from.ip, from.port, rxEpochUs),
      });
      this.sockets.set(logical, socket);
    }
    return socket;
  }

  private async doBind(): Promise<void> {
    const errors: string[] = [];
    for (const [logical, port] of [
      [STREAM_PORT, this.ports.stream],
      [DISCOVERY_PORT, this.ports.discovery],
    ] as const) {
      if (!this.wanted) break;
      const socket = this.socketFor(logical);
      if (socket.bound) continue;
      try {
        await socket.bind(this.bindHost, port);
      } catch (error) {
        errors.push(error instanceof PortInUseError ? studioPortMessage(error) : `UDP ${port}: ${errorText(error)}`);
      }
    }
    if (!this.wanted) {
      await this.closeSockets();
      return;
    }
    const message = errors.join(' ');
    if (message !== this.bindError) {
      this.bindError = message;
      if (message) {
        this.counters.lastError = message;
        this.logger.error(message);
      } else {
        this.logger.info(`UDP ${this.boundPorts().stream}/${this.boundPorts().discovery} bound`);
      }
    }
    if (message && this.wanted) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.wanted) void this.bindAll();
      }, this.bindRetryMs);
      this.retryTimer.unref?.();
    }
    this.onStateChange();
  }

  private async closeSockets(): Promise<void> {
    await Promise.all([...this.sockets.values()].map((socket) => socket.close()));
  }

  stopService(): boolean {
    const was = this.wanted;
    this.wanted = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.bindError = '';
    void this.closeSockets().then(() => {
      if (was) this.onStateChange();
    });
    return true;
  }

  /** stopService() and wait for the sockets to close. */
  async stopServiceAndWait(): Promise<void> {
    this.stopService();
    await this.binding?.catch(() => undefined);
    await this.closeSockets();
  }

  isRunning(): boolean {
    if (!this.wanted) return false;
    for (const logical of [STREAM_PORT, DISCOVERY_PORT]) if (!this.sockets.get(logical)?.bound) return false;
    return true;
  }

  serviceError(): string {
    return this.wanted ? this.bindError : '';
  }

  /** The ports actually bound (null while closed). */
  boundPorts(): { stream: number | null; discovery: number | null } {
    return { stream: this.sockets.get(STREAM_PORT)?.boundPort ?? null, discovery: this.sockets.get(DISCOVERY_PORT)?.boundPort ?? null };
  }

  private onMessage(logical: number, data: Uint8Array, ip: string, srcPort: number, rxEpochUs: number): void {
    this.counters.datagramsIn += 1;
    if (logical === STREAM_PORT) {
      // The raw capture first, as on Android: it must not depend on the host keeping up.
      this.captureStream(data, rxEpochUs);
      const reply = buildTimeResponse(data, rxEpochUs, () => this.clock.nowEpochUs());
      if (reply !== null) {
        this.counters.timeRequests += 1;
        const t3 = new DataView(reply.buffer, reply.byteOffset, reply.byteLength).getBigInt64(20, true);
        this.sendBytes(logical, ip, srcPort, reply);
        const event: TimeServedEvent = { seq: data[2]!, turnaroundUs: t3 === 0n ? 0 : Number(t3) - Math.floor(rxEpochUs) };
        for (const listener of [...this.timeListeners]) listener(event);
        return;
      }
    }
    if (this.datagramListeners.size === 0) return;
    const event: DatagramEvent = { localPort: logical, ip, srcPort, data: bytesToBase64(data), rxEpochUs };
    for (const listener of [...this.datagramListeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error(`datagram listener: ${errorText(error)}`);
      }
    }
  }

  private sendBytes(logical: number, ip: string, dstPort: number, bytes: Uint8Array): void {
    const socket = this.sockets.get(logical);
    if (socket === undefined || !socket.bound) {
      this.counters.sendErrors += 1;
      return;
    }
    try {
      socket.send(bytes, { ip, port: dstPort });
      this.counters.datagramsOut += 1;
    } catch (error) {
      this.counters.sendErrors += 1;
      this.counters.lastError = `send ${ip}:${dstPort}: ${errorText(error)}`;
    }
  }

  send(localPort: number, ip: string, dstPort: number, base64: string): void {
    this.sendBytes(localPort, ip, dstPort, base64ToBytes(base64));
  }

  nowEpochUs(): number {
    return this.clock.nowEpochUs();
  }

  stats(): NativeStats {
    return { running: this.isRunning(), ...this.counters };
  }

  networkInterfaces(): NetworkInterfaceInfo[] {
    const out: NetworkInterfaceInfo[] = [];
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const item of list ?? []) if (item.family === 'IPv4' && !item.internal) out.push({ name, address: item.address });
    }
    return out;
  }

  /** No battery optimisation on a desktop. */
  isIgnoringBatteryOptimizations(): boolean {
    return true;
  }

  requestIgnoreBatteryOptimizations(): boolean {
    return true;
  }

  addListener(event: 'onDatagram', listener: (event: DatagramEvent) => void): NativeSubscription;
  addListener(event: 'onTimeServed', listener: (event: TimeServedEvent) => void): NativeSubscription;
  addListener(event: 'onDatagram' | 'onTimeServed', listener: ((event: DatagramEvent) => void) | ((event: TimeServedEvent) => void)): NativeSubscription {
    const set = (event === 'onDatagram' ? this.datagramListeners : this.timeListeners) as Set<unknown>;
    set.add(listener);
    return { remove: () => void set.delete(listener) };
  }

  // -- `.nhraw` capture ------------------------------------------------------------

  rawStart(uid: string, path: string, startEpochUs: number, firstEvent: Uint8Array | null): number {
    const key = uid.toUpperCase();
    if (this.rawByUid.has(key)) throw new Error('capture_already_running');
    const header = encodeNhrawHeader({ deviceUid: key, startEpochUs }); // validates the UID
    const full = this.resolve(path);
    mkdirSync(join(full, '..'), { recursive: true });
    const fd = openSync(full, 'w');
    const writer: RawWriter = { uid: key, path, fd, pending: [], pendingBytes: 0, lastUs: startEpochUs, records: 0, bytes: header.length, error: '' };
    try {
      writeAll(fd, header);
      if (firstEvent !== null) this.rawWrite(writer, startEpochUs, RAW_SOURCE.event, firstEvent);
      this.rawDrain(writer);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    const handle = this.nextRawHandle++;
    this.raws.set(handle, writer);
    this.rawByUid.set(key, writer);
    return handle;
  }

  rawAppend(handle: number, source: number, payload: Uint8Array): number {
    const writer = this.raws.get(handle);
    if (writer === undefined) throw new Error('capture_closed');
    const stamp = Math.max(this.clock.nowEpochUs(), writer.lastUs);
    this.rawWrite(writer, stamp, source, payload);
    return stamp;
  }

  private captureStream(data: Uint8Array, rxEpochUs: number): void {
    if (this.rawByUid.size === 0 || data.length < 10 || data[0] !== PACKET_MAGIC_LO || data[1] !== PACKET_MAGIC_HI) return;
    const writer = this.rawByUid.get(uidHex(data, 4));
    if (writer !== undefined) this.rawWrite(writer, Math.max(rxEpochUs, writer.lastUs), RAW_SOURCE.stream, data);
  }

  private rawWrite(writer: RawWriter, stamp: number, source: number, payload: Uint8Array): void {
    if (writer.error) return;
    const name = SOURCE_NAMES[source];
    if (name === undefined) throw new Error(`unknown nhraw source ${source}`);
    // A copy: dgram reuses nothing, but the payload may be a view the caller keeps changing.
    const record = encodeNhrawRecord({ rxEpochUs: stamp, source: name, payload });
    writer.pending.push(record);
    writer.pendingBytes += record.length;
    writer.lastUs = stamp;
    writer.records += 1;
    writer.bytes += record.length;
    if (writer.pendingBytes >= RAW_BUFFER_BYTES) this.rawDrain(writer);
  }

  private rawDrain(writer: RawWriter): void {
    if (writer.pendingBytes === 0 || writer.error) return;
    const bytes = Buffer.concat(writer.pending, writer.pendingBytes);
    writer.pending = [];
    writer.pendingBytes = 0;
    try {
      writeAll(writer.fd, bytes);
    } catch (error) {
      // Disk full or the like: the capture stops growing; the host sees it in rawStats().
      writer.error = errorText(error);
    }
  }

  rawFlush(handle: number): void {
    const writer = this.raws.get(handle);
    if (writer !== undefined) this.rawDrain(writer);
  }

  rawFlushAll(): void {
    for (const writer of this.raws.values()) this.rawDrain(writer);
  }

  rawStop(handle: number): void {
    const writer = this.raws.get(handle);
    if (writer === undefined) return;
    this.raws.delete(handle);
    if (this.rawByUid.get(writer.uid) === writer) this.rawByUid.delete(writer.uid);
    this.rawDrain(writer);
    try {
      closeSync(writer.fd);
    } catch (error) {
      writer.error ||= errorText(error);
    }
  }

  rawStats(handle: number): RawCaptureStats | null {
    const writer = this.raws.get(handle);
    if (writer === undefined) return null;
    return { uid: writer.uid, path: writer.path, records: writer.records, bytes: writer.bytes, lastEpochUs: writer.lastUs, error: writer.error };
  }

  /** Quit: flush and close captures and files (a capture left open is recovered on the next start anyway). */
  closeAllFiles(): void {
    for (const handle of [...this.raws.keys()]) this.rawStop(handle);
    this.closeAll();
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let done = 0;
  while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
}

/** A port conflict in Studio's words (the core message talks about Gateway config keys). */
export function studioPortMessage(error: PortInUseError): string {
  const what = `UDP port ${error.port} (${error.purpose})`;
  if (error.code === 'EADDRINUSE') {
    return (
      `${what} is already in use on this computer: another NH Studio, NH Gateway (also the old Python Gateway) ` +
      `or the Desktop server in direct mode is running. Quit it; NH Studio retries automatically.`
    );
  }
  if (error.code === 'EACCES') return `${what} is not allowed (permission denied; on Windows the port may be reserved by the system).`;
  return `${what} cannot be bound (${error.code}).`;
}
