// UDP sockets on node:dgram (local_device.LocalUDPIngestServer and
// discovery.DiscoveryResponder's socket, without their threads).
//
// - SO_REUSEADDR as Python set it, plus SO_BROADCAST, which Python forgot:
//   its FindMe probe to 255.255.255.255 failed with EACCES and never left.
// - Before the real bind, the port is probed with an exclusive socket: with
//   SO_REUSEADDR on both sides Linux and Windows let two processes bind the
//   same UDP port silently (one of them then never sees a datagram), so a
//   Gateway still running beside this one would go unnoticed.
// - Datagrams are cut at `maxDatagramBytes` like Python's recvfrom(n).
// - The receive time is taken first thing in the 'message' handler: it is t2
//   of a device's time request.
import { createSocket, type Socket } from 'node:dgram';

import type { Address, Clock, Logger, UdpSocket } from '@nhgw/core';
import { silentLogger } from '@nhgw/core';

export type BindProtocol = 'udp' | 'tcp';

/** A port this host needs is taken (or not allowed). The message says which one, what for, and what to do. */
export class PortInUseError extends Error {
  readonly code: string;
  constructor(
    readonly protocol: BindProtocol,
    readonly host: string,
    readonly port: number,
    readonly purpose: string,
    readonly configKey: string,
    code: string,
    configFile = '',
  ) {
    super(portConflictMessage({ protocol, host, port, purpose, configKey, code, configFile }));
    this.name = 'PortInUseError';
    this.code = code;
  }

  /** The same error, its message naming the config file to edit. */
  withConfigFile(configFile: string): PortInUseError {
    const copy = new PortInUseError(this.protocol, this.host, this.port, this.purpose, this.configKey, this.code, configFile);
    copy.stack = this.stack;
    return copy;
  }
}

export function portConflictMessage(info: {
  protocol: BindProtocol;
  host: string;
  port: number;
  purpose: string;
  configKey: string;
  code: string;
  configFile?: string;
}): string {
  const where = `${info.protocol.toUpperCase()} port ${info.port} on ${info.host || '0.0.0.0'} (${info.purpose})`;
  const change = `change ${info.configKey}${info.configFile ? ` in ${info.configFile}` : ''}`;
  if (info.code === 'EADDRINUSE') {
    return (
      `${where} is already in use. Another Gateway is probably still running on this computer ` +
      `(the old Python Gateway: run "python3 scripts/stop.py" in its folder; or a second copy of this one). ` +
      `Stop it and start again, or ${change}.`
    );
  }
  if (info.code === 'EACCES') {
    return `${where} is not allowed (permission denied; on Windows the port may be reserved by the system). Free the port or ${change}.`;
  }
  if (info.code === 'EADDRNOTAVAIL') {
    return `${where} cannot be bound: ${info.host} is not an address of this computer. Fix the host or ${change}.`;
  }
  return `${where} cannot be bound (${info.code}). Free the port or ${change}.`;
}

function errnoCode(error: unknown): string {
  return (error as { code?: unknown } | null)?.code ? String((error as { code: unknown }).code) : 'EUNKNOWN';
}

export interface NodeUdpSocketOptions {
  /** For messages: "device stream/control" or "FindMe discovery". */
  purpose: string;
  /** The config key that sets the port, for messages. */
  configKey: string;
  clock: Clock;
  /** Every datagram, with its receive time (µs since the epoch). */
  onMessage(data: Uint8Array, from: Address, rxEpochUs: number): void;
  /** Python: recvfrom(8192) on 13250, recvfrom(1024) on 22346. */
  maxDatagramBytes?: number;
  logger?: Logger;
}

/** Binds a throwaway exclusive socket, to see whether anyone else holds host:port. */
function probeExclusive(host: string, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const probe = createSocket({ type: 'udp4', reuseAddr: false });
    probe.once('error', (error) => {
      try {
        probe.close();
      } catch {
        // never bound
      }
      reject(error);
    });
    probe.bind({ address: host, port, exclusive: true }, () => {
      probe.close(() => resolvePromise());
    });
  });
}

export class NodeUdpSocket implements UdpSocket {
  readonly purpose: string;
  readonly configKey: string;
  private socket: Socket | null = null;
  private port: number | null = null;
  private readonly clock: Clock;
  private readonly onMessage: NodeUdpSocketOptions['onMessage'];
  private readonly maxDatagramBytes: number;
  private readonly logger: Logger;
  private lastSendError = '';

  constructor(options: NodeUdpSocketOptions) {
    this.purpose = options.purpose;
    this.configKey = options.configKey;
    this.clock = options.clock;
    this.onMessage = options.onMessage;
    this.maxDatagramBytes = options.maxDatagramBytes ?? 8192;
    this.logger = options.logger ?? silentLogger;
  }

  get bound(): boolean {
    return this.socket !== null;
  }

  /** The actually bound port (the config may say 0), or null while closed. */
  get boundPort(): number | null {
    return this.port;
  }

  /** Binds host:port; rejects with PortInUseError when it is taken. Resolves with the bound port. */
  async bind(host: string, port: number): Promise<number> {
    if (this.socket !== null) return this.port!;
    const address = host || '0.0.0.0';
    if (port !== 0) {
      try {
        await probeExclusive(address, port);
      } catch (error) {
        throw new PortInUseError('udp', address, port, this.purpose, this.configKey, errnoCode(error));
      }
    }
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (msg, rinfo) => {
      // t2 of a time request: before anything else.
      const rxEpochUs = this.clock.nowEpochUs();
      if (msg.length === 0) return; // Python skipped empty datagrams
      const data = msg.length > this.maxDatagramBytes ? msg.subarray(0, this.maxDatagramBytes) : msg;
      try {
        this.onMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), { ip: rinfo.address, port: rinfo.port }, rxEpochUs);
      } catch (error) {
        this.logger.error(`${this.purpose}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => {
        try {
          socket.close();
        } catch {
          // never bound
        }
        reject(new PortInUseError('udp', address, port, this.purpose, this.configKey, errnoCode(error)));
      };
      socket.once('error', onError);
      socket.bind({ address, port }, () => {
        socket.off('error', onError);
        resolvePromise();
      });
    });
    socket.setBroadcast(true);
    socket.on('error', (error) => {
      // After the bind, errors are per-datagram (ICMP unreachable on some OSes): keep the socket.
      this.logger.warn(`${this.purpose} socket: ${error.message}`);
    });
    this.socket = socket;
    this.port = socket.address().port;
    return this.port;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.port = null;
    if (socket === null) return;
    await new Promise<void>((resolvePromise) => {
      try {
        socket.close(() => resolvePromise());
      } catch {
        resolvePromise();
      }
    });
  }

  send(data: Uint8Array, to: Address): void {
    const socket = this.socket;
    // Python raised RuntimeError("udp_ingest_not_started"); callers catch it.
    if (socket === null) throw new Error('udp_socket_not_bound');
    socket.send(data, to.port, to.ip, (error) => {
      if (error) {
        const text = `${this.purpose}: send to ${to.ip}:${to.port} failed: ${error.message}`;
        // One line per distinct failure, not one per datagram.
        if (text !== this.lastSendError) this.logger.warn(text);
        this.lastSendError = text;
      } else {
        this.lastSendError = '';
      }
    });
  }

  broadcast(data: Uint8Array, port: number): void {
    this.send(data, { ip: '255.255.255.255', port });
  }
}
