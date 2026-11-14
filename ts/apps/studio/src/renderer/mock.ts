// A StudioApi with canned data, so `vite` in a plain browser shows the whole
// app without Electron or a device. It behaves like the real engine where it
// matters to the UI: commands take a moment and can fail, rebooting takes the
// device offline briefly, recordings grow while running, live frames arrive
// at ~30 per second, and every settings command changes the status the
// settings pages read (deviceDetails[uid].status).

import type {
  CommandOutcome,
  DeviceView,
  HostStatus,
  LiveFrame,
  NearbyDeviceView,
  QuickCommand,
  RecordingSummary,
  RecordingTimeline,
  StudioApi,
  StudioSettings,
  StudioSnapshot,
} from '../shared/contract';
import type { AreaName } from '../shared/areas';
import { AREA_MOCKS } from './areas/mocks';
import type { AreaMockHandlers } from './areas/mockTypes';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** ~200 MB per hour at 112 sensors / 60 fps (docs/studio-pocket-plan.md). */
const BYTES_PER_MS = 200e6 / HOUR;
export const MOCK_VERSION = '2.0.0-preview';

type Raw = Record<string, unknown>;

export type MockOptions = {
  /** Multiplies every simulated delay (tests pass 0). */
  delayScale?: number;
  /** Start the ticking clock and connection (default true; tests pass false). */
  autoStart?: boolean;
  now?: () => number;
};

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

export function recordingId(uid: string, startedAtMs: number): string {
  const d = new Date(startedAtMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `recordings/${uid}/${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}/${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Each cell's resting reading (an unloaded sensor reads ~250-330). */
function baselineAt(uid: string, index: number): number {
  return 250 + (hash(`${uid}:${index}`) % 80);
}

/**
 * A plausible pressure frame (NH Pocket's mock generator): two contact areas
 * moving slowly over the matrix, pressed in and out, on the per-cell
 * baseline plus a little noise. Calibrated units in the 300..3150 range.
 */
export function generateFrame(uid: string, rows: number, cols: number, nowMs: number, tare: number[] | null, noise = Math.random): number[] {
  const t = nowMs / 1000;
  const phase = (hash(uid) % 1000) / 160;
  const blobs = [
    {
      r: (rows - 1) * (0.5 + 0.32 * Math.sin(t * 0.45 + phase)),
      c: (cols - 1) * (0.5 + 0.3 * Math.cos(t * 0.31 + phase)),
      sigma: Math.max(rows, cols) * 0.16,
      amp: 2600 * (0.55 + 0.45 * Math.sin(t * 1.3 + phase)),
    },
    {
      r: (rows - 1) * (0.5 + 0.28 * Math.cos(t * 0.27 + phase * 2)),
      c: (cols - 1) * (0.5 + 0.34 * Math.sin(t * 0.52 + phase)),
      sigma: Math.max(rows, cols) * 0.11,
      amp: 1700 * (0.5 + 0.5 * Math.cos(t * 0.9 + phase)),
    },
  ];
  const values: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      let v = baselineAt(uid, i) + (noise() - 0.5) * 24;
      for (const b of blobs) {
        const d2 = (r - b.r) ** 2 + (c - b.c) ** 2;
        v += Math.max(0, b.amp) * Math.exp(-d2 / (2 * b.sigma * b.sigma));
      }
      if (tare) v -= tare[i] ?? 0;
      values.push(Math.max(0, Math.min(4990, Math.round(v))));
    }
  }
  return values;
}

type MockDevice = DeviceView & { ownName: string; targetFps: number; tare: number[] | null; status: Raw; ip: string };

function deviceStatus(d: { uid: string; mode: string; hardwareModel: string; firmwareVersion: string; rows: number; cols: number; fps: number; soc: number; charging: boolean; channel: string }): Raw {
  return {
    command: 'status',
    device_uid: d.uid,
    mode: d.mode,
    hardware_model: d.hardwareModel,
    firmware_version: d.firmwareVersion,
    matrix_shape: { rows: d.rows, cols: d.cols },
    matrix_layout: { analog_pins: [3, 4, 5, 6, 7, 8, 9, 10, 13, 14].slice(0, d.rows), select_pins: [15, 16, 17, 18] },
    runtime: {
      scan_timing: { target_fps: d.fps, settle_us: d.fps > 60 ? 15 : 20, send_every_n_frames: 1 },
    },
    scan_health: {
      scan_active: true,
      requested_target_fps: d.fps,
      actual_scan_fps: d.fps,
      produced_frames: 63825,
      last_scan_duration_us: 2210,
      max_scan_duration_us: 4630,
      budget_us: Math.round(1e6 / d.fps),
      overrun_frames: 0,
      udp_sent_frames: 63800,
      udp_send_failures: 2,
      queue_capacity_frames: 4,
      queue_occupied_frames: 0,
      queue_dropped_frames: 0,
      adc_read_errors: [0, 3],
      adc_cal_digi: [998, 985],
    },
    filter: { enabled: false, median: 3, alpha: 0.25 },
    imu: { enabled: true, state: 'running', sample_rate_hz: d.fps },
    stream_raw_adc: false,
    stream_buffer: { enabled: true, mode: 'standard', depth_frames: 4 },
    battery: {
      gauge: 'max17048',
      sample_valid: true,
      battery_present: true,
      soc_centi_percent: d.soc * 100,
      vbat_mv: 3600 + d.soc * 6,
      rate: d.charging ? 1800 : -210,
      profile: 'balanced',
      profile_source: 'manual',
      profile_resolved: true,
      capacity_mah: 400,
      max_charge_current_ma: 200,
      state: d.charging ? 'charging' : 'discharging',
    },
    power: { state: 'normal', charge_state: d.charging ? 'charging' : 'not_charging', wake_source: 'power_on', charger_present: d.charging },
    ota: {
      channel: d.channel,
      auto_apply_on_boot: false,
      manifest_url: '',
      resolved_manifest_url: `https://isensing-s1.u-aizu.ac.jp/newhorizons/firmware/arduino-v15f-${d.channel === 'beta' ? 'beta' : 'latest'}.json`,
    },
    update_state: { phase: 'idle' },
    logging: { enabled: true, level: 'error', mode: 'standard', bytes: 3_412, effective_total_bytes: 12 * 1024 },
    calibration: { enabled: true, output_mode: 'calibrated', tare_enabled: false },
    wifi: { ssid: 'NH-Lab', rssi: -58, ip: '192.168.10.41' },
  };
}

