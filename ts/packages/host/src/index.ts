// @nhgw/host: the app host NH Studio and NH Pocket share (see host.ts).
export * from './contract';
export * from './nativeApi';
export { AppHost, type AppHostOptions, type HostDocuments, COMMAND_RESULT_TIMEOUT_MS, DEFAULT_VERSION, DISCOVERY_PORT, RingLogger, resultOutcome, STREAM_PORT } from './host';
export { FetchHttp, HostClock, NativeUdpSocket, NoUpdateControl, noAutoApplier, RelayUpstream, RnWsConnector } from './adapters';
export { quickCommandPayload, TARE_DURATION_MS } from './commands';
export { NativeJsonStore, NativeRecordingSink, NHRAW_SUFFIX, PATHS } from './files';
export { dict, num, plainJson, str } from './plainJson';
export { RawCaptures, rawPaths, type RawSidecar } from './rawCaptures';
export { RecordingCatalog, recordingDirectory, recordingIdOf } from './recordings';
export { decideRecovery, FAILED_SUFFIX, parseSidecar, recoverCaptures, RECOVERY_CHUNK_BYTES } from './recovery';
export { LatestThrottle, LIVE_FRAME_INTERVAL_MS, realTimers, type TimerPort } from './throttle';
export * from './views';
export * from './profiles';
export * as apps from './apps';
export * from './sync';
export * from './tools';
