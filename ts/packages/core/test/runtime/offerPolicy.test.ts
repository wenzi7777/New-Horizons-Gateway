// FindMe offer policy (NH Studio / NH Pocket): "managed" offers only to the
// devices this host manages, adopt/release move devices in and out, and the
// runtime observer lets an engine watch frames and take over Backend commands.
// "all" (the default) must stay exactly the Gateway's behaviour.
import { describe, expect, it } from 'vitest';

import { GatewayConfigStore, defaultConfig, normalizeConfig } from '../../src/config';
import type { Json } from '../../src/contracts';
import {
  CLAIM_PRIORITY_BOOST,
  DENIED_COOLDOWN_MS,
  MANAGED_OFFER_PRIORITY,
  decideFindme,
  type FindmeContext,
  type GatewayRuntimeObserver,
} from '../../src/runtime';
import { DEVICE_ADDR, MemoryStore, UID, heartbeatPacket, jsonFrame, makeRuntime, v5Packet } from './helpers';

const OTHER = 'AABBCCDDEEFF';
const FINDME_FROM = { ip: DEVICE_ADDR.ip, port: 22346 };

function ctx(overrides: Partial<FindmeContext> = {}): FindmeContext {
  return {
    gatewayId: 'gw-a',
    gatewayName: 'NH Studio',
    priority: 100,
    udpPort: 13250,
    upstreamStatus: 'online',
    isDenied: () => false,
    activeClaim: () => null,
    nowMs: 1_794_000_000_000,
    ...overrides,
  };
}

function managedCtx(managed: string[], overrides: Partial<FindmeContext> = {}): FindmeContext {
  return ctx({ offerPolicy: 'managed', isManaged: (uid) => managed.includes(uid), ...overrides });
}

describe('config: offer_policy / managed_devices / released_devices', () => {
  it('a config without them is unchanged (no keys added on load or save)', async () => {
    const disk = new MemoryStore({ gateway_id: 'gw-a' });
    const store = await GatewayConfigStore.load(disk);
    await store.save({});
    expect('offer_policy' in disk.value!).toBe(false);
    expect('managed_devices' in disk.value!).toBe(false);
    expect('released_devices' in disk.value!).toBe(false);
    expect(store.offerPolicy()).toBe('all');
    expect(store.managedDevices()).toEqual([]);
    expect(store.isManaged(UID)).toBe(false);
  });

  it('normalizes the policy and the UID lists', () => {
    const config = normalizeConfig({
      ...defaultConfig(),
      offer_policy: ' MANAGED ',
      managed_devices: ['3c:dc:75:45:cc:d0', ' aabbccddeeff', 'AABBCCDDEEFF', '', null],
      released_devices: 'not a list',
    });
    expect(config.offer_policy).toBe('managed');
    expect(config.managed_devices).toEqual(['3CDC7545CCD0', 'AABBCCDDEEFF']);
    expect(config.released_devices).toEqual([]);
    expect(normalizeConfig({ ...defaultConfig(), offer_policy: 'everyone' }).offer_policy).toBe('all');
  });

  it('manage / release move a UID between the lists and persist', async () => {
    const disk = new MemoryStore({});
    const store = await GatewayConfigStore.load(disk);
    await store.manage('3c-dc-75-45-cc-d0');
    expect(store.isManaged(UID)).toBe(true);
    expect(disk.value!.managed_devices).toEqual([UID]);
    await store.release(UID);
    expect(store.isManaged(UID)).toBe(false);
    expect(store.isReleased(UID)).toBe(true);
    expect(disk.value!.released_devices).toEqual([UID]);
    await store.manage(UID);
    expect(store.isReleased(UID)).toBe(false);
    expect(store.snapshot().managed_devices).toEqual([UID]);
  });

  it('setOfferPolicy refuses an unknown policy', async () => {
    const store = await GatewayConfigStore.load(new MemoryStore({}));
    await expect(store.setOfferPolicy('some')).rejects.toThrow('invalid_offer_policy');
    expect((await store.setOfferPolicy('managed')).offer_policy).toBe('managed');
  });
});

describe('decideFindme under "all" is the Gateway behaviour', () => {
  it('offers to every device; one it owns (took over) at the owner priority', () => {
    const plain = decideFindme({ device_uid: UID }, ctx());
    const withList = decideFindme({ device_uid: UID }, ctx({ offerPolicy: 'all', isManaged: () => false }));
    expect(withList).toEqual(plain);
    expect(plain.reply).toMatchObject({ accept: true, priority: 100 });
    expect(decideFindme({ device_uid: UID }, ctx({ offerPolicy: 'all', isManaged: () => true })).reply!.priority).toBe(MANAGED_OFFER_PRIORITY);
    // Taken over by another relay since: only a fallback.
    expect(decideFindme({ device_uid: UID }, ctx({ offerPolicy: 'all', isManaged: () => true, isOwned: () => false })).reply!.priority).toBe(100);
  });
});

