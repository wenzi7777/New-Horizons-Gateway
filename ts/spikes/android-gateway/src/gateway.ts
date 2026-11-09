// Phase 0 spike: the smallest Gateway that a real device and the production
// Backend accept, so the phone-hotspot route can be proven end to end before
// the real port starts. Behaviour follows the Python Gateway
// (newhorizons_gateway/main.py, discovery.py, udp_control.py, upstream_wss.py)
// but deliberately leaves out claims, deny lists, remote management and
// updates. Throwaway code: the real one goes to ts/packages/core.
import NhGatewayNative from '../modules/nh-gateway-native/src/NhGatewayNativeModule';
import type { DatagramEvent, TimeServedEvent } from '../modules/nh-gateway-native/src/NhGatewayNative.types';

export const STREAM_PORT = 13250;
export const DISCOVERY_PORT = 22346;
const PACKET_MAGIC = 0xa55a;
const FLAG_HEARTBEAT = 0x80;
const STATUS_INTERVAL_MS = 5000;
const SESSION_TTL_MS = 90_000;
const STALE_MS = 16_000;
const RESEND_MS = 500;
const MAX_ATTEMPTS = 30;
const VERSION = 'v2.0.0-spike';

export const PRODUCTION_URL = 'wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws';

export type DeviceEntry = {
  uid: string;
  ip: string;
  port: number;
  lastSeenMs: number;
  packets: number;
  forwarded: number;
  heartbeats: number;
  fps: number;
};

export type MinuteSample = { at: number; packets: number; timeReqs: number; upstream: boolean };

export type GatewaySnapshot = {
  nativeAvailable: boolean;
  serviceRunning: boolean;
  upstream: 'connecting' | 'online' | 'offline';
  upstreamError: string;
  clockOffsetMs: number | null;
  devices: DeviceEntry[];
  findmeRequests: number;
  offersSent: number;
  timeRequests: number;
  turnaroundUs: { last: number; max: number; avg: number };
  jsLagMs: { last: number; max: number; avg: number };
  packetsForwarded: number;
  commandsSent: number;
  commandsAcked: number;
  minutes: MinuteSample[];
  log: string[];
};

// --- base64 / bytes -------------------------------------------------------

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// UTF-8 by hand: Hermes is not guaranteed to ship TextDecoder.
function textToB64(text: string): string {
  const utf8 = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return btoa(utf8);
}

