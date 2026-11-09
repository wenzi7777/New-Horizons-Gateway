// Commands to devices over UDP (udp_control.py). UDP loses datagrams, so a
// command is resent every 500 ms until the device acks it; the device then
// answers with a `result` (possibly much later, possibly chunked). Sessions
// remember where each device last spoke from, and expire after 90 s of silence.
//
// Clocks: resend pacing and session TTL use monotonic time; `expires_at_ms`
// (set by the Backend, or by a FindMe claim) is wall-clock ms and is compared
// against the wall clock, as in Python.
import { utf8Encode } from '../bytes';
import type { Address, Clock } from '../ports';
import { pyInt, pyStr, pyStrip } from '../py';
import { normalizeDeviceUid } from '../protocol';
import { type Dict, dictOr, pyJsonDumpsCompact, pyOr, strOr } from './pyCompat';

export const RESEND_INTERVAL_MS = 500;
export const MAX_UNACKED_ATTEMPTS = 30;
export const DEFAULT_SESSION_TTL_SEC = 90.0;
/**
 * New (not in Python): how long an acked command with no expires_at_ms waits
 * for its result. Python kept such an entry forever. The same 15 s budget an
 * unacked command gets (30 x 500 ms), which is also the Backend's own
 * COMMAND_TTL_MS -- past it, nobody is waiting for the result any more.
 */
export const ACKED_RESULT_TIMEOUT_MS = RESEND_INTERVAL_MS * MAX_UNACKED_ATTEMPTS;

export type SendDatagram = (data: Uint8Array, to: Address) => void;
export type DeliveryTimeout = (deviceUid: string, payload: Dict) => void;

export interface PendingCommand {
  device_uid: string;
  addr: Address;
  payload: Dict;
  request_id: string;
  seq: number;
  packet: Uint8Array;
  attempts: number;
  acked: boolean;
  /** Monotonic ms. */
  created_at: number;
  /** Monotonic ms; 0 = never sent. */
  last_sent_at: number;
  /** Monotonic ms of the ack (new; drives ACKED_RESULT_TIMEOUT_MS). */
  acked_at?: number;
}

export interface UdpCommandSnapshot {
  sessions: number;
  pending: number;
  commands_sent: number;
  commands_retried: number;
  commands_acked: number;
  commands_timeout: number;
  last_command: string;
  last_error: string;
}

export interface UdpCommandDispatcherOptions {
  send: SendDatagram;
  clock: Clock;
  onDeliveryTimeout?: DeliveryTimeout;
  sessionTtlSec?: number;
  ackedResultTimeoutMs?: number;
}

/**
 * The datagram for one command, byte for byte what Python sent: json.dumps
 * with compact separators, insertion order (type, device_uid, seq, request_id,
 * payload) and ASCII escapes. No trailing newline (unlike encodeCommandLine).
 */
export function encodeCommandEnvelope(deviceUid: string, seq: number, requestId: string, payload: Dict): Uint8Array {
  return utf8Encode(
    pyJsonDumpsCompact({ type: 'command', device_uid: deviceUid, seq, request_id: requestId, payload }),
  );
}

