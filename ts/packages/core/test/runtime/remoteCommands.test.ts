// Ported from tests/test_gateway_remote_commands.py (RemoteCommandTest and the
// CAPABILITIES check; the auto-apply timing cases belong to src/update).
import { beforeEach, describe, expect, it } from 'vitest';

import type { GatewayConfig, GatewayConfigStore } from '../../src/config';
import type { Json } from '../../src/contracts';
import { CAPABILITIES, GATEWAY_COMMANDS, GatewayCommandHandler, GatewayOperations, GatewayState } from '../../src/runtime';
import { FakeClock, FakeUpdateControl, FakeUpstream, configStore } from './helpers';

let store: GatewayConfigStore;
let state: GatewayState;
let upstream: FakeUpstream;
let manager: FakeUpdateControl;
let clock: FakeClock;
let saved: GatewayConfig[];
let probes: number;
let results: [string, Json][];
let events: string[];
let restarts: number;
let afterCommands: number;

function ops(): GatewayOperations {
  return new GatewayOperations({
    configStore: store,
    state,
    upstream,
    udpControl: null,
    discovery: { sendProbe: () => void probes++ },
    updateControl: manager,
    onConfigSaved: (config) => {
      // What GatewayRuntime.applyRuntimeConfig does with the channel.
      saved.push(config);
      manager.setChannel(config.update_channel);
    },
  });
}

function handler(graceMs = 0): GatewayCommandHandler {
  return new GatewayCommandHandler({
    operations: ops,
    sendResult: (requestId, result) => {
      events.push('reply');
      results.push([requestId, result]);
    },
    restart: () => {
      events.push('restart');
      restarts++;
    },
    updateBlock: () => manager.updateBlock(''),
    afterCommand: () => void afterCommands++,
    clock,
    graceMs,
  });
}

let h: GatewayCommandHandler;

async function runCmd(command: string, args: Json = {}): Promise<Json> {
  const handled = h.handleMessage({ type: 'gateway_command', request_id: 'r1', payload: { command, ...args } });
  expect(handled).toBe(true);
  await h.idle();
  expect(results.at(-1)![0]).toBe('r1');
  return results.at(-1)![1];
}

beforeEach(async () => {
  store = await configStore();
  await store.save({ gateway_id: 'gw-a', enabled: true, target_mode: 'local' });
  clock = new FakeClock();
  state = new GatewayState({ clock, newClaimId: () => 'claim-1' });
  upstream = new FakeUpstream('gw-a');
  manager = new FakeUpdateControl();
  saved = [];
  probes = 0;
  results = [];
  events = [];
  restarts = 0;
  afterCommands = 0;
  h = handler();
});

