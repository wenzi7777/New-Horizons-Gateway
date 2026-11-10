// The StudioApi's main-process half, kept free of Electron so it can be
// tested with a fake ipcMain: request handlers (argument checks, then the
// controller), snapshot pushes coalesced to at most 4 per second per window,
// and live frames at most 30 per second per subscription.
import { LatestThrottle, type TimerPort, realTimers } from '@nhgw/host';
import type { CommandOutcome, LiveFrame, QuickCommand } from '@nhgw/host';

import type { StudioSettings, StudioSnapshot } from '../shared/contract';
import { CH } from './ipcChannels';

export const SNAPSHOT_INTERVAL_MS = 250;
export const LIVE_INTERVAL_MS = Math.ceil(1000 / 30);

/** The part of Electron's WebContents the handlers use. */
export interface SenderLike {
  readonly id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface IpcEventLike {
  sender: SenderLike;
}

/** The part of Electron's ipcMain the handlers use. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** What the handlers need from the controller (StudioController implements it). */
export interface StudioBackend {
  snapshot(): StudioSnapshot;
  subscribe(listener: () => void): () => void;
  subscribeLive(uid: string, listener: (frame: LiveFrame) => void): () => void;
  updateSettings(patch: Partial<StudioSettings>): Promise<void>;
  recordingPath(recordingId: string): string;
  exportTo(recordingId: string, destination: string): Promise<string>;
  readonly host: {
    adopt(uid: string): Promise<CommandOutcome>;
    release(uid: string): Promise<CommandOutcome>;
    setNickname(uid: string, nickname: string): Promise<void>;
    setGroup(uid: string, group: string): Promise<void>;
    run(uid: string, command: QuickCommand): Promise<CommandOutcome>;
    sendCommand(uid: string, payload: Record<string, unknown>): Promise<CommandOutcome>;
    setRecording(uid: string, on: boolean): Promise<CommandOutcome>;
    timeline(recordingId: string): Promise<import('@nhgw/host').RecordingTimeline>;
    deleteRecording(recordingId: string): Promise<void>;
  };
}

/** Dialogs and the shell (Electron's dialog / shell in main.ts). */
export interface DesktopPorts {
  /** Save dialog for a zip; the chosen absolute path or null. */
  saveZip(defaultName: string, sender: SenderLike): Promise<string | null>;
  /** Folder picker starting at `current`; the chosen absolute path or null. */
  chooseFolder(current: string, sender: SenderLike): Promise<string | null>;
  showItemInFolder(path: string): void;
  openExternal(url: string): Promise<void>;
  /** The zip's default file name for a recording. */
  zipName(recordingId: string): string;
}

export interface IpcOptions {
  /** Requests from any other sender (an unexpected frame) are refused. */
  isTrustedSender?: (event: IpcEventLike) => boolean;
  timers?: TimerPort;
  logger?: { warn(message: string): void };
}

const UID = /^[0-9A-Fa-f]{12}$/;

function uidArg(value: unknown): string {
  if (typeof value !== 'string' || !UID.test(value)) throw new Error('invalid_uid');
  return value.toUpperCase();
}

function stringArg(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`invalid_${name}`);
  return value;
}

