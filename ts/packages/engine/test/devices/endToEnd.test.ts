// End to end on the real core runtime with fake sockets: a device is found
// by FindMe, adopted (offer_policy "managed"), streams v5 packets, is
// recorded with app events (streamed and polled), and the recording is
// stopped. The files the live engine wrote must equal what convertRaw()
// makes of a .nhraw captured from the same run -- and convertRaw is itself
// checked byte for byte against the Desktop backend's Python
// (test/recording/nhraw.test.ts, recording.differential.test.ts).
import { describe, expect, it } from 'vitest';

import { utf8Decode, utf8Encode, type Json } from '@nhgw/core';

import { DEVICE_ADDR, jsonFrame, makeRuntime } from '../../../core/test/runtime/helpers';
import { DeviceService, type DeviceEvent } from '../../src/devices';
import { MemoryRecordingSink, NhrawWriter, convertRaw, recordingKnowledgeEvent } from '../../src';
import { encodePacket, FLAG, type AppEventSpec } from '../parse/packets';

const UID = 'AABBCCDDEEF0';
const FINDME_FROM = { ip: DEVICE_ADDR.ip, port: 22346 };
const STATUS = {
  device_name: `NHOS-${UID}`,
  mode: 'normal',
  firmware_version: 'v1.19.0',
  system: { hardware_model: 'TIA-CTL v2.3.D GCU LTS', firmware_version: 'v1.19.0' },
  matrix_shape: { rows: 1, cols: 3 },
  runtime: { scan_timing: { target_fps: 60, send_every_n_frames: 1 } },
  clock: { source: 'gateway', synced: true },
};
// Written by hand so 1.0 / 50.0 stay floats, as the firmware sends them.
const statusJson = (enabled: boolean) =>
  JSON.stringify({ type: 'status', device_uid: UID, payload: STATUS }).replace(
    '"clock":',
    `"calibration":{"enabled":${enabled},"fit_settings":{"k":1.0}},"battery":{"soc_percent":50.0,"vbat_mv":3800},"clock":`,
  );