function bytesToText(bytes: Uint8Array): string {
  let encoded = '';
  for (let i = 0; i < bytes.length; i++) encoded += '%' + bytes[i].toString(16).padStart(2, '0');
  try {
    return decodeURIComponent(encoded);
  } catch {
    return String.fromCharCode(...bytes);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// --- packet recognition (arduino_protocol.py) ------------------------------

type BinaryInfo = { uid: string; stream: boolean; heartbeat: boolean };

function inspectBinary(p: Uint8Array): BinaryInfo | null {
  if (p.length < 20) return null;
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  if (view.getUint16(0, true) !== PACKET_MAGIC) return null;
  const version = p[2];
  const flags = p[3];
  let headerLen: number;
  let payloadLen: number;
  if (version === 3) {
    headerLen = 20;
    payloadLen = view.getUint16(18, true);
  } else if (version === 4 || version === 5) {
    if (p.length < 24) return null;
    headerLen = 24;
    payloadLen = view.getUint16(22, true);
  } else {
    return null;
  }
  const stream = p.length >= headerLen + payloadLen;
  return {
    uid: stream ? hex(p.subarray(4, 10)) : '',
    stream,
    heartbeat: Boolean(flags & FLAG_HEARTBEAT) && payloadLen === 0,
  };
}

function normalizeUid(value: unknown): string {
  const uid = String(value ?? '').replace(/[:\-\s]/g, '').toUpperCase();
  return uid === '000000000000' ? '' : uid;
}

// --- stats helpers ----------------------------------------------------------

class Running {
  last = 0;
  max = 0;
  private sum = 0;
  private n = 0;
  add(v: number) {
    this.last = v;
    this.max = Math.max(this.max, v);
    this.sum += v;
    this.n += 1;
  }
  get avg() {
    return this.n ? this.sum / this.n : 0;
  }
}

type Pending = { uid: string; packet: string; attempts: number; nextAt: number; requestId: string; command: string };

export class SpikeGateway {
  gatewayId: string;
  serverUrl: string;
  private ws: WebSocket | null = null;
  private upstream: GatewaySnapshot['upstream'] = 'offline';
  private upstreamError = '';
  // Phone clock minus Backend clock, taken the moment hello_ack arrives
  // (one-way latency included, so a rough figure).
  private clockOffsetMs: number | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private subs: { remove(): void }[] = [];
  private stopped = true;

  private devices = new Map<string, DeviceEntry>();
  private fpsCounters = new Map<string, number>();
  private findmeRequests = 0;
  private offersSent = 0;
  private timeRequests = 0;
  private turnaround = new Running();
  private jsLag = new Running();
  private packetsForwarded = 0;
  private minutePackets = 0;
  private minuteTimeReqs = 0;
  private minutes: MinuteSample[] = [];
  private seq = 0;
  private pending = new Map<string, Pending>();
  private commandsSent = 0;
  private commandsAcked = 0;
  private chunks = new Map<string, { total: number; parts: string[]; at: number }>();
  private logLines: string[] = [];
  private listeners = new Set<() => void>();

  constructor(gatewayId: string, serverUrl = PRODUCTION_URL) {
    this.gatewayId = gatewayId;
    this.serverUrl = serverUrl;
  }

  get nativeAvailable() {
    return NhGatewayNative != null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  log(line: string) {
    const stamp = new Date().toISOString().slice(11, 19);
    this.logLines.unshift(`${stamp} ${line}`);
    if (this.logLines.length > 80) this.logLines.length = 80;
    this.notify();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (NhGatewayNative) {
      this.subs.push(NhGatewayNative.addListener('onDatagram', (e) => this.onDatagram(e)));
      this.subs.push(NhGatewayNative.addListener('onTimeServed', (e) => this.onTimeServed(e)));
      NhGatewayNative.startService();
      this.log('native service started (UDP 13250 / 22346)');
    } else {
      this.log('native module unavailable (Expo Go / iOS): upstream-only check');
    }
    this.connect();
    this.timers.push(setInterval(() => this.sendStatus(), STATUS_INTERVAL_MS));
    this.timers.push(setInterval(() => this.serviceCommands(), RESEND_MS));
    this.timers.push(setInterval(() => this.tickSecond(), 1000));
    this.timers.push(setInterval(() => this.tickMinute(), 60_000));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of this.subs) s.remove();
    this.subs = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.upstream = 'offline';
    NhGatewayNative?.stopService();
    this.log('stopped');
  }

  // --- upstream -----------------------------------------------------------

  private connect() {
    if (this.stopped) return;
    this.upstream = 'connecting';
    this.notify();
    const ws = new WebSocket(this.serverUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.upstream = 'online';
      this.upstreamError = '';
      this.reconnectDelay = 1000;
      this.sendJson({
        type: 'hello',
        gateway_id: this.gatewayId,
        version: VERSION,
        update_channel: 'stable',
        client_type: 'gateway',
        // No gateway_command / auto_update: this spike takes no management.
        capabilities: [],
        platform: 'android',
        connected_at: new Date().toISOString(),
      });
      this.log(`upstream connected ${this.serverUrl}`);
      this.sendStatus();
    };
    ws.onmessage = (event) => this.onUpstream(String(event.data));
    ws.onerror = (event: Event) => {
      this.upstreamError = (event as unknown as { message?: string }).message || 'websocket error';
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.upstream = 'offline';
      this.log(`upstream closed (${event.code}) ${this.upstreamError}`);
      this.ws = null;
      if (this.stopped) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    };
  }

  private sendJson(message: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private sendDeviceMessage(type: string, payload: Record<string, unknown>) {
    const upstreamType =
      { hello: 'device_hello', status: 'device_status', update_progress: 'device_update_progress', result: 'device_result' }[
        type
      ] ?? 'device_status';
    this.sendJson({ type: upstreamType, gateway_id: this.gatewayId, device_uid: payload.device_uid ?? '', payload });
  }

  private onUpstream(raw: string) {
    let message: Record<string, any>;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    switch (message.type) {
      case 'gateway_hello_ack':
        {
          const serverMs = Number(message.server_time_ms);
          this.clockOffsetMs = serverMs ? Date.now() - serverMs : null;
        }
        this.log(`hello_ack latest=${message.latest_gateway_version ?? '-'}`);
        break;
      case 'command': {
        const payload = (message.payload ?? {}) as Record<string, unknown>;
        this.onCommand(normalizeUid(message.device_uid ?? payload.device_uid), payload);
        break;
      }
      case 'gateway_command':
        this.sendJson({
          type: 'gateway_command_result',
          gateway_id: this.gatewayId,
          request_id: String(message.request_id ?? ''),
          result: { ok: false, message: 'unknown_command', command: message.payload?.command ?? '' },
        });
        break;
      case 'error':
        this.log(`upstream error ${message.code ?? ''} ${message.message ?? ''}`);
        break;
    }
    this.notify();
  }

  private sendStatus() {
    if (this.upstream !== 'online') return;
    this.pruneDevices();
    const now = Date.now();
    const devices = [...this.devices.values()].map((d) => ({
      device_uid: d.uid,
      connected: now - d.lastSeenMs < STALE_MS,
      findme_state: 'attached',
      ip: d.ip,
      udp_forwarded: d.forwarded,
      udp_dropped: 0,
    }));
    this.sendJson({
      type: 'gateway_status',
      gateway_id: this.gatewayId,
      payload: {
        gateway_name: 'NH Gateway (Android spike)',
        gateway_id: this.gatewayId,
        enabled: true,
        version: VERSION,
        update_channel: 'stable',
        target_mode: 'production',
        server_url: this.serverUrl,
        listen_udp_port: STREAM_PORT,
        listen_discovery_port: DISCOVERY_PORT,
        upstream: { connected: true, server_url: this.serverUrl },
        state: { devices, denied_devices: [], claims: [], nearby_devices: [] },
        remote_management: false,
        platform: 'android',
      },
    });
  }

  // --- UDP ------------------------------------------------------------------

  private onTimeServed(event: TimeServedEvent) {
    this.timeRequests += 1;
    this.minuteTimeReqs += 1;
    this.turnaround.add(event.turnaroundUs);
  }

  private onDatagram(event: DatagramEvent) {
    // How late JS sees a packet after native received it: the cost the
    // real port pays for keeping its logic in JS.
    this.jsLag.add(Date.now() - event.rxEpochUs / 1000);
    const bytes = b64ToBytes(event.data);
    if (event.localPort === DISCOVERY_PORT) {
      this.onFindMe(bytes, event.ip, event.srcPort);
      return;
    }
    if (bytes.length && (bytes[0] === 0x7b || bytes[0] === 0x20)) {
      this.onControl(bytesToText(bytes), event.ip, event.srcPort);
      return;
    }
    const info = inspectBinary(bytes);
    if (!info || !info.uid) return;
    const device = this.touch(info.uid, event.ip, event.srcPort);
    this.minutePackets += 1;
    if (info.heartbeat) {
      device.heartbeats += 1;
      return;
    }
    device.packets += 1;
    this.fpsCounters.set(info.uid, (this.fpsCounters.get(info.uid) ?? 0) + 1);
    if (info.stream && this.ws?.readyState === WebSocket.OPEN) {
      // upstream_wss.py: sensor packets travel as a text frame.
      this.ws.send('NHPKT1:' + event.data);
      device.forwarded += 1;
      this.packetsForwarded += 1;
    }
  }

  private touch(uid: string, ip: string, port: number): DeviceEntry {
    let device = this.devices.get(uid);
    if (!device) {
      device = { uid, ip, port, lastSeenMs: 0, packets: 0, forwarded: 0, heartbeats: 0, fps: 0 };
      this.devices.set(uid, device);
      this.log(`device ${uid} at ${ip}:${port}`);
    }
    device.ip = ip;
    device.port = port;
    device.lastSeenMs = Date.now();
    return device;
  }

  private onFindMe(bytes: Uint8Array, ip: string, port: number) {
    let request: Record<string, any>;
    try {
      request = JSON.parse(bytesToText(bytes));
    } catch {
      return;
    }
    if (request.type !== 'findme_discover' || !request.device_uid) return;
    this.findmeRequests += 1;
    const uid = String(request.device_uid).trim().toUpperCase();
    const current = String(request.current_gateway_id ?? '');
    if (current && current !== this.gatewayId) return; // attached elsewhere: don't steal
    const preferred = String(request.preferred_gateway_id ?? '');
    let offer: Record<string, unknown>;
    if (preferred && preferred !== this.gatewayId) {
      offer = { type: 'findme_offer', device_uid: uid, gateway_id: this.gatewayId, accept: false, reason: 'device_switching_gateway' };
    } else {
      const claimId = preferred === this.gatewayId ? String(request.claim_id ?? '') : '';
      offer = {
        version: 1,
        gateway_name: 'NH Gateway (Android spike)',
        gateway_id: this.gatewayId,
        udp_port: STREAM_PORT,
        priority: claimId ? 10000 : 0,
        accept: true,
        upstream_status: this.upstream === 'online' ? 'online' : 'offline',
        ttl_ms: 10000,
        server_time: Date.now(),
        type: 'findme_offer',
        device_uid: uid,
        ...(claimId ? { claim_id: claimId } : {}),
      };
    }
    NhGatewayNative?.send(DISCOVERY_PORT, ip, port, textToB64(JSON.stringify(offer)));
    this.offersSent += 1;
    this.log(`findme ${uid} from ${ip} -> offer accept=${String(offer.accept)}`);
  }

  private onControl(text: string, ip: string, port: number) {
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.type === 'result_chunk') {
      const assembled = this.addChunk(frame);
      if (!assembled) return;
      frame = assembled;
    }
    const payload = (frame.payload && typeof frame.payload === 'object' ? frame.payload : {}) as Record<string, unknown>;
    const uid = normalizeUid(frame.device_uid) || normalizeUid(payload.device_uid) || normalizeUid(payload.device_id);
    if (!uid) return;
    this.touch(uid, ip, port);
    const type = String(frame.type ?? '');
    if (type === 'ack') {
      this.onAck(uid, frame);
      return;
    }
    if (!['hello', 'status', 'update_progress', 'result'].includes(type)) return;
    const data: Record<string, unknown> = { ...payload };
    data.device_uid ??= uid;
    data.request_id ??= frame.request_id ?? '';
    data.received_at_ms ??= Date.now();
    if (type === 'result') {
      if ('cmd' in data && !('command' in data)) data.command = data.cmd;
      if ('ok' in data && !('status' in data)) data.status = data.ok ? 'ok' : 'error';
      data.transport_path ??= 'arduino_udp';
      for (const [key, entry] of this.pending) {
        if (entry.uid === uid && entry.requestId && entry.requestId === data.request_id) this.pending.delete(key);
      }
    }
    this.sendDeviceMessage(type, data);
  }

  // result_chunks.py: string slices joined in index order, then parsed.
  private addChunk(frame: Record<string, any>): Record<string, any> | null {
    const id = String(frame.request_id ?? '');
    const total = Number(frame.chunks) || 0;
    const index = Number(frame.chunk);
    if (!id || total <= 0 || !(index >= 0 && index < total)) return null;
    let entry = this.chunks.get(id);
    if (!entry || entry.total !== total) {
      entry = { total, parts: new Array(total).fill(undefined), at: Date.now() };
      this.chunks.set(id, entry);
    }
    entry.parts[index] = String(frame.data ?? '');
    if (entry.parts.some((p) => p === undefined)) return null;
    this.chunks.delete(id);
    try {
      const result = JSON.parse(entry.parts.join(''));
      return { ...result, type: 'result', device_uid: result.device_uid ?? frame.device_uid };
    } catch {
      return null;
    }
  }

  // --- commands (udp_control.py) -----------------------------------------------

  private onCommand(uid: string, payload: Record<string, unknown>) {
    const requestId = String(payload.request_id ?? '');
    const command = String(payload.command ?? '');
    const expires = Number(payload.expires_at_ms) || 0;
    if (expires && Date.now() > expires) {
      this.sendDeviceMessage('result', { device_uid: uid, request_id: requestId, command, status: 'error', message: 'command_expired' });
      return;
    }
    const device = this.devices.get(uid);
    if (!device || Date.now() - device.lastSeenMs > SESSION_TTL_MS || !NhGatewayNative) {
      this.sendDeviceMessage('result', {
        device_uid: uid,
        request_id: requestId,
        command,
        status: 'error',
        message: 'device_not_connected_to_gateway',
      });
      return;
    }
    this.seq = (this.seq + 1) & 0xffff || 1;
    const packet = textToB64(JSON.stringify({ type: 'command', device_uid: uid, seq: this.seq, request_id: requestId, payload }));
    const key = `${uid}:${requestId || this.seq}`;
    this.pending.set(key, { uid, packet, attempts: 0, nextAt: 0, requestId, command });
    this.commandsSent += 1;
    this.serviceCommands();
  }

  private onAck(uid: string, frame: Record<string, any>) {
    for (const [key, entry] of this.pending) {
      if (entry.uid !== uid) continue;
      const byRequest = entry.requestId && frame.request_id === entry.requestId;
      if (byRequest || key === `${uid}:${frame.ack}`) {
        // Acked: stop resending. The result clears it, or the timeout below
        // does -- unlike the Python version, which leaks acked entries.
        entry.attempts = MAX_ATTEMPTS - 1;
        entry.nextAt = Date.now() + 15_000;
        this.commandsAcked += 1;
      }
    }
  }

  private serviceCommands() {
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      if (now < entry.nextAt) continue;
      if (entry.attempts >= MAX_ATTEMPTS) {
        this.pending.delete(key);
        this.sendDeviceMessage('result', {
          device_uid: entry.uid,
          request_id: entry.requestId,
          command: entry.command,
          status: 'error',
          message: 'command_delivery_timeout',
        });
        continue;
      }
      const device = this.devices.get(entry.uid);
      if (device) NhGatewayNative?.send(STREAM_PORT, device.ip, device.port, entry.packet);
      entry.attempts += 1;
      entry.nextAt = now + RESEND_MS;
    }
  }

  // --- housekeeping -------------------------------------------------------------

  private pruneDevices() {
    const now = Date.now();
    for (const [uid, d] of this.devices) if (now - d.lastSeenMs > 300_000) this.devices.delete(uid);
    for (const [id, c] of this.chunks) if (now - c.at > 10_000) this.chunks.delete(id);
  }

  private tickSecond() {
    for (const device of this.devices.values()) {
      device.fps = this.fpsCounters.get(device.uid) ?? 0;
    }
    this.fpsCounters.clear();
    this.notify();
  }

  // One sample a minute: the screen-off test reads gaps in this list.
  private tickMinute() {
    this.minutes.unshift({ at: Date.now(), packets: this.minutePackets, timeReqs: this.minuteTimeReqs, upstream: this.upstream === 'online' });
    if (this.minutes.length > 180) this.minutes.length = 180;
    this.minutePackets = 0;
    this.minuteTimeReqs = 0;
    this.notify();
  }

  snapshot(): GatewaySnapshot {
    return {
      nativeAvailable: this.nativeAvailable,
      serviceRunning: NhGatewayNative?.isRunning() ?? false,
      upstream: this.upstream,
      upstreamError: this.upstreamError,
      clockOffsetMs: this.clockOffsetMs,
      devices: [...this.devices.values()],
      findmeRequests: this.findmeRequests,
      offersSent: this.offersSent,
      timeRequests: this.timeRequests,
      turnaroundUs: { last: this.turnaround.last, max: this.turnaround.max, avg: this.turnaround.avg },
      jsLagMs: { last: this.jsLag.last, max: this.jsLag.max, avg: this.jsLag.avg },
      packetsForwarded: this.packetsForwarded,
      commandsSent: this.commandsSent,
      commandsAcked: this.commandsAcked,
      minutes: this.minutes,
      log: this.logLines,
    };
  }
}
