import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dark, light, resolveTheme, t } from '@nhgw/ui-tokens';
import type { ConsoleStatus, GatewayHostHandle, LogLine, RuntimePaths } from '../src/hostApi';
import { defaultLocale, runTui, type TuiController } from '../src/tui';
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CURSOR_SHOW, CLEAR_SCREEN, displayWidth, nearest256, parseHex, stripAnsi } from '../src/tui/ansi';
import { renderFrame, stylesFor } from '../src/tui/layout';
import { terminalPalette } from '@nhgw/ui-tokens';

const paths: RuntimePaths = {
  root: '/srv/gw',
  runDir: '/srv/gw/.run',
  configFile: '/srv/gw/.run/config/config.json',
  logFile: '/srv/gw/.run/logs/gateway.log',
  healthFile: '/srv/gw/.run/health.json',
  pidFile: '/srv/gw/.run/gateway.pid',
  downloadsDir: '/srv/gw/.run/downloads',
};

function fakeHandle(status: Partial<ConsoleStatus> = {}, logs: LogLine[] = []) {
  const statusListeners = new Set<(s: ConsoleStatus) => void>();
  const logListeners = new Set<(l: LogLine) => void>();
  let current: ConsoleStatus = {
    enabled: true,
    gateway_id: 'gw-lab-1',
    gateway_name: 'Lab bench',
    server_url: 'wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws',
    target_mode: 'production',
    web_ui_url: 'http://127.0.0.1:5052',
    listen_udp_port: 13250,
    listen_discovery_port: 22346,
    upstream_connected: true,
    required_update: false,
    latest_gateway_version: 'v2.0.0',
    current_version: 'v2.0.0',
    ...status,
  } as ConsoleStatus;
  const recent = [...logs];
  const stop = vi.fn(async () => undefined);
  const handle: GatewayHostHandle = {
    version: 'v2.0.0',
    paths,
    status: () => current,
    onStatus: (l) => {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    recentLogs: () => recent,
    onLog: (l) => {
      logListeners.add(l);
      return () => logListeners.delete(l);
    },
    stats: () => ({ devices: 5, serving: 3, udpInFps: 12.34, upstreamSentFps: 120 }),
    stop,
    done: new Promise(() => undefined),
  };
  return {
    handle,
    stop,
    setStatus(patch: Partial<ConsoleStatus>) {
      current = { ...current, ...patch } as ConsoleStatus;
      for (const l of statusListeners) l(current);
    },
    log(message: string, level: LogLine['level'] = 'info') {
      const line = { at: Date.now(), level, message };
      recent.push(line);
      for (const l of logListeners) l(line);
    },
    listenerCount: () => statusListeners.size + logListeners.size,
  };
}

class FakeOut extends EventEmitter {
  chunks: string[] = [];
  constructor(
    public isTTY: boolean,
    public columns = 100,
    public rows = 30,
  ) {
    super();
  }
  write(chunk: string) {
    this.chunks.push(String(chunk));
    return true;
  }
  get text() {
    return this.chunks.join('');
  }
}

class FakeIn extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  paused = true;
  setRawMode(on: boolean) {
    this.raw.push(on);
    return this;
  }
  resume() {
    this.paused = false;
    return this;
  }
  pause() {
    this.paused = true;
    return this;
  }
}

const asOut = (s: FakeOut) => s as unknown as NodeJS.WriteStream;
const asIn = (s: FakeIn) => s as unknown as NodeJS.ReadStream;

function rgbCode(hex: string, layer = 38) {
  const [r, g, b] = parseHex(hex);
  return `${layer};2;${r};${g};${b}m`;
}

let controller: TuiController | null = null;
afterEach(() => {
  controller?.stop();
  controller = null;
});