describe('decideFindme under "managed"', () => {
  it('offers to a managed device above the server (200), keeping the claim boost', () => {
    const d = decideFindme({ device_uid: UID }, managedCtx([UID]));
    expect(d.record).toEqual({ accepted: true, reason: '' });
    expect(d.reply).toMatchObject({ accept: true, priority: MANAGED_OFFER_PRIORITY });
    const claimed = decideFindme(
      { device_uid: UID },
      managedCtx([UID], { activeClaim: () => ({ claim_id: 'c1' }) }),
    );
    expect(claimed.reply).toMatchObject({ claim_id: 'c1', priority: MANAGED_OFFER_PRIORITY + CLAIM_PRIORITY_BOOST });
  });

  it('a configured priority above 200 is kept', () => {
    expect(decideFindme({ device_uid: UID }, managedCtx([UID], { priority: 500 })).reply!.priority).toBe(500);
  });

  it('stays silent to an unmanaged device and records it as nearby', () => {
    const d = decideFindme({ device_uid: OTHER }, managedCtx([UID]));
    expect(d).toEqual({ record: { accepted: false, reason: 'device_unmanaged' }, reply: null });
  });

  it('never steals a managed device attached elsewhere', () => {
    const d = decideFindme({ device_uid: UID, current_gateway_id: 'server' }, managedCtx([UID]));
    expect(d).toEqual({ record: { accepted: false, reason: 'device_attached_elsewhere' }, reply: null });
  });

  it('a managed device switching to another host is declined, as before', () => {
    const d = decideFindme({ device_uid: UID, preferred_gateway_id: 'gw-b' }, managedCtx([UID]));
    expect(d.reply).toMatchObject({ accept: false, reason: 'device_switching_gateway' });
  });

  it('a denied device is still refused with device_rejected', () => {
    const d = decideFindme({ device_uid: UID }, managedCtx([UID], { isDenied: () => true }));
    expect(d.reply).toMatchObject({ accept: false, reason: 'device_rejected' });
  });
});

describe('released devices', () => {
  for (const policy of ['all', 'managed'] as const) {
    it(`are declined with device_released under "${policy}"`, () => {
      const d = decideFindme(
        { device_uid: UID, preferred_gateway_id: 'gw-a', claim_id: 'old' },
        ctx({ offerPolicy: policy, isManaged: () => false, isReleased: (uid) => uid === UID }),
      );
      expect(d.record).toEqual({ accepted: false, reason: 'device_released' });
      expect(d.reply).toMatchObject({
        type: 'findme_offer',
        device_uid: UID,
        accept: false,
        reason: 'device_released',
        cooldown_ms: DENIED_COOLDOWN_MS,
      });
      expect(d.reply!.claim_id).toBeUndefined();
    });
  }
});

async function managedRuntime(config: Json = {}) {
  const h = await makeRuntime({ offer_policy: 'managed', managed_devices: [UID], ...config });
  await h.runtime.start();
  return h;
}

describe('runtime under "managed"', () => {
  it('offers to managed devices only and lists the others as available nearby', async () => {
    const h = await managedRuntime();
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), FINDME_FROM);
    expect(h.findme.json(0)).toMatchObject({ accept: true, priority: 200 });
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: OTHER, device_name: 'other' }), FINDME_FROM);
    expect(h.findme.sent).toHaveLength(1);
    const nearby = h.runtime.state.snapshot([]).nearby_devices.find((d) => d.device_uid === OTHER)!;
    expect(nearby).toMatchObject({ findme_accepted: false, findme_reason: 'device_unmanaged', findme_state: 'available' });
  });

  it('a policy change applies to the next request', async () => {
    const h = await managedRuntime();
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: OTHER }), FINDME_FROM);
    expect(h.findme.sent).toHaveLength(0);
    expect((await h.runtime.operations().setOfferPolicy('all')).ok).toBe(true);
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: OTHER }), FINDME_FROM);
    expect(h.findme.json(0)).toMatchObject({ accept: true, priority: 100 });
    expect((await h.runtime.operations().setOfferPolicy('x')).error).toBe('invalid_offer_policy');
  });
});

