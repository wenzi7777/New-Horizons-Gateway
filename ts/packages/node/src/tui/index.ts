// The Gateway's terminal UI: a status panel over a scrolling event log, like
// the Python Textual console (newhorizons_gateway/gateway_tui.py), with no
// dependencies (Ink cannot be bundled into the CommonJS file a Node SEA
// runs: yoga-layout uses top-level await).
//
//  - stdout is a terminal: the alternate screen, redrawn at most every
//    350 ms (only the rows that changed are rewritten) and at once on resize;
//    the whole screen is painted with the theme's `bg` token and the boxes
//    with `panel`, so light/dark do not depend on the terminal's own colours;
//    the terminal is restored by stop(), on process exit and on an uncaught
//    exception. Ctrl+C calls options.onExit (default: handle.stop()) and the
//    footer shows "Stopping…"; a second Ctrl+C calls options.onForceExit
//    (default: restore the terminal, exit 130).
//  - stdout is not a terminal (service, redirected to a file): plain lines,
//    the status block when something other than the counters changes and
//    every log line as it comes. stdin and signals are left alone.
//
// Colours: @nhgw/ui-tokens' terminalPalette for the light or dark theme
// ("auto" = light by day and dark by night at the lab, re-checked when the
// next sunrise/sunset passes), 24-bit when COLORTERM says truecolor, else
// the nearest xterm-256 colour, none under NO_COLOR.

import { writeSync } from 'node:fs';
import {
  daylightAt,
  normalizeLocale,
  resolveTheme,
  terminalPalette,
  themes,
  type Locale,
  type Theme,
  type ThemeMode,
} from '@nhgw/ui-tokens';
import type { GatewayHostHandle, LogLine } from '../hostApi';
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  AUTOWRAP_OFF,
  AUTOWRAP_ON,
  CLEAR_LINE_RIGHT,
  CLEAR_SCREEN,
  CURSOR_HIDE,
  CURSOR_SHOW,
  type ColorDepth,
  detectColorDepth,
  moveTo,
  RESET,
  setTitle,
} from './ansi';
import { type FrameModel, plainLogLine, plainStatusLines, renderFrame, stylesFor, connectionCell, updateCell } from './layout';

export { renderFrame, plainStatusLines, plainLogLine, stylesFor } from './layout';
export { tuiText } from './strings';
export { detectColorDepth, nearest256 } from './ansi';

export const REFRESH_MS = 350;
const MAX_LOG_LINES = 1000;
const THEME_RECHECK_MS = 60_000;

export interface TuiOptions {
  /** 'auto' (default) follows sunrise/sunset at the lab. */
  theme?: ThemeMode;
  /** A locale tag ("ja", "zh-CN", "en_US.UTF-8"); default from LC_ALL/LC_MESSAGES/LANG, then Intl. */
  locale?: string;
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  /** First Ctrl+C. Default: `void handle.stop()` (handle.done then resolves "exit"). */
  onExit?: () => void;
  /** Second Ctrl+C while stopping. Default: restore the terminal and process.exit(130). */
  onForceExit?: () => void;
  /** Overrides for tests: environment (colour depth, locale), clock, colour depth, redraw interval. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  colorDepth?: ColorDepth;
  refreshMs?: number;
}

export interface TuiController {
  /** Unsubscribes, stops timers, restores the terminal (idempotent). Does not stop the host. */
  stop(): void;
}

/** The locale for the terminal: LC_ALL > LC_MESSAGES > LANG (ignoring C/POSIX), then Intl. */
export function defaultLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  for (const value of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const tag = (value ?? '').trim();
    if (!tag) continue;
    const base = tag.split('.')[0]!.toUpperCase();
    if (base === 'C' || base === 'POSIX') continue;
    return normalizeLocale(tag);
  }
  try {
    return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return 'en';
  }
}

