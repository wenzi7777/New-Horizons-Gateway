// What NH Pocket's screens (src/ui/*) use of the shared app host
// (@nhgw/host, packages/host): a subset of its HostStore. The real store is
// AppHost on the Android module (index.ts); src/host/mockStore.ts implements
// the same interface with canned data so screens can be built and reviewed
// without a device.
import type { HostSettings, HostStore } from '@nhgw/host';

export type {
  BatteryView,
  CommandOutcome,
  ConnectionState,
  DeviceView,
  HostStatus,
  LiveFrame,
  NearbyDeviceView,
  QuickCommand,
  RecordingAnalysisInfo,
  RecordingChunk,
  RecordingSummary,
  RecordingTimeline,
  ServerTarget,
  SyncPolicy,
} from '@nhgw/host';

/** Pocket's settings are the host's. */
export type PocketSettings = HostSettings;

export type PocketStore = Pick<
  HostStore,
  | 'subscribe'
  | 'status'
  | 'settings'
  | 'devices'
  | 'nearby'
  | 'recordings'
  | 'subscribeLive'
  | 'start'
  | 'stop'
  | 'updateSettings'
  | 'adopt'
  | 'release'
  | 'setNickname'
  | 'run'
  | 'setRecording'
  | 'timeline'
  | 'recordingAnalysisInfo'
  | 'readRecordingChunk'
  | 'exportRecording'
  | 'deleteRecording'
  | 'requestIgnoreBatteryOptimizations'
>;
