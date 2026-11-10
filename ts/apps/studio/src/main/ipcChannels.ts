// IPC channel names between the preload bridge (window.nhStudio) and the
// main process. Requests are ipcRenderer.invoke -> ipcMain.handle; pushes are
// webContents.send -> ipcRenderer.on.
export const CH = {
  // requests
  snapshot: 'nh-studio:snapshot',
  /** Starts snapshot pushes to the calling window (the preload calls it on the first onSnapshot listener). */
  watch: 'nh-studio:watch',
  unwatch: 'nh-studio:unwatch',
  liveSubscribe: 'nh-studio:live-subscribe',
  liveUnsubscribe: 'nh-studio:live-unsubscribe',
  updateSettings: 'nh-studio:update-settings',
  adopt: 'nh-studio:adopt',
  release: 'nh-studio:release',
  setNickname: 'nh-studio:set-nickname',
  setGroup: 'nh-studio:set-group',
  run: 'nh-studio:run',
  sendCommand: 'nh-studio:send-command',
  setRecording: 'nh-studio:set-recording',
  timeline: 'nh-studio:timeline',
  exportRecording: 'nh-studio:export-recording',
  revealRecording: 'nh-studio:reveal-recording',
  deleteRecording: 'nh-studio:delete-recording',
  chooseDataFolder: 'nh-studio:choose-data-folder',
  openExternal: 'nh-studio:open-external',
  // pushes (main -> renderer)
  snapshotPush: 'nh-studio:snapshot-push',
  liveFrame: 'nh-studio:live-frame',
} as const;

export type Channel = (typeof CH)[keyof typeof CH];

/** Windows / Linux title bar (handled in main.ts, not registerStudioIpc). */
export const WINDOW_CH = {
  /** ('minimize' | 'toggleMaximize' | 'close' | 'isMaximized') -> isMaximized */
  control: 'nh-studio:window-control',
  /** push: isMaximized changed */
  maximized: 'nh-studio:window-maximized',
} as const;
