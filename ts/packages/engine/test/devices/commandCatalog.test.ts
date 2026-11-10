// Ported from New-Horizons-Desktop/tests/test_device_command_catalog.py: the
// per-device command catalog (firmware v1.15.0+ `commands`), the static
// fallback, the fetch/probe backoff and the pending-command table.
import { describe, expect, it } from 'vitest';

import {
  CATALOG_RETRY_MS,
  CommandCatalogStore,
  CommandGating,
  InvalidCommandError,
  commandModeError,
  failureBackoffMs,
  firmwareHasCatalog,
  validateDeviceCommandPayload,
} from '../../src/devices';
import { CATALOG, UID, makeService } from './helpers';

describe('firmware version', () => {
  it('the catalog starts at 1.15.0, including its betas', () => {
    expect(firmwareHasCatalog('v1.14.0')).toBe(false);
    expect(firmwareHasCatalog('')).toBe(false);
    expect(firmwareHasCatalog('garbage')).toBe(false);
    expect(firmwareHasCatalog('v1.15.0-beta.1')).toBe(true);
    expect(firmwareHasCatalog('1.15.0')).toBe(true);
    expect(firmwareHasCatalog('v2.0.0')).toBe(true);
  });
});

describe('CommandCatalogStore', () => {
  const store = () => new CommandCatalogStore(() => 0);

  it('fetches once per firmware and retries after silence', () => {
    const s = store();
    expect(s.needsFetch(UID, 'v1.14.0')).toBe(false);
    expect(s.needsFetch(UID, 'v1.15.0', 100_000)).toBe(true);
    s.markRequested(UID, 'v1.15.0', 100_000);
    expect(s.needsFetch(UID, 'v1.15.0', 101_000)).toBe(false);
    expect(s.needsFetch(UID, 'v1.15.0', 100_000 + CATALOG_RETRY_MS)).toBe(true);
    // An OTA to another version asks again right away.
    expect(s.needsFetch(UID, 'v1.15.1', 101_000)).toBe(true);
  });

  it('keeps a recorded catalog for that firmware only', () => {
    const s = store();
    s.markRequested(UID, 'v1.15.0');
    expect(s.record(UID, 'v1.15.0', CATALOG)).not.toBeNull();
    expect(s.needsFetch(UID, 'v1.15.0')).toBe(false);
    expect(s.needsFetch(UID, 'v1.15.1')).toBe(true);
    expect(s.get(UID)!.hash).toBe(1234);
  });

  it('ignores malformed replies', () => {
    const s = store();
    expect(s.record(UID, 'v1.15.0', { error: 'x' })).toBeNull();
    expect(s.record(UID, 'v1.15.0', { commands: [] })).toBeNull();
    expect(s.get(UID)).toBeNull();
  });

  it('public names leave out internal commands', () => {
    const s = store();
    s.record(UID, 'v1.15.0', CATALOG);
    expect(s.publicNames(UID)).toEqual(new Set(['status', 'file_delete', 'exit_maintenance', 'blink_twice']));
    expect(s.publicNames('OTHER')).toBeNull();
  });

  it('a schema hash mismatch drops the catalog', () => {
    const s = store();
    s.record(UID, 'v1.15.0', CATALOG);
    expect(s.invalidateIfHashDiffers(UID, 1234)).toBe(false);
    expect(s.invalidateIfHashDiffers(UID, 999)).toBe(true);
    expect(s.get(UID)).toBeNull();
    expect(s.needsFetch(UID, 'v1.15.0')).toBe(true);
  });

  it('the failure backoff grows and is capped', () => {
    expect([0, 1, 2, 3, 4].map(failureBackoffMs)).toEqual([0, 4000, 8000, 16000, 32000]);
    expect(failureBackoffMs(20)).toBe(300_000);
  });

  it('mode_error follows the flags', () => {
    const s = store();
    expect(s.modeError(UID, 'status', false)).toBeNull();
    s.record(UID, 'v1.15.0', CATALOG);
    expect(s.modeError(UID, 'status', false)).toBe('');
    expect(s.modeError(UID, 'file_delete', false)).toBe('maintenance_required');
    expect(s.modeError(UID, 'file_delete', true)).toBe('');
    expect(s.modeError(UID, 'nope', true)).toBe('unknown_command');
  });
});