function sameAddress(a: Address | undefined, b: Address): boolean {
  return a !== undefined && a.ip === b.ip && a.port === b.port;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export class UdpCommandDispatcher {
  static readonly RESEND_INTERVAL_MS = RESEND_INTERVAL_MS;
  static readonly MAX_UNACKED_ATTEMPTS = MAX_UNACKED_ATTEMPTS;

  readonly sessionTtlSec: number;
  readonly ackedResultTimeoutMs: number;
  readonly sessions = new Map<string, Address>();
  readonly sessionSeenAt = new Map<string, number>();
  /** Keyed (uid, request_id or seq); insertion-ordered like the Python dict. */
  readonly pending = new Map<string, PendingCommand>();
  seq = 0;
  commandsSent = 0;
  commandsRetried = 0;
  commandsAcked = 0;
  commandsTimeout = 0;
  lastCommand = '';
  lastError = '';

  private readonly send: SendDatagram;
  private readonly clock: Clock;
  onDeliveryTimeout: DeliveryTimeout | undefined;

  constructor(options: UdpCommandDispatcherOptions) {
    this.send = options.send;
    this.clock = options.clock;
    this.onDeliveryTimeout = options.onDeliveryTimeout;
    this.sessionTtlSec = Math.max(1.0, options.sessionTtlSec || DEFAULT_SESSION_TTL_SEC);
    this.ackedResultTimeoutMs = options.ackedResultTimeoutMs ?? ACKED_RESULT_TIMEOUT_MS;
  }

  private mono(): number {
    return this.clock.monotonicMs();
  }

  setSession(deviceUid: unknown, addr: Address): string {
    const uid = normalizeDeviceUid(deviceUid);
    if (uid) {
      this.sessions.set(uid, addr);
      this.sessionSeenAt.set(uid, this.mono());
    }
    return uid;
  }

  dropSession(deviceUid: unknown, addr: Address | null = null): void {
    const uid = normalizeDeviceUid(deviceUid);
    if (!uid) return;
    if (addr === null || sameAddress(this.sessions.get(uid), addr)) {
      this.sessions.delete(uid);
      this.sessionSeenAt.delete(uid);
    }
  }

  /** Sends through the device's current session; false when it has none (or it went stale). */
  sendCommand(deviceUid: unknown, payload: Dict): boolean {
    const uid = normalizeDeviceUid(deviceUid);
    if (!uid) return false;
    this.pruneStaleSessions(this.mono());
    const addr = this.sessions.get(uid);
    if (addr === undefined) return false;
    this.queueCommand(uid, addr, payload);
    return true;
  }

  /** Sends to an explicit address, session or not (the FindMe switch command). */
  sendCommandTo(deviceUid: unknown, addr: Address | null, payload: Dict): boolean {
    const uid = normalizeDeviceUid(deviceUid);
    const host = addr ? pyStrip(pyStr(addr.ip)) : '';
    let port = 0;
    try {
      port = addr ? pyInt(addr.port) : 0;
    } catch {
      port = 0;
    }
    if (!uid || !host || port <= 0) return false;
    this.queueCommand(uid, { ip: host, port }, payload);
    return true;
  }

  handleAck(deviceUid: unknown, frame: Dict): void {
    const uid = normalizeDeviceUid(pyOr(deviceUid, frame.device_uid));
    if (!uid) return;
    const framePayload = dictOr(frame.payload);
    const requestId = strOr(pyOr(frame.request_id, framePayload.request_id));
    // Python's int() raises on a non-numeric ack; the caller (the runtime) catches it.
    const ack = pyInt(pyOr(frame.ack, 0));
    for (const entry of [...this.pending.values()]) {
      if (entry.device_uid !== uid) continue;
      if (requestId && entry.request_id === requestId) {
        this.markAcked(entry);
        return;
      }
      if (ack && pyInt(pyOr(entry.seq, 0)) === ack) {
        this.markAcked(entry);
        return;
      }
    }
  }

  handleResult(deviceUid: unknown, payload: Dict | null): void {
    const uid = normalizeDeviceUid(pyOr(deviceUid, (payload ?? {}).device_uid));
    const requestId = strOr((payload ?? {}).request_id);
    if (!uid || !requestId) return;
    this.pending.delete(pendingKey(uid, requestId));
  }

  /** Resends, expires and times out pending commands. Ticked by the runtime (Python: every 0.5 s). */
  service(): void {
    const now = this.mono();
    const nowWallMs = Math.floor(this.clock.nowMs());
    const timedOut: PendingCommand[] = [];
    const staleUids = this.pruneStaleSessions(now);
    for (const [key, entry] of [...this.pending]) {
      const expired = UdpCommandDispatcher.expired(entry, nowWallMs);
      if (entry.acked) {
        // Delivered: only waiting for the result. Dropped silently (no
        // delivery-timeout report), like Python's acked+expired path -- the
        // device did get the command, so "command_delivery_timeout" would be
        // false, and for a findme_switch_gateway it would fail a claim whose
        // device acked the switch. Python never dropped an acked entry without
        // expires_at_ms (a leak); ACKED_RESULT_TIMEOUT_MS bounds it.
        if (
          expired ||
          (!UdpCommandDispatcher.hasExplicitExpiry(entry) && now - (entry.acked_at ?? now) >= this.ackedResultTimeoutMs)
        ) {
          this.pending.delete(key);
        }
        continue;
      }
      if (staleUids.has(entry.device_uid)) {
        this.pending.delete(key);
        this.commandsTimeout += 1;
        this.lastError = 'command_delivery_timeout';
        timedOut.push(entry);
        continue;
      }
      if (
        expired ||
        (!UdpCommandDispatcher.hasExplicitExpiry(entry) && entry.attempts >= MAX_UNACKED_ATTEMPTS)
      ) {
        this.pending.delete(key);
        this.commandsTimeout += 1;
        this.lastError = 'command_delivery_timeout';
        timedOut.push(entry);
        continue;
      }
      if (now - entry.last_sent_at >= RESEND_INTERVAL_MS) this.sendEntry(entry, true);
    }
    if (this.onDeliveryTimeout !== undefined) {
      for (const entry of timedOut) this.onDeliveryTimeout(entry.device_uid, { ...entry.payload });
    }
  }

  snapshot(): UdpCommandSnapshot {
    this.pruneStaleSessions(this.mono());
    return {
      sessions: this.sessions.size,
      pending: this.pending.size,
      commands_sent: this.commandsSent,
      commands_retried: this.commandsRetried,
      commands_acked: this.commandsAcked,
      commands_timeout: this.commandsTimeout,
      last_command: this.lastCommand,
      last_error: this.lastError,
    };
  }

  private markAcked(entry: PendingCommand): void {
    if (!entry.acked) {
      entry.acked = true;
      entry.acked_at = this.mono();
      this.commandsAcked += 1;
      this.lastError = '';
    }
  }

  private queueCommand(uid: string, addr: Address, payloadIn: Dict | null): void {
    const payload: Dict = { ...(payloadIn ?? {}) };
    const requestId = strOr(payload.request_id);
    this.seq = (this.seq + 1) & 0xffff;
    if (this.seq === 0) this.seq = 1;
    const entry: PendingCommand = {
      device_uid: uid,
      addr,
      payload,
      request_id: requestId,
      seq: this.seq,
      packet: encodeCommandEnvelope(uid, this.seq, requestId, payload),
      attempts: 0,
      acked: false,
      created_at: this.mono(),
      last_sent_at: 0,
    };
    // A re-sent request_id replaces the old entry in place (dict semantics).
    this.pending.set(pendingKey(uid, requestId || String(this.seq)), entry);
    this.sendEntry(entry, false);
  }

  private sendEntry(entry: PendingCommand, retry: boolean): void {
    try {
      this.send(entry.packet, entry.addr);
    } catch (error) {
      // The address is unusable (host unreachable, socket closed): forget the
      // session so new commands fail fast; this one times out normally.
      this.dropSession(entry.device_uid, entry.addr);
      this.lastError = errorText(error);
      entry.attempts += 1;
      entry.last_sent_at = this.mono();
      return;
    }
    entry.attempts += 1;
    entry.last_sent_at = this.mono();
    if (retry) this.commandsRetried += 1;
    else this.commandsSent += 1;
    const command = strOr(entry.payload.command);
    this.lastCommand = entry.request_id ? `${command}:${entry.request_id}` : command;
    this.lastError = '';
  }

  private pruneStaleSessions(now: number): Set<string> {
    const stale = new Set<string>();
    for (const [uid, seenAt] of [...this.sessionSeenAt]) {
      if (now - seenAt <= this.sessionTtlSec * 1000) continue;
      stale.add(uid);
      this.sessions.delete(uid);
      this.sessionSeenAt.delete(uid);
    }
    return stale;
  }

  static expired(entry: PendingCommand, nowWallMs: number): boolean {
    const expiresAtMs = explicitExpiry(entry);
    return Boolean(expiresAtMs && nowWallMs > expiresAtMs);
  }

  static hasExplicitExpiry(entry: PendingCommand): boolean {
    return explicitExpiry(entry) > 0;
  }
}

function explicitExpiry(entry: PendingCommand): number {
  try {
    return pyInt(pyOr(dictOr(entry.payload).expires_at_ms, 0));
  } catch {
    return 0;
  }
}

function pendingKey(uid: string, id: string): string {
  return `${uid}\u0000${id}`;
}
