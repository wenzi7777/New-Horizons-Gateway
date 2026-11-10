// The StudioApi handlers with a fake ipcMain, fake windows and fake timers:
// argument checks, coalesced snapshot pushes, throttled live frames, dialogs.
import { describe, expect, it } from 'vitest';

import type { LiveFrame, TimerPort } from '@nhgw/host';

import type { StudioSnapshot } from '../../src/shared/contract';
import { CH } from '../../src/main/ipcChannels';
import { externalUrl, LIVE_INTERVAL_MS, registerStudioIpc, SNAPSHOT_INTERVAL_MS, type DesktopPorts, type IpcEventLike, type IpcMainLike, type SenderLike, type StudioBackend } from '../../src/main/ipc';

const UID = '3CDC7545CCD0';

class FakeTimers implements TimerPort {
  t = 0;
  private queue: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.queue.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.queue = this.queue.filter((item) => item.id !== handle);
  }
  advance(ms: number) {
    const until = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at);
      const next = this.queue[0];
      if (!next || next.at > until) break;
      this.queue.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = until;
  }
}

class FakeIpc implements IpcMainLike {
  handlers = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown) {
    if (this.handlers.has(channel)) throw new Error(`second handler for ${channel}`);
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string) {
    this.handlers.delete(channel);
  }
  async invoke(sender: SenderLike, channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler ${channel}`);
    return handler({ sender }, ...args);
  }
}

class FakeSender implements SenderLike {
  sent: { channel: string; args: unknown[] }[] = [];
  destroyed = false;
  private onDestroyed: (() => void)[] = [];
  constructor(readonly id: number) {}
  send(channel: string, ...args: unknown[]) {
    this.sent.push({ channel, args });
  }
  isDestroyed() {
    return this.destroyed;
  }
  once(_event: 'destroyed', listener: () => void) {
    this.onDestroyed.push(listener);
  }
  destroy() {
    this.destroyed = true;
    for (const fn of this.onDestroyed) fn();
  }
  of(channel: string) {
    return this.sent.filter((item) => item.channel === channel);
  }
}

function makeBackend() {
  const listeners = new Set<() => void>();
  const live = new Map<string, Set<(frame: LiveFrame) => void>>();
  const calls: unknown[][] = [];
  let version = 0;
  const ok = { ok: true, message: 'ok', data: null };
  const backend: StudioBackend & { change(): void; frame(uid: string, n: number): void; calls: unknown[][]; liveCount(): number } = {
    calls,
    snapshot: () => ({ version: `v${version}`, settings: { dataFolder: '/data' } }) as unknown as StudioSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    subscribeLive(uid, listener) {
      let set = live.get(uid);
      if (!set) live.set(uid, (set = new Set()));
      set.add(listener);
      return () => void set!.delete(listener);
    },
    async updateSettings(patch) {
      calls.push(['updateSettings', patch]);
    },
    recordingPath(id) {
      if (id.split('/').length !== 3) throw new Error('invalid_recording_id');
      return `/data/recordings/${id}`;
    },
    async exportTo(id, destination) {
      calls.push(['exportTo', id, destination]);
      return destination;
    },
    host: {
      adopt: async (uid) => (calls.push(['adopt', uid]), ok),
      release: async (uid) => (calls.push(['release', uid]), ok),
      setNickname: async (uid, nickname) => void calls.push(['setNickname', uid, nickname]),
      setGroup: async (uid, group) => void calls.push(['setGroup', uid, group]),
      run: async (uid, command) => (calls.push(['run', uid, command]), ok),
      sendCommand: async (uid, payload) => (calls.push(['sendCommand', uid, payload]), ok),
      setRecording: async (uid, on) => (calls.push(['setRecording', uid, on]), ok),
      timeline: async (id) => (calls.push(['timeline', id]), { buckets: [], durationMs: 0, lostFrames: 0, gaps: 0, events: [] }),
      deleteRecording: async (id) => void calls.push(['deleteRecording', id]),
    },
    change() {
      version += 1;
      for (const listener of listeners) listener();
    },
    frame(uid, n) {
      for (const listener of live.get(uid) ?? []) listener({ uid, values: [n], rows: 1, cols: 1, timestampMs: n, fps: 60 });
    },
    liveCount: () => [...live.values()].reduce((sum, set) => sum + set.size, 0),
  };
  return backend;
}

function setup(overrides: Partial<DesktopPorts> = {}, trusted = true) {
  const ipc = new FakeIpc();
  const timers = new FakeTimers();
  const backend = makeBackend();
  const desktop: DesktopPorts & { shown: string[]; opened: string[] } = {
    shown: [],
    opened: [],
    saveZip: async (name) => `/Users/me/Downloads/${name}`,
    chooseFolder: async () => '/Volumes/Lab/NH Studio',
    showItemInFolder(path) {
      this.shown.push(path);
    },
    async openExternal(url) {
      this.opened.push(url);
    },
    zipName: (id) => `${id.split('/').join('_')}.zip`,
    ...overrides,
  };
  // Labels are edited on the server (the sync client), which updates the host's mirror.
  const labels = {
    setLabel: async (uid: string, patch: { nickname?: string; group?: string }) => {
      if (patch.nickname !== undefined) await backend.host.setNickname(uid, patch.nickname);
      if (patch.group !== undefined) await backend.host.setGroup(uid, patch.group);
    },
  };
  const dispose = registerStudioIpc(ipc, backend, desktop, { timers, isTrustedSender: () => trusted, labels: () => labels });
  return { ipc, timers, backend, desktop, dispose };
}

describe('registerStudioIpc', () => {
  it('registers every channel and removes them on dispose', () => {
    const { ipc, dispose } = setup();
    const requests = Object.entries(CH).filter(([key]) => !['snapshotPush', 'liveFrame'].includes(key)).map(([, channel]) => channel);
    expect([...ipc.handlers.keys()].sort()).toEqual(requests.sort());
    dispose();
    expect(ipc.handlers.size).toBe(0);
  });

  it('pushes snapshots to watching windows at most every 250 ms, latest only', async () => {
    const { ipc, timers, backend } = setup();
    const win = new FakeSender(1);
    const other = new FakeSender(2);
    expect(await ipc.invoke(win, CH.snapshot)).toMatchObject({ version: 'v0' });
    await ipc.invoke(win, CH.watch);
    expect(win.of(CH.snapshotPush)).toHaveLength(1); // one right away
    for (let i = 0; i < 10; i++) backend.change();
    expect(win.of(CH.snapshotPush)).toHaveLength(1);
    timers.advance(SNAPSHOT_INTERVAL_MS);
    expect(win.of(CH.snapshotPush).map((item) => (item.args[0] as StudioSnapshot).version)).toEqual(['v0', 'v10']);
    expect(other.sent).toHaveLength(0); // never watched
    await ipc.invoke(win, CH.unwatch);
    backend.change();
    timers.advance(1000);
    expect(win.of(CH.snapshotPush)).toHaveLength(2);
  });

  it('throttles live frames per subscription to 30 per second and stops them on unsubscribe or window close', async () => {
    const { ipc, timers, backend } = setup();
    const win = new FakeSender(1);
    const id = (await ipc.invoke(win, CH.liveSubscribe, UID.toLowerCase())) as number;
    for (let ms = 0; ms < 1000; ms += 5) {
      backend.frame(UID, ms);
      timers.advance(5);
    }
    const frames = win.of(CH.liveFrame);
    expect(frames.length).toBeLessThanOrEqual(31);
    expect(frames.length).toBeGreaterThanOrEqual(25);
    expect(frames[0]!.args[0]).toBe(id);
    await ipc.invoke(win, CH.liveUnsubscribe, id);
    expect(backend.liveCount()).toBe(0);
    await ipc.invoke(win, CH.liveSubscribe, UID);
    expect(backend.liveCount()).toBe(1);
    win.destroy();
    expect(backend.liveCount()).toBe(0);
  });

  it('checks arguments before they reach the host', async () => {
    const { ipc, backend } = setup();
    const win = new FakeSender(1);
    await expect(ipc.invoke(win, CH.adopt, 'nope')).rejects.toThrow('invalid_uid');
    await expect(ipc.invoke(win, CH.run, UID, { kind: 'format_disk' })).rejects.toThrow('invalid_command');
    await expect(ipc.invoke(win, CH.run, UID, { kind: 'scan_rate', fps: 120 })).rejects.toThrow('invalid_command');
    await expect(ipc.invoke(win, CH.sendCommand, UID, ['status'])).rejects.toThrow('invalid_payload');
    await expect(ipc.invoke(win, CH.setRecording, UID, 'yes')).rejects.toThrow('invalid_recording_switch');
    await expect(ipc.invoke(win, CH.updateSettings, { theme: 'neon' })).rejects.toThrow('invalid_setting_theme');
    await expect(ipc.invoke(win, CH.updateSettings, { evil: 1 })).rejects.toThrow('invalid_setting_evil');
    expect(backend.calls).toEqual([]);

    await ipc.invoke(win, CH.adopt, UID.toLowerCase());
    await ipc.invoke(win, CH.run, UID, { kind: 'scan_rate', fps: 90 });
    await ipc.invoke(win, CH.sendCommand, UID, { command: 'status' });
    await ipc.invoke(win, CH.setGroup, UID, 'Lab');
    await ipc.invoke(win, CH.setRecording, UID, true);
    await ipc.invoke(win, CH.updateSettings, { theme: 'dark', relayEnabled: false });
    expect(backend.calls).toEqual([
      ['adopt', UID],
      ['run', UID, { kind: 'scan_rate', fps: 90 }],
      ['sendCommand', UID, { command: 'status' }],
      ['setGroup', UID, 'Lab'],
      ['setRecording', UID, true],
      ['updateSettings', { theme: 'dark', relayEnabled: false }],
    ]);
  });

  it('exports through the save dialog, reveals, picks the data folder and opens only http(s)', async () => {
    const id = `${UID}/20261110/120000`;
    const { ipc, backend, desktop } = setup();
    const win = new FakeSender(1);
    expect(await ipc.invoke(win, CH.exportRecording, id)).toBe(`/Users/me/Downloads/${UID}_20261110_120000.zip`);
    await expect(ipc.invoke(win, CH.exportRecording, 'not-a-recording')).rejects.toThrow('invalid_recording_id');
    await ipc.invoke(win, CH.revealRecording, id);
    expect(desktop.shown).toEqual([`/data/recordings/${id}`]);
    expect(await ipc.invoke(win, CH.chooseDataFolder)).toBe('/Volumes/Lab/NH Studio');
    expect(backend.calls).toContainEqual(['updateSettings', { dataFolder: '/Volumes/Lab/NH Studio' }]);
    await ipc.invoke(win, CH.openExternal, 'https://github.com/wenzi7777');
    expect(desktop.opened).toEqual(['https://github.com/wenzi7777']);
    await expect(ipc.invoke(win, CH.openExternal, 'file:///etc/passwd')).rejects.toThrow('invalid_url');
    await expect(ipc.invoke(win, CH.openExternal, 'javascript:alert(1)')).rejects.toThrow('invalid_url');

    const cancelled = setup({ saveZip: async () => null, chooseFolder: async () => null });
    expect(await cancelled.ipc.invoke(win, CH.exportRecording, id)).toBeNull();
    expect(await cancelled.ipc.invoke(win, CH.chooseDataFolder)).toBeNull();
    expect(cancelled.backend.calls).toEqual([]);
  });

  it('refuses untrusted senders', async () => {
    const { ipc } = setup({}, false);
    await expect(ipc.invoke(new FakeSender(1), CH.snapshot)).rejects.toThrow('untrusted_sender');
  });

  it('externalUrl normalises http(s) only', () => {
    expect(externalUrl('HTTPS://Example.com/a b')).toBe('https://example.com/a%20b');
    expect(() => externalUrl('mailto:a@b')).toThrow('invalid_url');
    expect(() => externalUrl(42)).toThrow('invalid_url');
  });
});