describe('FindMe -> adopt -> stream -> record -> app events -> stop', () => {
  it('records what convertRaw makes of the same run, and keeps unadopted devices out', async () => {
    const h = await makeRuntime({ offer_policy: 'managed', managed_devices: [] });
    // convertRaw's clocks: monotonic ms = wall µs / 1000.
    h.clock.mono = h.clock.wallMs;
    await h.runtime.start();
    const sink = new MemoryRecordingSink();
    let seq = 0;
    const service = new DeviceService({
      clock: h.clock,
      clientType: 'pocket',
      newRequestId: () => `e2e${(++seq).toString(16).padStart(29, '0')}`,
      recording: { sink, dataRoot: '', serverTimeZone: '+00:00' },
      // Every status while recording (presence ones too) goes into the capture.
      onRecordingKnowledge: (_uid, event) => rawRef?.event(h.clock.nowEpochUs(), event),
    });
    let rawRef: NhrawWriter | null = null;
    service.bindRuntime(h.runtime);
    const events: DeviceEvent[] = [];
    service.on((event) => events.push(event));
    const step = async (ms: number) => {
      h.clock.advance(ms / 1000);
      await h.runtime.tick();
      service.tick();
    };

    let frameId = 0;
    let epoch = h.clock.wallMs - 400; // the device clock runs 400 ms behind arrival (a stop drains)
    const packet = (eventsIn: AppEventSpec[] = []) => {
      frameId += 1;
      epoch += 16;
      return encodePacket({
        uid: UID,
        frameId,
        timestamp: epoch,
        flags: FLAG.EPOCH,
        matrix: [frameId * 0.5, 1, -frameId / 3],
        imu: [1, 2, 3, 0.5, 0.25, 0.125, 30],
        battery: { status: 1, fault: 0, vbat_mv: 3800, soc_centi_percent: 5000 },
        events: eventsIn,
      });
    };

    // 1. Seen by FindMe while attached to the server: nearby, not ours.
    h.runtime.onFindmePacket(jsonFrame({ type: 'findme_discover', device_uid: UID, current_gateway_id: 'server' }), FINDME_FROM);
    expect(service.nearby()).toMatchObject([{ device_uid: UID, managed: false, findme_reason: 'device_attached_elsewhere' }]);
    h.runtime.onUdpPacket(packet(), DEVICE_ADDR);
    expect(h.upstream().packets).toEqual([]);
    expect(service.getDevice(UID)).toBeNull();

    // 2. Adopted: switch command out, its discover now gets our claimed offer.
    expect((await h.runtime.operations().adopt(UID)).data).toMatchObject({ switch_sent: true });
    h.runtime.onFindmePacket(
      jsonFrame({ type: 'findme_discover', device_uid: UID, preferred_gateway_id: 'gw-a', claim_id: 'claim-1' }),
      FINDME_FROM,
    );
    expect(h.findme.json()).toMatchObject({ accept: true, claim_id: 'claim-1' });

    // 3. Streams and reports a full status.
    h.runtime.onUdpPacket(utf8Encode(statusJson(true)), DEVICE_ADDR);
    for (let i = 0; i < 5; i++) {
      await step(16);
      h.runtime.onUdpPacket(packet(), DEVICE_ADDR);
    }
    await step(5000); // roster sync: gateway_id / client_type on the entry
    expect(service.getDevice(UID)).toMatchObject({ gateway_id: 'gw-a', client_type: 'pocket', gateway_connected: true });
    expect(h.upstream().packets.length).toBeGreaterThan(0);

    // 4. Recording on; the .nhraw twin captures the same inputs.
    const raw = new NhrawWriter({ deviceUid: UID, startEpochUs: h.clock.nowEpochUs() });
    rawRef = raw;
    const sentBefore = h.stream.sent.length;
    expect(service.setRecording(UID, true)).toEqual({ device_uid: UID, enabled: true, finishing: false });
    expect(h.stream.sent.length).toBe(sentBefore); // the status is full: no recmeta request
    const capture = (bytes: Uint8Array) => {
      // Handled first: a presence status this frame causes is a knowledge
      // event (onRecordingKnowledge) that must precede the frame in the capture.
      const at = h.clock.nowEpochUs();
      h.runtime.onUdpPacket(bytes, DEVICE_ADDR);
      raw.record(at, 'stream', bytes);
    };
    const knowledge = (statusUpdate: boolean) =>
      raw.event(h.clock.nowEpochUs(), recordingKnowledgeEvent(service.recordingKnowledge(UID), statusUpdate));
    const pollsSeen = new Set<number>();
    const requestIds = new Set<string>();
    const capturePolls = () => {
      h.stream.sent.forEach((sent, index) => {
        if (pollsSeen.has(index)) return;
        pollsSeen.add(index);
        const frame = JSON.parse(utf8Decode(sent.data)) as Json;
        const payload = frame.payload as Json;
        // The dispatcher resends until acked: one request per request_id.
        if (payload?.command === 'app_events' && !requestIds.has(String(payload.request_id))) {
          requestIds.add(String(payload.request_id));
          raw.event(h.clock.nowEpochUs(), { type: 'app_events_request', request_id: payload.request_id, since: payload.since_seq });
        }
      });
    };
    h.stream.sent.forEach((_s, i) => pollsSeen.add(i));
    knowledge(false);

    for (let i = 1; i <= 160; i++) {
      // Frames 80-99 arrive late (the recording falls ~0.5 s behind, so the
      // stop drains); after the stop the backlog arrives in a burst.
      await step(i >= 80 && i < 100 ? 40 : i > 100 ? 2 : 16);
      capturePolls();
      const streamed: AppEventSpec[] =
        i === 10 ? [{ seq: 1, frame_seq: frameId + 1, ms: 5, app: 'flow', event: 'tap', detail: '', value: 2 }] :
        i === 40 ? [{ seq: 4, frame_seq: frameId + 1, ms: 9, app: 'flow', event: 'tap', detail: 'x' }] : [];
      capture(packet(streamed));
      if (i === 41) {
        // The gap (2, 3) is asked for; the device answers the latest request.
        capturePolls();
        const request = [...h.stream.sent].reverse().map((s) => JSON.parse(utf8Decode(s.data)) as Json).find((f) => (f.payload as Json)?.command === 'app_events')!;
        const reply = utf8Encode(
          `{"type":"result","device_uid":"${UID}","request_id":"${request.request_id}","payload":{"ok":true,"cmd":"app_events","message":"app_events","data":{"seq":4,"streaming":true,"events":[{"seq":2,"frame_seq":${frameId - 5},"ms":7,"app":"flow","event":"tap","detail":"","value":1.0}]},"error":""}}`,
        );
        raw.record(h.clock.nowEpochUs(), 'control', reply);
        h.runtime.onUdpPacket(reply, DEVICE_ADDR);
      }
      if (i === 60) {
        // A status mid-recording: the meta refreshes (calibration turned off is a tracked change).
        const status = utf8Encode(statusJson(false));
        h.runtime.onUdpPacket(status, DEVICE_ADDR);
      }
      if (i === 100) {
        raw.event(h.clock.nowEpochUs(), { type: 'stop' });
        expect(service.setRecording(UID, false)).toMatchObject({ enabled: false, finishing: true });
      }
    }
    capturePolls();
    expect(service.recorders.get(UID)!.finishing).toBe(false);

    const live = new Map([...sink.files].filter(([path]) => path.startsWith(`${UID}/`)));
    const replay = convertRaw(raw.bytes(), { serverTimeZone: '+00:00' });
    expect([...live.keys()].sort()).toEqual([...replay.files.keys()].sort());
    expect(live.size).toBe(3);
    if (process.env.NH_E2E_DUMP) {
      const fs = await import('node:fs');
      for (const [path, text] of replay.files) {
        fs.writeFileSync(`${process.env.NH_E2E_DUMP}/replay-${path.split('/').at(-1)}`, text);
        fs.writeFileSync(`${process.env.NH_E2E_DUMP}/live-${path.split('/').at(-1)}`, live.get(path) ?? '');
      }
      const { readNhraw } = await import('../../src');
      const lines = readNhraw(raw.bytes()).records.map((r) => `${r.rxEpochUs} ${r.source} ${r.source === 'stream' ? r.payload.length : utf8Decode(r.payload)}`);
      fs.writeFileSync(`${process.env.NH_E2E_DUMP}/raw.txt`, lines.join('\n'));
    }
    for (const [path, text] of replay.files) expect(live.get(path), path).toBe(text);

    const meta = JSON.parse([...live].find(([p]) => p.endsWith('.meta.json'))![1]) as Json;
    expect(meta.transport).toMatchObject({ relay: 'pocket', relay_id: 'gw-a' });
    expect((meta.recording as Json).stop_reason).toBe('user');
    const eventsCsv = [...live].find(([p]) => p.endsWith('.events.csv'))![1];
    // header, streamed 1 and 4, polled 2, and seq 3 marked lost (the reply did not bring it).
    expect(eventsCsv.split('\n').filter(Boolean).map((line) => line.split(',').slice(0, 2).join(','))).toEqual([
      'seq,frame_seq', '1,16', '4,46', '2,42', '2,0',
    ]);
    expect(events.filter((e) => e.type === 'recording_update').map((e) => [(e as Json).enabled, (e as Json).finishing])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
    // Floats from device JSON stayed floats in the table (and so in the meta).
    expect([...live].find(([p]) => p.endsWith('.meta.json'))![1]).toContain('"k": 1.0');
  });
});
