// The device records: ported from New-Horizons-Desktop/tests
// test_device_entry_merge.py, test_relayed_update_state.py,
// test_device_name_canonicalization.py, test_relay_presence.py and the
// status/result/label cases of test_backend_gateway.py.
import { describe, expect, it } from 'vitest';

import {
  DeviceTable,
  STALE_DEVICE_TIMEOUT_MS,
  canonicalDeviceName,
  deviceUidFromPayload,
  markRelayedUpdateStarted,
  mergeUpdateState,
  normalizeUid,
} from '../../src/devices';
import { UID, makeService } from './helpers';

describe('findme / gateway_state merge (test_device_entry_merge)', () => {
  it('relay and device blocks are merged, not swapped', () => {
    const device = { findme: { state: 'attached', gateway_id: 'gw1', udp_port: 13250, heartbeat_interval_ms: 5000 } };
    const relay = { findme: { state: 'attached', gateway_id: 'gw1', claim_id: 'c1' } };
    const merged = DeviceTable.mergeDeviceEntry(device, relay);
    expect(merged.findme).toMatchObject({ udp_port: 13250, heartbeat_interval_ms: 5000, claim_id: 'c1' });
    const again = DeviceTable.mergeDeviceEntry(merged, device);
    expect((again.findme as Record<string, unknown>).claim_id).toBe('c1');
  });

  it('the device can still clear a field', () => {
    const after = DeviceTable.mergeDeviceEntry({ findme: { state: 'attached', gateway_id: 'gw1' } }, { findme: { state: 'idle', gateway_id: '' } });
    expect(after.findme).toEqual({ state: 'idle', gateway_id: '' });
  });

  it('None never overwrites', () => {
    expect(DeviceTable.mergeDeviceEntry({ mode: 'normal' }, { mode: null, protocol: undefined })).toEqual({ mode: 'normal' });
  });

  it('a Hub snapshot does not write findme', () => {
    const h = makeService();
    h.service.table.recordStatus(UID, { mode: 'normal', findme: { state: 'idle' } });
    h.service.table.recordRelayPresence(UID, 'hub-1', { device_uid: UID, connected: true }, true, h.service.table.nowIso(), { clientType: 'hub' });
    const device = h.service.getDevice(UID)!;
    expect(device.findme).toEqual({ state: 'idle' });
    expect(device.gateway_state).toMatchObject({ gateway_id: 'hub-1', connected: true });
    expect(device.client_type).toBe('hub');
  });
});

describe('relayed update start (test_device_entry_merge.RelayedUpdateTest)', () => {
  it('a Direct-mode check reply reads as checking', () => {
    const payload: Record<string, unknown> = {
      command: 'check_update',
      message: 'update_check_started',
      data: { update_state: { phase: 'idle', version: '', operation: 'check_update' } },
    };
    markRelayedUpdateStarted(payload);
    const state = (payload.data as Record<string, Record<string, unknown>>).update_state!;
    expect(state.phase).toBe('checking');
    expect('version' in state).toBe(false);
  });

  it('apply reads as starting; other replies are untouched', () => {
    const payload: Record<string, unknown> = { message: 'update_started', update_state: { phase: 'idle' } };
    markRelayedUpdateStarted(payload);
    expect((payload.update_state as Record<string, unknown>).phase).toBe('starting');
    const wifi = { message: 'update_checked', data: { update_state: { phase: 'ready', version: 'v1.13.0' } } };
    markRelayedUpdateStarted(wifi);
    expect(wifi.data.update_state).toEqual({ phase: 'ready', version: 'v1.13.0' });
  });
});

