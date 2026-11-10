// publish_command for a local host: gating (test_backend_gateway's gating
// cases), the pending table and results inferred from statuses, expiry and
// request IDs, and the set_time push (test_clock_push_guard.py).
import { describe, expect, it } from 'vitest';

import { COMMAND_TTL_MS, CommandError, TIME_PUSH_INTERVAL_MS, clockIsSynced, resultFromPendingStatus } from '../../src/devices';
import { ADDR, UID, makeService } from './helpers';

function withMode(mode: string) {
  const h = makeService();
  h.service.table.recordResult(UID, { device_uid: UID, message: 'status', mode });
  h.transport.sent.length = 0;
  return h;
}

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof CommandError) return error.code;
    if (error instanceof Error) return error.message;
  }
  return '';
}

describe('gating before anything is queued', () => {
  it('blocks wrong-mode, unknown and maintenance-only commands', () => {
    let h = withMode('recovery');
    expect(errorOf(() => h.service.publishCommand(UID, { command: 'set_scan_timing', request_id: 'r1' }))).toBe('wrong_mode');
    h = withMode('normal');
    expect(errorOf(() => h.service.publishCommand(UID, { command: 'write_os', request_id: 'r2' }))).toBe('unknown_command');
    expect(errorOf(() => h.service.publishCommand(UID, { command: 'file_write_begin', path: 'p', size: 1, request_id: 'r3' }))).toBe(
      'maintenance_required',
    );
    expect(h.transport.sent).toEqual([]);
    expect(h.service.gating.pending.has(UID)).toBe(false);
  });

  it('a removed recovery boot command is unknown and not queued', () => {
    const h = withMode('normal');
    expect(errorOf(() => h.service.publishCommand(UID, { command: 'reboot_to_os', target_mode: 'recovery', request_id: 'b' }))).toBe('unknown_command');
    expect(h.service.gating.pending.has(UID)).toBe(false);
  });

  it('calibration commands follow the mode contract', () => {
    const h = withMode('normal');
    expect(h.service.publishCommand(UID, { command: 'calibration_status', request_id: 'a' }).transport).toBe('udp');
    expect(h.service.publishCommand(UID, { command: 'calibration_dump_tare', request_id: 'b' }).transport).toBe('udp');
    expect(errorOf(() => h.service.publishCommand(UID, { command: 'calibration_session_begin', request_id: 'c' }))).toBe('maintenance_required');
    expect(errorOf(() => h.service.publishCommand(UID, { command: 'calibration_capture_tare', request_id: 'd' }))).toBe('maintenance_required');
    h.service.table.recordResult(UID, { device_uid: UID, message: 'status', mode: 'maintenance' });
    h.service.publishCommand(UID, { command: 'calibration_session_begin', request_id: 'e' });
    h.service.publishCommand(UID, { command: 'calibration_capture_tare', request_id: 'f' });
    expect(h.transport.commands()).toEqual(['calibration_status', 'calibration_dump_tare', 'calibration_session_begin', 'calibration_capture_tare']);
  });

  it('set_raw_adc runs in normal mode; reboot queues without a boot transition', () => {
    const h = withMode('normal');
    h.service.publishCommand(UID, { command: 'set_raw_adc', enabled: true, request_id: 'raw' });
    h.service.publishCommand(UID, { command: 'reboot', request_id: 'req-reboot' });
    expect(h.transport.commands()).toEqual(['set_raw_adc', 'reboot']);
    expect(h.service.gating.pending.get(UID)!.has('req-reboot')).toBe(true);
    expect(h.service.gating.bootTransitions.has(UID)).toBe(false);
  });

  it('sendCommand validates like the Desktop UI path; publishCommand does not', () => {
    const h = withMode('normal');
    expect(errorOf(() => h.service.sendCommand(UID, { command: 'file_list', scope: 'etc' }))).toBe('invalid_scope');
    expect(errorOf(() => h.service.sendCommand(UID, { command: 'set_wifi' }))).toBe('unknown_command');
    // Internal commands are real: the service may send them itself.
    expect(h.service.publishCommand(UID, { command: 'set_wifi', request_id: 'w' }).status).toBe('queued');
  });
});