describe('gating with and without a catalog', () => {
  function gate(catalogs: CommandCatalogStore, command: string, mode: string) {
    return commandModeError(catalogs, UID, { mode }, { command });
  }

  it('without a catalog the static tables apply', () => {
    const catalogs = new CommandCatalogStore(() => 0);
    expect(gate(catalogs, 'file_delete', 'normal')).toBe('maintenance_required');
    expect(gate(catalogs, 'blink_twice', 'normal')).toBe('unknown_command');
    expect(gate(catalogs, 'status', 'normal')).toBe('');
  });

  it('with a catalog the device flags apply', () => {
    const catalogs = new CommandCatalogStore(() => 0);
    catalogs.record(UID, 'v1.15.0', CATALOG);
    expect(gate(catalogs, 'blink_twice', 'normal')).toBe('');
    expect(gate(catalogs, 'blink_twice', 'maintenance')).toBe('');
    expect(gate(catalogs, 'file_delete', 'normal')).toBe('maintenance_required');
    expect(gate(catalogs, 'file_delete', 'safe')).toBe('');
    // The device does not list it, so it would answer exactly this.
    expect(gate(catalogs, 'calibration_clear_profile', 'maintenance')).toBe('unknown_command');
    expect(gate(catalogs, 'status', 'booting')).toBe('wrong_mode');
    expect(gate(catalogs, 'status', '')).toBe('');
  });
});

const STATUS = { command: 'status', status: 'ok', data: { firmware_version: 'v1.15.0-beta.1', mode: 'normal' } };

describe('the service fetches catalogs', () => {
  it('a status from new firmware fetches the catalog once', () => {
    const h = makeService();
    h.service.table.recordResult(UID, { ...STATUS, request_id: 'a' });
    h.service.table.recordResult(UID, { ...STATUS, request_id: 'b' });
    expect(h.transport.sent.map(([uid, p]) => [uid, p.command, p.quiet])).toEqual([[UID, 'commands', true]]);
  });

  it('a status from old firmware fetches nothing', () => {
    const h = makeService();
    h.service.table.recordResult(UID, { command: 'status', status: 'ok', data: { firmware_version: 'v1.14.0', mode: 'normal' } });
    expect(h.transport.sent).toEqual([]);
  });

  it('records a commands reply from either envelope', () => {
    const h = makeService();
    // Relayed (Gateway/UDP): data nested.
    h.service.table.recordResult(UID, { command: 'status', status: 'ok', data: { firmware_version: 'v1.14.0', mode: 'normal' } });
    h.service.table.recordResult(UID, { command: 'commands', status: 'ok', data: CATALOG });
    expect(h.service.deviceCommandNames(UID)!.has('blink_twice')).toBe(true);
    const catalog = h.service.deviceCommandCatalog(UID)!;
    expect(catalog.hash).toBe(1234);
    expect((catalog.commands as { name: string }[]).map((c) => c.name)).not.toContain('set_transport');
    // Flattened into the envelope.
    const other = '80456B76AAF5';
    h.service.table.recordResult(other, { ...CATALOG, command: 'commands', status: 'ok' });
    expect(h.service.deviceCommandNames(other)!.has('blink_twice')).toBe(true);
  });

  it('an error reply records nothing', () => {
    const h = makeService();
    h.service.table.recordResult(UID, { command: 'commands', status: 'error', message: 'unknown_command' });
    expect(h.service.deviceCommandCatalog(UID)).toBeNull();
  });

  it('commands the service sends itself carry a request_id; a chosen one is kept', () => {
    const h = makeService();
    h.service.publishCommand(UID, { command: 'commands', quiet: true });
    expect(h.transport.sent[0]![1].request_id).toBe('rid-1');
    h.service.publishCommand(UID, { command: 'status', request_id: 'mine' });
    expect(h.transport.sent[1]![1].request_id).toBe('mine');
  });

  it('asking for a missing catalog fetches it (once)', () => {
    const h = makeService();
    h.service.table.devices.set(UID, { device_uid: UID, firmware_version: 'v1.15.0-beta.3' });
    expect(h.service.deviceCommandCatalog(UID)).toBeNull();
    expect(h.service.deviceCommandCatalog(UID)).toBeNull(); // already requested
    expect(h.transport.commands()).toEqual(['commands']);
  });

  it('unknown firmware is asked for first', () => {
    const h = makeService();
    h.service.table.devices.set(UID, { device_uid: UID });
    expect(h.service.deviceCommandCatalog(UID)).toBeNull();
    expect(h.service.deviceCommandCatalog(UID)).toBeNull(); // probed recently
    expect(h.transport.commands()).toEqual(['capabilities']);
    // Its reply carries the version and goes on to fetch the catalog.
    h.service.table.recordResult(UID, {
      command: 'capabilities', status: 'ok', ok: true,
      data: { firmware_version: 'v1.15.0-beta.3', command_schema_hash: 1 },
    });
    expect(h.transport.commands()).toEqual(['capabilities', 'commands']);
  });

  it('old firmware is probed once, then left alone', () => {
    const h = makeService();
    h.service.table.devices.set(UID, { device_uid: UID });
    h.service.deviceCommandCatalog(UID);
    h.service.table.recordResult(UID, { command: 'capabilities', status: 'ok', ok: true, data: { firmware_version: 'v1.14.0' } });
    h.service.deviceCommandCatalog(UID);
    expect(h.transport.commands()).toEqual(['capabilities']);
  });

  it('a failed fetch or probe is retried after a short, growing backoff', () => {
    const h = makeService();
    h.service.table.devices.set(UID, { device_uid: UID });
    const busy = { status: 'error', ok: false, message: 'device_command_already_in_flight' };
    const status = { command: 'status', status: 'ok', ok: true, data: { firmware_version: 'v1.15.0', mode: 'normal' } };
    h.service.deviceCommandCatalog(UID); // probe
    h.service.table.recordResult(UID, { ...busy, command: 'capabilities' });
    h.service.deviceCommandCatalog(UID); // within backoff: nothing
    h.clock.advance(5);
    h.service.deviceCommandCatalog(UID); // probe again
    h.service.table.recordResult(UID, { command: 'capabilities', status: 'ok', ok: true, data: { firmware_version: 'v1.15.0' } }); // -> fetch
    expect(h.transport.commands()).toEqual(['capabilities', 'capabilities', 'commands']);
    h.service.table.recordResult(UID, { ...busy, command: 'commands' }); // it fails
    for (const [wait, expectFetch] of [[0, false], [5, true], [5, false], [5, true]] as const) {
      h.clock.advance(wait);
      const before = h.transport.sent.length;
      h.service.table.recordResult(UID, { ...status });
      const fetched = h.transport.sent.length > before;
      expect(fetched, `wait ${wait}`).toBe(expectFetch);
      if (fetched) h.service.table.recordResult(UID, { ...busy, command: 'commands' });
    }
  });

  it('a chunked catalog reply is recorded (direct UDP result_chunk pieces)', () => {
    const h = makeService();
    h.service.table.recordResult(UID, { command: 'status', status: 'ok', ok: true, data: { firmware_version: 'v1.15.0-beta.3', mode: 'normal' } });
    const request = h.transport.sent.at(-1)![1];
    expect(request.command).toBe('commands');
    const reply = JSON.stringify({ ok: true, cmd: 'commands', message: 'commands', data: CATALOG, error: '' });
    const size = Math.floor(reply.length / 3) + 1;
    for (let i = 0; i < 3; i++) {
      h.service.ingestControlFrame(
        { type: 'result_chunk', device_uid: UID, request_id: request.request_id, chunk: i, chunks: 3, data: reply.slice(i * size, (i + 1) * size) },
        { ip: '10.0.0.2', port: 1 },
      );
    }
    expect(h.service.deviceCommandNames(UID)!.has('blink_twice')).toBe(true);
  });

  it('partial chunks are kept 30 s (the Backend variant), then dropped', () => {
    const h = makeService();
    h.service.ingestControlFrame({ type: 'result_chunk', device_uid: UID, request_id: 'r', chunk: 0, chunks: 2, data: '{' }, { ip: 'x', port: 1 });
    h.clock.advance(29);
    h.service.tick();
    expect(h.service.resultChunks.pendingCount()).toBe(1);
    h.clock.advance(2);
    h.service.tick();
    expect(h.service.resultChunks.pendingCount()).toBe(0);
  });
});

