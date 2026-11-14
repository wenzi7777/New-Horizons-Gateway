// Typed API of the "sync" area (see ../areas.ts): recording upload and
// label / profile sync with the Desktop server, through @nhgw/host's
// SyncClient. main/areas/sync.ts implements it, renderer/areas/sync calls it.
// Plain JSON only; the token never comes back (only a masked form).

export type SyncUploadState = 'local' | 'queued' | 'uploading' | 'synced' | 'failed';

export interface SyncRecordingEntry {
  id: string;
  uid: string;
  deviceName: string;
  startedAtMs: number;
  bytes: number;
  state: SyncUploadState;
  sentBytes: number;
  totalBytes: number;
  /** '' or a plain code: network, unauthorized, forbidden, server_error, recording_id_conflict, data_file_missing … */
  error: string;
  attempts: number;
  nextAttemptMs: number;
  syncedAtMs: number;
  serverPath: string;
}

export interface SyncConnectionResult {
  ok: boolean;
  /** '' | no_token | no_server | network | unauthorized | forbidden | not_admin | server_error | sync_unsupported | unexpected */
  error: string;
  checkedAtMs: number;
  username: string;
  role: string;
  clientType: string;
}

export interface SyncMetadataResult {
  ok: boolean;
  error: string;
  atMs: number;
  pushed: number;
  pulled: number;
}

export interface SyncAreaStatus {
  configured: boolean;
  tokenMasked: string;
  /** The Desktop account signed in with ('' when none). */
  account: string;
  baseUrl: string;
  policy: 'manual' | 'auto' | 'wifi_only';
  paused: boolean;
  autoAllowed: boolean;
  network: { online: boolean; metered: boolean | null };
  connection: SyncConnectionResult | null;
  recordings: SyncRecordingEntry[];
  counts: Record<SyncUploadState, number>;
  current: { id: string; sentBytes: number; totalBytes: number } | null;
  lastUploadMs: number;
  /** An account is remembered: Studio signs in by itself. */
  remembered: boolean;
  /** The remembered account (or none) cannot sign in by itself: the user has to. */
  tokenRejected: boolean;
  labels: SyncMetadataResult | null;
  profiles: SyncMetadataResult | null;
}

export interface RelayBenchReport {
  framesPerSecond: number;
  packetBytes: number;
  link: { ok: boolean; error: string; rttMs: number | null; uploadBytesPerSecond: number | null };
  estimate: {
    fps: number;
    sensors: number;
    bytesPerDevicePerSecond: number;
    devicesByMachine: number;
    devicesByNetwork: number | null;
    devices: number;
    bottleneck: 'machine' | 'network' | 'unknown';
  };
}

export interface SyncAreaApi {
  status(): SyncAreaStatus;
  /** Signs in with a Desktop account, remembers it (encrypted by the OS) so Studio signs in again by itself on every start, tests the connection. */
  login(username: string, password: string): SyncConnectionResult;
  /** Ends this install's token on the server (best effort) and forgets the account. */
  logout(): SyncAreaStatus;
  testConnection(): SyncConnectionResult;
  /** One recording, or every finished one not yet synced; ignores the policy. */
  uploadNow(id?: string): SyncAreaStatus;
  retry(id?: string): SyncAreaStatus;
  pause(): SyncAreaStatus;
  resume(): SyncAreaStatus;
  syncLabelsNow(): SyncMetadataResult;
  /** Relay performance test: this computer (3 s), then the server link. */
  relayBench(): RelayBenchReport;
  syncProfilesNow(): SyncMetadataResult;
}

export interface SyncAreaEvents {
  /** Bytes sent of the recording being uploaded. */
  progress: { id: string; sentBytes: number; totalBytes: number };
  /** Anything else changed: a fresh status. */
  state: SyncAreaStatus;
}