describe('queuing', () => {
  it('stamps expires_at_ms (15 s) and a request_id, and reports the peer', () => {
    const h = withMode('normal');
    const queued = h.service.sendCommand(UID, { command: 'status' });
    expect(queued).toEqual({
      status: 'queued',
      transport: 'udp',
      device_uid: UID,
      request_id: 'rid-1',
      peer: `${ADDR.ip}:${ADDR.port}`,
      payload: { command: 'status', expires_at_ms: h.clock.wallMs + COMMAND_TTL_MS, request_id: 'rid-1' },
    });
    // A caller's expiry is kept.
    expect(h.service.sendCommand(UID, { command: 'status', expires_at_ms: 5 }).payload.expires_at_ms).toBe(5);
  });

  it('without a route: device_control_unavailable, nothing pending', () => {
    const h = makeService();
    h.transport.sessions = new Set();
    expect(errorOf(() => h.service.publishCommand(UID, { command: 'status', request_id: 'req-1' }))).toBe('device_control_unavailable');
    expect(h.service.gating.pending.has(UID)).toBe(false);
    h.service.setTransport(null);
    expect(errorOf(() => h.service.publishCommand(UID, { command: 'status' }))).toBe('device_control_unavailable');
  });

  it('a send that fails forgets the pending entry', () => {
    const h = makeService();
    h.transport.fail = true;
    expect(errorOf(() => h.service.publishCommand(UID, { command: 'status', request_id: 'x' }))).toBe('device_control_unavailable');
    expect(h.service.gating.pending.has(UID)).toBe(false);
  });

  it('a result clears its pending entry', () => {
    const h = withMode('normal');
    h.service.publishCommand(UID, { command: 'scan_health', request_id: 'p1' });
    expect(h.service.gating.pending.get(UID)!.has('p1')).toBe(true);
    h.service.table.recordResult(UID, { command: 'scan_health', request_id: 'p1', status: 'ok' });
    expect(h.service.gating.pending.has(UID)).toBe(false);
  });
});

describe('results inferred from a later status', () => {
  it('memory_status / scan_health are status-like (test_backend_gateway)', () => {
    expect(resultFromPendingStatus('memory_status', 'req-memory', { memory: { free: 81920 }, mode: 'normal' }, {})).toMatchObject({
      command: 'memory_status', request_id: 'req-memory', status: 'ok',
    });
    expect(resultFromPendingStatus('scan_health', 'req-health', { measured_scan_fps: 42, mode: 'normal' }, {})).toMatchObject({
      command: 'scan_health', request_id: 'req-health', status: 'ok', measured_scan_fps: 42,
    });
    expect(resultFromPendingStatus('storage_status', 'r', { mode: 'normal' }, {})).toBeNull();
    expect(resultFromPendingStatus('reboot', 'r', { mode: 'normal' }, {})).toBeNull();
  });

  it('a status answers a status whose reply was lost, as a command_result', () => {
    const h = withMode('normal');
    h.service.publishCommand(UID, { command: 'status', request_id: 'lost' });
    h.events.length = 0;
    h.service.table.recordStatus(UID, { mode: 'normal', wifi: { rssi: -50 } });
    const result = h.events.find((e) => e.type === 'command_result');
    expect(result).toMatchObject({ request_id: 'lost', result: { command: 'status', status: 'ok', message: 'status' } });
    expect(h.service.gating.pending.has(UID)).toBe(false);
  });

  it('enter_maintenance and check_update are answered by what the status shows', () => {
    const h = withMode('normal');
    h.service.publishCommand(UID, { command: 'enter_maintenance', request_id: 'm' });
    h.service.publishCommand(UID, { command: 'check_update', request_id: 'c' });
    h.events.length = 0;
    h.service.table.recordStatus(UID, { mode: 'maintenance' });
    h.service.table.recordStatus(UID, { mode: 'maintenance', update_state: { operation: 'check_update', phase: 'ready', version: 'v2' } });
    const results = h.events.filter((e) => e.type === 'command_result').map((e) => (e as { result: Record<string, unknown> }).result);
    expect(results.map((r) => [r.request_id, r.message])).toEqual([
      ['m', 'maintenance_entered'],
      ['c', 'update_checked'],
    ]);
  });

  it('pending entries expire after 30 s', () => {
    const h = withMode('normal');
    h.service.publishCommand(UID, { command: 'status', request_id: 'old' });
    h.clock.advance(31);
    h.events.length = 0;
    h.service.table.recordStatus(UID, { mode: 'normal' });
    expect(h.events.some((e) => e.type === 'command_result')).toBe(false);
  });
});

