// The device side of the apps area: the exact install sequence the Desktop
// sends (maintenance, file_write_* in 96-byte hex chunks, app_install with
// replace, maintenance restored), the CommandOutcome adapter, the app-state
// parsers and the catalog helpers.
import { describe, expect, it } from 'vitest';

import type { CommandOutcome } from '../../src/shared/contract';
import { categoriesOf, installBlocker, installMinFirmware, localised, satisfiesMinOs } from '../../src/renderer/areas/apps/lib/appLibrary';
import { appErrorKey, budgetPercent, freeSlots, isUnknownCommand, needsRevive, parseAppEvents, parseAppList, parseAppView, parsePackageList } from '../../src/renderer/areas/apps/lib/deviceApps';
import { commandRunner, isMaintenance, outcomeResult, runAppInstall, type InstallStep } from '../../src/renderer/areas/apps/lib/deviceCommand';
import { CHUNK_BYTES, MAX_USER_PATH, bytesToHex, hexToBytes, installAppPackage, readDeviceFile, writeDeviceFile, type CommandRunner } from '../../src/renderer/areas/apps/lib/deviceFileTransfer';

function recorder(fail: (payload: Record<string, unknown>) => string | null = () => null) {
  const sent: Record<string, unknown>[] = [];
  const run: CommandRunner = async (payload) => {
    sent.push(payload);
    const error = fail(payload);
    return { result: error ? { status: 'error', error } : { status: 'ok' } };
  };
  return { sent, run };
}

const DATA = Uint8Array.from({ length: 200 }, (_, i) => i);
const DATA_HEX = bytesToHex(DATA);

describe('install sequence', () => {
  it('sends exactly the Desktop payloads, in order', async () => {
    const { sent, run } = recorder();
    const steps: (InstallStep | null)[] = [];
    await runAppInstall(run, { appId: 'demo', devicePath: 'apps/demo.nha', dataHex: DATA_HEX, sha256: 'abc', alreadyInMaintenance: false, onStep: (s) => steps.push(s) });
    expect(sent).toEqual([
      { command: 'enter_maintenance', reason: 'app_install' },
      { command: 'file_write_begin', scope: 'user', path: 'apps/demo.nha', size: 200 },
      { command: 'file_write_chunk', scope: 'user', path: 'apps/demo.nha', offset: 0, data: bytesToHex(DATA.slice(0, 96)) },
      { command: 'file_write_chunk', scope: 'user', path: 'apps/demo.nha', offset: 96, data: bytesToHex(DATA.slice(96, 192)) },
      { command: 'file_write_chunk', scope: 'user', path: 'apps/demo.nha', offset: 192, data: bytesToHex(DATA.slice(192)) },
      { command: 'file_write_finish', scope: 'user', path: 'apps/demo.nha', sha256: 'abc' },
      { command: 'app_install', path: 'apps/demo.nha', sha256: 'abc', replace: true },
      { command: 'exit_maintenance' },
    ]);
    expect(CHUNK_BYTES).toBe(96);
    expect(steps).toEqual(['maintenance', 'upload', 'install', 'restore', null]);
  });

  it('leaves maintenance alone when the device was already in it', async () => {
    const { sent, run } = recorder();
    await runAppInstall(run, { appId: 'demo', devicePath: 'apps/demo.nha', dataHex: '00', alreadyInMaintenance: true });
    expect(sent.map((p) => p.command)).toEqual(['file_write_begin', 'file_write_chunk', 'file_write_finish', 'app_install']);
    expect(sent[3]).toEqual({ command: 'app_install', path: 'apps/demo.nha', replace: true });
  });

  it('restores maintenance after a failure, and reports the device error', async () => {
    const { sent, run } = recorder((p) => (p.command === 'app_install' ? 'os_too_old' : null));
    await expect(runAppInstall(run, { appId: 'demo', devicePath: 'apps/demo.nha', dataHex: '00', alreadyInMaintenance: false })).rejects.toThrow('os_too_old');
    expect(sent.at(-1)).toEqual({ command: 'exit_maintenance' });
  });

  it('does not touch the file system when maintenance is refused', async () => {
    const { sent, run } = recorder((p) => (p.command === 'enter_maintenance' ? 'busy' : null));
    await expect(runAppInstall(run, { appId: 'demo', devicePath: 'apps/demo.nha', dataHex: '00', alreadyInMaintenance: false })).rejects.toThrow('busy');
    expect(sent).toEqual([{ command: 'enter_maintenance', reason: 'app_install' }]);
  });

  it('can be cancelled between chunks', async () => {
    const { run } = recorder();
    const abortRef = { current: false };
    const progress: number[] = [];
    await expect(
      writeDeviceFile(run, {
        path: 'apps/demo.nha',
        bytes: DATA,
        abortRef,
        onProgress: (p) => {
          progress.push(p.loaded);
          if (p.loaded >= 96) abortRef.current = true;
        },
      }),
    ).rejects.toThrow('upload_cancelled');
    expect(progress).toEqual([0, 96]);
  });

  it('refuses a user path SPIFFS cannot hold, before sending anything', async () => {
    const { sent, run } = recorder();
    await expect(writeDeviceFile(run, { path: `apps/${'x'.repeat(MAX_USER_PATH)}.nha`, bytes: DATA })).rejects.toThrow('path_too_long');
    expect(sent).toEqual([]);
  });

  it('binds to a slot when asked', async () => {
    const { sent, run } = recorder();
    await installAppPackage(run, { appId: 'demo', devicePath: 'apps/demo.nha', dataHex: '00', slot: 2 });
    expect(sent.at(-1)).toEqual({ command: 'app_activate', id: 'demo', slot: 2 });
  });

  it('hex round-trips', () => {
    expect([...hexToBytes(bytesToHex(DATA))]).toEqual([...DATA]);
  });
});