describe('pending commands', () => {
  it('unanswered commands do not pile up', () => {
    let now = 100_000;
    const gating = new CommandGating(() => now);
    for (let i = 0; i < 50; i++) {
      gating.remember(UID, { command: 'app_events', request_id: `r${i}` });
      now += 1000;
    }
    expect(gating.pending.get(UID)!.size).toBeLessThanOrEqual(31);
  });
});

describe('allowlist (terminal.validate_device_command_payload)', () => {
  it('catalog commands pass validation; payload checks still apply', () => {
    expect(() => validateDeviceCommandPayload({ command: 'blink_twice' })).toThrow(InvalidCommandError);
    expect(validateDeviceCommandPayload({ command: 'blink_twice' }, new Set(['blink_twice'])).command).toBe('blink_twice');
    expect(() => validateDeviceCommandPayload({ command: 'file_delete', scope: 'proc' }, new Set(['file_delete']))).toThrow('read_only_scope');
  });

  it('checks scopes and battery profiles', () => {
    expect(validateDeviceCommandPayload({ command: ' file_list ', scope: null }).scope).toBe('user');
    expect(() => validateDeviceCommandPayload({ command: 'file_list', scope: 'etc' })).toThrow('invalid_scope');
    expect(validateDeviceCommandPayload({ command: 'file_list', scope: 'proc' }).scope).toBe('proc');
    expect(() => validateDeviceCommandPayload({ command: 'set_battery_profile', capacity_mah: 400, max_charge_current_ma: 355 })).toThrow('invalid_battery_profile');
    expect(() => validateDeviceCommandPayload({ command: 'set_battery_profile', capacity_mah: true, max_charge_current_ma: 200 })).toThrow('invalid_battery_profile');
    expect(validateDeviceCommandPayload({ command: 'set_battery_profile', capacity_mah: 400, max_charge_current_ma: 200 }).command).toBe('set_battery_profile');
  });
});