describe('adopt', () => {
  it('adds to managed, claims, and sends findme_switch_gateway like serve()', async () => {
    const h = await managedRuntime({ managed_devices: [] });
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: OTHER, current_gateway_id: 'server' }), FINDME_FROM);
    const result = await h.runtime.operations().adopt(OTHER.toLowerCase());
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ managed_devices: [OTHER], switch_sent: true, claim: { claim_id: 'claim-1', state: 'requested' } });
    expect(h.runtime.configStore.isManaged(OTHER)).toBe(true);
    expect(h.upstream().claims).toEqual([[OTHER, 'claim-1', 30000]]);
    expect(h.stream.sent.at(-1)!.to).toEqual({ ip: DEVICE_ADDR.ip, port: 13250 });
    expect(h.stream.json()).toMatchObject({
      type: 'command',
      device_uid: OTHER,
      payload: { command: 'findme_switch_gateway', preferred_gateway_id: 'gw-a', claim_id: 'claim-1' },
    });
    // Its next discover (now preferring us) gets the claimed, managed offer.
    h.runtime.onFindmePacket(
      jsonFrame({ type: 'findme_discover', device_uid: OTHER, preferred_gateway_id: 'gw-a', claim_id: 'claim-1' }),
      FINDME_FROM,
    );
    expect(h.findme.json()).toMatchObject({ accept: true, claim_id: 'claim-1', priority: 200 + CLAIM_PRIORITY_BOOST });
  });

  it('works offline (NH Pocket): no claim request upstream, the device is still switched', async () => {
    const h = await managedRuntime({ managed_devices: [] });
    h.upstream().connected = false;
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: OTHER }), FINDME_FROM);
    const result = await h.runtime.operations().adopt(OTHER);
    expect(result).toMatchObject({ ok: true, data: { switch_sent: true } });
    expect(h.upstream().claims).toEqual([]);
    // serve() is adopt() now: it works offline too.
    expect(await h.runtime.operations().serve(OTHER)).toMatchObject({ ok: true });
  });

  it('without a known address it only joins the list', async () => {
    const h = await managedRuntime({ managed_devices: [] });
    const result = await h.runtime.operations().adopt(OTHER);
    expect(result).toMatchObject({ ok: true, data: { switch_sent: false, managed_devices: [OTHER] } });
    expect(h.stream.sent).toEqual([]);
  });

  it('refuses denied devices, empty UIDs and a locked Gateway', async () => {
    const h = await managedRuntime({ denied_devices: [OTHER] });
    expect(await h.runtime.operations().adopt(OTHER)).toMatchObject({ ok: false, error: 'device_denied', status: 409 });
    expect(await h.runtime.operations().adopt(' ')).toMatchObject({ ok: false, error: 'device_uid_required' });
    h.updates.required = true;
    expect((await h.runtime.operations().adopt(UID)).error).toBe('update_required');
    expect((await h.runtime.operations().release(UID)).error).toBe('update_required');
  });
});

describe('release', () => {
  it('removes from managed, sends findme_discover through the session, then declines the device', async () => {
    const h = await managedRuntime();
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    const result = await h.runtime.operations().release(UID);
    expect(result).toMatchObject({ ok: true, data: { managed_devices: [], released_devices: [UID], discover_sent: true } });
    expect(h.stream.sent.at(-1)!.to).toEqual(DEVICE_ADDR);
    expect(h.stream.json()).toMatchObject({ type: 'command', device_uid: UID, payload: { command: 'findme_discover' } });
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), FINDME_FROM);
    expect(h.findme.json()).toMatchObject({ accept: false, reason: 'device_released' });
    // Adopting again lifts the decline.
    await h.runtime.operations().adopt(UID);
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), FINDME_FROM);
    expect(h.findme.json()).toMatchObject({ accept: true });
  });

  it('falls back to the last FindMe address, and fails a claim in flight', async () => {
    const h = await managedRuntime();
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), FINDME_FROM);
    await h.runtime.operations().adopt(UID);
    const result = await h.runtime.operations().release(UID);
    expect(result.data.discover_sent).toBe(true);
    expect(h.stream.sent.at(-1)!.to).toEqual({ ip: DEVICE_ADDR.ip, port: 13250 });
    expect(h.runtime.state.claims.get('claim-1')).toMatchObject({ state: 'failed', last_error: 'device_released' });
  });

  it('persists the released list', async () => {
    const h = await managedRuntime();
    await h.runtime.operations().release(UID);
    expect(h.runtime.configStore.snapshot()).toMatchObject({ managed_devices: [], released_devices: [UID] });
  });
});