describe('CommandOutcome adapter', () => {
  const ok = (data: unknown): CommandOutcome => ({ ok: true, message: 'ok', data });

  it('keeps both a result data object and its fields', () => {
    const result = outcomeResult(ok({ apps: [{ name: 'slot0' }], size: 10 }));
    expect(result).toMatchObject({ status: 'ok', size: 10, data: { apps: [{ name: 'slot0' }] } });
    expect(parseAppList(result)).toHaveLength(1);
  });

  it('turns a failure into the error record the Desktop code reads', () => {
    expect(outcomeResult({ ok: false, message: 'command_timeout', data: null })).toMatchObject({ status: 'error', ok: false, error: 'command_timeout' });
  });

  it('reads a file whose chunks come back as bare hex strings', async () => {
    const send = async (_uid: string, payload: Record<string, unknown>): Promise<CommandOutcome> => {
      if (payload.command === 'file_read_begin') return ok({ size: 4 });
      const offset = Number(payload.offset);
      return ok(offset === 0 ? 'aabb' : 'ccdd');
    };
    // The host hands back a chunk's `data` (the hex) without next_offset: the read advances by the bytes it got.
    const bytes = await readDeviceFile(commandRunner(send, 'A'), { path: 'apps/x.nha', chunkBytes: 2 });
    expect([...bytes]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it('runs one command at a time per device', async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const send = async (_uid: string, payload: Record<string, unknown>): Promise<CommandOutcome> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      order.push(String(payload.command));
      active -= 1;
      return ok({});
    };
    const run = commandRunner(send, 'A');
    await Promise.all([run({ command: 'a' }), run({ command: 'b' }), run({ command: 'c' })]);
    expect(peak).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('maintenance modes', () => {
    expect(['maintenance', 'safe_maintenance', 'SafeMaintenance'].every(isMaintenance)).toBe(true);
    expect(isMaintenance('normal')).toBe(false);
  });
});

describe('device app state', () => {
  it('parses app_list, packages, events and free slots', () => {
    const apps = parseAppList({ data: { apps: [
      { name: 'slot0', state: 'running', budget_us: 1000, last_us: 250, state_detail: { package: 'steps', nodes: 5 } },
      { name: 'slot1', state: 'killed', idle: true },
      { name: 'slot2', state: 'weird' },
    ] } });
    expect(apps.map((a) => [a.name, a.state, a.idle])).toEqual([['slot0', 'running', false], ['slot1', 'killed', true], ['slot2', 'unknown', false]]);
    expect(budgetPercent(apps[0]!)).toBe(25);
    expect(needsRevive(apps[1]!)).toBe(true);
    const packages = parsePackageList({ data: { packages: [{ id: 'steps', slot: 0, kind: 'flow' }, { id: 'scan', kind: 'readout' }] } });
    expect(packages.map((p) => [p.id, p.slot, p.kind])).toEqual([['steps', 0, 'flow'], ['scan', -1, 'readout']]);
    expect(freeSlots(apps, packages)).toEqual([1, 2]);
    expect(parsePackageList({ data: { registry: { packages: [{ id: 'x' }] } } })[0]?.id).toBe('x');
    const events = parseAppEvents({ data: { seq: 40, dropped: 2, events: [{ seq: 39, ms: 10, frame_seq: 7, app: 'slot0', event: 'pressed', value: 3 }] } });
    expect(events).toEqual({ seq: 40, dropped: 2, events: [{ seq: 39, ms: 10, frameSeq: 7, app: 'slot0', event: 'pressed', detail: '', value: 3 }] });
  });

  it('parses app_view and spots firmware without it', () => {
    const view = parseAppView({ data: {
      oled: { hw: true, page: 'app', on_screen: true, rows: [{ kind: 'text', text: 'Hi', slot: 'slot0' }, null, { kind: 'bar', label: 'L', x0: 20, width: 100, fill_px: 50, slot: 'slot1', contended: ['slot2'] }] },
      status_led: { rgb: [0, 255, 0], owner: 'slot0', app_request: { slot: 'slot0', rgb: [0, 255, 0] } },
      ext_led: { count: 3, owner: 'app', pixels: [[1, 2, 3]] },
    } });
    expect(view.oled.rows[0]).toMatchObject({ kind: 'text', text: 'Hi' });
    expect(view.oled.rows[2]).toMatchObject({ kind: 'bar', bar: { x0: 20, width: 100, fillPx: 50 }, contended: ['slot2'] });
    expect(view.oled.rows[3]).toBeNull();
    expect(view.statusLed.request).toMatchObject({ slot: 'slot0', suppressed: false });
    expect(view.extLed.pixels).toEqual([[1, 2, 3]]);
    expect(isUnknownCommand({ status: 'error', error: 'unknown_command' })).toBe(true);
    expect(isUnknownCommand({ status: 'ok' })).toBe(false);
  });

  it('explains known device errors by code', () => {
    expect(appErrorKey('os_too_old:v1.9.0')).toBe('appError_os_too_old');
    expect(appErrorKey('file_checksum_mismatch')).toBe('appError_checksum_mismatch');
    expect(appErrorKey('mystery')).toBeNull();
  });
});

describe('catalog helpers', () => {
  it('localises with an English fallback', () => {
    expect(localised({ en: 'Steps', ja: '歩数' }, 'ja')).toBe('歩数');
    expect(localised({ en: 'Steps' }, 'zh-CN')).toBe('Steps');
    expect(localised('Plain', 'ja')).toBe('Plain');
    expect(localised(undefined, 'en')).toBe('');
  });

  it('min_os compares release cores; the registry needs v1.1.0', () => {
    expect(satisfiesMinOs({ min_os: 'v1.6.0' }, 'v1.6.0-beta.1')).toBe(true);
    expect(satisfiesMinOs({ min_os: 'v1.6.0' }, 'v1.5.9')).toBe(false);
    expect(satisfiesMinOs({ min_os: 'v1.6.0' }, undefined)).toBe(true);
    expect(installMinFirmware({ min_os: 'v1.0.0' })).toBe('v1.1.0');
    expect(installMinFirmware({ min_os: 'v1.19.0' })).toBe('v1.19.0');
    expect(installBlocker({ min_os: 'v1.6.0' }, { online: false, firmwareVersion: 'v2.0.0' })).toBe('offline');
    expect(installBlocker({ min_os: 'v1.6.0' }, { online: true, firmwareVersion: 'unknown' })).toBe('firmware');
    expect(installBlocker({ min_os: 'v1.6.0' }, { online: true, firmwareVersion: 'v1.19.0' })).toBe('');
    expect(categoriesOf([{ category: 'gait' }, {}, { category: 'diagnostics' }])).toEqual(['diagnostics', 'gait', 'other']);
  });
});