describe('update_state merge (test_backend_gateway)', () => {
  it('an apply_update starting progress resets a previous done state', () => {
    const merged = mergeUpdateState(
      { phase: 'done', operation: 'apply_update', total_files: 1, applied_files: 1, last_result: 'applied' },
      { phase: 'downloading', operation: 'apply_update', total_files: 0, applied_files: 0, last_result: 'starting', current_file: 'firmware manifest' },
      'normal',
      'normal',
    ) as Record<string, unknown>;
    expect(merged).toMatchObject({ phase: 'downloading', last_result: 'starting', current_file: 'firmware manifest' });
  });

  it('a status reporting the target version marks apply_update done', () => {
    const existing = {
      device_uid: UID,
      firmware_version: 'v0.5.9',
      update_state: {
        phase: 'downloading', operation: 'apply_update', version: 'v0.5.10', total_files: 0, applied_files: 0,
        downloaded_files: 0, skipped_files: 0, current_file: 'firmware', last_error: '', last_result: 'starting', reboot_required: true,
      },
    };
    const incoming = {
      device_uid: UID,
      firmware_version: 'v0.5.10',
      update_state: { phase: 'idle', available: false, version: '', url: '', size: 0, manifest_url: '', error: '' },
    };
    const merged = DeviceTable.mergeDeviceEntry(existing, incoming);
    expect(merged.update_state).toMatchObject({ phase: 'done', last_result: 'applied', downloaded_files: 1, version: 'v0.5.10' });
  });

  it('progress never goes backwards within one apply', () => {
    const existing = { phase: 'downloading', operation: 'apply_update', applied_files: 5, total_files: 10 };
    expect(mergeUpdateState(existing, { phase: 'downloading', operation: 'apply_update', applied_files: 3, total_files: 10 })).toBe(existing);
  });
});

describe('a Hub-relayed update as the settings card sees it (test_relayed_update_state)', () => {
  function seeded() {
    const h = makeService();
    h.service.table.recordResult(UID, {
      command: 'status', status: 'ok', ok: true,
      data: {
        firmware_version: 'v1.15.0-beta.3', mode: 'normal',
        update_state: { phase: 'ready', operation: 'check_update', available: true, version: 'v1.15.0-beta.4', transport: 'espnow_relay' },
      },
    });
    const card = () => (h.service.getDevice(UID)!.last_status as Record<string, Record<string, unknown>>).update_state!;
    return { h, card };
  }

  it('apply replaces the ready left by the check', () => {
    const { h, card } = seeded();
    expect(card().phase).toBe('ready');
    h.service.table.recordResult(UID, {
      command: 'apply_update', status: 'ok', ok: true, message: 'update_started',
      data: { update_state: { phase: 'checking', operation: 'apply_update', available: false, version: '', transport: 'espnow_relay' } },
    });
    expect(card().phase).toBe('checking');
    expect(card().operation).toBe('apply_update');
  });

  it('a status during the transfer carries its progress', () => {
    const { h, card } = seeded();
    h.service.table.recordResult(UID, {
      command: 'status', status: 'ok', ok: true,
      data: {
        firmware_version: 'v1.15.0-beta.3',
        update_state: { phase: 'downloading', operation: 'apply_update', version: 'v1.15.0-beta.4', total_chunks: 425, applied_chunks: 120, transport: 'espnow_relay' },
      },
    });
    expect([card().phase, card().applied_chunks, card().total_chunks]).toEqual(['downloading', 120, 425]);
  });

  it('an update that never reported progress does not stay running', () => {
    const { h, card } = seeded();
    h.service.table.recordResult(UID, {
      command: 'apply_update', status: 'ok', ok: true, message: 'update_started',
      data: { update_state: { phase: 'checking', operation: 'apply_update', transport: 'espnow_relay' } },
    });
    h.service.table.recordResult(UID, {
      command: 'status', status: 'ok', ok: true,
      data: { firmware_version: 'v1.15.0', update_state: { phase: 'idle', operation: '', available: false, version: '', transport: 'espnow_relay' } },
    });
    expect(card().phase).toBe('idle');
  });
});

