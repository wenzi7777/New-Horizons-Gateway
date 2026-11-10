// Browser-preview (mock) implementation of the "app" area: the same
// methods as main/areas/app.ts, with canned behaviour.
import type { AppInfo, AppPrefs, ConnectionInfo, UpdateState } from '../../../shared/areas/app';
import type { AreaMock } from '../mockTypes';

export const appMock: AreaMock = (emit) => {
  let prefs: AppPrefs = { updateChannel: 'stable', checkUpdatesOnStart: true, openAtLogin: false, keepRunningInBackground: true };
  let update: UpdateState = {
    phase: 'idle',
    channel: 'stable',
    currentVersion: 'v2.0.0',
    latestVersion: '',
    notesUrl: '',
    noAssetForPlatform: false,
    platformKey: 'darwin-arm64',
    downloadedBytes: 0,
    totalBytes: 0,
    error: '',
    checkedAtMs: null,
  };
  const info: AppInfo = {
    version: 'v2.0.0',
    electron: '45.2.3',
    node: '22',
    chrome: '142',
    platform: 'darwin',
    arch: 'arm64',
    osRelease: '25.0.0',
    userDataDir: '/Users/demo/Library/Application Support/NH Studio',
    logDir: '/Users/demo/Library/Application Support/NH Studio/logs',
    dataFolder: '/Users/demo/Documents/NH Studio',
    packaged: false,
  };
  const connection: ConnectionInfo = {
    lastError: '',
    ports: { stream: 13250, discovery: 22346, boundStream: 13250, boundDiscovery: 22346 },
    serviceRunning: true,
    serviceError: '',
  };
  const setUpdate = (patch: Partial<UpdateState>) => {
    update = { ...update, ...patch };
    emit('update', update);
    return update;
  };
  return {
    getPrefs: () => prefs,
    setPrefs: (patch: Partial<AppPrefs>) => {
      prefs = { ...prefs, ...patch };
      if (patch.updateChannel) setUpdate({ channel: patch.updateChannel, phase: 'idle' });
      emit('prefs', prefs);
      return prefs;
    },
    info: () => info,
    connectionInfo: () => connection,
    updateState: () => update,
    checkForUpdate: async () => {
      setUpdate({ phase: 'checking' });
      await new Promise((resolve) => setTimeout(resolve, 600));
      return setUpdate({ phase: 'none', checkedAtMs: Date.now() });
    },
    installUpdate: () => update,
    openReleaseNotes: () => undefined,
    openLogFolder: () => undefined,
    revealDataFolder: () => undefined,
    exportDiagnostics: () => '/Users/demo/Downloads/nh-studio-diagnostics.zip',
    resetSettings: () => undefined,
    pruneRecordings: (days: number, dryRun: boolean) => ({ count: dryRun ? Math.max(0, 5 - Math.floor(days / 10)) : 0, bytes: 12_000_000, failed: 0 }),
    splashState: () => null,
    splashAnswer: () => undefined,
  };
};