describe('set_time push (gateway_ws._maybe_push_time, test_clock_push_guard)', () => {
  it('clockIsSynced: a missing block is unknown, nested containers are searched', () => {
    expect(clockIsSynced({})).toBeNull();
    expect(clockIsSynced({ status: {}, data: {} })).toBeNull();
    expect(clockIsSynced({ device_uid: UID, fps: 60, status: { uptime_ms: 1234 } })).toBeNull();
    expect(clockIsSynced({ clock: { synced: true } })).toBe(true);
    expect(clockIsSynced({ clock: { synced: false } })).toBe(false);
    expect(clockIsSynced({ status: { clock: { synced: false } } })).toBe(false);
    expect(clockIsSynced({ data: { clock: { synced: true } } })).toBe(true);
    expect(clockIsSynced({ clock: {} })).toBeNull();
  });

  function status(h: ReturnType<typeof makeService>, payload: Record<string, unknown>) {
    h.service.ingestControlFrame({ type: 'status', device_uid: UID, payload: { mode: 'normal', ...payload } }, ADDR);
  }

  it('pushes set_time to an unsynced device once per 600 s', () => {
    const h = makeService();
    status(h, { clock: { synced: false } });
    expect(h.transport.sent.map(([, p]) => [p.command, p.quiet, p.epoch_ms])).toEqual([['set_time', true, String(h.clock.wallMs)]]);
    status(h, { clock: { synced: false } });
    expect(h.transport.commands()).toEqual(['set_time']);
    h.clock.advance(TIME_PUSH_INTERVAL_MS / 1000);
    status(h, { clock: { synced: false } });
    expect(h.transport.commands()).toEqual(['set_time', 'set_time']);
  });

  it('never pushes to a synced or pre-v1.0.0 device, nor from an unsynced host', () => {
    const h = makeService();
    status(h, { clock: { synced: true } });
    status(h, {});
    expect(h.transport.sent).toEqual([]);
    let hostSynced = false;
    const g = makeService({ hostClockSynced: () => hostSynced });
    status(g, { clock: { synced: false } });
    expect(g.transport.sent).toEqual([]);
    hostSynced = true;
    status(g, { clock: { synced: false } });
    expect(g.transport.commands()).toEqual(['set_time']);
  });

  it('a result never triggers a push; an unreachable device does not throw', () => {
    const h = makeService();
    h.service.ingestControlFrame({ type: 'result', device_uid: UID, payload: { cmd: 'status', ok: true, data: { clock: { synced: false } } } }, ADDR);
    expect(h.transport.commands()).not.toContain('set_time');
    h.transport.sessions = new Set();
    expect(() => status(h, { clock: { synced: false } })).not.toThrow();
  });
});

describe('direct control frames (datagram_ingest)', () => {
  it('a result is normalized like the Gateway relays it (cmd -> command, ok -> status)', () => {
    const h = makeService();
    h.service.ingestControlFrame({ type: 'result', device_uid: UID, request_id: 'r', payload: { cmd: 'memory_status', ok: true, memory: { heap_free: 1 } } }, ADDR);
    const event = h.events.find((e) => e.type === 'command_result') as { result: Record<string, unknown> };
    expect(event.result).toMatchObject({ command: 'memory_status', status: 'ok', request_id: 'r' });
    expect(h.service.getDevice(UID)!.last_status).toMatchObject({ memory: { heap_free: 1 } });
  });

  it('hello / update_progress record a status; unknown types and frames without a device are ignored', () => {
    const h = makeService();
    h.service.ingestControlFrame({ type: 'hello', device_uid: UID, payload: { device_name: 'Glove', firmware_version: 'v1.19.0' } }, ADDR);
    h.service.ingestControlFrame({ type: 'update_progress', payload: { device_uid: UID, update_state: { phase: 'downloading', operation: 'apply_update' } } }, ADDR);
    h.service.ingestControlFrame({ type: 'weird', device_uid: UID, payload: {} }, ADDR);
    h.service.ingestControlFrame({ type: 'status', payload: {} }, ADDR);
    expect(h.service.getDevice(UID)).toMatchObject({ device_name: 'Glove', firmware_version: 'v1.19.0', update_state: { phase: 'downloading' } });
    expect(h.service.listDevices()).toHaveLength(1);
  });

  it('a streaming device is recorded at most every 5 s', () => {
    const h = makeService();
    h.service.recordStreamPresence(UID, ADDR);
    h.service.recordStreamPresence(UID, ADDR);
    expect(h.events.filter((e) => e.type === 'device_update')).toHaveLength(1);
    h.clock.advance(5);
    h.service.recordStreamPresence(UID, ADDR);
    expect(h.events.filter((e) => e.type === 'device_update')).toHaveLength(2);
    expect(h.service.getDevice(UID)).toMatchObject({ transport_path: 'arduino_udp', gateway_connected: true, device_name: `NHOS-${UID}` });
  });
});