describe('device names (test_device_name_canonicalization)', () => {
  const canonical = (name: string, uid = UID) => canonicalDeviceName(name, uid);

  it('a short new-style default name expands to the full UID', () => {
    expect(canonical('NHOS-45CCD0')).toBe(`NHOS-${UID}`);
  });
  it('a short legacy default name is recognized and migrated', () => {
    expect(canonical('New Horizons OS-45CCD0')).toBe(`NHOS-${UID}`);
  });
  it('full names, nicknames and non-UID devices are left alone', () => {
    for (const name of [`NHOS-${UID}`, `New Horizons OS-${UID}`, "Nick's glove", 'NHOS lab unit', '']) expect(canonical(name)).toBe(name);
    expect(canonical('New Horizons OS-45CCD0', 'short')).toBe('New Horizons OS-45CCD0');
  });

  function named() {
    const h = makeService();
    const names: unknown[] = [];
    h.service.on((event) => {
      if (event.type === 'device_update') names.push(event.item.display_name);
    });
    h.service.table.recordStatus(UID, { device_uid: UID, device_name: `NHOS-${UID}`, mode: 'normal' });
    const kept = () => {
      expect(h.service.table.devices.get(UID)!.device_name).toBe(`NHOS-${UID}`);
      expect(new Set(names)).toEqual(new Set([`NHOS-${UID}`]));
    };
    return { h, kept };
  }

  it('a command result without a name keeps the name', () => {
    const { h, kept } = named();
    for (const command of ['memory_status', 'app_list', 'scan_health']) {
      h.service.table.recordResult(UID, { device_uid: UID, command, status: 'ok', request_id: command, data: { heap_free: 1 } });
    }
    kept();
  });

  it('a status without a name keeps the name', () => {
    const { h, kept } = named();
    h.service.table.recordStatus(UID, { device_uid: UID, mode: 'normal' });
    kept();
  });

  it('a device first seen without a name is shown by its UID', () => {
    const { h } = named();
    const other = '3CDC7545CCD1';
    h.service.table.recordResult(other, { device_uid: other, command: 'memory_status', status: 'ok' });
    expect(h.service.getDevice(other)!.display_name).toBe(other);
  });

  it('a real rename still applies', () => {
    const { h } = named();
    h.service.table.recordStatus(UID, { device_uid: UID, device_name: 'Left insole', mode: 'normal' });
    expect(h.service.table.devices.get(UID)!.device_name).toBe('Left insole');
  });

  it('heartbeats do not rename a device that named itself', () => {
    const { h } = named();
    h.service.table.recordStatus(UID, { device_uid: UID, device_name: 'Left insole', mode: 'normal' });
    h.service.recordHeartbeat(UID, { ip: '10.0.0.5', port: 1 });
    expect(h.service.table.devices.get(UID)!.device_name).toBe('Left insole');
  });
});

describe('identity and alias folding (device_identity.py)', () => {
  it('normalizes UIDs and picks the full one from a payload', () => {
    expect(normalizeUid(' 3c:dc:75-45 cc:d0 ')).toBe(UID);
    expect(normalizeUid('nhos-x')).toBe('NHOS-X');
    expect(deviceUidFromPayload('45CCD0', { system: { device_uid: UID } })).toBe(UID);
    expect(deviceUidFromPayload('45ccd0', {})).toBe('45CCD0');
  });

  it('a short alias resolves to the one full UID it ends', () => {
    const h = makeService();
    h.service.table.recordStatus(UID, { mode: 'normal' });
    expect(h.service.table.resolveKnownDeviceUid('45ccd0')).toBe(UID);
    expect(h.service.getDevice('45CCD0')!.device_uid).toBe(UID);
  });

  it('a device first seen under an alias is folded into its full UID', () => {
    const h = makeService();
    h.service.table.recordStatus('45CCD0', { mode: 'normal' });
    expect([...h.service.table.devices.keys()]).toEqual(['45CCD0']);
    h.service.table.recordStatus(UID, { device_uid: UID, mode: 'normal' });
    expect([...h.service.table.devices.keys()]).toEqual([UID]);
    expect(h.events.at(-1)).toMatchObject({ type: 'device_snapshot' });
    expect(h.service.table.resolveKnownDeviceUid('45CCD0')).toBe(UID);
  });

  it('a device_id under system maps to the UID', () => {
    const h = makeService();
    h.service.table.recordStatus(UID, { system: { id: 'lab-7' }, mode: 'normal' });
    expect(h.service.table.resolveKnownDeviceUid('LAB-7')).toBe(UID);
    // As in Python, a "0x" id is stored with a lower-case x.
    h.service.table.recordStatus(UID, { system: { device_id: '0xab12' } });
    expect(h.service.table.deviceIdToUid.get('0xAB12')).toBe(UID);
  });
});

