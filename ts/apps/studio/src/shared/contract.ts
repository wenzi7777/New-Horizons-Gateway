// The seam between NH Studio's main process (src/main: the shared app host,
// @nhgw/host AppHost with clientType 'studio', on a Node HostNative) and its
// renderer (src/renderer: the new UI). It is the host's HostStore plus what
// only a desktop needs. The renderer reaches it through the preload bridge
// (window.nhStudio), never through Node directly.

import type {
  CommandOutcome,
  DeviceDetail,
  DeviceView,
  HostSettings,
  HostStatus,
  LiveFrame,
  NearbyDeviceView,
  QuickCommand,
  RecordingSummary,
  RecordingTimeline,
} from '@nhgw/host';

import type { AreaName } from './areas';

export type {
  BatteryView,
  CommandOutcome,
  ConnectionState,
  DeviceView,
  HostStatus,
  LiveFrame,
  DeviceDetail,
  HostSettings,
  NearbyDeviceView,
  QuickCommand,
  RecordingSummary,
  RecordingTimeline,
  ServerTarget,
  SyncPolicy,
} from '@nhgw/host';

/** The host's settings under their first name (kept for the renderer). */
export type PocketSettings = HostSettings;

/** Studio's settings are the host's plus where recordings go on this computer. */
export interface StudioSettings extends HostSettings {
  /** Absolute folder holding recordings/ (default: ~/Documents/NH Studio). */
  dataFolder: string;
}

/** Everything the renderer reads, in one snapshot (pushed on every change). */
export interface StudioSnapshot {
  status: HostStatus;
  settings: StudioSettings;
  devices: DeviceView[];
  nearby: NearbyDeviceView[];
  recordings: RecordingSummary[];
  /** The full device record and last status as the engine keeps them (plain JSON), for the settings pages. */
  deviceDetails: Record<string, DeviceDetail>;
  version: string;
}

/** The API the preload exposes as window.nhStudio. All calls are async (IPC). */
export interface StudioApi {
  snapshot(): Promise<StudioSnapshot>;
  /** Called with a fresh snapshot after every change (coalesced, ~4 per second at most). */
  onSnapshot(listener: (snapshot: StudioSnapshot) => void): () => void;
  /** Live frames for one device, ~30 per second at most. */
  subscribeLive(uid: string, listener: (frame: LiveFrame) => void): () => void;

  updateSettings(patch: Partial<StudioSettings>): Promise<void>;
  adopt(uid: string): Promise<CommandOutcome>;
  release(uid: string): Promise<CommandOutcome>;
  /** Asks every device on the network to announce itself to this computer (FindMe probe). */
  discoverNearby(): Promise<CommandOutcome>;
  setNickname(uid: string, nickname: string): Promise<void>;
  setGroup(uid: string, group: string): Promise<void>;
  run(uid: string, command: QuickCommand): Promise<CommandOutcome>;
  /** Any device command payload (validated by the engine like the Desktop's terminal). */
  sendCommand(uid: string, payload: Record<string, unknown>): Promise<CommandOutcome>;
  setRecording(uid: string, on: boolean): Promise<CommandOutcome>;

  timeline(recordingId: string): Promise<RecordingTimeline>;
  /** Save dialog → writes a zip of the recording folder. Resolves with the saved path, or null if cancelled. */
  exportRecording(recordingId: string): Promise<string | null>;
  /** Show the recording folder in Finder / Explorer. */
  revealRecording(recordingId: string): Promise<void>;
  deleteRecording(recordingId: string): Promise<void>;
  /** Folder picker for the data folder; resolves with the new path or null. */
  chooseDataFolder(): Promise<string | null>;
  openExternal(url: string): Promise<void>;

  /**
   * A feature area's method (see ./areas.ts). Areas wrap this in a typed
   * client (renderer/areas/<area>/api.ts); rejects with "unknown_method"
   * for anything the area did not register.
   */
  call<T = unknown>(area: AreaName, method: string, ...args: unknown[]): Promise<T>;
  /** A feature area's broadcast event. */
  onAreaEvent(area: AreaName, event: string, listener: (payload: unknown) => void): () => void;
}

/** Windows / Linux title bar buttons (absent on macOS's own title bar, and in the browser preview). */
export interface StudioWindowControls {
  platform: string;
  minimize(): Promise<boolean>;
  toggleMaximize(): Promise<boolean>;
  close(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  onMaximized(listener: (maximized: boolean) => void): () => void;
}

declare global {
  interface Window {
    nhStudio: StudioApi;
    nhStudioWindow?: StudioWindowControls;
  }
}
