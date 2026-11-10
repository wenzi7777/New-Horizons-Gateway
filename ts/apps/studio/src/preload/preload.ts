// The renderer's only door to the main process: window.nhStudio (StudioApi)
// over ipcRenderer, nothing else. Runs sandboxed (contextIsolation on,
// nodeIntegration off), so it may only import electron and code esbuild
// inlines.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { LiveFrame, StudioApi, StudioSnapshot } from '../shared/contract';
import { AREA_CALL, AREA_EVENT, type AreaName } from '../shared/areas';
import { CH, WINDOW_CH } from '../main/ipcChannels';

const snapshotListeners = new Set<(snapshot: StudioSnapshot) => void>();
const liveListeners = new Map<number, (frame: LiveFrame) => void>();

ipcRenderer.on(CH.snapshotPush, (_event: IpcRendererEvent, snapshot: StudioSnapshot) => {
  for (const listener of [...snapshotListeners]) listener(snapshot);
});

ipcRenderer.on(CH.liveFrame, (_event: IpcRendererEvent, id: number, frame: LiveFrame) => {
  liveListeners.get(id)?.(frame);
});

const areaListeners = new Set<{ area: AreaName; event: string; listener: (payload: unknown) => void }>();
ipcRenderer.on(AREA_EVENT, (_event: IpcRendererEvent, area: AreaName, name: string, payload: unknown) => {
  for (const entry of [...areaListeners]) if (entry.area === area && entry.event === name) entry.listener(payload);
});

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: StudioApi = {
  snapshot: () => invoke(CH.snapshot),
  onSnapshot(listener) {
    snapshotListeners.add(listener);
    if (snapshotListeners.size === 1) void invoke(CH.watch);
    return () => {
      snapshotListeners.delete(listener);
      if (snapshotListeners.size === 0) void invoke(CH.unwatch);
    };
  },
  subscribeLive(uid, listener) {
    let id: number | null = null;
    let cancelled = false;
    void invoke<number>(CH.liveSubscribe, uid).then(
      (assigned) => {
        if (cancelled) {
          void invoke(CH.liveUnsubscribe, assigned);
          return;
        }
        id = assigned;
        liveListeners.set(assigned, listener);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      if (id !== null) {
        liveListeners.delete(id);
        void invoke(CH.liveUnsubscribe, id);
        id = null;
      }
    };
  },
  updateSettings: (patch) => invoke(CH.updateSettings, patch),
  adopt: (uid) => invoke(CH.adopt, uid),
  release: (uid) => invoke(CH.release, uid),
  setNickname: (uid, nickname) => invoke(CH.setNickname, uid, nickname),
  setGroup: (uid, group) => invoke(CH.setGroup, uid, group),
  run: (uid, command) => invoke(CH.run, uid, command),
  sendCommand: (uid, payload) => invoke(CH.sendCommand, uid, payload),
  setRecording: (uid, on) => invoke(CH.setRecording, uid, on),
  timeline: (recordingId) => invoke(CH.timeline, recordingId),
  exportRecording: (recordingId) => invoke(CH.exportRecording, recordingId),
  revealRecording: (recordingId) => invoke(CH.revealRecording, recordingId),
  deleteRecording: (recordingId) => invoke(CH.deleteRecording, recordingId),
  chooseDataFolder: () => invoke(CH.chooseDataFolder),
  openExternal: (url) => invoke(CH.openExternal, url),
  call: (area, method, ...args) => invoke(AREA_CALL, area, method, args),
  onAreaEvent(area, event, listener) {
    const entry = { area, event, listener };
    areaListeners.add(entry);
    return () => {
      areaListeners.delete(entry);
    };
  },
};

contextBridge.exposeInMainWorld('nhStudio', api);

// The drawn title bar on Windows / Linux (macOS keeps its own).
const maximizedListeners = new Set<(maximized: boolean) => void>();
ipcRenderer.on(WINDOW_CH.maximized, (_event: IpcRendererEvent, maximized: boolean) => {
  for (const listener of [...maximizedListeners]) listener(maximized);
});
contextBridge.exposeInMainWorld('nhStudioWindow', {
  platform: process.platform,
  minimize: () => invoke<boolean>(WINDOW_CH.control, 'minimize'),
  toggleMaximize: () => invoke<boolean>(WINDOW_CH.control, 'toggleMaximize'),
  close: () => invoke<boolean>(WINDOW_CH.control, 'close'),
  isMaximized: () => invoke<boolean>(WINDOW_CH.control, 'isMaximized'),
  onMaximized(listener: (maximized: boolean) => void) {
    maximizedListeners.add(listener);
    return () => {
      maximizedListeners.delete(listener);
    };
  },
});