describe('liveness (test_relay_presence)', () => {
  it('a real answer counts', () => {
    expect(DeviceTable.payloadIsLive({ status: 'ok', message: 'status' }, 'result')).toBe(true);
    expect(DeviceTable.payloadIsLive({}, 'status')).toBe(true);
  });
  it('relay-generated failures do not', () => {
    for (const code of ['command_delivery_timeout', 'result_page_timeout', 'device_not_connected_to_hub']) {
      expect(DeviceTable.payloadIsLive({ status: 'error', message: code }, 'result')).toBe(false);
    }
    expect(DeviceTable.payloadIsLive({ error: 'command_delivery_timeout' }, 'result')).toBe(false);
  });
  it('an explicit flag wins', () => {
    expect(DeviceTable.payloadIsLive({ live_seen: false, message: 'status' }, 'result')).toBe(false);
    expect(DeviceTable.payloadIsLive({ live_seen: true }, 'update_progress')).toBe(true);
  });
  it('a device error is still an answer', () => {
    expect(DeviceTable.payloadIsLive({ status: 'error', error: 'maintenance_required' }, 'result')).toBe(true);
  });
});

describe('status snapshots from results (test_backend_gateway)', () => {
  it('memory_status updates the latest status', () => {
    const h = makeService();
    h.service.table.recordResult(UID, { device_uid: UID, command: 'memory_status', message: 'memory_status', memory: { heap_free: 81920 } });
    expect((h.service.getDevice(UID)!.last_status as Record<string, Record<string, number>>).memory!.heap_free).toBe(81920);
  });

  it('a status delivery timeout does not clobber last_status', () => {
    const h = makeService();
    h.service.table.recordResult(UID, {
      device_uid: UID, command: 'status', message: 'status', status: 'ok', ok: true,
      data: { firmware_version: 'v0.16.1', wifi: { ip: '192.168.1.10' } }, firmware_version: 'v0.16.1',
    });
    h.service.table.recordResult(UID, { device_uid: UID, request_id: 'req-timeout', command: 'status', status: 'error', message: 'command_delivery_timeout' });
    const device = h.service.getDevice(UID)!;
    expect((device.last_result as Record<string, unknown>).message).toBe('command_delivery_timeout');
    expect(device.last_status).toMatchObject({ firmware_version: 'v0.16.1', wifi: { ip: '192.168.1.10' } });
  });

  it('isStatusSnapshotResult rejects transport errors', () => {
    expect(DeviceTable.isStatusSnapshotResult({ command: 'status', status: 'error', message: 'command_delivery_timeout' })).toBe(false);
    expect(DeviceTable.isStatusSnapshotResult({ command: 'status', status: 'error', message: 'command_expired' })).toBe(false);
    expect(DeviceTable.isStatusSnapshotResult({ command: 'memory_status', ok: false, message: 'device_not_connected_to_gateway' })).toBe(false);
    expect(DeviceTable.isStatusSnapshotResult({ command: 'status', message: 'status', status: 'ok' })).toBe(true);
    expect(DeviceTable.isStatusSnapshotResult({ command: 'memory_status', message: 'memory_status' })).toBe(true);
  });

  it('the visualization target fps follows the scan timing, default 60', () => {
    const h = makeService();
    expect(h.service.table.visualizationTargetFps(UID)).toBe(60);
    h.service.table.recordResult(UID, { device_uid: UID, command: 'status', message: 'status', runtime: { scan_timing: { target_fps: 123 } } });
    expect(h.service.table.visualizationTargetFps(UID)).toBe(123);
  });

  it('enter/exit_maintenance acks without a mode field set the mode', () => {
    const h = makeService();
    h.service.table.recordStatus(UID, { device_uid: UID, message: 'status', mode: 'normal' });
    expect(h.service.getDevice(UID)!.mode).toBe('normal');
    h.service.table.recordResult(UID, { device_uid: UID, ok: true, cmd: 'enter_maintenance', message: 'maintenance_entered', request_id: 'r1', data: {} });
    expect(h.service.getDevice(UID)!.mode).toBe('maintenance');
    h.service.table.recordResult(UID, { device_uid: UID, ok: true, cmd: 'exit_maintenance', message: 'maintenance_exited', request_id: 'r2', data: {} });
    expect(h.service.getDevice(UID)!.mode).toBe('normal');
  });

  it('a calibration reply refreshes the calibration in last_status', () => {
    const h = makeService();
    h.service.table.recordStatus(UID, { mode: 'normal', calibration: { enabled: false } });
    h.service.table.recordResult(UID, {
      command: 'calibration_enable', status: 'ok',
      data: { enabled: true, session_active: false, tare_complete: true, levels: [], unrelated: 1 },
    });
    expect((h.service.getDevice(UID)!.last_status as Record<string, unknown>).calibration).toEqual({
      enabled: true, session_active: false, tare_complete: true, levels: [],
    });
  });

  it('a result emits command_result then device_update', () => {
    const h = makeService();
    h.service.table.recordResult(UID, { command: 'status', status: 'ok', request_id: 'r9', data: { mode: 'normal' } });
    expect(h.events.map((e) => e.type)).toEqual(['command_result', 'device_update']);
    expect(h.events[0]).toMatchObject({ device_uid: UID, request_id: 'r9' });
  });
});

