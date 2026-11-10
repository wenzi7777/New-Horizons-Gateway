// Builds NHO/Arduino/1 stream packets for tests (v2-v5), the layout
// PacketV5Codec.cpp writes.
export type PacketSpec = {
  version?: 2 | 3 | 4 | 5;
  flags?: number;
  uid?: string;
  frameId?: number;
  timestamp?: number;
  matrix?: number[];
  raw?: number[];
  imu?: number[]; // 7 floats: acc xyz, gyro xyz, temperature
  mag?: number[];
  battery?: { status: number; fault: number; vbat_mv: number; soc_centi_percent?: number };
  events?: AppEventSpec[];
  /** Raw extension TLV bytes appended after the events. */
  extraTlv?: number[];
  /** Overrides the declared payload length. */
  payloadLen?: number;
  /** Bytes appended after the declared payload. */
  trailing?: number[];
};

export type AppEventSpec = { seq: number; frame_seq: number; ms: number; app: string; event: string; detail: string; value?: number };

export const FLAG = { IMU: 0x01, BATTERY: 0x02, MAG: 0x04, RAW: 0x08, EPOCH: 0x10, EXT: 0x20, HEARTBEAT: 0x80 } as const;

const enc = new TextEncoder();

export function encodeAppEvent(event: AppEventSpec): number[] {
  const out: number[] = [];
  const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  u32(event.seq);
  u32(event.frame_seq);
  u32(event.ms);
  out.push(event.value !== undefined ? 1 : 0);
  if (event.value !== undefined) {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, event.value, true);
    for (let i = 0; i < 4; i++) out.push(view.getUint8(i));
  }
  for (const text of [event.app, event.event, event.detail]) {
    const bytes = enc.encode(text);
    out.push(bytes.length, ...bytes);
  }
  return out;
}

export function encodePacket(spec: PacketSpec): Uint8Array {
  const version = spec.version ?? 5;
  const matrix = spec.matrix ?? [];
  let flags = spec.flags ?? 0;
  if (spec.raw) flags |= FLAG.RAW;
  if (spec.imu) flags |= FLAG.IMU;
  if (spec.mag) flags |= FLAG.MAG;
  if (spec.battery) flags |= FLAG.BATTERY;
  if (spec.events?.length || spec.extraTlv) flags |= FLAG.EXT;
  const body: number[] = [];
  const f32 = (v: number) => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, v, true);
    for (let i = 0; i < 4; i++) body.push(view.getUint8(i));
  };
  matrix.forEach(f32);
  spec.raw?.forEach(f32);
  spec.imu?.forEach(f32);
  spec.mag?.forEach(f32);
  if (spec.battery) {
    const b = spec.battery;
    body.push(b.status, b.fault, b.vbat_mv & 0xff, b.vbat_mv >> 8);
    if (version === 5) body.push((b.soc_centi_percent ?? 0) & 0xff, (b.soc_centi_percent ?? 0) >> 8);
  }
  for (const event of spec.events ?? []) {
    const value = encodeAppEvent(event);
    body.push(0x01, value.length, ...value);
  }
  if (spec.extraTlv) body.push(...spec.extraTlv);
  const headerLen = version >= 4 ? 24 : 20;
  const out = new Uint8Array(headerLen + body.length + (spec.trailing?.length ?? 0));
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xa55a, true);
  out[2] = version;
  out[3] = flags;
  const uid = spec.uid ?? '3CDC7545CCD0';
  for (let i = 0; i < 6; i++) out[4 + i] = parseInt(uid.slice(i * 2, i * 2 + 2), 16);
  view.setUint32(10, spec.frameId ?? 1, true);
  if (version >= 4) {
    view.setBigUint64(14, BigInt(spec.timestamp ?? 0), true);
    view.setUint16(22, spec.payloadLen ?? body.length, true);
  } else {
    view.setUint32(14, spec.timestamp ?? 0, true);
    view.setUint16(18, spec.payloadLen ?? body.length, true);
  }
  out.set(body, headerLen);
  if (spec.trailing) out.set(spec.trailing, headerLen + body.length);
  return out;
}

export const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
