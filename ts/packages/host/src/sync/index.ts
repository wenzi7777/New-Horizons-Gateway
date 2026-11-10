// Recording upload and label / profile sync with the Desktop server, shared by NH Studio and NH Pocket.
export { LOCAL_BASE_URL, maskToken, PRODUCTION_BASE_URL, redact, relayToken, serverChoiceOf, SYNC_KEYS, syncBaseUrl, TOKEN_PATTERN, type ServerChoice } from './config';
export {
  SYNC_DIR,
  SYNC_PATHS,
  SyncClient,
  SyncError,
  type ConnectionResult,
  type MetadataResult,
  type NetworkInfo,
  type RecordingSyncEntry,
  type SyncClientOptions,
  type SyncEvent,
  type SyncHost,
  type SyncStatus,
  type UploadState,
} from './client';
export { FetchSyncHttp, type SyncHttp, type SyncMethod, type SyncRequest, type SyncResponse } from './http';
export { Sha256, sha256Hex } from './sha256';
