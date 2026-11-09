// The host side of a self-update, replacing Python's slot_a/slot_b + venv +
// bootloader machinery. The core downloads and verifies the release; what it
// takes to make the next start run it is the host's business:
//
//  - desktop (Node SEA): stage() writes the new binary beside the running one
//    (e.g. `<exe>.new`); activate() swaps it in, keeping the old one as
//    `<exe>.old` so a start that fails its health check can roll back; the
//    restart callback then exits/relaunches.
//  - android: stage() writes the APK into app storage; activate() opens the
//    system package installer (the user confirms; the OS replaces the app).
//
// How GatewayUpdateManager.state() maps onto it (field names unchanged, so
// the WebUI and the Desktop read them as before):
//   pending_release_ready / pending_slot / boot_phase "pending_switch"
//                                     <- staged() !== null
//   target_version, pending_slot_version <- staged().version
//   active_slot "current", inactive_slot "staged" (labels, there are no slots)
//   rollback_reason, boot_phase "rolled_back", health_ready <- bootStatus()

export interface StageInfo {
  version: string;
  platformKey: string;
  url: string;
  sha256: string;
  size: number;
}

export interface StagedUpdate {
  version: string;
}

export interface InstallerBootStatus {
  /** Non-empty when the last start rolled back from a staged release. */
  rollbackReason?: string;
  /** The running build passed its own start-up health check. */
  healthReady?: boolean;
  /**
   * The release that was switched to and failed its health check. The manager
   * stops treating exactly that version as required, so the auto-applier does
   * not stage it, roll back and stage it again forever; a newer release, or a
   * manual apply, still goes ahead.
   */
  rolledBackVersion?: string;
}

export interface UpdateInstaller {
  /**
   * Persists verified bytes so that activate() can switch to them. Replaces
   * anything staged earlier. `onProgress` takes 0..100. Rejects on failure.
   */
  stage(bytes: Uint8Array, info: StageInfo, onProgress?: (pct: number) => void): Promise<void>;
  /** What is staged and not yet activated, or null. Must be cheap and synchronous: state() reads it. */
  staged(): StagedUpdate | null;
  /** Makes the staged release the one the next start runs (desktop: swap files; android: open the installer). */
  activate(): Promise<void>;
  bootStatus?(): InstallerBootStatus;
}