function record(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

export class MockStudioApi implements StudioApi {
  private listeners = new Set<(snapshot: StudioSnapshot) => void>();
  private liveListeners = new Map<string, Set<(frame: LiveFrame) => void>>();
  private liveTimers = new Map<string, ReturnType<typeof setInterval>>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayScale: number;
  private readonly now: () => number;
  private clockOffsetMs = new Map<string, number>();
  private clockConfig = new Map<string, Raw>();

  private settings: StudioSettings = {
    pocketId: 'nh-studio-lab-mac',
    displayName: 'Lab MacBook',
    serverTarget: 'production',
    manualUrl: '',
    relayEnabled: true,
    offerPolicy: 'managed',
    syncPolicy: 'manual',
    theme: 'auto',
    locale: 'system',
    dataFolder: '/Users/lab/Documents/NH Studio',
  };
  private status: HostStatus;
  private devices: MockDevice[];
  private nearby: NearbyDeviceView[];
  private recordings: RecordingSummary[];

  constructor(options: MockOptions = {}) {
    this.delayScale = options.delayScale ?? 1;
    this.now = options.now ?? Date.now;
    const now = this.now();
    this.status = {
      serviceRunning: true,
      serviceError: '',
      upstream: 'offline',
      serverUrl: 'wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws',
      addresses: [{ name: 'en0', address: '192.168.10.23' }],
      batteryOptimizationIgnored: null,
      findmeRequests: 12,
      authRejected: false,
      isolationSuspected: false,
      storage: { freeBytes: 312e9, recordingsBytes: 0 },
    };
    const make = (
      uid: string,
      ownName: string,
      nickname: string,
      group: string,
      online: boolean,
      model: string,
      fw: string,
      soc: number,
      charging: boolean,
      fps: number,
      rows: number,
      cols: number,
      recording: boolean,
      lastSeenMs: number,
      ip: string,
      channel = 'stable',
    ): MockDevice => ({
      uid,
      ownName,
      displayName: nickname || ownName,
      nickname,
      group,
      online,
      mode: 'normal',
      hardwareModel: model,
      firmwareVersion: fw,
      battery: { percent: soc, charging },
      fps: online ? fps : 0,
      targetFps: fps,
      matrix: { rows, cols },
      recording: { enabled: recording, finishing: false, error: '' },
      lastSeenMs,
      tare: null,
      ip,
      status: deviceStatus({ uid, mode: 'normal', hardwareModel: model, firmwareVersion: fw, rows, cols, fps, soc, charging, channel }),
    });
    this.devices = [
      make('3C84279A1F20', 'NHOS-3C84279A1F20', 'Left insole', 'Gait study', true, 'TIA-CTL v1.5.F', 'v1.19.0', 78, false, 60, 10, 12, true, now, '192.168.10.41'),
      make('3C84279A2B44', 'NHOS-3C84279A2B44', '', 'Gait study', true, 'TIA-CTL v1.5.F', 'v1.19.0', 41, true, 90, 14, 10, false, now, '192.168.10.42', 'beta'),
      make('F412FA0C77D8', 'NHOS-F412FA0C77D8', 'Bench pad', '', false, 'VD-CTL/R v1.0.F', 'v1.18.0', 12, false, 60, 10, 12, false, now - 3 * HOUR - 12 * MINUTE, '192.168.10.44'),
    ];
    this.nearby = [
      { uid: '3C84279A5E10', name: 'NHOS-3C84279A5E10', ip: '192.168.10.52', attachedTo: '', lastSeenMs: now - 4_000 },
      { uid: '84F703B19A6C', name: 'Chair back', ip: '192.168.10.61', attachedTo: 'NH Gateway lab-90', lastSeenMs: now - 9_000 },
    ];
    const today = new Date(now);
    const at = (daysAgo: number, h: number, m: number) =>
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, h, m, 17).getTime();
    const rec = (uid: string, name: string, startedAtMs: number, durationMs: number, sync: RecordingSummary['syncState']): RecordingSummary => ({
      id: recordingId(uid, startedAtMs),
      uid,
      deviceName: name,
      startedAtMs,
      durationMs,
      frames: Math.round((durationMs / 1000) * 60),
      bytes: Math.round(durationMs * BYTES_PER_MS),
      inProgress: false,
      syncState: sync,
    });
    const liveStart = now - 4 * MINUTE - 32_000;
    this.recordings = [
      { ...rec('3C84279A1F20', 'Left insole', liveStart, now - liveStart, 'local'), inProgress: true },
      rec('3C84279A2B44', 'NHOS-3C84279A2B44', Math.min(at(0, 9, 41), now - 2 * HOUR), 18 * MINUTE + 4_000, 'local'),
      rec('3C84279A1F20', 'Left insole', Math.min(at(0, 9, 12), now - 3 * HOUR), 22 * MINUTE + 51_000, 'local'),
      rec('3C84279A1F20', 'Left insole', at(1, 16, 5), 47 * MINUTE + 9_000, 'uploading'),
      rec('F412FA0C77D8', 'Bench pad', at(1, 11, 30), 6 * MINUTE + 40_000, 'synced'),
      rec('3C84279A2B44', 'NHOS-3C84279A2B44', at(2, 15, 2), 12 * MINUTE + 15_000, 'synced'),
      rec('F412FA0C77D8', 'Bench pad', at(4, 14, 22), 1 * HOUR + 3 * MINUTE, 'synced'),
    ];
    if (options.autoStart !== false) this.start();
  }

  // -- lifecycle (mock only) --------------------------------------------------

  start(): void {
    if (this.tick) return;
    this.connect();
    this.tick = setInterval(() => this.onTick(), 1000);
  }

  dispose(): void {
    if (this.tick) clearInterval(this.tick);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.tick = null;
    for (const timer of this.liveTimers.values()) clearInterval(timer);
    this.liveTimers.clear();
  }

  private sleep(ms: number): Promise<void> {
    const scaled = ms * this.delayScale;
    return scaled > 0 ? new Promise((resolve) => setTimeout(resolve, scaled)) : Promise.resolve();
  }

  // -- snapshot -----------------------------------------------------------------

  private build(): StudioSnapshot {
    const recordingsBytes = this.recordings.reduce((sum, r) => sum + r.bytes, 0);
    const deviceDetails: StudioSnapshot['deviceDetails'] = {};
    for (const d of this.devices) {
      deviceDetails[d.uid] = {
        record: {
          device_uid: d.uid,
          device_name: d.ownName,
          hardware_model: d.hardwareModel,
          firmware_version: d.firmwareVersion,
          mode: d.mode,
          ip: d.ip,
          transport: 'udp',
          last_status: null,
        },
        status: structuredClone(d.status),
      };
    }
    return {
      status: { ...this.status, storage: { freeBytes: 312e9 - recordingsBytes, recordingsBytes } },
      settings: { ...this.settings },
      devices: this.devices.map(({ ownName: _o, targetFps: _t, tare: _r, status: _s, ip: _i, ...view }) => structuredClone(view)),
      nearby: this.nearby.map((n) => ({ ...n })),
      recordings: this.recordings.map((r) => ({ ...r })),
      deviceDetails,
      version: MOCK_VERSION,
    };
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snap = this.build();
    for (const listener of [...this.listeners]) listener(snap);
  }

  async snapshot(): Promise<StudioSnapshot> {
    return this.build();
  }

  onSnapshot(listener: (snapshot: StudioSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private connect(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    const s = this.settings;
    const serverUrl =
      s.serverTarget === 'production'
        ? 'wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws'
        : s.serverTarget === 'local'
          ? 'ws://127.0.0.1:5051/newhorizons/gateway/ws'
          : s.manualUrl;
    if (!s.relayEnabled || !serverUrl) {
      this.status = { ...this.status, upstream: 'offline', serverUrl };
      this.emit();
      return;
    }
    this.status = { ...this.status, upstream: 'connecting', serverUrl };
    this.emit();
    this.connectTimer = setTimeout(() => {
      // No Desktop server runs on this machine in the preview: "Local" stays offline.
      this.status = { ...this.status, upstream: s.serverTarget === 'local' ? 'offline' : 'online' };
      this.emit();
    }, 1500 * this.delayScale);
  }

  private onTick(): void {
    const now = this.now();
    this.status = { ...this.status, findmeRequests: this.status.findmeRequests + (Math.random() < 0.5 ? 1 : 0) };
    for (const d of this.devices) {
      if (!d.online) continue;
      d.lastSeenMs = now;
      d.fps = d.mode === 'maintenance' ? 0 : Math.max(0, d.targetFps - Math.round(Math.random() * 2));
    }
    for (const r of this.recordings) {
      if (!r.inProgress) continue;
      r.durationMs = now - r.startedAtMs;
      r.frames = Math.round((r.durationMs / 1000) * 60);
      r.bytes = Math.round(r.durationMs * BYTES_PER_MS);
    }
    for (const n of this.nearby) n.lastSeenMs = now - Math.round(Math.random() * 5000);
    this.emit();
  }

  // -- live -------------------------------------------------------------------

  subscribeLive(uid: string, listener: (frame: LiveFrame) => void): () => void {
    let set = this.liveListeners.get(uid);
    if (!set) {
      set = new Set();
      this.liveListeners.set(uid, set);
    }
    set.add(listener);
    if (!this.liveTimers.has(uid)) this.liveTimers.set(uid, setInterval(() => this.emitFrame(uid), 33));
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        const timer = this.liveTimers.get(uid);
        if (timer) clearInterval(timer);
        this.liveTimers.delete(uid);
      }
    };
  }

  /** One frame for `uid` now, or null when the device sends none (offline, maintenance). */
  frameFor(uid: string): LiveFrame | null {
    const d = this.find(uid);
    if (!d || !d.online || !d.matrix || d.mode === 'maintenance') return null;
    const now = this.now();
    const values = generateFrame(uid, d.matrix.rows, d.matrix.cols, now, d.tare);
    return { uid, values, rows: d.matrix.rows, cols: d.matrix.cols, timestampMs: now, fps: d.fps };
  }

  private emitFrame(uid: string): void {
    const frame = this.frameFor(uid);
    if (!frame) return;
    for (const listener of [...(this.liveListeners.get(uid) ?? [])]) listener(frame);
  }

  // -- settings ---------------------------------------------------------------

  async updateSettings(patch: Partial<StudioSettings>): Promise<void> {
    const before = this.settings;
    this.settings = { ...before, ...patch };
    const reconnect =
      before.serverTarget !== this.settings.serverTarget ||
      before.manualUrl !== this.settings.manualUrl ||
      before.relayEnabled !== this.settings.relayEnabled ||
      before.pocketId !== this.settings.pocketId;
    this.emit();
    if (reconnect && this.tick) this.connect();
  }

  // -- devices ----------------------------------------------------------------

  private find(uid: string): MockDevice | undefined {
    return this.devices.find((d) => d.uid === uid);
  }

  async adopt(uid: string): Promise<CommandOutcome> {
    await this.sleep(900);
    const listed = this.find(uid);
    if (listed?.takenOver) {
      // Taking it back from the relay that took it over.
      listed.takenOver = false;
      listed.takenOverBy = '';
      listed.online = true;
      this.emit();
      return { ok: true, message: '', data: null };
    }
    const index = this.nearby.findIndex((n) => n.uid === uid);
    const nearby = this.nearby[index];
    if (!nearby) return { ok: false, message: 'device_not_found', data: null };
    // A device attached to another relay is taken over from it.
    this.nearby.splice(index, 1);
    const fw = 'v1.19.0';
    this.devices.push({
      uid,
      ownName: nearby.name,
      displayName: nearby.name,
      nickname: '',
      group: '',
      online: true,
      mode: 'normal',
      hardwareModel: 'TIA-CTL v1.5.F',
      firmwareVersion: fw,
      battery: { percent: 93, charging: false },
      fps: 60,
      targetFps: 60,
      matrix: { rows: 10, cols: 12 },
      recording: { enabled: false, finishing: false, error: '' },
      lastSeenMs: this.now(),
      tare: null,
      ip: nearby.ip,
      status: deviceStatus({ uid, mode: 'normal', hardwareModel: 'TIA-CTL v1.5.F', firmwareVersion: fw, rows: 10, cols: 12, fps: 60, soc: 93, charging: false, channel: 'stable' }),
    });
    this.emit();
    return { ok: true, message: '', data: null };
  }

  async discoverNearby(): Promise<CommandOutcome> {
    await this.sleep(300);
    const now = this.now();
    for (const n of this.nearby) n.lastSeenMs = now;
    return { ok: true, message: 'ok', data: null };
  }

  async release(uid: string): Promise<CommandOutcome> {
    await this.sleep(600);
    const d = this.find(uid);
    if (!d) return { ok: false, message: 'device_not_found', data: null };
    this.finishRecording(uid);
    this.devices = this.devices.filter((x) => x.uid !== uid);
    if (d.online) this.nearby.push({ uid, name: d.ownName, ip: d.ip, attachedTo: '', lastSeenMs: this.now() });
    this.emit();
    return { ok: true, message: '', data: null };
  }

  async setNickname(uid: string, nickname: string): Promise<void> {
    await this.sleep(150);
    const d = this.find(uid);
    if (!d) return;
    d.nickname = nickname.trim();
    d.displayName = d.nickname || d.ownName;
    for (const r of this.recordings) if (r.uid === uid) r.deviceName = d.displayName;
    this.emit();
  }

  async setGroup(uid: string, group: string): Promise<void> {
    await this.sleep(150);
    const d = this.find(uid);
    if (!d) return;
    d.group = group.trim();
    this.emit();
  }

  async run(uid: string, command: QuickCommand): Promise<CommandOutcome> {
    switch (command.kind) {
      case 'status':
        return this.sendCommand(uid, { command: 'status' });
      case 'reboot':
        return this.sendCommand(uid, { command: 'reboot' });
      case 'enter_maintenance':
        return this.sendCommand(uid, { command: 'enter_maintenance', reason: 'manual' });
      case 'exit_maintenance':
        return this.sendCommand(uid, { command: 'exit_maintenance' });
      case 'scan_rate':
        return this.sendCommand(uid, { command: 'set_scan_timing', target_fps: command.fps, settle_us: command.fps > 60 ? 15 : 20, send_every_n_frames: 1 });
      case 'tare':
        return this.sendCommand(uid, { command: 'calibration_tare_capture', duration_ms: 1000 });
      case 'tare_clear':
        return this.sendCommand(uid, { command: 'calibration_tare_clear' });
      case 'range_mode':
        return this.sendCommand(uid, {
          command: 'set_range',
          mode: command.mode,
          ...(command.refRfbOhm !== undefined ? { ref_rfb_ohm: command.refRfbOhm } : {}),
          ...(command.leakCompensation !== undefined ? { leak_comp: command.leakCompensation } : {}),
        });
      case 'vref_reset':
        return this.sendCommand(uid, { command: 'set_vref', mv: 330 });
      case 'rfb_measure':
        return this.sendCommand(uid, { command: 'rfb_measure' });
    }
  }

  /** Every payload the mock received, oldest first (for tests). */
  readonly sent: { uid: string; payload: Raw }[] = [];

  async sendCommand(uid: string, payload: Raw): Promise<CommandOutcome> {
    this.sent.push({ uid, payload: { ...payload } });
    const d = this.find(uid);
    if (!d) return { ok: false, message: 'device_not_found', data: null };
    const command = String(payload.command ?? '');
    if (!command) return { ok: false, message: 'command_required', data: null };
    await this.sleep(300 + Math.random() * 400);
    if (!d.online) return { ok: false, message: 'device_offline', data: null };
    const s = d.status;
    const ok = (data: Raw = {}): CommandOutcome => {
      this.emit();
      return { ok: true, message: 'ok', data: { command, ...data } };
    };
    switch (command) {
      case 'status':
        return ok(structuredClone(s));
      case 'scan_health':
        return ok({ scan_health: s.scan_health });
      case 'reboot':
        d.online = false;
        d.fps = 0;
        this.finishRecording(uid);
        setTimeout(() => {
          d.online = true;
          d.mode = 'normal';
          s.mode = 'normal';
          d.tare = null;
          record(s.calibration).tare_enabled = false;
          record(s.calibration).output_mode = 'calibrated';
          this.emit();
        }, 4000 * Math.max(this.delayScale, 0.01));
        return ok();
      case 'enter_maintenance':
        d.mode = 'maintenance';
        s.mode = 'maintenance';
        d.fps = 0;
        return ok({ mode: 'maintenance' });
      case 'exit_maintenance':
        d.mode = 'normal';
        s.mode = 'normal';
        return ok({ mode: 'normal' });
      case 'set_scan_timing': {
        const fps = Number(payload.target_fps);
        if (!Number.isFinite(fps) || fps < 1 || fps > 200) return { ok: false, message: 'invalid_target_fps', data: null };
        d.targetFps = fps;
        const timing = { target_fps: fps, settle_us: Number(payload.settle_us), send_every_n_frames: Number(payload.send_every_n_frames) };
        record(s.runtime).scan_timing = timing;
        Object.assign(record(s.scan_health), { requested_target_fps: fps, actual_scan_fps: fps, budget_us: Math.round(1e6 / fps) });
        return ok({ runtime: { scan_timing: timing } });
      }
      case 'set_filter':
        s.filter = { enabled: payload.enabled === true, median: Number(payload.median), alpha: Number(payload.alpha) };
        return ok({ filter: s.filter });
      case 'set_imu':
        s.imu = { ...record(s.imu), enabled: payload.enabled === true, state: payload.enabled === true ? 'running' : 'disabled' };
        return ok({ imu: s.imu });
      case 'set_raw_adc':
        s.stream_raw_adc = payload.enabled === true;
        return ok({ stream_raw_adc: s.stream_raw_adc });
      case 'set_stream_buffer':
        s.stream_buffer = { ...record(s.stream_buffer), enabled: payload.enabled === true, mode: payload.mode, depth_frames: payload.mode === 'extended' ? 16 : 4 };
        return ok({ stream_buffer: s.stream_buffer });
      case 'set_charge_profile':
        record(s.battery).profile = payload.profile;
        return ok({ battery: s.battery });
      case 'set_battery_profile':
        Object.assign(record(s.battery), { capacity_mah: payload.capacity_mah, max_charge_current_ma: payload.max_charge_current_ma, profile_resolved: true, profile_source: 'manual' });
        return ok({ battery: s.battery });
      case 'resync_battery_gauge':
        return ok({ battery: s.battery });
      case 'power_set_state':
        record(s.power).state = payload.state;
        if (payload.state !== 'normal') {
          d.online = false;
          d.fps = 0;
          this.finishRecording(uid);
        }
        return ok({ power: s.power });
      case 'clock_status':
        return ok(this.clockReply(uid));
      case 'clock_sync':
        this.clockOffsetMs.set(uid, Math.round((Math.random() - 0.5) * 6));
        return ok(this.clockReply(uid));
      case 'set_time':
        this.clockOffsetMs.set(uid, 0);
        return ok(this.clockReply(uid));
      case 'set_clock_config': {
        const cfg = { ...this.clockConfigFor(uid) };
        if (payload.ntp_server !== undefined) cfg.ntp_server = payload.ntp_server;
        if (payload.ntp_interval_s !== undefined) cfg.ntp_interval_s = payload.ntp_interval_s;
        if (payload.sync_interval_s !== undefined) cfg.sync_interval_s = payload.sync_interval_s;
        this.clockConfig.set(uid, cfg);
        return ok(this.clockReply(uid));
      }
      case 'set_ota_config': {
        const ota = record(s.ota);
        if (payload.channel !== undefined) {
          ota.channel = payload.channel;
          ota.resolved_manifest_url = String(ota.resolved_manifest_url ?? '').replace(/-(latest|beta)\.json$/, payload.channel === 'beta' ? '-beta.json' : '-latest.json');
          s.update_state = { phase: 'idle' };
        }
        if (payload.auto_apply_on_boot !== undefined) ota.auto_apply_on_boot = payload.auto_apply_on_boot;
        if (payload.manifest_url !== undefined) ota.manifest_url = payload.manifest_url;
        return ok({ ota });
      }
      case 'check_update': {
        await this.sleep(900);
        const beta = record(s.ota).channel === 'beta';
        const next = beta ? 'v1.20.0-beta.2' : d.firmwareVersion === 'v1.19.0' ? '' : 'v1.19.0';
        s.update_state = next
          ? { phase: 'ready', operation: 'check_update', version: next, changelog_url: '' }
          : { phase: 'current', operation: 'check_update', version: d.firmwareVersion };
        return ok({ update_state: s.update_state });
      }
      case 'apply_update': {
        const target = String(record(s.update_state).version ?? '');
        if (!target) return { ok: false, message: 'no_update', data: null };
        const total = 425;
        s.update_state = { phase: 'downloading', operation: 'apply_update', version: target, total_chunks: total, applied_chunks: 0 };
        const step = () => {
          const st = record(s.update_state);
          const done = Math.min(total, Number(st.applied_chunks ?? 0) + 40);
          if (done < total) {
            st.applied_chunks = done;
            this.emit();
            setTimeout(step, 400 * Math.max(this.delayScale, 0.01));
            return;
          }
          s.update_state = { phase: 'applied', operation: 'apply_update', version: target, total_chunks: total, applied_chunks: total };
          d.online = false;
          this.emit();
          setTimeout(() => {
            d.firmwareVersion = target;
            s.firmware_version = target;
            s.update_state = { phase: 'current', version: target };
            d.online = true;
            this.emit();
          }, 3000 * Math.max(this.delayScale, 0.01));
        };
        setTimeout(step, 400 * Math.max(this.delayScale, 0.01));
        return ok({ update_state: s.update_state });
      }
      case 'set_log':
        s.logging = { ...record(s.logging), enabled: payload.enabled === true, level: payload.level, mode: payload.mode, effective_total_bytes: payload.max_bytes };
        return ok({ log_status: s.logging });
      case 'log_clear':
        record(s.logging).bytes = 0;
        return ok();
      case 'calibration_tare_capture':
        if (d.matrix) {
          d.tare = generateFrame(uid, d.matrix.rows, d.matrix.cols, this.now(), null).map((v, i) => Math.min(v, baselineAt(uid, i)));
        }
        Object.assign(record(s.calibration), { tare_enabled: true, output_mode: 'tared' });
        return ok({ calibration: s.calibration });
      case 'calibration_tare_clear':
        d.tare = null;
        Object.assign(record(s.calibration), { tare_enabled: false, output_mode: 'calibrated' });
        return ok({ calibration: s.calibration });
      default:
        return { ok: false, message: 'unknown_command', data: null };
    }
  }

  private clockConfigFor(uid: string): Raw {
    return this.clockConfig.get(uid) ?? { ntp_server: 'pool.ntp.org', ntp_interval_s: 3600, sync_interval_s: 60 };
  }

  private clockReply(uid: string): Raw {
    const offset = this.clockOffsetMs.get(uid) ?? 2;
    return {
      clock: {
        synced: true,
        source: 'gateway',
        mode: 'wifi',
        epoch_ms: this.now() + offset,
        uncertainty_ms: 3,
        sync_age_ms: 12_000,
        gateway: { supported: true, last_rtt_us: 2100 },
      },
      clock_config: this.clockConfigFor(uid),
    };
  }

  async setRecording(uid: string, on: boolean): Promise<CommandOutcome> {
    const d = this.find(uid);
    if (!d) return { ok: false, message: 'device_not_found', data: null };
    if (on) {
      if (!d.online) return { ok: false, message: 'device_offline', data: null };
      if (d.recording.enabled) return { ok: true, message: '', data: null };
      await this.sleep(300);
      const startedAtMs = this.now();
      d.recording = { enabled: true, finishing: false, error: '' };
      this.recordings.unshift({
        id: recordingId(uid, startedAtMs),
        uid,
        deviceName: d.displayName,
        startedAtMs,
        durationMs: 0,
        frames: 0,
        bytes: 0,
        inProgress: true,
        syncState: 'local',
      });
      this.emit();
      return { ok: true, message: '', data: null };
    }
    if (!d.recording.enabled) return { ok: true, message: '', data: null };
    d.recording = { enabled: true, finishing: true, error: '' };
    this.emit();
    await this.sleep(1200);
    this.finishRecording(uid);
    this.emit();
    return { ok: true, message: '', data: null };
  }

  private finishRecording(uid: string): void {
    const d = this.find(uid);
    if (d) d.recording = { enabled: false, finishing: false, error: '' };
    const now = this.now();
    for (const r of this.recordings) {
      if (r.uid === uid && r.inProgress) {
        r.inProgress = false;
        r.durationMs = now - r.startedAtMs;
        r.frames = Math.round((r.durationMs / 1000) * 60);
        r.bytes = Math.round(r.durationMs * BYTES_PER_MS);
      }
    }
  }

  // -- recordings --------------------------------------------------------------

  async timeline(id: string): Promise<RecordingTimeline> {
    await this.sleep(400);
    const r = this.recordings.find((x) => x.id === id);
    if (!r) throw new Error('recording_not_found');
    const random = rng(hash(id));
    const count = Math.max(2, Math.min(240, Math.round(r.durationMs / 1000)));
    const buckets: { min: number; max: number }[] = [];
    let level = 0.3;
    for (let i = 0; i < count; i++) {
      level = Math.max(0.05, Math.min(1, level + (random() - 0.5) * 0.18));
      const step = 0.5 + 0.5 * Math.sin((i / count) * Math.PI * 9);
      const max = 34_000 + level * 210_000 * (0.4 + 0.6 * step);
      const min = 34_000 + (max - 34_000) * (0.2 + random() * 0.35);
      buckets.push({ min: Math.round(min), max: Math.round(max) });
    }
    const gaps = random() < 0.5 ? 0 : 1 + Math.floor(random() * 2);
    const events = [
      { atMs: Math.round(r.durationMs * 0.12), label: 'app: start_walk' },
      { atMs: Math.round(r.durationMs * 0.58), label: 'button: mark' },
    ];
    if (gaps) events.push({ atMs: Math.round(r.durationMs * 0.77), label: 'gap 0.4 s' });
    return { buckets, durationMs: r.durationMs, lostFrames: gaps * 23, gaps, events };
  }

  async exportRecording(id: string): Promise<string | null> {
    await this.sleep(700);
    const r = this.recordings.find((x) => x.id === id);
    if (!r) throw new Error('recording_not_found');
    return `/Users/lab/Downloads/${id.split('/').slice(1).join('-')}.zip`;
  }

  async revealRecording(id: string): Promise<void> {
    if (!this.recordings.some((r) => r.id === id)) throw new Error('recording_not_found');
  }

  async deleteRecording(id: string): Promise<void> {
    await this.sleep(250);
    const r = this.recordings.find((x) => x.id === id);
    if (!r) throw new Error('recording_not_found');
    if (r.inProgress) throw new Error('recording_in_progress');
    this.recordings = this.recordings.filter((x) => x.id !== id);
    this.emit();
  }

  async chooseDataFolder(): Promise<string | null> {
    await this.sleep(300);
    const next = this.settings.dataFolder.endsWith('NH Studio') ? '/Volumes/LabData/NH Studio recordings' : '/Users/lab/Documents/NH Studio';
    this.settings = { ...this.settings, dataFolder: next };
    this.emit();
    return next;
  }

  async openExternal(url: string): Promise<void> {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
  }

  private areaHandlers: Partial<Record<AreaName, AreaMockHandlers>> = {};
  private areaListeners = new Set<{ area: AreaName; event: string; listener: (payload: unknown) => void }>();

  async call<T = unknown>(area: AreaName, method: string, ...args: unknown[]): Promise<T> {
    let handlers = this.areaHandlers[area];
    if (!handlers) {
      handlers = AREA_MOCKS[area]((event, payload) => {
        for (const entry of [...this.areaListeners]) if (entry.area === area && entry.event === event) entry.listener(payload);
      });
      this.areaHandlers[area] = handlers;
    }
    const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined;
    if (!handler) throw new Error('unknown_method');
    return (await (handler as (...a: unknown[]) => unknown)(...args)) as T;
  }

  onAreaEvent(area: AreaName, event: string, listener: (payload: unknown) => void): () => void {
    const entry = { area, event, listener };
    this.areaListeners.add(entry);
    return () => {
      this.areaListeners.delete(entry);
    };
  }
}

export function createMockApi(options?: MockOptions): MockStudioApi {
  return new MockStudioApi(options);
}
