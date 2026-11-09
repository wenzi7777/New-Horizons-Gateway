// What the terminal UI shows, as pure functions of the host's state: the
// full-screen frame (status panel over a scrolling event log, as in the
// Python Textual console gateway_tui.py) and the plain lines printed when
// stdout is not a terminal. No I/O here, so tests render it directly.

import { isNewerVersion } from '@nhgw/core';
import type { Locale, TerminalPalette } from '@nhgw/ui-tokens';
import type { ConsoleStatus, LogLine } from '../hostApi';
import { bg, BOLD, type ColorDepth, fg, renderRow, sanitize, type Segment, wrap, displayWidth } from './ansi';
import { tuiText } from './strings';
import type { MessageKey } from '@nhgw/ui-tokens';

export interface HostStats {
  devices: number;
  serving: number;
  udpInFps: number;
  upstreamSentFps: number;
}

export interface FrameModel {
  version: string;
  status: ConsoleStatus;
  stats: HostStats;
  configFile: string;
  logFile: string;
  logs: readonly LogLine[];
  now: Date;
  /** Ctrl+C was pressed: the host is shutting down. */
  stopping: boolean;
}

/** SGR prefixes for each palette role ('' everywhere when monochrome). */
export interface Styles {
  text: string;
  dim: string;
  accent: string;
  title: string;
  success: string;
  warning: string;
  danger: string;
  /** Backgrounds: the screen (`bg` token) and the two boxes (`panel`); '' when monochrome. */
  bg: string;
  panel: string;
}

/**
 * Foregrounds from the terminal palette; backgrounds from the theme's `bg`
 * and `panel` tokens, so the screen follows the light/dark theme whatever
 * the terminal's own colours are.
 */
