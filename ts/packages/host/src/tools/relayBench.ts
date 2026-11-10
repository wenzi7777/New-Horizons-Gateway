// Relay performance test (Studio, Pocket, headless): how many devices this
// host can relay, and what limits it.
//
//   1. This machine: synthetic stream packets of the chosen size go through
//      the work a relay does per frame -- parse (as the engine does for live
//      view / recording) and frame for the server (base64 NHPKT1 text) --
//      for a fixed time. Result: frames per second.
//   2. The server link (optional, needs the server): round trips to
//      /api/auth/me (answers without a sign-in), and -- when signed in -- an
//      upload of a test body (POST /api/relay-bench, which the server reads
//      and discards). Result: RTT and upload bytes/s.
//
// estimateCapacity() turns both into devices at a frame rate, with headroom
// (a relay also records, draws and answers commands), and names the
// bottleneck. Ports are injected: no platform code here.
import { bytesToBase64 } from '@nhgw/core';
import { parseBinaryPacket } from '@nhgw/engine';

/** A typical TIA-CTL device: 112 sensors (8 x 14) at 60 fps. */
export const DEFAULT_BENCH_SENSORS = 112;
export const DEFAULT_BENCH_FPS = 60;
/** Only this share of the measured capacity is promised: the rest is left for recording, live view and commands. */
export const BENCH_HEADROOM = 0.6;
/** Per-frame overhead on the server link besides the payload (WebSocket framing, JSON-free text prefix). */
export const UPSTREAM_FRAME_OVERHEAD_BYTES = 16;

const HEADER_V5_LEN = 24;
const PACKET_TEXT_PREFIX = 'NHPKT1:';

/** A v5 stream packet with `sensors` matrix values (what a device sends each frame). */
export function syntheticPacket(sensors: number = DEFAULT_BENCH_SENSORS, seq = 1): Uint8Array {
  const packet = new Uint8Array(HEADER_V5_LEN + sensors * 4);
  const view = new DataView(packet.buffer);
  view.setUint16(0, 0xa55a, true); // magic 5A A5
  packet[2] = 5; // version
  packet[3] = 0x10; // flags: epoch valid
  packet.set([0x3c, 0xdc, 0x75, 0x45, 0xcc, 0xd0], 4); // device uid
  view.setUint32(10, seq, true);
  view.setUint32(14, 0xcfe5687b, true);
  view.setUint32(18, 0x18b, true);
  view.setUint16(22, sensors * 4, true);
  for (let i = 0; i < sensors; i++) view.setFloat32(HEADER_V5_LEN + i * 4, (i % 50) * 1.5, true);
  return packet;
}

export interface CpuBenchResult {
  framesPerSecond: number;
  durationMs: number;
  frames: number;
  packetBytes: number;
}

/** Runs the per-frame relay work for `durationMs` (in slices, so a UI stays responsive). */
export async function runCpuBench(options: { sensors?: number; durationMs?: number; now?: () => number; yieldEvery?: () => Promise<void> } = {}): Promise<CpuBenchResult> {
  const sensors = options.sensors ?? DEFAULT_BENCH_SENSORS;
  const durationMs = options.durationMs ?? 2000;
  const now = options.now ?? (() => performance.now());
  const pause = options.yieldEvery ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const packet = syntheticPacket(sensors);
  const view = new DataView(packet.buffer);
  let frames = 0;
  let sink = 0;
  const start = now();
  let sliceStart = start;
  while (now() - start < durationMs) {
    view.setUint32(10, frames, true);
    const parsed = parseBinaryPacket(packet, sensors, null);
    sink += parsed.p.length;
    sink += (PACKET_TEXT_PREFIX + bytesToBase64(packet)).length;
    frames += 1;
    if (now() - sliceStart > 40) {
      await pause();
      sliceStart = now();
    }
  }
  const elapsed = Math.max(1, now() - start);
  if (sink < 0) throw new Error('unreachable');
  return { framesPerSecond: (frames * 1000) / elapsed, durationMs: elapsed, frames, packetBytes: packet.length };
}

export interface LinkBenchResult {
  ok: boolean;
  /** '' | no_server | network | unauthorized | unsupported (an older server without /api/relay-bench) */
  error: string;
  rttMs: number | null;
  uploadBytesPerSecond: number | null;
}