function objectArg(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${name}`);
  return value as Record<string, unknown>;
}

const QUICK_KINDS = new Set(['status', 'reboot', 'enter_maintenance', 'exit_maintenance', 'scan_rate', 'tare', 'tare_clear']);

function quickArg(value: unknown): QuickCommand {
  const command = objectArg(value, 'command');
  if (typeof command.kind !== 'string' || !QUICK_KINDS.has(command.kind)) throw new Error('invalid_command');
  if (command.kind === 'scan_rate' && command.fps !== 60 && command.fps !== 90) throw new Error('invalid_command');
  return command as QuickCommand;
}

const SETTINGS_KEYS: Record<keyof StudioSettings, 'string' | 'boolean'> = {
  pocketId: 'string',
  displayName: 'string',
  serverTarget: 'string',
  manualUrl: 'string',
  relayEnabled: 'boolean',
  offerPolicy: 'string',
  syncPolicy: 'string',
  theme: 'string',
  locale: 'string',
  dataFolder: 'string',
};

const SETTINGS_VALUES: Partial<Record<keyof StudioSettings, readonly string[]>> = {
  serverTarget: ['production', 'local', 'manual'],
  offerPolicy: ['managed', 'all'],
  syncPolicy: ['manual', 'auto', 'wifi_only'],
  theme: ['auto', 'light', 'dark'],
  locale: ['system', 'en', 'ja', 'zh-CN'],
};

function settingsArg(value: unknown): Partial<StudioSettings> {
  const patch = objectArg(value, 'settings');
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(patch)) {
    const type = SETTINGS_KEYS[key as keyof StudioSettings];
    if (type === undefined) throw new Error(`invalid_setting_${key}`);
    if (typeof item !== type) throw new Error(`invalid_setting_${key}`);
    const allowed = SETTINGS_VALUES[key as keyof StudioSettings];
    if (allowed && !allowed.includes(item as string)) throw new Error(`invalid_setting_${key}`);
    if (typeof item === 'string' && item.length > 2048) throw new Error(`invalid_setting_${key}`);
    out[key] = item;
  }
  return out as Partial<StudioSettings>;
}

/** Only http(s) URLs leave the app. */
export function externalUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid_url');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid_url');
  return url.toString();
}

type Window = {
  sender: SenderLike;
  throttle: LatestThrottle<null> | null;
  live: Map<number, { off: () => void; throttle: LatestThrottle<LiveFrame> }>;
};

/** Registers every StudioApi handler; returns a function that removes them and stops all pushes. */
export function registerStudioIpc(ipc: IpcMainLike, backend: StudioBackend, desktop: DesktopPorts, options: IpcOptions = {}): () => void {
  const timers = options.timers ?? realTimers;
  const trusted = options.isTrustedSender ?? (() => true);
  const windows = new Map<number, Window>();
  let nextLiveId = 1;

  const windowOf = (sender: SenderLike): Window => {
    let win = windows.get(sender.id);
    if (win === undefined) {
      win = { sender, throttle: null, live: new Map() };
      windows.set(sender.id, win);
      const id = sender.id;
      sender.once('destroyed', () => dropWindow(id));
    }
    return win;
  };

  const dropWindow = (id: number) => {
    const win = windows.get(id);
    if (win === undefined) return;
    windows.delete(id);
    win.throttle?.close();
    for (const sub of win.live.values()) {
      sub.off();
      sub.throttle.close();
    }
  };

  const push = (win: Window) => {
    if (win.sender.isDestroyed()) return dropWindow(win.sender.id);
    try {
      win.sender.send(CH.snapshotPush, backend.snapshot());
    } catch (error) {
      options.logger?.warn(`snapshot push: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const offBackend = backend.subscribe(() => {
    for (const win of windows.values()) win.throttle?.push(null);
  });

  const handlers: Record<string, (event: IpcEventLike, ...args: unknown[]) => unknown> = {
    [CH.snapshot]: () => backend.snapshot(),
    [CH.watch]: (event) => {
      const win = windowOf(event.sender);
      if (win.throttle === null) win.throttle = new LatestThrottle<null>(() => push(win), SNAPSHOT_INTERVAL_MS, timers);
      // A fresh one right away, so a late listener does not wait for the next change.
      win.throttle.push(null);
    },
    [CH.unwatch]: (event) => {
      const win = windows.get(event.sender.id);
      win?.throttle?.close();
      if (win) win.throttle = null;
    },
    [CH.liveSubscribe]: (event, uid) => {
      const key = uidArg(uid);
      const win = windowOf(event.sender);
      const id = nextLiveId++;
      const throttle = new LatestThrottle<LiveFrame>(
        (frame) => {
          if (win.sender.isDestroyed()) return dropWindow(win.sender.id);
          win.sender.send(CH.liveFrame, id, frame);
        },
        LIVE_INTERVAL_MS,
        timers,
      );
      const off = backend.subscribeLive(key, (frame) => throttle.push(frame));
      win.live.set(id, { off, throttle });
      return id;
    },
    [CH.liveUnsubscribe]: (event, id) => {
      const win = windows.get(event.sender.id);
      const sub = typeof id === 'number' ? win?.live.get(id) : undefined;
      if (sub === undefined) return;
      win!.live.delete(id as number);
      sub.off();
      sub.throttle.close();
    },
    [CH.updateSettings]: (_event, patch) => backend.updateSettings(settingsArg(patch)),
    [CH.adopt]: (_event, uid) => backend.host.adopt(uidArg(uid)),
    [CH.release]: (_event, uid) => backend.host.release(uidArg(uid)),
    [CH.setNickname]: (_event, uid, nickname) => backend.host.setNickname(uidArg(uid), stringArg(nickname, 'nickname')),
    [CH.setGroup]: (_event, uid, group) => backend.host.setGroup(uidArg(uid), stringArg(group, 'group')),
    [CH.run]: (_event, uid, command) => backend.host.run(uidArg(uid), quickArg(command)),
    [CH.sendCommand]: (_event, uid, payload) => {
      const body = objectArg(payload, 'payload');
      if (typeof body.command !== 'string' || !body.command) throw new Error('invalid_payload');
      return backend.host.sendCommand(uidArg(uid), body);
    },
    [CH.setRecording]: (_event, uid, on) => {
      if (typeof on !== 'boolean') throw new Error('invalid_recording_switch');
      return backend.host.setRecording(uidArg(uid), on);
    },
    [CH.timeline]: (_event, id) => backend.host.timeline(stringArg(id, 'recording_id', 512)),
    [CH.exportRecording]: async (event, id) => {
      const recordingId = stringArg(id, 'recording_id', 512);
      backend.recordingPath(recordingId); // validates before the dialog opens
      const destination = await desktop.saveZip(desktop.zipName(recordingId), event.sender);
      if (destination === null) return null;
      return backend.exportTo(recordingId, destination);
    },
    [CH.revealRecording]: (_event, id) => {
      desktop.showItemInFolder(backend.recordingPath(stringArg(id, 'recording_id', 512)));
    },
    [CH.deleteRecording]: (_event, id) => backend.host.deleteRecording(stringArg(id, 'recording_id', 512)),
    [CH.chooseDataFolder]: async (event) => {
      const folder = await desktop.chooseFolder(backend.snapshot().settings.dataFolder, event.sender);
      if (folder === null) return null;
      await backend.updateSettings({ dataFolder: folder });
      return folder;
    },
    [CH.openExternal]: (_event, url) => desktop.openExternal(externalUrl(url)),
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipc.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error('untrusted_sender');
      return handler(event, ...args);
    });
  }

  return () => {
    offBackend();
    for (const channel of Object.keys(handlers)) ipc.removeHandler(channel);
    for (const id of [...windows.keys()]) dropWindow(id);
  };
}
