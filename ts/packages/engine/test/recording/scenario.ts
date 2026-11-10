// A recording scenario both sides run: the Python harness (record mode, the
// Desktop backend's real service code) and runTs() below (DeviceRecorder).
// Steps carry the wall clock (epoch µs) and monotonic clock (ms) at which
// they happen.
import { hexToBytes } from '../../../core/src/bytes';
import { extensionSensorCount, PacketParseError, parseBinaryPacket } from '../../src/parse/packetParser';
import { isDict, parsePyJson } from '../../src/parse/pyJson';
import { DeviceRecorder, type DrainToken } from '../../src/recording/deviceRecorder';
import type { DeviceKnowledge } from '../../src/recording/meta';
import { MemoryRecordingSink, dirname } from '../../src/recording/sink';
import { encodePacket, toHex, type PacketSpec } from '../parse/packets';

export type Step = { op: string; wall_us?: number; mono_ms?: number; [key: string]: unknown };

export type ScenarioSpec = {
  uid: string;
  device_json: string;
  status_json: string;
  nickname?: string;
  group?: string;
  gateways_json?: string;
  existing?: string[];
  steps: Step[];
};

export class Scenario {
  readonly steps: Step[] = [];
  wallUs: number;
  monoMs: number;
  existing: string[] = [];
  knowledge: { device: unknown; status: unknown; nickname?: string; group?: string; gateways?: unknown } = { device: {}, status: {} };

  constructor(
    readonly uid = '3CDC7545CCD0',
    startWallUs = Date.UTC(2026, 10, 10, 1, 2, 3, 456) * 1000 + 789,
    startMonoMs = 5000,
  ) {
    this.wallUs = startWallUs;
    this.monoMs = startMonoMs;
  }

  /** Both clocks move by `ms` (the monotonic one by `monoMs` if given). */
  advance(ms: number, monoMs = ms): this {
    this.wallUs += Math.round(ms * 1000);
    this.monoMs += monoMs;
    return this;
  }

  private push(step: Step): this {
    this.steps.push({ ...step, wall_us: this.wallUs, mono_ms: this.monoMs });
    return this;
  }

  enable(enabled = true): this {
    return this.push({ op: 'enable', enabled });
  }
  frame(spec: PacketSpec): this {
    return this.push({ op: 'frame', hex: toHex(encodePacket({ uid: this.uid, ...spec })) });
  }
  rawFrame(bytes: Uint8Array): this {
    return this.push({ op: 'frame', hex: toHex(bytes) });
  }
  setKnowledge(update: { device?: string; status?: string; nickname?: string; group?: string; gateways?: string }, statusUpdate = false): this {
    const step: Step = { op: 'knowledge', status_update: statusUpdate };
    if (update.device !== undefined) step.device_json = update.device;
    if (update.status !== undefined) step.status_json = update.status;
    if (update.nickname !== undefined) step.nickname = update.nickname;
    if (update.group !== undefined) step.group = update.group;
    if (update.gateways !== undefined) step.gateways_json = update.gateways;
    return this.push(step);
  }
  appEventsResult(payloadJson: string): this {
    return this.push({ op: 'app_events_result', payload_json: payloadJson });
  }
  poll(): this {
    return this.push({ op: 'poll' });
  }
  online(online: boolean): this {
    return this.push({ op: 'online', online });
  }
  drainTimer(): this {
    return this.push({ op: 'drain_timer' });
  }
  shutdown(): this {
    return this.push({ op: 'shutdown' });
  }

  spec(initial: { device?: string; status?: string; nickname?: string; group?: string; gateways?: string } = {}): ScenarioSpec {
    return {
      uid: this.uid,
      device_json: initial.device ?? '{}',
      status_json: initial.status ?? '{}',
      ...(initial.nickname !== undefined ? { nickname: initial.nickname } : {}),
      ...(initial.group !== undefined ? { group: initial.group } : {}),
      ...(initial.gateways !== undefined ? { gateways_json: initial.gateways } : {}),
      existing: this.existing,
      steps: this.steps,
    };
  }
}

export type RunResult = { files: Record<string, string>; log: unknown[] };