describe('GatewayCommandHandler', () => {
  it('ignores other messages', () => {
    expect(h.handleMessage({ type: 'gateway_hello_ack' })).toBe(false);
  });

  it('unknown command', async () => {
    const result = await runCmd('format_disk');
    expect(result.ok).toBe(false);
    expect(result.message).toBe('unknown_command');
    expect(result.command).toBe('format_disk');
  });

  it('set_config replies before applying and keeps enabled', async () => {
    const result = await runCmd('set_config', {
      gateway_id: 'gw-b',
      target_mode: 'manual',
      manual_url: 'ws://10.0.0.2:5051/newhorizons/gateway/ws',
      enabled: false,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toBe('config_saved_reconnecting');
    const config = store.snapshot();
    expect(config.gateway_id).toBe('gw-b');
    expect(config.server_url).toBe('ws://10.0.0.2:5051/newhorizons/gateway/ws');
    expect(config.enabled).toBe(true); // remote never disables
    expect(saved).toHaveLength(1);
  });

  it('remote management defaults on', () => {
    expect(store.snapshot().remote_management).toBe(true);
  });

  it('remote management off refuses every command', async () => {
    await store.save({ remote_management: false });
    for (const command of GATEWAY_COMMANDS) {
      const result = await runCmd(command, { gateway_id: 'gw-b', channel: 'beta', device_uid: 'AA' });
      expect(result.ok, command).toBe(false);
      expect(result.message).toBe('remote_management_disabled');
    }
    expect(store.snapshot().gateway_id).toBe('gw-a');
    expect(restarts).toBe(0);
    expect(saved).toEqual([]);
  });

  it('remote cannot change remote_management', async () => {
    await store.save({ remote_management: false });
    const plain = new GatewayOperations({ configStore: store, state, upstream, updateControl: manager });
    await plain.saveSettings({ remote_management: true }, false);
    expect(store.snapshot().remote_management).toBe(false);
    await plain.saveSettings({ remote_management: true });
    expect(store.snapshot().remote_management).toBe(true);
  });

  it('set_config rejects bad values without saving', async () => {
    const cases: [Json, string][] = [
      [{ gateway_id: 'bad id!' }, 'gateway_id_invalid'],
      [{ target_mode: 'manual', manual_url: 'http://x' }, 'invalid_manual_url'],
      [{ target_mode: 'cloud' }, 'invalid_target_mode'],
      [{}, 'nothing_to_change'],
    ];
    for (const [args, message] of cases) {
      const result = await runCmd('set_config', args);
      expect(result.ok).toBe(false);
      expect(result.message).toBe(message);
    }
    expect(store.snapshot().gateway_id).toBe('gw-a');
    expect(saved).toEqual([]);
  });

  it('a required update locks config and devices but not the channel', async () => {
    manager.setServerLatestVersion('v99.0.0');
    expect((await runCmd('set_config', { gateway_id: 'gw-b' })).message).toBe('update_required');
    expect((await runCmd('discover')).message).toBe('update_required');
    expect((await runCmd('device_reject', { device_uid: 'AA' })).message).toBe('update_required');
    expect((await runCmd('set_update_channel', { channel: 'beta' })).ok).toBe(true);
  });

  it('set_update_channel', async () => {
    const result = await runCmd('set_update_channel', { channel: 'beta' });
    expect(result.ok).toBe(true);
    expect(store.snapshot().update_channel).toBe('beta');
    expect((result.update as Json).channel).toBe('beta');
    expect((await runCmd('set_update_channel', { channel: 'nightly' })).ok).toBe(false);
  });

  it('device commands', async () => {
    expect((await runCmd('discover')).ok).toBe(true);
    expect(probes).toBe(1);
    let result = await runCmd('device_reject', { device_uid: 'aa11' });
    expect(result.denied_devices).toEqual(['AA11']);
    expect((await runCmd('device_serve', { device_uid: 'AA11' })).message).toBe('device_denied');
    expect((await runCmd('device_allow', { device_uid: 'AA11' })).denied_devices).toEqual([]);
    result = await runCmd('device_serve', { device_uid: 'AA11' });
    expect(result.ok).toBe(true);
    expect(result.message).toBe('claim_requested');
    expect((result.claim as Json).state).toBe('requested');
    expect(upstream.claims[0]![0]).toBe('AA11');
    expect((await runCmd('device_allow')).message).toBe('device_uid_required');
  });

  it('restart replies first', async () => {
    const result = await runCmd('restart');
    expect(result.ok).toBe(true);
    expect(events).toEqual(['reply', 'restart']);
  });

  it('factory reset clears identity and keeps ports', async () => {
    await store.save({ listen_web_port: 6000, denied_devices: ['AA'] });
    const result = await runCmd('factory_reset');
    expect(result.ok).toBe(true);
    const config = store.snapshot();
    expect(config.enabled).toBe(false);
    expect(config.gateway_id).toBe('');
    expect(config.denied_devices).toEqual([]);
    expect(config.listen_web_port).toBe(6000);
  });

  it('check_update reports versions', async () => {
    manager.checkResult = { latest: 'v99.0.0', required: true };
    const result = await runCmd('check_update');
    expect(result.message).toBe('update_available');
    expect(result.current_version).toBe(manager.currentVersion);
    expect((result.update as Json).version).toBe('v99.0.0');
    expect((result.update as Json).required_update).toBe(true);
  });

  it('check_update reports a failed check', async () => {
    manager.checkResult = { phase: 'error' };
    const result = await runCmd('check_update');
    expect(result.ok).toBe(false);
    expect(result.message).toBe('update_check_failed');
  });

  it('apply_update starts the updater', async () => {
    const result = await runCmd('apply_update');
    expect(result.message).toBe('update_started');
    expect(manager.starts).toBe(1);
    expect((await runCmd('apply_update')).message).toBe('update_in_progress');
    expect(manager.starts).toBe(1);
  });

  it('the command list is what the Desktop expects', () => {
    expect(new Set(GATEWAY_COMMANDS)).toEqual(
      new Set(['set_config', 'check_update', 'apply_update', 'set_update_channel', 'restart', 'factory_reset', 'discover', 'device_reject', 'device_allow', 'device_serve']),
    );
    expect([...CAPABILITIES]).toEqual(['gateway_command', 'auto_update']);
  });
});

describe('GatewayCommandHandler (TS additions)', () => {
  it('connection-cutting commands act only after the grace period, then push status', async () => {
    h = handler(1000);
    await runCmd('restart');
    expect(events).toEqual(['reply']);
    expect(h.pendingDeferred()).toBe(1);
    expect(afterCommands).toBe(0);
    clock.advance(0.5);
    await h.service();
    expect(restarts).toBe(0);
    clock.advance(0.5);
    await h.service();
    expect(events).toEqual(['reply', 'restart']);
    expect(afterCommands).toBe(1);
    expect(h.pendingDeferred()).toBe(0);
  });

  it('set_config with grace saves only after the reply has had time to leave', async () => {
    h = handler(1000);
    await runCmd('set_config', { gateway_id: 'gw-b' });
    expect(store.snapshot().gateway_id).toBe('gw-a');
    clock.advance(1);
    await h.service();
    expect(store.snapshot().gateway_id).toBe('gw-b');
  });

  it('a command that throws replies command_failed', async () => {
    manager.check = async () => {
      throw new Error('boom');
    };
    const result = await runCmd('check_update');
    expect(result).toEqual({ ok: false, message: 'command_failed', error: 'boom', command: 'check_update' });
    expect(afterCommands).toBe(1);
  });

  it('request_id falls back to the payload', async () => {
    h.handleMessage({ type: 'gateway_command', payload: { command: 'discover', request_id: 'p1' } });
    await h.idle();
    expect(results.at(-1)![0]).toBe('p1');
  });
});