export interface LinkPorts {
  /** Base URL of the server (e.g. https://host/newhorizons); '' when none is chosen. */
  baseUrl: string;
  /** Resolves with status and how long it took; rejects when nothing answered. */
  request(method: 'GET' | 'POST', url: string, body?: Uint8Array): Promise<{ status: number }>;
  now?: () => number;
}

/** RTT (median of `pings`) and one upload of `uploadBytes` to the server. */
export async function runLinkBench(ports: LinkPorts, options: { pings?: number; uploadBytes?: number; upload?: boolean } = {}): Promise<LinkBenchResult> {
  const now = ports.now ?? (() => performance.now());
  if (!ports.baseUrl) return { ok: false, error: 'no_server', rttMs: null, uploadBytesPerSecond: null };
  const times: number[] = [];
  try {
    for (let i = 0; i < (options.pings ?? 5); i++) {
      const t0 = now();
      await ports.request('GET', `${ports.baseUrl}/api/auth/me`);
      times.push(now() - t0);
    }
  } catch {
    return { ok: false, error: 'network', rttMs: null, uploadBytesPerSecond: null };
  }
  times.sort((a, b) => a - b);
  const rttMs = times[Math.floor(times.length / 2)] ?? null;
  // Without a sign-in (NH Studio headless) only the round trip is measured.
  if (options.upload === false) return { ok: true, error: '', rttMs, uploadBytesPerSecond: null };
  const body = new Uint8Array(options.uploadBytes ?? 2 * 1024 * 1024);
  for (let i = 0; i < body.length; i += 4096) body[i] = i & 0xff;
  let response: { status: number };
  const t0 = now();
  try {
    response = await ports.request('POST', `${ports.baseUrl}/api/relay-bench`, body);
  } catch {
    return { ok: false, error: 'network', rttMs, uploadBytesPerSecond: null };
  }
  const elapsed = Math.max(1, now() - t0);
  if (response.status === 404 || response.status === 405) return { ok: false, error: 'unsupported', rttMs, uploadBytesPerSecond: null };
  if (response.status === 401 || response.status === 403) return { ok: false, error: 'unauthorized', rttMs, uploadBytesPerSecond: null };
  if (response.status >= 300) return { ok: false, error: `http_${response.status}`, rttMs, uploadBytesPerSecond: null };
  return { ok: true, error: '', rttMs, uploadBytesPerSecond: (body.length * 1000) / elapsed };
}

export type Bottleneck = 'machine' | 'network' | 'unknown';

export interface CapacityEstimate {
  fps: number;
  sensors: number;
  /** Bytes per device per second on the server link. */
  bytesPerDevicePerSecond: number;
  devicesByMachine: number;
  /** null when the link was not measured. */
  devicesByNetwork: number | null;
  /** The smaller of the two, with headroom. */
  devices: number;
  bottleneck: Bottleneck;
}

/** Devices this host can relay at `fps`, from the two measurements. */
export function estimateCapacity(input: { cpu: CpuBenchResult; link?: LinkBenchResult | null; fps?: number; sensors?: number }): CapacityEstimate {
  const fps = input.fps ?? DEFAULT_BENCH_FPS;
  const sensors = input.sensors ?? DEFAULT_BENCH_SENSORS;
  // Base64 grows the packet by 4/3; the text prefix and framing add a little.
  const frameBytes = Math.ceil((input.cpu.packetBytes * 4) / 3) + PACKET_TEXT_PREFIX.length + UPSTREAM_FRAME_OVERHEAD_BYTES;
  const bytesPerDevicePerSecond = frameBytes * fps;
  const devicesByMachine = Math.floor((input.cpu.framesPerSecond * BENCH_HEADROOM) / fps);
  const upload = input.link?.ok ? input.link.uploadBytesPerSecond ?? null : null;
  const devicesByNetwork = upload ? Math.floor((upload * BENCH_HEADROOM) / bytesPerDevicePerSecond) : null;
  const devices = devicesByNetwork === null ? devicesByMachine : Math.min(devicesByMachine, devicesByNetwork);
  const bottleneck: Bottleneck = devicesByNetwork === null ? 'unknown' : devicesByNetwork < devicesByMachine ? 'network' : 'machine';
  return { fps, sensors, bytesPerDevicePerSecond, devicesByMachine, devicesByNetwork, devices: Math.max(0, devices), bottleneck };
}