describe('staleness', () => {
  it('a device not genuinely heard from for 12 s goes offline, gateway_state too', () => {
    const h = makeService();
    h.service.recordHeartbeat(UID, { ip: '10.0.0.5', port: 4000 });
    h.service.table.recordRelayPresence(UID, 'gw-a', { device_uid: UID, connected: true }, true);
    expect(h.service.getDevice(UID)).toMatchObject({ gateway_connected: true, gateway_state: { connected: true } });
    h.events.length = 0;
    h.clock.advance(STALE_DEVICE_TIMEOUT_MS / 1000 - 1);
    expect(h.service.table.checkStale()).toEqual([]);
    h.clock.advance(2);
    expect(h.service.table.checkStale()).toEqual([UID]);
    expect(h.service.getDevice(UID)).toMatchObject({ gateway_connected: false, gateway_state: { connected: false } });
    expect(h.events.map((e) => e.type)).toEqual(['device_update']);
  });

  it('a fresh device stays online', () => {
    const h = makeService();
    h.service.recordHeartbeat(UID, { ip: '10.0.0.5', port: 4000 });
    h.clock.advance(5);
    expect(h.service.table.checkStale()).toEqual([]);
    expect(h.service.getDevice(UID)!.gateway_connected).toBe(true);
  });

  it('a relay-reported failure does not keep a device online', () => {
    const h = makeService();
    h.service.recordHeartbeat(UID, { ip: '10.0.0.5', port: 4000 });
    h.clock.advance(8);
    h.service.table.recordResult(UID, { command: 'status', status: 'error', message: 'command_delivery_timeout' });
    h.clock.advance(5);
    expect(h.service.table.checkStale()).toEqual([UID]);
  });
});

describe('relay presence', () => {
  it('rides out one disconnected snapshot within 5 s of being live, then lets go', () => {
    const h = makeService();
    const t = h.service.table;
    t.recordRelayPresence(UID, 'gw-a', { device_uid: UID, connected: true, findme_state: 'attached', last_findme_addr: '10.0.0.5' }, true);
    h.clock.advance(3);
    const item = t.recordRelayPresence(UID, 'gw-a', { device_uid: UID, connected: false, findme_state: 'disconnected' }, false, t.nowIso(), {
      allowDisconnectGrace: true,
    })!;
    expect(item.gateway_connected).toBe(true);
    expect(item.findme).toMatchObject({ state: 'attached', host: '10.0.0.5' });
    h.clock.advance(5);
    const later = t.recordRelayPresence(UID, 'gw-a', { device_uid: UID, connected: false, findme_state: 'disconnected' }, false, t.nowIso(), {
      allowDisconnectGrace: true,
    })!;
    expect(later.gateway_connected).toBe(false);
  });

  it("a stale report from another relay does not take an owner's device", () => {
    const h = makeService();
    const t = h.service.table;
    t.recordRelayPresence(UID, 'gw-a', { device_uid: UID, connected: true }, true);
    expect(t.recordRelayPresence(UID, 'gw-b', { device_uid: UID, connected: false }, false)).toBeNull();
    expect(h.service.getDevice(UID)!.gateway_id).toBe('gw-a');
    // A device never seen is not added by a disconnected report.
    expect(t.recordRelayPresence('AABBCCDDEEFF', 'gw-a', { connected: false }, false)).toBeNull();
  });

  it("a relay's cached mode never overrides a fresh direct one", () => {
    const h = makeService();
    const t = h.service.table;
    t.recordStatus(UID, { mode: 'maintenance' });
    t.recordRelayPresence(UID, 'gw-a', { device_uid: UID, mode: 'normal' }, true);
    expect(h.service.getDevice(UID)!.mode).toBe('maintenance');
    h.clock.advance(16);
    t.recordRelayPresence(UID, 'gw-a', { device_uid: UID, mode: 'normal' }, true);
    expect(h.service.getDevice(UID)!.mode).toBe('normal');
  });
});