/** Runs a scenario through DeviceRecorder, mirroring the harness's glue step for step. */
export function runTs(spec: ScenarioSpec, options: { serverTimeZone?: string; localRelay?: 'studio' | 'pocket'; localRelayId?: string } = {}): RunResult {
  const sink = new MemoryRecordingSink();
  for (const path of spec.existing ?? []) {
    if (path.endsWith('.csv')) {
      sink.mkdirp(dirname(path));
      sink.files.set(path, '');
    } else sink.mkdirp(path);
  }
  const before = new Set(sink.files.keys());
  const clock = { us: 0, ms: 0 };
  const log: unknown[] = [];
  let online = true;
  let requestCounter = 0;
  let device = parsePyJson(spec.device_json) as Record<string, unknown>;
  let status = parsePyJson(spec.status_json) as Record<string, unknown>;
  let nickname = spec.nickname ?? '';
  let group = spec.group ?? '';
  let gateways = spec.gateways_json ? (parsePyJson(spec.gateways_json) as Record<string, unknown>) : {};
  const knowledge = (): DeviceKnowledge => {
    const gateway = gateways[String(device.gateway_id ?? '')];
    return {
      device,
      status,
      nickname,
      group,
      relayClientType: isDict(gateway) && typeof gateway.client_type === 'string' ? gateway.client_type : '',
      ...(options.localRelay ? { localRelay: options.localRelay, localRelayId: options.localRelayId ?? null } : {}),
    };
  };
  const recorder = new DeviceRecorder(spec.uid, {
    sink,
    dataRoot: '',
    clock: { nowEpochUs: () => clock.us, monotonicMs: () => clock.ms },
    knowledge,
    ...(options.serverTimeZone ? { serverTimeZone: options.serverTimeZone } : {}),
    publishCommand: (payload) => {
      if (!online) throw new Error('device_not_connected');
      log.push({ published: payload });
    },
    newRequestId: () => (++requestCounter).toString(16).padStart(32, '0'),
  });
  const drains: DrainToken[] = [];
  for (const step of spec.steps) {
    if (step.wall_us !== undefined) clock.us = step.wall_us;
    if (step.mono_ms !== undefined) clock.ms = step.mono_ms;
    switch (step.op) {
      case 'enable': {
        const result = recorder.setEnabled(Boolean(step.enabled));
        if (result.drain) drains.push(result.drain.token);
        log.push({ enable: { device_uid: result.device_uid, enabled: result.enabled, finishing: result.finishing } });
        break;
      }
      case 'online':
        online = Boolean(step.online);
        break;
      case 'knowledge':
        if (typeof step.device_json === 'string') device = parsePyJson(step.device_json) as Record<string, unknown>;
        if (typeof step.status_json === 'string') status = parsePyJson(step.status_json) as Record<string, unknown>;
        if (typeof step.nickname === 'string') nickname = step.nickname;
        if (typeof step.group === 'string') group = step.group;
        if (typeof step.gateways_json === 'string') gateways = parsePyJson(step.gateways_json) as Record<string, unknown>;
        if (step.status_update) recorder.onDeviceStatus();
        break;
      case 'frame': {
        const bytes = hexToBytes(step.hex as string);
        let parsed;
        try {
          parsed = parseBinaryPacket(bytes, extensionSensorCount(bytes, () => device));
        } catch (error) {
          if (!(error instanceof PacketParseError)) throw error;
          log.push({ frame_error: error.code });
          break;
        }
        const result = recorder.onFrame(parsed);
        const entry: Record<string, unknown> = {};
        if (result.recording_lag_ms !== undefined) entry.recording_lag_ms = result.recording_lag_ms;
        if (result.finished?.startsWith('write_error: ')) entry.error = result.finished.slice('write_error: '.length);
        log.push({ frame: entry });
        break;
      }
      case 'app_events_result':
        recorder.onAppEventsResult(parsePyJson(step.payload_json as string) as Record<string, unknown>);
        break;
      case 'poll':
        recorder.pollAppEvents();
        break;
      case 'drain_timer':
        recorder.drainTimedOut(drains[drains.length - 1]!);
        break;
      case 'shutdown':
        recorder.shutdown();
        break;
      default:
        throw new Error(`unknown op ${step.op}`);
    }
  }
  const files: Record<string, string> = {};
  for (const [path, text] of [...sink.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!before.has(path)) files[path] = text;
  }
  return { files, log };
}