describe('runtime observer', () => {
  function recorder() {
    const calls: [string, ...unknown[]][] = [];
    const observer: GatewayRuntimeObserver = {
      onDeviceMessage: (type, data) => calls.push(['message', type, data.device_uid]),
      onDevicePacket: (uid, _packet, _from, info) => calls.push(['packet', uid, info]),
      onFindmeRequest: (request, _from, accepted, reason) => calls.push(['findme', request.device_uid, accepted, reason]),
      onDeliveryTimeout: (uid, payload) => calls.push(['timeout', uid, payload.command]),
    };
    return { calls, observer };
  }

  it('sees control frames, packets and FindMe decisions after the runtime handled them', async () => {
    const h = await makeRuntime();
    await h.runtime.start();
    const { calls, observer } = recorder();
    h.runtime.setObserver(observer);
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), FINDME_FROM);
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    h.runtime.onUdpPacket(v5Packet(), DEVICE_ADDR);
    h.runtime.onUdpPacket(jsonFrame({ type: 'status', device_uid: UID, payload: { mode: 'normal' } }), DEVICE_ADDR);
    h.runtime.onUdpPacket(jsonFrame({ type: 'ack', device_uid: UID, ack: 1 }), DEVICE_ADDR);
    expect(calls).toEqual([
      ['findme', UID, true, ''],
      ['packet', UID, { kind: 'heartbeat', attached: true, forwarded: false }],
      ['packet', UID, { kind: 'stream', attached: true, forwarded: true }],
      ['message', 'status', UID],
    ]);
    expect(h.upstream().deviceMessages.map(([t]) => t)).toEqual(['status']);
  });

  it('is not told about denied devices', async () => {
    const h = await makeRuntime({ denied_devices: [UID] });
    await h.runtime.start();
    const { calls, observer } = recorder();
    h.runtime.setObserver(observer);
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    h.runtime.onUdpPacket(jsonFrame({ type: 'status', device_uid: UID }), DEVICE_ADDR);
    expect(calls).toEqual([]);
  });

  it('can take over a Backend command; otherwise the runtime routes it', async () => {
    const h = await makeRuntime();
    await h.runtime.start();
    const taken: string[] = [];
    h.runtime.setObserver({
      onUpstreamCommand: (uid, payload) => {
        taken.push(`${uid}:${payload.command}`);
        return payload.command === 'status';
      },
    });
    h.upstream().callbacks!.onCommand(UID.toLowerCase(), { command: 'status', request_id: 'r1' });
    expect(taken).toEqual([`${UID}:status`]);
    expect(h.upstream().deviceMessages).toEqual([]);
    h.upstream().callbacks!.onCommand(UID, { command: 'reboot', request_id: 'r2' });
    expect(h.upstream().deviceMessages.at(-1)![1]).toMatchObject({ request_id: 'r2', message: 'device_not_connected_to_gateway' });
  });

  it('an expired command never reaches the observer', async () => {
    const h = await makeRuntime();
    await h.runtime.start();
    const taken: string[] = [];
    h.runtime.setObserver({ onUpstreamCommand: () => (taken.push('x'), true) });
    h.upstream().callbacks!.onCommand(UID, { command: 'status', expires_at_ms: h.clock.wallMs - 1 });
    expect(taken).toEqual([]);
    expect(h.upstream().deviceMessages.at(-1)![1]).toMatchObject({ message: 'command_expired' });
  });

  it('a throwing observer never breaks the runtime', async () => {
    const h = await makeRuntime();
    await h.runtime.start();
    h.runtime.setObserver({
      onDeviceMessage: () => {
        throw new Error('boom');
      },
      onUpstreamCommand: () => {
        throw new Error('boom');
      },
    });
    h.runtime.onUdpPacket(jsonFrame({ type: 'status', device_uid: UID }), DEVICE_ADDR);
    expect(h.upstream().deviceMessages).toHaveLength(1);
    h.upstream().callbacks!.onCommand(UID, { command: 'status', request_id: 'r' });
    // Not handled, so the runtime routed it to the device itself.
    expect(h.stream.json()).toMatchObject({ type: 'command', request_id: 'r' });
  });

  it('hears delivery timeouts after the runtime reported them upstream', async () => {
    const h = await makeRuntime();
    await h.runtime.start();
    const { calls, observer } = recorder();
    h.runtime.setObserver(observer);
    h.runtime.onUdpPacket(heartbeatPacket(), DEVICE_ADDR);
    h.runtime.udpCommands.sendCommand(UID, { command: 'status', request_id: 'r1' });
    for (let i = 0; i < 31; i++) {
      h.clock.advance(0.5);
      h.runtime.udpCommands.service();
    }
    expect(calls.at(-1)).toEqual(['timeout', UID, 'status']);
    expect(h.upstream().deviceMessages.at(-1)![1]).toMatchObject({ message: 'command_delivery_timeout' });
  });
});

