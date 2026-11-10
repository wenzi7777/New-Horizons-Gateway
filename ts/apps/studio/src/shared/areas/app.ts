// Typed API of the "app" area (see ../areas.ts): Studio-only preferences
// (update channel, start at login, background), self-update, the start-up
// splash, diagnostics and maintenance. main/areas/app.ts implements it;
// renderer/areas/app/api.ts and the splash call it.

export type UpdateChannelPref = 'stable' | 'beta';

/** Preferences only Studio has (the host's settings travel through api.updateSettings). */
export interface AppPrefs {
  updateChannel: UpdateChannelPref;
  checkUpdatesOnStart: boolean;
  /** Mirrors app.getLoginItemSettings().openAtLogin. */
  openAtLogin: boolean;
  /** Closing the window keeps relaying/recording (macOS default on, Windows default off). */
  keepRunningInBackground: boolean;
  /** The first-run guide (server, sign-in, sync, device policy) was finished or skipped. */
  onboardingDone: boolean;
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  /** No manifest published for the channel yet (404): shown as "no release yet", never an error. */
  | 'none'
  | 'current'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'installing'
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  channel: UpdateChannelPref;
  currentVersion: string;
  latestVersion: string;
  notesUrl: string;
  /** The release has no build for this computer (platform key below). */
  noAssetForPlatform: boolean;
  platformKey: string;
  downloadedBytes: number;
  totalBytes: number;
  /** Error code (download_failed, sha256_mismatch, size_mismatch, http_<n>, network, …). */
  error: string;
  checkedAtMs: number | null;
}

export type SplashStepId = 'settings' | 'recovery' | 'ports' | 'server' | 'update';
export type SplashStepStatus = 'pending' | 'running' | 'done' | 'warn' | 'skipped' | 'blocked';

export interface SplashStep {
  id: SplashStepId;
  status: SplashStepStatus;
  /** Code + values the splash turns into a sentence (e.g. recovered:{count}). */
  detail: string;
  vars?: Record<string, string | number>;
}

/** A question the splash is waiting on. */
export type SplashPrompt =
  | { kind: 'ports'; message: string }
  | { kind: 'update'; version: string; notesUrl: string };

export interface SplashState {
  version: string;
  theme: 'light' | 'dark';
  locale: string;
  steps: SplashStep[];
  prompt: SplashPrompt | null;
  update: UpdateState | null;
  done: boolean;
}

export type SplashAnswer = 'continue' | 'retry' | 'quit' | 'install' | 'later';

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  arch: string;
  osRelease: string;
  userDataDir: string;
  logDir: string;
  dataFolder: string;
  packaged: boolean;
}

export interface ConnectionInfo {
  /** The server link's last error ('' when none / unknown). */
  lastError: string;
  ports: { stream: number; discovery: number; boundStream: number | null; boundDiscovery: number | null };
  serviceRunning: boolean;
  serviceError: string;
}

export interface PruneResult {
  /** Recordings matched (dry run) or deleted. */
  count: number;
  bytes: number;
  failed: number;
}

export interface AppAreaApi {
  getPrefs(): AppPrefs;
  setPrefs(patch: Partial<AppPrefs>): AppPrefs;
  info(): AppInfo;
  connectionInfo(): ConnectionInfo;
  updateState(): UpdateState;
  checkForUpdate(): UpdateState;
  installUpdate(): UpdateState;
  openReleaseNotes(): void;
  openLogFolder(): void;
  revealDataFolder(): void;
  /** Save dialog, then a zip (logs, settings without secrets, versions); the saved path or null. */
  exportDiagnostics(): string | null;
  /** Studio prefs and the host's settings back to defaults (id, name, devices, data folder kept). */
  resetSettings(): void;
  pruneRecordings(olderThanDays: number, dryRun: boolean): PruneResult;
  splashState(): SplashState;
  splashAnswer(answer: SplashAnswer): void;
}

export interface AppAreaEvents {
  update: UpdateState;
  prefs: AppPrefs;
  splash: SplashState;
}
