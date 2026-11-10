// A PocketStore with canned data, for building and reviewing the screens
// without a device or the native module. Behaves like the real host where
// it matters to the UI: commands take a moment and can fail, rebooting takes
// the device offline briefly, recordings grow while running and finish
// asynchronously, live frames arrive at ~20 per second.
//
// Snapshot getters return the same array/object until something changes.

import type {
  CommandOutcome,
  DeviceView,
  HostStatus,
  LiveFrame,
  NearbyDeviceView,
  PocketSettings,
  PocketStore,
  QuickCommand,
  RecordingSummary,
  RecordingTimeline,
} from './contract';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** ~200 MB per hour at 112 sensors / 60 fps (docs/studio-pocket-plan.md). */
const BYTES_PER_MS = 200e6 / HOUR;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Small deterministic PRNG so timelines stay the same between visits. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function recordingId(uid: string, startedAtMs: number): string {
  const d = new Date(startedAtMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${uid}/${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}/${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

type MockDevice = DeviceView & { ownName: string; targetFps: number; tare: number[] | null };

export type MockStoreOptions = {
  /** Seconds after start() before FindMe requests arrive (isolation warning shows until then). */
  isolationSeconds?: number;
};

export class MockPocketStore implements PocketStore {
  private listeners = new Set<() => void>();
  private liveListeners = new Map<string, Set<(frame: LiveFrame) => void>>();
  private liveTimers = new Map<string, ReturnType<typeof setInterval>>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private readonly isolationMs: number;

  private settingsValue: PocketSettings = {
    pocketId: 'nh-pocket-iplay60',
    displayName: 'Lab tablet',
    serverTarget: 'production',
    manualUrl: '',
    relayEnabled: true,
    offerPolicy: 'managed',
    syncPolicy: 'manual',
    theme: 'auto',
    locale: 'system',
  };
  private statusValue: HostStatus;
  private deviceList: MockDevice[];
  private nearbyList: NearbyDeviceView[];
  private recordingList: RecordingSummary[];

  private devicesSnapshot: DeviceView[] = [];
  private nearbySnapshot: NearbyDeviceView[] = [];
  private recordingsSnapshot: RecordingSummary[] = [];

  constructor(options: MockStoreOptions = {}) {
    this.isolationMs = (options.isolationSeconds ?? 20) * 1000;
    const now = Date.now();
    this.statusValue = {
      serviceRunning: false,
      serviceError: '',
      upstream: 'offline',
      serverUrl: 'wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws',
      addresses: [{ name: 'wlan0', address: '192.168.10.37' }],
      batteryOptimizationIgnored: false,
      findmeRequests: 0,
      authRejected: false,
      isolationSuspected: false,
      storage: { freeBytes: 41.7e9, recordingsBytes: 0 },
    };
    this.deviceList = [
      {
        uid: '3C84279A1F20',
        ownName: 'NHOS-3C84279A1F20',
        displayName: 'Left insole',
        nickname: 'Left insole',
        group: 'Gait study',
        online: true,
        mode: 'normal',
        hardwareModel: 'TIA-CTL v1.5.F',
        firmwareVersion: 'v1.19.0',
        battery: { percent: 78, charging: false },
        fps: 60,
        targetFps: 60,
        matrix: { rows: 10, cols: 12 },
        recording: { enabled: true, finishing: false, error: '' },
        lastSeenMs: now,
        tare: null,
      },
      {
        uid: '3C84279A2B44',
        ownName: 'NHOS-3C84279A2B44',
        displayName: 'NHOS-3C84279A2B44',
        nickname: '',
        group: 'Gait study',
        online: true,
        mode: 'normal',
        hardwareModel: 'TIA-CTL v1.5.F',
        firmwareVersion: 'v1.19.0',
        battery: { percent: 41, charging: true },
        fps: 90,
        targetFps: 90,
        matrix: { rows: 14, cols: 10 },
        recording: { enabled: false, finishing: false, error: '' },
        lastSeenMs: now,
        tare: null,
      },
      {
        uid: 'F412FA0C77D8',
        ownName: 'NHOS-F412FA0C77D8',
        displayName: 'Bench pad',
        nickname: 'Bench pad',
        group: '',
        online: false,
        mode: 'normal',
        hardwareModel: 'VD-CTL/R v1.0.F',
        firmwareVersion: 'v1.18.0',
        battery: { percent: 12, charging: false },
        fps: 0,
        targetFps: 60,
        matrix: { rows: 10, cols: 12 },
        recording: { enabled: false, finishing: false, error: '' },
        lastSeenMs: now - 3 * HOUR - 12 * MINUTE,
        tare: null,
      },
    ];
    this.nearbyList = [
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
    this.recordingList = [
      { ...rec('3C84279A1F20', 'Left insole', liveStart, now - liveStart, 'local'), inProgress: true },
      rec('3C84279A2B44', 'NHOS-3C84279A2B44', Math.min(at(0, 9, 41), now - 2 * HOUR), 18 * MINUTE + 4_000, 'local'),
      rec('3C84279A1F20', 'Left insole', Math.min(at(0, 9, 12), now - 3 * HOUR), 22 * MINUTE + 51_000, 'local'),
      rec('3C84279A1F20', 'Left insole', at(1, 16, 5), 47 * MINUTE + 9_000, 'uploading'),
      rec('F412FA0C77D8', 'Bench pad', at(1, 11, 30), 6 * MINUTE + 40_000, 'synced'),
      rec('F412FA0C77D8', 'Bench pad', at(4, 14, 22), 1 * HOUR + 3 * MINUTE, 'synced'),
    ];
    this.refreshSnapshots();
  }

  // -- snapshots ------------------------------------------------------------

  private refreshSnapshots(): void {
    this.devicesSnapshot = this.deviceList.map(({ ownName: _o, targetFps: _t, tare: _r, ...view }) => ({ ...view }));
    this.nearbySnapshot = this.nearbyList.map((n) => ({ ...n }));
    this.recordingsSnapshot = this.recordingList.map((r) => ({ ...r }));
    const recordingsBytes = this.recordingList.reduce((sum, r) => sum + r.bytes, 0);
    this.statusValue = { ...this.statusValue, storage: { freeBytes: 41.7e9 - recordingsBytes, recordingsBytes } };
  }

  private emit(): void {
    this.refreshSnapshots();
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  status(): HostStatus {
    return this.statusValue;
  }
  settings(): PocketSettings {
    return this.settingsValue;
  }
  devices(): DeviceView[] {
    return this.devicesSnapshot;
  }
  nearby(): NearbyDeviceView[] {
    return this.nearbySnapshot;
  }
  recordings(): RecordingSummary[] {
    return this.recordingsSnapshot;
  }

  // -- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.tick) return;
    this.startedAt = Date.now();
    this.setStatus({ serviceRunning: true, isolationSuspected: this.isolationMs > 0 });
    this.connect();
    this.tick = setInterval(() => this.onTick(), 1000);
  }

  async stop(): Promise<void> {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    for (const timer of this.liveTimers.values()) clearInterval(timer);
    this.liveTimers.clear();
    this.setStatus({ serviceRunning: false, upstream: 'offline' });
  }

  private setStatus(patch: Partial<HostStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    this.emit();
  }

  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  private connect(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    const s = this.settingsValue;
    const serverUrl =
      s.serverTarget === 'production'
        ? 'wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws'
        : s.serverTarget === 'local'
          ? 'ws://127.0.0.1:5051/newhorizons/gateway/ws'
          : s.manualUrl;
    if (!s.relayEnabled || !serverUrl) {
      this.setStatus({ upstream: 'offline', serverUrl });
      return;
    }
    this.setStatus({ upstream: 'connecting', serverUrl });
    this.connectTimer = setTimeout(() => {
      // "Local" means the phone itself, where no server runs: stays offline.
      this.setStatus({ upstream: s.serverTarget === 'local' ? 'offline' : 'online' });
    }, 1500);
  }

  private onTick(): void {
    const now = Date.now();
    const elapsed = now - this.startedAt;
    const status: Partial<HostStatus> = {};
    if (elapsed >= this.isolationMs) {
      status.isolationSuspected = false;
      status.findmeRequests = this.statusValue.findmeRequests + (Math.random() < 0.5 ? 1 : 0);
    }
    this.statusValue = { ...this.statusValue, ...status };
    for (const device of this.deviceList) {
      if (!device.online) continue;
      device.lastSeenMs = now;
      device.fps = device.mode === 'maintenance' ? 0 : Math.max(0, device.targetFps - Math.round(Math.random() * 2));
      if (device.battery && device.battery.percent !== null && Math.random() < 0.02) {
        const step = device.battery.charging ? 1 : -1;
        device.battery = { ...device.battery, percent: Math.max(0, Math.min(100, device.battery.percent + step)) };
      }
    }
    for (const r of this.recordingList) {
      if (!r.inProgress) continue;
      r.durationMs = now - r.startedAtMs;
      r.frames = Math.round((r.durationMs / 1000) * 60);
      r.bytes = Math.round(r.durationMs * BYTES_PER_MS);
    }
    for (const n of this.nearbyList) n.lastSeenMs = now - Math.round(Math.random() * 5000);
    this.emit();
  }

  // -- live frames ----------------------------------------------------------

  subscribeLive(uid: string, listener: (frame: LiveFrame) => void): () => void {
    let set = this.liveListeners.get(uid);
    if (!set) {
      set = new Set();
      this.liveListeners.set(uid, set);
    }
    set.add(listener);
    if (!this.liveTimers.has(uid)) {
      this.liveTimers.set(
        uid,
        setInterval(() => this.emitFrame(uid), 50),
      );
    }
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        const timer = this.liveTimers.get(uid);
        if (timer) clearInterval(timer);
        this.liveTimers.delete(uid);
      }
    };
  }

  private emitFrame(uid: string): void {
    const device = this.deviceList.find((d) => d.uid === uid);
    if (!device || !device.online || !device.matrix || device.mode === 'maintenance') return;
    const values = generateFrame(uid, device.matrix.rows, device.matrix.cols, Date.now(), device.tare);
    const frame: LiveFrame = { uid, values, rows: device.matrix.rows, cols: device.matrix.cols, timestampMs: Date.now(), fps: device.fps };
    for (const listener of [...(this.liveListeners.get(uid) ?? [])]) listener(frame);
  }

  // -- settings -------------------------------------------------------------

  async updateSettings(patch: Partial<PocketSettings>): Promise<void> {
    const before = this.settingsValue;
    this.settingsValue = { ...before, ...patch };
    const reconnect =
      before.serverTarget !== this.settingsValue.serverTarget ||
      before.manualUrl !== this.settingsValue.manualUrl ||
      before.relayEnabled !== this.settingsValue.relayEnabled ||
      before.pocketId !== this.settingsValue.pocketId;
    this.emit();
    if (reconnect && this.tick) this.connect();
  }

  // -- devices --------------------------------------------------------------

  private find(uid: string): MockDevice | undefined {
    return this.deviceList.find((d) => d.uid === uid);
  }

  async adopt(uid: string): Promise<CommandOutcome> {
    await sleep(900);
    const index = this.nearbyList.findIndex((n) => n.uid === uid);
    const nearby = this.nearbyList[index];
    if (!nearby) return { ok: false, message: 'device_not_found', data: null };
    if (nearby.attachedTo) return { ok: false, message: 'device_attached_elsewhere', data: null };
    this.nearbyList.splice(index, 1);
    this.deviceList.push({
      uid,
      ownName: nearby.name,
      displayName: nearby.name,
      nickname: '',
      group: '',
      online: true,
      mode: 'normal',
      hardwareModel: 'TIA-CTL v1.5.F',
      firmwareVersion: 'v1.19.0',
      battery: { percent: 93, charging: false },
      fps: 60,
      targetFps: 60,
      matrix: { rows: 10, cols: 12 },
      recording: { enabled: false, finishing: false, error: '' },
      lastSeenMs: Date.now(),
      tare: null,
    });
    this.emit();
    return { ok: true, message: '', data: null };
  }

  async release(uid: string): Promise<CommandOutcome> {
    await sleep(600);
    const device = this.find(uid);
    if (!device) return { ok: false, message: 'device_not_found', data: null };
    this.deviceList = this.deviceList.filter((d) => d.uid !== uid);
    this.finishRecording(uid);
    if (device.online) {
      this.nearbyList.push({ uid, name: device.ownName, ip: '192.168.10.44', attachedTo: '', lastSeenMs: Date.now() });
    }
    this.emit();
    return { ok: true, message: '', data: null };
  }

  async setNickname(uid: string, nickname: string): Promise<void> {
    await sleep(150);
    const device = this.find(uid);
    if (!device) return;
    device.nickname = nickname.trim();
    device.displayName = device.nickname || device.ownName;
    for (const r of this.recordingList) if (r.uid === uid) r.deviceName = device.displayName;
    this.emit();
  }

  async run(uid: string, command: QuickCommand): Promise<CommandOutcome> {
    const device = this.find(uid);
    if (!device) return { ok: false, message: 'device_not_found', data: null };
    await sleep(350 + Math.random() * 500);
    if (!device.online) return { ok: false, message: 'device_offline', data: null };
    switch (command.kind) {
      case 'status':
        break;
      case 'reboot':
        device.online = false;
        device.fps = 0;
        this.finishRecording(uid);
        setTimeout(() => {
          device.online = true;
          device.mode = 'normal';
          device.tare = null;
          this.emit();
        }, 4000);
        break;
      case 'enter_maintenance':
        device.mode = 'maintenance';
        device.fps = 0;
        break;
      case 'exit_maintenance':
        device.mode = 'normal';
        break;
      case 'scan_rate':
        device.targetFps = command.fps;
        break;
      case 'tare':
        if (device.matrix) {
          device.tare = generateFrame(uid, device.matrix.rows, device.matrix.cols, Date.now(), null).map((v, i) =>
            Math.min(v, baselineAt(uid, i)),
          );
        }
        break;
      case 'tare_clear':
        device.tare = null;
        break;
    }
    this.emit();
    return { ok: true, message: 'ok', data: { uid, command: command.kind } };
  }

  async setRecording(uid: string, on: boolean): Promise<CommandOutcome> {
    const device = this.find(uid);
    if (!device) return { ok: false, message: 'device_not_found', data: null };
    if (on) {
      if (!device.online) return { ok: false, message: 'device_offline', data: null };
      if (device.recording.enabled) return { ok: true, message: '', data: null };
      await sleep(300);
      const startedAtMs = Date.now();
      device.recording = { enabled: true, finishing: false, error: '' };
      this.recordingList.unshift({
        id: recordingId(uid, startedAtMs),
        uid,
        deviceName: device.displayName,
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
    if (!device.recording.enabled) return { ok: true, message: '', data: null };
    device.recording = { enabled: true, finishing: true, error: '' };
    this.emit();
    await sleep(1200);
    this.finishRecording(uid);
    this.emit();
    return { ok: true, message: '', data: null };
  }

  private finishRecording(uid: string): void {
    const device = this.find(uid);
    if (device) device.recording = { enabled: false, finishing: false, error: '' };
    for (const r of this.recordingList) {
      if (r.uid === uid && r.inProgress) {
        r.inProgress = false;
        r.durationMs = Date.now() - r.startedAtMs;
        r.frames = Math.round((r.durationMs / 1000) * 60);
        r.bytes = Math.round(r.durationMs * BYTES_PER_MS);
      }
    }
  }

  // -- recordings -----------------------------------------------------------

  async timeline(recordingId: string): Promise<RecordingTimeline> {
    await sleep(400);
    const r = this.recordingList.find((x) => x.id === recordingId);
    if (!r) throw new Error('recording_not_found');
    const random = rng(hash(recordingId));
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

  async exportRecording(recordingId: string): Promise<void> {
    await sleep(700);
    if (!this.recordingList.some((r) => r.id === recordingId)) throw new Error('recording_not_found');
  }

  async deleteRecording(recordingId: string): Promise<void> {
    await sleep(250);
    this.recordingList = this.recordingList.filter((r) => r.id !== recordingId || r.inProgress);
    this.emit();
  }

  requestIgnoreBatteryOptimizations(): void {
    setTimeout(() => this.setStatus({ batteryOptimizationIgnored: true }), 800);
  }
}

// -- frame generator ----------------------------------------------------------

/** Each cell's resting reading (an unloaded sensor reads ~250-330). */
function baselineAt(uid: string, index: number): number {
  return 250 + (hash(`${uid}:${index}`) % 80);
}

/**
 * A plausible pressure frame: two contact areas moving slowly over the
 * matrix (a foot rolling heel to toe, say), pressed in and out, on top of
 * the per-cell baseline plus a little noise. Values are calibrated units in
 * the Desktop's 300..3150 default range.
 */
export function generateFrame(uid: string, rows: number, cols: number, nowMs: number, tare: number[] | null): number[] {
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
      let v = baselineAt(uid, i) + (Math.random() - 0.5) * 24;
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

export function createMockStore(options?: MockStoreOptions): PocketStore {
  return new MockPocketStore(options);
}
