import { describe, expect, it } from 'vitest';

import { parseBinaryPacket } from '@nhgw/engine';

import { estimateCapacity, runCpuBench, runLinkBench, syntheticPacket } from '../src/tools/relayBench';

describe('relay bench', () => {
  it('builds a packet the engine parses as a 112-sensor frame', () => {
    const packet = syntheticPacket(112, 7);
    const parsed = parseBinaryPacket(packet, null, null);
    expect(parsed.p).toHaveLength(112);
    expect(parsed.device_uid).toBe('3CDC7545CCD0');
    expect(packet.length).toBe(24 + 112 * 4);
  });

  it('measures frames per second over the given time', async () => {
    let t = 0;
    const result = await runCpuBench({ durationMs: 100, now: () => (t += 1), yieldEvery: async () => undefined });
    expect(result.frames).toBeGreaterThan(0);
    expect(result.framesPerSecond).toBeCloseTo((result.frames * 1000) / result.durationMs);
  });

  it('times the server link and tells an older server apart', async () => {
    let t = 0;
    const calls: string[] = [];
    const ports = {
      baseUrl: 'http://s/newhorizons',
      now: () => t,
      request: async (method: 'GET' | 'POST', url: string, body?: Uint8Array) => {
        calls.push(`${method} ${url}`);
        t += method === 'GET' ? 20 : body!.length / 1000; // 1 MB/s upload
        return { status: 200 };
      },
    };
    const link = await runLinkBench(ports, { pings: 3, uploadBytes: 1_000_000 });
    expect(link).toMatchObject({ ok: true, rttMs: 20 });
    expect(link.uploadBytesPerSecond).toBeCloseTo(1_000_000);
    expect(calls.at(-1)).toBe('POST http://s/newhorizons/api/relay-bench');
    const old = await runLinkBench({ ...ports, request: async (m) => ({ status: m === 'POST' ? 404 : 200 }) });
    expect(old.error).toBe('unsupported');
    expect((await runLinkBench({ ...ports, baseUrl: '' })).error).toBe('no_server');
  });

  it('estimates devices with headroom and names the bottleneck', () => {
    const cpu = { framesPerSecond: 100_000, durationMs: 2000, frames: 200_000, packetBytes: 472 };
    const machineOnly = estimateCapacity({ cpu });
    expect(machineOnly).toMatchObject({ devicesByMachine: 1000, devicesByNetwork: null, bottleneck: 'unknown', devices: 1000 });
    // 472 B -> 630 B base64 + 7 + 16 = 653 B a frame, 39 180 B/s a device at 60 fps.
    const slowLink = estimateCapacity({ cpu, link: { ok: true, error: '', rttMs: 30, uploadBytesPerSecond: 1_000_000 } });
    expect(slowLink.bytesPerDevicePerSecond).toBe(653 * 60);
    expect(slowLink).toMatchObject({ devicesByNetwork: 15, devices: 15, bottleneck: 'network' });
  });
});