export function runTui(handle: GatewayHostHandle, options: TuiOptions = {}): TuiController {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const locale: Locale = options.locale ? normalizeLocale(options.locale) : defaultLocale(env);
  const mode: ThemeMode = options.theme ?? 'auto';
  const depth: ColorDepth = options.colorDepth ?? detectColorDepth(env);

  const logs: LogLine[] = [...handle.recentLogs()].slice(-MAX_LOG_LINES);
  const unsubscribers: (() => void)[] = [];
  let stopped = false;
  let stopping = false;

  const model = (): FrameModel => {
    let stats: FrameModel['stats'];
    try {
      stats = handle.stats();
    } catch {
      stats = { devices: 0, serving: 0, udpInFps: 0, upstreamSentFps: 0 };
    }
    return {
      version: handle.version,
      status: handle.status(),
      stats,
      configFile: handle.paths.configFile,
      logFile: handle.paths.logFile,
      logs,
      now: now(),
      stopping,
    };
  };

  if (!stdout.isTTY) {
    // Plain output: the status block when it changes (not for counters), and log lines.
    const write = (text: string) => {
      try {
        stdout.write(`${text}\n`);
      } catch {
        // A closed pipe must not take the Gateway down.
      }
    };
    let lastSignature = '';
    const printStatus = () => {
      const m = model();
      const signature = JSON.stringify([
        connectionCell(m.status, locale).text,
        updateCell(m.status, m.version, locale).text,
        m.status.enabled,
        m.status.gateway_id,
        m.status.gateway_name,
        m.status.server_url,
        m.status.target_mode,
        m.status.web_ui_url,
        m.status.listen_udp_port,
        m.status.listen_discovery_port,
        m.status.current_version,
        Boolean((m.status as Record<string, unknown>).legacy_import),
      ]);
      if (signature === lastSignature) return;
      lastSignature = signature;
      for (const line of plainStatusLines(m, locale)) write(line);
    };
    printStatus();
    for (const line of logs) write(plainLogLine(line));
    unsubscribers.push(handle.onStatus(() => printStatus()));
    unsubscribers.push(handle.onLog((line) => write(plainLogLine(line))));
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        for (const off of unsubscribers.splice(0)) off();
      },
    };
  }

  // ---- full-screen mode ----
  let themeCache: { theme: Theme; until: number } | null = null;
  const currentTheme = (date: Date): Theme => {
    const t = date.getTime();
    if (!themeCache || t >= themeCache.until || t < themeCache.until - 2 * 86_400_000) {
      const theme = resolveTheme(mode, date);
      const next = mode === 'auto' ? daylightAt(date).nextChange : null;
      // Re-check at the next sunrise/sunset, and at least once a minute (clock changes, sleep).
      const until = Math.min(next ? next.getTime() : Infinity, t + THEME_RECHECK_MS);
      themeCache = { theme, until };
    }
    return themeCache.theme;
  };

  const rawFd = (stdout as unknown as { fd?: unknown }).fd;
  const fd = typeof rawFd === 'number' ? rawFd : null;
  const writeOut = (text: string, sync = false) => {
    if (sync && fd !== null) {
      try {
        writeSync(fd, text);
        return;
      } catch {
        // fall through
      }
    }
    try {
      stdout.write(text);
    } catch {
      // ignore: terminal gone
    }
  };

  let previous: string[] = [];
  let previousTheme: Theme | null = null;
  const render = (full = false) => {
    if (stopped) return;
    const m = model();
    const theme = currentTheme(m.now);
    const tokens = themes[theme];
    const styles = stylesFor(terminalPalette(tokens), depth, { bg: tokens.bg, panel: tokens.panel });
    const size = { columns: stdout.columns || 80, rows: stdout.rows || 24 };
    const frame = renderFrame(m, size, styles, locale);
    const redrawAll = full || theme !== previousTheme || frame.length !== previous.length;
    // The background SGR is set before clearing, so cleared cells take the theme's bg (not the terminal's).
    let out = redrawAll ? `${RESET}${styles.bg}${CLEAR_SCREEN}` : '';
    for (let i = 0; i < frame.length; i++) {
      if (!redrawAll && frame[i] === previous[i]) continue;
      out += `${moveTo(i + 1)}${frame[i]}${RESET}${styles.bg}${CLEAR_LINE_RIGHT}`;
    }
    previous = frame;
    previousTheme = theme;
    if (out) writeOut(`${out}${RESET}`);
  };

  const restoreSequence = `${RESET}${CURSOR_SHOW}${AUTOWRAP_ON}${ALT_SCREEN_OFF}`;
  let rawMode = false;
  let resumed = false;
  const restoreTerminal = (sync: boolean) => {
    writeOut(restoreSequence, sync);
    if (rawMode && typeof stdin.setRawMode === 'function') {
      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    rawMode = false;
  };

  const onProcessExit = () => {
    if (stopped) return;
    stopped = true;
    restoreTerminal(true);
  };
  const onCrash = () => {
    if (stopped) return;
    stopped = true;
    restoreTerminal(true);
  };
  process.on('exit', onProcessExit);
  process.on('uncaughtExceptionMonitor', onCrash);
  unsubscribers.push(() => {
    process.off('exit', onProcessExit);
    process.off('uncaughtExceptionMonitor', onCrash);
  });

  const controller: TuiController = {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const off of unsubscribers.splice(0)) off();
      restoreTerminal(false);
      if (resumed) {
        try {
          stdin.pause();
        } catch {
          // ignore
        }
      }
    },
  };

  const onExit = options.onExit ?? (() => void handle.stop().catch(() => undefined));
  const onForceExit =
    options.onForceExit ??
    (() => {
      controller.stop();
      process.exit(130);
    });

  const onKey = (data: Buffer | string) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    for (const ch of text) {
      if (ch === '\x03') {
        if (stopping) {
          onForceExit();
          return;
        }
        stopping = true;
        render();
        onExit();
      } else if (ch === '\x0c') {
        render(true); // Ctrl+L
      }
    }
  };

  writeOut(`${setTitle('NH Studio')}${ALT_SCREEN_ON}${CURSOR_HIDE}${AUTOWRAP_OFF}${CLEAR_SCREEN}`);

  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    try {
      stdin.setRawMode(true);
      rawMode = true;
    } catch {
      rawMode = false;
    }
  }
  stdin.on('data', onKey);
  unsubscribers.push(() => stdin.off('data', onKey));
  if (stdin.isTTY) {
    stdin.resume();
    resumed = true;
  }

  const onResize = () => render(true);
  stdout.on('resize', onResize);
  unsubscribers.push(() => stdout.off('resize', onResize));

  // New lines go into the buffer; the next tick draws them (at most every refreshMs).
  unsubscribers.push(
    handle.onLog((line) => {
      logs.push(line);
      if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
    }),
  );

  const timer = setInterval(() => render(), options.refreshMs ?? REFRESH_MS);
  timer.unref?.();
  render(true);
  return controller;
}
