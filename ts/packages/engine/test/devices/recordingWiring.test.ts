// DeviceService's recording switch, frame ingestion and Python float
// fidelity, without the runtime.
import { describe, expect, it } from 'vitest';

import { utf8Encode } from '@nhgw/core';

import { MemoryRecordingSink, PyFloat } from '../../src';
import { encodePacket, FLAG } from '../parse/packets';
import { ADDR, UID, makeService } from './helpers';

function withRecording() {
  const sink = new MemoryRecordingSink();
  const h = makeService({ recording: { sink, dataRoot: 'rec', serverTimeZone: '+00:00' }, clientType: 'pocket', relayId: () => 'pocket-1' });
  return { ...h, sink };
}

describe('recording switch', () => {
  it('is unavailable without a sink; needs a device UID', () => {
    const h = makeService();
    expect(() => h.service.setRecording(UID, true)).toThrow('recording_unavailable');
    const r = withRecording();
    expect(() => r.service.setRecording('', true)).toThrow('device_uid_required');
  });

  it('asks for a full status when none is known, and emits recording_update', () => {
    const h = withRecording();
    expect(h.service.setRecording(UID, true)).toEqual({ device_uid: UID, enabled: true, finishing: false });
    expect(h.transport.sent.map(([, p]) => [p.command, p.quiet, String(p.request_id).startsWith('recmeta-')])).toEqual([['status', true, true]]);
    expect(h.events.filter((e) => e.type === 'recording_update')).toEqual([{ type: 'recording_update', device_uid: UID, enabled: true, finishing: false }]);
    expect(h.service.recordingEnabled(UID)).toBe(true);
  });

  it('frames go to the recording and the table; the meta names this host as the relay', () => {
    const h = withRecording();
    h.service.ingestControlFrame({ type: 'status', device_uid: UID, payload: { system: { hardware_model: 'TIA-CTL v2.3.D GCU LTS' }, matrix_shape: { rows: 1, cols: 2 } } }, ADDR);
    h.service.setRecording(UID, true);
    for (let i = 1; i <= 3; i++) {
      h.clock.advance(0.016);
      h.service.ingestStreamPacket(encodePacket({ uid: UID, frameId: i, timestamp: 1_000 + i, flags: 0, matrix: [i, 0.5] }));
    }
    h.service.setRecording(UID, false);
    const files = [...h.sink.files.keys()];
    expect(files.some((p) => p.startsWith(`rec/${UID}/`) && p.endsWith('.data.csv'))).toBe(true);
    const meta = JSON.parse([...h.sink.files].find(([p]) => p.endsWith('.meta.json'))![1]);
    expect(meta.transport).toMatchObject({ relay: 'pocket', relay_id: 'pocket-1' });
    expect(h.service.getDevice(UID)).toMatchObject({ recording_enabled: false, recording_finishing: false, visualization_source: 'udp' });
    expect(h.events.filter((e) => e.type === 'visualization_update')).toHaveLength(3);
  });

  it('a packet that does not parse is dropped; heartbeats are not frames', () => {
    const h = withRecording();
    h.service.ingestStreamPacket(new Uint8Array([0x5a, 0xa5, 5, 0]));
    h.service.ingestStreamPacket(encodePacket({ uid: UID, flags: FLAG.HEARTBEAT }));
    expect(h.service.listDevices()).toEqual([]);
  });

  it('a host stop ends recordings as server_stopped', () => {
    const h = withRecording();
    h.service.setRecording(UID, true);
    h.service.ingestStreamPacket(encodePacket({ uid: UID, frameId: 1, matrix: [1] }));
    h.service.stop();
    const meta = JSON.parse([...h.sink.files].find(([p]) => p.endsWith('.meta.json'))![1]);
    expect(meta.recording.stop_reason).toBe('server_stopped');
  });
});

describe('Python float fidelity', () => {
  it('device JSON keeps 1.0 a float in the table (parsePyJson)', () => {
    const h = makeService();
    h.service.ingestControlDatagram(utf8Encode(`{"type":"status","device_uid":"${UID}","payload":{"calibration":{"fit_settings":{"k":1.0}},"n":2}}`), ADDR);
    const status = h.service.getDevice(UID)!.last_status as { calibration: { fit_settings: { k: unknown } }; n: unknown };
    expect(status.calibration.fit_settings.k).toBeInstanceOf(PyFloat);
    expect(status.n).toBe(2);
  });

  it('a chunked reply is joined with the same semantics', () => {
    const h = makeService();
    const reply = '{"ok":true,"cmd":"memory_status","message":"memory_status","data":{"frag":0.0}}';
    for (const [i, part] of [reply.slice(0, 30), reply.slice(30)].entries()) {
      h.service.ingestControlDatagram(utf8Encode(JSON.stringify({ type: 'result_chunk', device_uid: UID, request_id: 'r', chunk: i, chunks: 2, data: part })), ADDR);
    }
    const result = h.service.getDevice(UID)!.last_result as { data: { frag: unknown } };
    expect(result.data.frag).toBeInstanceOf(PyFloat);
  });
});