describe('terminal UI (TTY)', () => {
  it('draws the status panel fields and the event log on the alternate screen', () => {
    const fake = fakeHandle({}, [{ at: Date.now(), level: 'warn', message: 'upstream reconnecting' }]);
    const out = new FakeOut(true);
    const input = new FakeIn();
    controller = runTui(fake.handle, { stdout: asOut(out), stdin: asIn(input), theme: 'light', locale: 'en', colorDepth: 24 });
    const text = out.text;
    expect(text.startsWith('\x1b]0;NH Studio\x07')).toBe(true);
    expect(text).toContain(ALT_SCREEN_ON);
    const plain = stripAnsi(text);
    for (const needle of [
      'NH Studio v2.0.0',
      'Online',
      'Enabled: Yes',
      'gw-lab-1',
      'Lab bench',
      'Production',
      'wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws',
      'http://127.0.0.1:5052',
      'UDP 13250 · FindMe 22346',
      '3 serving · 5 known',
      'UDP in 12/s · sent 120/s',
      'Up to date',
      paths.configFile,
      paths.logFile,
      'WARN',
      'upstream reconnecting',
      'Ctrl+C stops NH Studio.',
    ]) {
      expect(plain).toContain(needle);
    }
    expect(input.raw).toEqual([true]);
    expect(input.paused).toBe(false);
  });

  it('frames are exactly the terminal size, CJK included', () => {
    const fake = fakeHandle({ gateway_name: '研究室ゲートウェイ' });
    const styles = stylesFor(terminalPalette(light), 24);
    for (const [columns, rows] of [
      [100, 30],
      [60, 12],
      [40, 8],
    ] as const) {
      const frame = renderFrame(
        {
          version: 'v2.0.0',
          status: fake.handle.status(),
          stats: fake.handle.stats(),
          configFile: paths.configFile,
          logFile: paths.logFile,
          logs: [{ at: 0, level: 'info', message: 'x'.repeat(300) }],
          now: new Date(),
          stopping: false,
        },
        { columns, rows },
        styles,
        'ja',
      );
      expect(frame).toHaveLength(rows);
      for (const line of frame) expect(displayWidth(line)).toBe(columns);
    }
  });

  it('marks a required update and a disconnected upstream', () => {
    const fake = fakeHandle({ upstream_connected: false, required_update: true, latest_gateway_version: 'v2.1.0' });
    const out = new FakeOut(true);
    controller = runTui(fake.handle, { stdout: asOut(out), stdin: asIn(new FakeIn()), theme: 'dark', locale: 'en', colorDepth: 24 });
    const plain = stripAnsi(out.text);
    expect(plain).toContain('Not connected');
    expect(plain).toContain('Update required: v2.1.0');
    expect(out.text).toContain(`${rgbCode(dark.danger)}Update required: v2.1.0`);
  });

  it('uses the light or dark palette', () => {
    const outLight = new FakeOut(true);
    controller = runTui(fakeHandle().handle, { stdout: asOut(outLight), stdin: asIn(new FakeIn()), theme: 'light', colorDepth: 24, locale: 'en' });
    controller.stop();
    const outDark = new FakeOut(true);
    controller = runTui(fakeHandle().handle, { stdout: asOut(outDark), stdin: asIn(new FakeIn()), theme: 'dark', colorDepth: 24, locale: 'en' });
    expect(outLight.text).toContain(rgbCode(light.text));
    expect(outLight.text).toContain(rgbCode(light.success));
    expect(outLight.text).not.toContain(rgbCode(dark.text));
    expect(outDark.text).toContain(rgbCode(dark.text));
    expect(outDark.text).toContain(rgbCode(dark.success));
    expect(outDark.text).not.toContain(rgbCode(light.text));
  });

  it('paints the theme background (bg token for the screen, panel for the boxes), also before clearing', () => {
    for (const [theme, tokens, other] of [
      ['light', light, dark],
      ['dark', dark, light],
    ] as const) {
      const out = new FakeOut(true);
      const c = runTui(fakeHandle().handle, { stdout: asOut(out), stdin: asIn(new FakeIn()), theme, colorDepth: 24, locale: 'en' });
      c.stop();
      const bgCode = `\x1b[${rgbCode(tokens.bg, 48)}`;
      expect(out.text).toContain(`${bgCode}${CLEAR_SCREEN}`);
      expect(out.text).toContain(`\x1b[${rgbCode(tokens.panel, 48)}`);
      expect(out.text).not.toContain(rgbCode(other.bg, 48));
      // Every clear-to-end-of-line runs with the theme background set.
      const clears = out.text.split('\x1b[K').length - 1;
      expect(clears).toBeGreaterThan(0);
      expect(out.text.split(`${bgCode}\x1b[K`).length - 1).toBe(clears);
    }
  });

  it('every row of the frame keeps a background after each styled segment', () => {
    const styles = stylesFor(terminalPalette(dark), 24, { bg: dark.bg, panel: dark.panel });
    const fake = fakeHandle();
    const frame = renderFrame(
      { version: 'v2', status: fake.handle.status(), stats: fake.handle.stats(), configFile: 'c', logFile: 'l', logs: [], now: new Date(), stopping: false },
      { columns: 80, rows: 24 },
      styles,
      'en',
    );
    for (const line of frame) {
      expect(line.startsWith(styles.panel) || line.startsWith(styles.bg)).toBe(true);
      // After a reset the background comes straight back.
      for (const part of line.split('\x1b[0m').slice(1)) {
        if (part) expect(part.startsWith(styles.panel) || part.startsWith(styles.bg)).toBe(true);
      }
    }
  });

  it('shows the legacy-import notice when the host reports one', () => {
    const fake = fakeHandle({ legacy_import: { imported_at: '2026-11-09T00:00:00Z', source: '/old/gateway_config.json', in_place: false, gateway_id: 'gw-lab-1' } } as Partial<ConsoleStatus>);
    const out = new FakeOut(true, 120, 30);
    controller = runTui(fake.handle, { stdout: asOut(out), stdin: asIn(new FakeIn()), theme: 'light', locale: 'ja', colorDepth: 24 });
    const plain = stripAnsi(out.text);
    expect(plain).toContain(t('ja', 'legacyImported'));
    expect(plain).toContain('/old/gateway_config.json');
    controller.stop();
    const without = new FakeOut(true, 120, 30);
    controller = runTui(fakeHandle().handle, { stdout: asOut(without), stdin: asIn(new FakeIn()), theme: 'light', locale: 'en', colorDepth: 24 });
    expect(stripAnsi(without.text)).not.toContain(t('en', 'legacyImported'));
  });

  it('auto follows sunrise/sunset at the lab', () => {
    const noon = new Date(2026, 5, 21, 12, 0, 0);
    const midnight = new Date(2026, 5, 21, 0, 30, 0);
    for (const now of [noon, midnight]) {
      const out = new FakeOut(true);
      const c = runTui(fakeHandle().handle, { stdout: asOut(out), stdin: asIn(new FakeIn()), theme: 'auto', colorDepth: 24, locale: 'en', now: () => now });
      c.stop();
      const expected = resolveTheme('auto', now) === 'light' ? light : dark;
      expect(out.text).toContain(rgbCode(expected.text));
    }
  });

  it('maps to the 256-colour palette without COLORTERM, and to none under NO_COLOR', () => {
    const out = new FakeOut(true);
    controller = runTui(fakeHandle().handle, { stdout: asOut(out), stdin: asIn(new FakeIn()), theme: 'light', locale: 'en', env: { TERM: 'xterm-256color' } });
    expect(out.text).toContain('\x1b[38;5;');
    expect(out.text).not.toContain('\x1b[38;2;');
    expect(out.text).toContain('\x1b[48;5;');
    expect(out.text).not.toContain('\x1b[48;2;');
    controller.stop();
    const mono = new FakeOut(true);
    controller = runTui(fakeHandle().handle, { stdout: asOut(mono), stdin: asIn(new FakeIn()), theme: 'light', locale: 'en', env: { NO_COLOR: '1' } });
    expect(mono.text).not.toMatch(/\x1b\[[34]8;/);
    controller.stop();
    const truecolor = new FakeOut(true);
    controller = runTui(fakeHandle().handle, { stdout: asOut(truecolor), stdin: asIn(new FakeIn()), theme: 'light', locale: 'en', env: { COLORTERM: 'truecolor' } });
    expect(truecolor.text).toContain('\x1b[38;2;');
  });

  it('nearest256 picks sensible entries', () => {
    expect(nearest256([0, 0, 0])).toBe(16);
    expect([231, 255]).toContain(nearest256([255, 255, 255]));
    expect(nearest256([128, 128, 128])).toBeGreaterThanOrEqual(232);
    expect(nearest256([255, 0, 0])).toBe(196);
  });

  it('draws new log lines on the next tick, and redraws everything on resize', async () => {
    const fake = fakeHandle();
    const out = new FakeOut(true);
    controller = runTui(fake.handle, { stdout: asOut(out), stdin: asIn(new FakeIn()), theme: 'light', locale: 'en', colorDepth: 24, refreshMs: 40 });
    fake.log('device AA:BB attached');
    expect(stripAnsi(out.text)).not.toContain('device AA:BB attached');
    await new Promise((r) => setTimeout(r, 100));
    expect(stripAnsi(out.text)).toContain('device AA:BB attached');
    const before = out.text.split(CLEAR_SCREEN).length;
    out.columns = 70;
    out.emit('resize');
    expect(out.text.split(CLEAR_SCREEN).length).toBe(before + 1);
  });

  it('Ctrl+C calls onExit once and shows stopping; a second calls onForceExit', () => {
    const fake = fakeHandle();
    const out = new FakeOut(true);
    const input = new FakeIn();
    const onExit = vi.fn();
    const onForceExit = vi.fn();
    controller = runTui(fake.handle, { stdout: asOut(out), stdin: asIn(input), theme: 'light', locale: 'en', onExit, onForceExit });
    input.emit('data', Buffer.from('\x03'));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(stripAnsi(out.text)).toContain('Stopping NH Studio…');
    input.emit('data', '\x03');
    expect(onForceExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+C defaults to handle.stop()', () => {
    const fake = fakeHandle();
    const input = new FakeIn();
    controller = runTui(fake.handle, { stdout: asOut(new FakeOut(true)), stdin: asIn(input), theme: 'light', locale: 'en' });
    input.emit('data', '\x03');
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('stop() restores the terminal and unsubscribes', () => {
    const fake = fakeHandle();
    const out = new FakeOut(true);
    const input = new FakeIn();
    const c = runTui(fake.handle, { stdout: asOut(out), stdin: asIn(input), theme: 'light', locale: 'en' });
    expect(fake.listenerCount()).toBe(1);
    expect(process.listenerCount('exit')).toBeGreaterThan(0);
    const exitListeners = process.listenerCount('exit');
    c.stop();
    c.stop();
    const tail = out.text.slice(out.text.lastIndexOf(CURSOR_SHOW));
    expect(tail).toContain(ALT_SCREEN_OFF);
    expect(out.text.split(ALT_SCREEN_OFF)).toHaveLength(2);
    expect(input.raw).toEqual([true, false]);
    expect(input.paused).toBe(true);
    expect(fake.listenerCount()).toBe(0);
    expect(process.listenerCount('exit')).toBe(exitListeners - 1);
    expect(input.listenerCount('data')).toBe(0);
    expect(out.listenerCount('resize')).toBe(0);
  });

  it('uses the shared dictionaries for the locale', () => {
    const out = new FakeOut(true, 120, 30);
    controller = runTui(fakeHandle().handle, { stdout: asOut(out), stdin: asIn(new FakeIn()), theme: 'light', locale: 'ja_JP.UTF-8', colorDepth: 24 });
    const plain = stripAnsi(out.text);
    expect(plain).toContain(t('ja', 'gatewayIdLabel'));
    expect(plain).toContain(t('ja', 'statusOnline'));
    expect(plain).toContain(t('ja', 'targetProduction'));
  });
});

describe('terminal UI (not a TTY)', () => {
  it('prints plain lines: status block, logs, status changes; no escapes and no stdin', () => {
    const fake = fakeHandle({}, [{ at: Date.now(), level: 'info', message: 'started' }]);
    const out = new FakeOut(false);
    const input = new FakeIn();
    controller = runTui(fake.handle, { stdout: asOut(out), stdin: asIn(input), theme: 'dark', locale: 'en', colorDepth: 24 });
    fake.log('\x1b[31mred\x1b[0m error text', 'error');
    fake.setStatus({ upstream_connected: true }); // nothing visible changed
    const linesBefore = out.chunks.length;
    fake.setStatus({ upstream_connected: false });
    expect(out.chunks.length).toBeGreaterThan(linesBefore);
    expect(out.text).not.toContain('\x1b');
    expect(out.text).toContain('Gateway ID: gw-lab-1');
    expect(out.text).toContain('Status: ● Online');
    expect(out.text).toContain('Status: ● Not connected');
    expect(out.text).toMatch(/\d\d:\d\d:\d\d INFO  started/);
    expect(out.text).toMatch(/ERROR red error text/);
    expect(input.raw).toEqual([]);
    expect(input.listenerCount('data')).toBe(0);
    fake.setStatus({ legacy_import: { source: '/old/config.json' } } as Partial<ConsoleStatus>);
    expect(out.text).toContain('Imported settings from the previous Gateway.  /old/config.json');
    controller.stop();
    expect(fake.listenerCount()).toBe(0);
  });
});

describe('defaultLocale', () => {
  it('reads LC_ALL > LC_MESSAGES > LANG and skips C/POSIX', () => {
    expect(defaultLocale({ LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ja');
    expect(defaultLocale({ LC_ALL: 'C', LANG: 'zh_CN.UTF-8' })).toBe('zh-CN');
    expect(defaultLocale({ LANG: 'C.UTF-8', LC_MESSAGES: 'POSIX', LC_ALL: '' })).toMatch(/^(en|ja|zh-CN)$/);
  });
});