describe('labels (device_labels.py)', () => {
  it('a group is saved, decorated, emitted, and cleared', async () => {
    const h = makeService();
    h.service.table.recordResult(UID, { device_uid: UID, message: 'status', mode: 'normal' });
    h.events.length = 0;
    expect(await h.service.setGroup(UID, ' Bench A ')).toEqual({ status: 'saved', device_uid: UID, group: 'Bench A' });
    expect(h.service.getDevice(UID)!.device_group).toBe('Bench A');
    expect(h.groups.value).toEqual({ [UID]: 'Bench A' });
    expect(h.events.map((e) => e.type)).toEqual(['device_update']);
    expect((await h.service.setGroup(UID, '')).group).toBe('');
    expect(h.service.getDevice(UID)!.device_group).toBe('');
    expect(h.groups.value).toEqual({});
  });

  it('a nickname becomes the display name; too long is refused', async () => {
    const h = makeService();
    h.service.table.recordStatus(UID, { device_name: `NHOS-${UID}` });
    await h.service.setNickname(UID, 'Left glove');
    expect(h.service.getDevice(UID)).toMatchObject({ nickname: 'Left glove', display_name: 'Left glove' });
    await expect(h.service.setNickname(UID, 'x'.repeat(65))).rejects.toThrow('nickname_too_long');
    await expect(h.service.setGroup(UID, 'x'.repeat(65))).rejects.toThrow('device_group_too_long');
    expect(h.service.getDevice(UID)!.nickname).toBe('Left glove');
  });

  it('loads cleaned maps, sorted on save; an unreadable store is empty', async () => {
    const h = makeService();
    h.nicknames.value = { [UID]: '  Glove ', '': 'x', B: '  ', A: 3 };
    h.groups.value = 'throw';
    await h.service.load();
    expect(h.service.labels.allNicknames()).toEqual({ [UID]: 'Glove', A: '3' });
    expect(h.service.labels.allGroups()).toEqual({});
    await h.service.setNickname('AABBCCDDEEFF', 'Z');
    expect(Object.keys(h.nicknames.value as object)).toEqual(['3CDC7545CCD0', 'A', 'AABBCCDDEEFF']);
  });
});

describe('parsed frames', () => {
  it('update the visualization, battery and fps; a new device gets a device_update', () => {
    const h = makeService();
    h.service.recordParsed(UID, { p: [1, 2, 3, 4], battery: { soc: 80 } });
    expect(h.events.map((e) => e.type)).toEqual(['visualization_update', 'device_update']);
    h.service.recordParsed(UID, { p: [1, 2, 3, 4], battery: { voltage: 3.9 } });
    expect(h.events.map((e) => e.type).slice(2)).toEqual(['visualization_update']);
    const device = h.service.getDevice(UID)!;
    expect(device.last_status).toMatchObject({ battery: { soc: 80, voltage: 3.9 } });
    expect((device.latest_sample as Record<string, unknown>).device_udp_fps).toBe(2);
    expect(device.visualization_source).toBe('udp');
  });

  it('a new matrix shape drops an incompatible last frame', () => {
    const h = makeService();
    h.service.recordParsed(UID, { p: [1, 2, 3, 4] });
    h.service.table.recordStatus(UID, { matrix_shape: { rows: 3, cols: 3 } });
    expect(h.service.table.latestSample(UID)).toEqual([]);
    expect(h.service.getDevice(UID)!.latest_sample).toBeUndefined();
  });
});
