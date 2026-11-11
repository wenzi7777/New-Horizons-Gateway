// The seam between the app host (AppHost: the engine, the platform's
// HostNative, files, the server link) and an app's UI. HostStore is the full
// interface, designed for NH Studio; NH Pocket's screens use a subset of it
// (apps/pocket/src/host/contract.ts PocketStore). Values here are plain JSON
// (no PyFloat): the host converts engine records with plainJson() before
// handing them out.

import type { Locale, ThemeMode } from '@nhgw/ui-tokens';

export type ConnectionState = 'offline' | 'connecting' | 'online';
export type ServerTarget = 'production' | 'local' | 'manual';
export type SyncPolicy = 'manual' | 'auto' | 'wifi_only';

/** Which app the host runs in: reported upstream as client_type and in recordings' meta. */
export type HostClientType = 'studio' | 'pocket';

export interface HostSettings {
  /** Relay id shown on the server (gateway_id). The field keeps its first (Pocket) name. */
  pocketId: string;
  displayName: string;
  serverTarget: ServerTarget;
  manualUrl: string;
  /** Relay managed devices to the server while connected. */
  relayEnabled: boolean;
  /** "managed" (default): only devices added here; "all": every device that asks. */
  offerPolicy: 'managed' | 'all';
  /** Recording upload; the upload itself arrives with the sync phase. */
  syncPolicy: SyncPolicy;
  theme: ThemeMode;
  /** 'system' follows the OS language. */
  locale: Locale | 'system';
}

export interface BatteryView {
  percent: number | null;
  charging: boolean;
}

export interface DeviceView {
  uid: string;
  /** Nickname if set, else the device's own name, else NHOS-<UID>. */
  displayName: string;
  nickname: string;
  group: string;
  online: boolean;
  /** "normal" | "maintenance" | "safe" … as the device reports it. */
  mode: string;
  hardwareModel: string;
  firmwareVersion: string;
  battery: BatteryView | null;
  /** Frames per second received from the device, last second. */
  fps: number;
  matrix: { rows: number; cols: number } | null;
  recording: { enabled: boolean; finishing: boolean; error: string };
  lastSeenMs: number | null;
  /** TIA-CTL v2.0.F: its Vref DAC and range; null (or absent) on a board without one. */
  vref?: VrefView | null;
}

/** Where a Vref sits against the GPIO45 boot strap (see vrefZone in views.ts). */
export type VrefZone = 'auto' | 'safe' | 'raised' | 'near' | 'risk' | 'unknown';
export type RangeMode = 'raw' | 'virtual' | 'auto';

export interface VrefView {
  mv: number | null;
  zone: VrefZone;
  limitMv: number | null;
  mode: RangeMode;
  refRfbOhm: number;
  leakCompensation: boolean;
  /** Rows with a measured Rfb, of `rfbRows`; the range modes need at least one. */
  rfbMeasuredRows: number;
  rfbRows: number;
  rfbMedianOhm: number | null;
  saturatedRows: number | null;
  calibrationOn: boolean;
}

export interface NearbyDeviceView {
  uid: string;
  name: string;
  ip: string;
  /** Set when the device said it is attached to another Gateway/Studio/Pocket/server. */
  attachedTo: string;
  lastSeenMs: number;
}

export interface LiveFrame {
  uid: string;
  /** Calibrated values P1..Pn in device order (row-major for the matrix). */
  values: number[];
  rows: number;
  cols: number;
  timestampMs: number;
  fps: number;
}

export interface RecordingSummary {
  /** Stable id: the folder path relative to the data root. */
  id: string;
  uid: string;
  deviceName: string;
  startedAtMs: number;
  durationMs: number;
  frames: number;
  bytes: number;
  inProgress: boolean;
  syncState: 'local' | 'uploading' | 'synced';
}

/** What the analysis screen needs to open a recording: file sizes and the parsed .meta.json. */
export interface RecordingAnalysisInfo {
  /** Bytes of the data CSV (0 when missing). */
  dataBytes: number;
  eventsBytes: number;
  meta: Record<string, unknown> | null;
}

/** One slice of a recording file; decode with a streaming TextDecoder (a slice can end inside a character). */
export interface RecordingChunk {
  data: Uint8Array;
  nextOffset: number;
  done: boolean;
  totalBytes: number;
}

export interface RecordingTimeline {
  /** Up to 240 buckets of summed pressure, min and max per bucket. */
  buckets: { min: number; max: number }[];
  durationMs: number;
  lostFrames: number;
  gaps: number;
  events: { atMs: number; label: string }[];
}

