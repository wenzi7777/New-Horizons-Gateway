export {
  ACTIVE_SLOT_LABEL,
  DEFAULT_AUTO_CHECK_INTERVAL_SEC,
  DOWNLOAD_TIMEOUT_MS,
  GatewayUpdateManager,
  MANIFEST_TIMEOUT_MS,
  NOTES_TIMEOUT_MS,
  STAGED_SLOT_LABEL,
  type UpdateManagerOptions,
} from './manager';
export {
  binManifestUrlFor,
  localizedNotesUrl,
  NOTES_TRANSLATIONS,
  parseBinManifest,
  PLATFORM_KEYS,
  type BinManifest,
  type PlatformAsset,
  type PlatformKey,
} from './manifest';
export type { InstallerBootStatus, StagedUpdate, StageInfo, UpdateInstaller } from './installer';
export { BOOT_GRACE_SEC, IDLE_SEC, RETRY_SEC, RequiredUpdateAutoApplier, type AutoApplierOptions } from './autoApply';
