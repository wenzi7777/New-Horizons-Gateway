// Fakes for the device-service tests: a hand-advanced clock, a recording
// command transport and in-memory label stores.
import type { Address, Clock, JsonStore } from '@nhgw/core';

import { DeviceService, type CommandTransport, type DeviceEvent, type DeviceServiceOptions, type StringMap } from '../../src/devices';

export const UID = '3CDC7545CCD0';
export const ADDR: Address = { ip: '192.168.1.152', port: 43309 };

export class FakeClock implements Clock {
  wallMs = 1_794_000_000_000;
  mono = 1_000_000;
  nowMs() {
    return this.wallMs;
  }
  nowEpochUs() {
    return this.wallMs * 1000;
  }
  monotonicMs() {
    return this.mono;
  }
  advance(seconds: number) {
    this.wallMs += seconds * 1000;
    this.mono += seconds * 1000;
  }
}

export class FakeTransport implements CommandTransport {
  sent: [string, Record<string, unknown>][] = [];
  /** Devices with a session; null = every device has one. */
  sessions: Set<string> | null = null;
  fail = false;
  sendCommand(uid: string, payload: Record<string, unknown>) {
    if (this.fail) return false;
    if (this.sessions !== null && !this.sessions.has(uid)) return false;
    this.sent.push([uid, payload]);
    return true;
  }
  sessionAddress(uid: string) {
    return this.sessions === null || this.sessions.has(uid) ? ADDR : undefined;
  }
  commands() {
    return this.sent.map(([, p]) => p.command);
  }
}

export class MemoryMap implements JsonStore<StringMap> {
  saves: StringMap[] = [];
  constructor(public value: unknown = null) {}
  async load() {
    if (this.value === 'throw') throw new Error('unreadable');
    return this.value as StringMap | null;
  }
  async save(value: StringMap) {
    this.value = structuredClone(value);
    this.saves.push(structuredClone(value));
  }
}

export interface ServiceHarness {
  service: DeviceService;
  clock: FakeClock;
  transport: FakeTransport;
  events: DeviceEvent[];
  nicknames: MemoryMap;
  groups: MemoryMap;
}

export function makeService(options: Partial<DeviceServiceOptions> = {}): ServiceHarness {
  const clock = new FakeClock();
  const transport = new FakeTransport();
  const nicknames = new MemoryMap();
  const groups = new MemoryMap();
  let seq = 0;
  const service = new DeviceService({
    clock,
    labels: { nicknames, groups },
    newRequestId: () => `rid-${++seq}`,
    ...options,
  });
  service.setTransport(transport);
  const events: DeviceEvent[] = [];
  service.on((event) => events.push(event));
  return { service, clock, transport, events, nicknames, groups };
}

export function row(name: string, flags: Record<string, unknown> = {}) {
  return { name, maintenance: false, heavy: false, quiet: false, internal: false, status_snapshot: false, summary: name, ...flags };
}

/** test_device_command_catalog.CATALOG */
export const CATALOG = {
  hash: 1234,
  count: 5,
  commands: [
    row('status', { heavy: true, status_snapshot: true }),
    row('file_delete', { maintenance: true }),
    row('exit_maintenance', { maintenance: true }),
    row('set_transport', { internal: true }),
    // Added to the firmware after this Desktop: in no static table.
    row('blink_twice'),
  ],
};