export interface HostStatus {
  serviceRunning: boolean;
  /** Why the UDP service is not serving although started (e.g. a port held by another Gateway/Studio/Desktop); '' when fine. */
  serviceError: string;
  upstream: ConnectionState;
  /** The server refused this app's token (revoked, or the server was reset): sign in again. */
  authRejected: boolean;
  serverUrl: string;
  /** IPv4 addresses of this phone / computer, for the device setup hint. */
  addresses: { name: string; address: string }[];
  batteryOptimizationIgnored: boolean | null;
  /** FindMe requests seen since start; 0 for a while hints at client isolation. */
  findmeRequests: number;
  /** Running for 60 s with Wi-Fi up and no FindMe at all. */
  isolationSuspected: boolean;
  storage: { freeBytes: number; recordingsBytes: number };
}

export interface CommandOutcome {
  ok: boolean;
  /** Error code or the device's message. */
  message: string;
  data: unknown;
}

/** Commands the UI offers; the host maps them to device payloads. */
export type QuickCommand =
  | { kind: 'status' }
  | { kind: 'reboot' }
  | { kind: 'enter_maintenance' }
  | { kind: 'exit_maintenance' }
  | { kind: 'scan_rate'; fps: 60 | 90 }
  | { kind: 'tare' }
  | { kind: 'tare_clear' }
  /** v2.0.F: switch the range mode, keeping the reference Rfb and leak setting unless given. */
  | { kind: 'range_mode'; mode: RangeMode; refRfbOhm?: number; leakCompensation?: boolean }
  /** v2.0.F: Vref back to its safe 330 mV. */
  | { kind: 'vref_reset' }
  /** v2.0.F: measure each row's Rfb (about 1.5 s). */
  | { kind: 'rfb_measure' };

/** The engine's full record of one device and its last status (plain JSON), for settings pages. */
export interface DeviceDetail {
  record: Record<string, unknown>;
  status: Record<string, unknown>;
}

/** A recording folder zipped to a temp file (exportZip); the caller moves or shares it. */
export interface ExportedZip {
  /** Absolute path of the zip. */
  path: string;
  /** `<UID>_<YYYYMMDD>_<HHMMSS>.zip` */
  name: string;
}

export interface HostStore {
  /** Any change to status, settings, devices, nearby or recordings (coalesced, at most every 250 ms). */
  subscribe(listener: () => void): () => void;
  status(): HostStatus;
  settings(): HostSettings;
  devices(): DeviceView[];
  nearby(): NearbyDeviceView[];
  recordings(): RecordingSummary[];
  /** Full engine records of the devices in devices(), by UID. */
  deviceDetails(): Record<string, DeviceDetail>;

  /** Live frames for one device, at most ~20 per second. */
  subscribeLive(uid: string, listener: (frame: LiveFrame) => void): () => void;

  start(): Promise<void>;
  stop(): Promise<void>;
  updateSettings(patch: Partial<HostSettings>): Promise<void>;

  adopt(uid: string): Promise<CommandOutcome>;
  release(uid: string): Promise<CommandOutcome>;
  setNickname(uid: string, nickname: string): Promise<void>;
  setGroup(uid: string, group: string): Promise<void>;
  run(uid: string, command: QuickCommand): Promise<CommandOutcome>;
  /** Any device command payload, validated by the engine like the Desktop's terminal; waits for the device's result. */
  sendCommand(uid: string, payload: Record<string, unknown>): Promise<CommandOutcome>;
  setRecording(uid: string, on: boolean): Promise<CommandOutcome>;

  timeline(recordingId: string): Promise<RecordingTimeline>;
  /** The sizes of a recording's CSV files and its meta, for the analysis screen. */
  recordingAnalysisInfo(recordingId: string): Promise<RecordingAnalysisInfo>;
  /** A slice of a recording's data or events CSV (at most `length` bytes from `offset`). */
  readRecordingChunk(recordingId: string, file: 'data' | 'events', offset: number, length: number): Promise<RecordingChunk>;
  /** Zips the recording folder (without its raw capture) to a temp file. */
  exportZip(recordingId: string): Promise<ExportedZip>;
  /** exportZip, then the host's share callback (Pocket: the Android share sheet). */
  exportRecording(recordingId: string): Promise<void>;
  deleteRecording(recordingId: string): Promise<void>;

  requestIgnoreBatteryOptimizations(): void;
}