export function stylesFor(palette: TerminalPalette, depth: ColorDepth, surfaces?: { bg: string; panel: string }): Styles {
  const accent = fg(palette.accent, depth);
  return {
    bg: surfaces ? bg(surfaces.bg, depth) : '',
    panel: surfaces ? bg(surfaces.panel, depth) : '',
    text: fg(palette.text, depth),
    dim: fg(palette.textDim, depth),
    accent,
    title: depth === 1 ? BOLD : `${BOLD}${accent}`,
    success: fg(palette.success, depth),
    warning: fg(palette.warning, depth),
    danger: fg(palette.danger, depth),
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function clockText(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function rate(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : sanitize(String(value)).trim();
}

type Tone = keyof Styles;
interface StatusRow {
  label: string;
  value: { text: string; tone: Tone }[];
}

function targetModeLabel(locale: Locale, mode: string): string {
  const key = ({ production: 'targetProduction', local: 'targetLocal', manual: 'targetManual' } as const)[
    mode.toLowerCase() as 'production' | 'local' | 'manual'
  ];
  return key ? tuiText(locale, key) : mode;
}

/** The update cell: required (danger), available (warning), up to date (success) or not checked (dim). */
export function updateCell(status: ConsoleStatus, version: string, locale: Locale): { text: string; tone: Tone } {
  const current = str(status.current_version) || version;
  const latest = str(status.latest_gateway_version);
  if (status.required_update) return { text: tuiText(locale, 'updateRequiredShort', { version: latest }), tone: 'danger' };
  if (latest && isNewerVersion(latest, current)) return { text: tuiText(locale, 'updateAvailable', { version: latest }), tone: 'warning' };
  if (latest) return { text: tuiText(locale, 'upToDateShort'), tone: 'success' };
  return { text: tuiText(locale, 'updateNotChecked'), tone: 'dim' };
}

/** Connection state: disabled, not set up, online or not connected. */
export function connectionCell(status: ConsoleStatus, locale: Locale): { text: string; tone: Tone } {
  if (!status.enabled) return { text: `○ ${tuiText(locale, 'statusDisabled')}`, tone: 'dim' };
  if (!str(status.gateway_id)) return { text: `● ${tuiText(locale, 'statusSetup')}`, tone: 'warning' };
  if (status.upstream_connected) return { text: `● ${tuiText(locale, 'statusOnline')}`, tone: 'success' };
  return { text: `● ${tuiText(locale, 'statusOffline')}`, tone: 'warning' };
}

export function statusRows(model: FrameModel, locale: Locale): StatusRow[] {
  const { status, stats } = model;
  const L = (key: MessageKey, vars?: Record<string, unknown>) => tuiText(locale, key, vars);
  const id = str(status.gateway_id);
  const name = str(status.gateway_name);
  const mode = str(status.target_mode);
  const server = str(status.server_url);
  const current = str(status.current_version) || model.version;
  const rows: StatusRow[] = [
    {
      label: L('cardStatus'),
      value: [
        connectionCell(status, locale),
        { text: `   ${L('tuiEnabled')}: `, tone: 'dim' },
        { text: status.enabled ? L('tuiYes') : L('tuiNo'), tone: 'text' },
      ],
    },
    {
      label: L('gatewayIdLabel'),
      value: [
        { text: id || '-', tone: 'text' },
        ...(name && name !== id ? [{ text: `  ${L('tuiName')}: ${name}`, tone: 'dim' as Tone }] : []),
      ],
    },
    {
      label: L('factServer'),
      value: [
        ...(mode ? [{ text: `${targetModeLabel(locale, mode)}  `, tone: 'text' as Tone }] : []),
        { text: server || '-', tone: 'dim' },
      ],
    },
    { label: L('tuiWebUi'), value: [{ text: str(status.web_ui_url) || 'http://127.0.0.1:5052', tone: 'accent' }] },
    {
      label: L('factPorts'),
      value: [
        {
          text: L('tuiPortsValue', { udp: status.listen_udp_port || '', findme: status.listen_discovery_port || '' }),
          tone: 'text',
        },
      ],
    },
    {
      label: L('cardServing'),
      value: [{ text: L('tuiDevicesValue', { serving: stats.serving, devices: stats.devices }), tone: 'text' }],
    },
    {
      label: L('factTraffic'),
      value: [{ text: L('trafficValue', { in: rate(stats.udpInFps), out: rate(stats.upstreamSentFps) }), tone: 'text' }],
    },
    {
      label: L('cardVersion'),
      value: [{ text: `${current}   `, tone: 'text' }, updateCell(status, model.version, locale)],
    },
    { label: L('tuiConfigFile'), value: [{ text: model.configFile, tone: 'dim' }] },
    ...legacyImportRows(status, locale),
    { label: L('tuiLogFile'), value: [{ text: model.logFile, tone: 'dim' }] },
  ];
  return rows;
}

/** The host's `legacy_import` record (settings taken over from the Python Gateway): one notice row. */
function legacyImportRows(status: ConsoleStatus, locale: Locale): StatusRow[] {
  const info = (status as Record<string, unknown>).legacy_import;
  if (!info || typeof info !== 'object') return [];
  const source = str((info as Record<string, unknown>).source);
  return [
    {
      label: '',
      value: [
        { text: tuiText(locale, 'legacyImported'), tone: 'accent' },
        ...(source ? [{ text: `  ${source}`, tone: 'dim' as Tone }] : []),
      ],
    },
  ];
}

const H = '─';

function topBorder(title: Segment[], right: Segment[], width: number, styles: Styles): string {
  // ╭─ title ───── right ─╮
  const titleWidth = title.reduce((n, s) => n + displayWidth(s.text), 0);
  const rightWidth = right.reduce((n, s) => n + displayWidth(s.text), 0);
  const fill = width - 2 - 2 - titleWidth - 1 - (rightWidth ? rightWidth + 2 : 0) - 1;
  if (fill < 1) return renderRow([{ text: `╭${H.repeat(Math.max(0, width - 2))}╮`, style: styles.dim }], width, styles.panel);
  return renderRow(
    [
      { text: `╭${H} `, style: styles.dim },
      ...title,
      { text: ` ${H.repeat(fill)}${rightWidth ? ' ' : ''}`, style: styles.dim },
      ...right,
      { text: `${rightWidth ? ' ' : ''}${H}╮`, style: styles.dim },
    ],
    width,
    styles.panel,
  );
}

function bottomBorder(width: number, styles: Styles): string {
  return renderRow([{ text: `╰${H.repeat(Math.max(0, width - 2))}╯`, style: styles.dim }], width, styles.panel);
}

function boxRow(content: Segment[], width: number, styles: Styles): string {
  const inner = Math.max(0, width - 4);
  const p = styles.panel;
  return `${renderRow([{ text: '│ ', style: styles.dim }], 2, p)}${renderRow(content, inner, p)}${renderRow([{ text: ' │', style: styles.dim }], 2, p)}`;
}

const LEVEL_TAG = { info: 'INFO ', warn: 'WARN ', error: 'ERROR' } as const;

/** The newest log lines that fit `height` rows of `width` columns, wrapped, oldest first. */
export function logRows(logs: readonly LogLine[], width: number, height: number, styles: Styles): Segment[][] {
  if (height <= 0 || width <= 0) return [];
  const prefixWidth = 8 + 1 + 5 + 1;
  const messageWidth = Math.max(10, width - prefixWidth);
  const rows: Segment[][] = [];
  for (let i = logs.length - 1; i >= 0 && rows.length < height; i--) {
    const line = logs[i]!;
    const tone = line.level === 'error' ? styles.danger : line.level === 'warn' ? styles.warning : styles.text;
    const tagTone = line.level === 'error' ? styles.danger : line.level === 'warn' ? styles.warning : styles.dim;
    const chunks = wrap(sanitize(line.message), messageWidth);
    const block: Segment[][] = chunks.map((chunk, index) =>
      index === 0
        ? [
            { text: `${clockText(new Date(line.at))} `, style: styles.dim },
            { text: `${LEVEL_TAG[line.level] ?? 'INFO '} `, style: tagTone },
            { text: chunk, style: tone },
          ]
        : [{ text: ' '.repeat(prefixWidth) }, { text: chunk, style: tone }],
    );
    rows.unshift(...block);
  }
  return rows.slice(Math.max(0, rows.length - height));
}

/** One full screen: exactly `rows` strings, each exactly `columns` wide. */
export function renderFrame(model: FrameModel, size: { columns: number; rows: number }, styles: Styles, locale: Locale): string[] {
  const width = Math.max(10, size.columns);
  const height = Math.max(1, size.rows);
  const L = (key: MessageKey, vars?: Record<string, unknown>) => tuiText(locale, key, vars);

  const rows = statusRows(model, locale);
  const labelWidth = Math.min(
    Math.max(...rows.map((row) => displayWidth(row.label))) + 2,
    Math.max(8, Math.floor((width - 4) / 3)),
  );
  const lines: string[] = [];
  lines.push(
    topBorder(
      [{ text: L('tuiTitle', { version: model.version }), style: styles.title }],
      [{ text: clockText(model.now), style: styles.dim }],
      width,
      styles,
    ),
  );
  for (const row of rows) {
    const label = row.label.length ? row.label : '';
    const p = styles.panel;
    const labelCell = renderRow([{ text: label, style: styles.dim }], labelWidth, p);
    const inner = Math.max(0, width - 4 - labelWidth);
    const value = renderRow(
      row.value.map((v) => ({ text: v.text, style: styles[v.tone] })),
      inner,
      p,
    );
    lines.push(`${renderRow([{ text: '│ ', style: styles.dim }], 2, p)}${labelCell}${value}${renderRow([{ text: ' │', style: styles.dim }], 2, p)}`);
  }
  lines.push(bottomBorder(width, styles));

  const footer = model.stopping
    ? renderRow([{ text: ` ${L('tuiStopping')}  `, style: styles.warning }, { text: L('tuiForceQuitHint'), style: styles.dim }], width, styles.bg)
    : renderRow([{ text: ` ${L('tuiQuitHint')}`, style: styles.dim }], width, styles.bg);

  const logHeight = height - lines.length - 1;
  if (logHeight >= 3) {
    lines.push(topBorder([{ text: L('tuiEvents'), style: styles.accent }], [], width, styles));
    const inner = logHeight - 2;
    const logLines = logRows(model.logs, width - 4, inner, styles);
    if (logLines.length === 0) logLines.push([{ text: L('tuiNoEvents'), style: styles.dim }]);
    for (let i = 0; i < inner; i++) lines.push(boxRow(logLines[i] ?? [], width, styles));
    lines.push(bottomBorder(width, styles));
  }
  let frame = lines.length + 1 > height ? lines.slice(0, height - 1) : lines;
  frame = [...frame, footer];
  while (frame.length < height) frame.splice(frame.length - 1, 0, renderRow([], width, styles.bg));
  return frame.slice(0, height);
}

/** The status block printed once (and on changes) when stdout is not a terminal: "Label: value" lines, no colour. */
export function plainStatusLines(model: FrameModel, locale: Locale): string[] {
  return [
    tuiText(locale, 'tuiTitle', { version: model.version }),
    ...statusRows(model, locale).map((row) => `${row.label ? `${row.label}: ` : ''}${row.value.map((v) => v.text).join('')}`.trimEnd()),
  ];
}

/** One log line for plain output. */
export function plainLogLine(line: LogLine): string {
  return `${clockText(new Date(line.at))} ${LEVEL_TAG[line.level] ?? 'INFO '} ${sanitize(line.message)}`;
}