describe('ownership: takeover, fallback, reclaim', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const attachedTo = (gw: string, priority?: number) =>
    jsonFrame({ type: 'findme_discover', device_uid: UID, current_gateway_id: gw, ...(priority === undefined ? {} : { current_priority: priority }) });

  it('a remote device_serve under "managed" adopts the device, so its FindMe is then answered', async () => {
    const h = await managedRuntime({ managed_devices: [] });
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: OTHER, current_gateway_id: 'nh-studio-rpi' }), FINDME_FROM);
    h.runtime.onUpstreamMessage({ type: 'gateway_command', request_id: 'q1', payload: { command: 'device_serve', device_uid: OTHER } });
    await h.runtime.idle();
    expect(h.upstream().commandResults[0]![1]).toMatchObject({ ok: true, message: 'claim_requested' });
    expect(h.runtime.configStore.isOwned(OTHER)).toBe(true);
    const claim = h.runtime.state.activeClaimFor(OTHER)!;
    h.runtime.onFindmePacket(
      jsonFrame({ type: 'findme_discover', device_uid: OTHER, preferred_gateway_id: 'gw-a', claim_id: claim.claim_id }),
      FINDME_FROM,
    );
    expect(h.findme.json(0)).toMatchObject({ accept: true, claim_id: claim.claim_id });
  });

  it('attached elsewhere at the owner priority (a takeover): yields once, stays managed, offers only as a fallback', async () => {
    const h = await managedRuntime();
    const taken: string[] = [];
    h.runtime.setObserver({ onTakenOver: (uid, by) => taken.push(`${uid}@${by}`) });
    h.runtime.onFindmePacket(attachedTo('studio-1234abcd', 10200), FINDME_FROM);
    await settle();
    expect(taken).toEqual([`${UID}@studio-1234abcd`]);
    expect(h.runtime.configStore.isManaged(UID)).toBe(true);
    expect(h.runtime.configStore.isOwned(UID)).toBe(false);
    expect(h.runtime.attachedTo(UID)).toBe('studio-1234abcd');
    h.runtime.onFindmePacket(attachedTo('studio-1234abcd', 200), FINDME_FROM);
    await settle();
    expect(taken).toHaveLength(1);
    expect(h.stream.sent).toEqual([]); // never asked back
    // The new owner is gone: this relay is a fallback (base priority).
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), FINDME_FROM);
    expect(h.findme.json(0)).toMatchObject({ accept: true, priority: 100 });
  });

  it('firmware that does not report current_priority is treated as a takeover', async () => {
    const h = await managedRuntime();
    h.runtime.onFindmePacket(attachedTo('nh-studio-rpi'), FINDME_FROM);
    await settle();
    expect(h.runtime.configStore.isYielded(UID)).toBe(true);
  });

  it('attached to a fallback (below the owner priority): the owner takes it back, at most every RECLAIM_COOLDOWN_MS', async () => {
    const h = await managedRuntime();
    h.runtime.onFindmePacket(attachedTo('nh-studio-rpi', 100), FINDME_FROM);
    await settle();
    expect(h.runtime.configStore.isOwned(UID)).toBe(true);
    const switches = () => h.stream.sent.filter((_, i) => JSON.stringify(h.stream.json(i)).includes('findme_switch_gateway')).length;
    expect(switches()).toBe(1);
    // The claim is live: nothing more.
    h.runtime.onFindmePacket(attachedTo('nh-studio-rpi', 100), FINDME_FROM);
    await settle();
    expect(switches()).toBe(1);
  });

  it('a relay serving every device (headless) owns what it took over too', async () => {
    const h = await makeRuntime({ offer_policy: 'all' });
    await h.runtime.start();
    expect((await h.runtime.operations().serve(OTHER)).ok).toBe(true);
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: OTHER }), FINDME_FROM);
    // Owner priority, plus the boost while its claim is live.
    expect(h.findme.json(0)).toMatchObject({ accept: true, priority: MANAGED_OFFER_PRIORITY + CLAIM_PRIORITY_BOOST });
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID }), FINDME_FROM);
    expect(h.findme.json(1)).toMatchObject({ accept: true, priority: 100 });
  });
});
