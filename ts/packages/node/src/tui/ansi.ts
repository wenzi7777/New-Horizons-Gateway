// Escape sequences, colours and display widths for the terminal UI. No
// dependencies: everything here is plain VT100/xterm, which Windows 10+
// conhost and Windows Terminal understand (Node/libuv turns on
// ENABLE_VIRTUAL_TERMINAL_PROCESSING for TTY streams).

export const ESC = '\x1b[';
export const ALT_SCREEN_ON = '\x1b[?1049h';
export const ALT_SCREEN_OFF = '\x1b[?1049l';
export const CURSOR_HIDE = '\x1b[?25l';
export const CURSOR_SHOW = '\x1b[?25h';
export const CLEAR_SCREEN = '\x1b[2J';
export const CLEAR_LINE_RIGHT = '\x1b[K';
export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
/** Line wrap off while we own the screen (a too-wide line never scrolls the frame). */
export const AUTOWRAP_OFF = '\x1b[?7l';
export const AUTOWRAP_ON = '\x1b[?7h';

export function moveTo(row: number, col = 1): string {
  return `${ESC}${row};${col}H`;
}

/** OSC 0: window/tab title (the Python console set "NH Gateway" on Windows). */
export function setTitle(title: string): string {
  return `\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`;
}

export type ColorDepth = 24 | 8 | 1;

/**
 * 24-bit when the terminal says so (COLORTERM=truecolor/24bit; Windows
 * Terminal sets WT_SESSION and always has it), monochrome under NO_COLOR or
 * TERM=dumb, otherwise the xterm 256-colour palette.
 */
export function detectColorDepth(env: NodeJS.ProcessEnv): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 1;
  if ((env.TERM ?? '').toLowerCase() === 'dumb') return 1;
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 24;
  if (env.WT_SESSION) return 24;
  return 8;
}

export function parseHex(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`not a #hex colour: ${hex}`);
  let digits = match[1]!;
  if (digits.length === 3) digits = digits.replace(/./g, (c) => c + c);
  const n = parseInt(digits, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function nearestCubeIndex(value: number): number {
  let best = 0;
  for (let i = 1; i < CUBE_LEVELS.length; i++) {
    if (Math.abs(CUBE_LEVELS[i]! - value) < Math.abs(CUBE_LEVELS[best]! - value)) best = i;
  }
  return best;
}

function distance(a: readonly number[], b: readonly number[]): number {
  // Weighted ("redmean"-ish) RGB distance: good enough to pick a palette entry.
  const dr = a[0]! - b[0]!;
  const dg = a[1]! - b[1]!;
  const db = a[2]! - b[2]!;
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

/** The xterm-256 index (16..255: colour cube or grey ramp) nearest to an RGB colour. */
export function nearest256(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb;
  const ri = nearestCubeIndex(r);
  const gi = nearestCubeIndex(g);
  const bi = nearestCubeIndex(b);
  const cube: [number, number, number] = [CUBE_LEVELS[ri]!, CUBE_LEVELS[gi]!, CUBE_LEVELS[bi]!];
  const cubeIndex = 16 + 36 * ri + 6 * gi + bi;
  const avg = (r + g + b) / 3;
  const greyStep = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const greyValue = 8 + 10 * greyStep;
  const grey: [number, number, number] = [greyValue, greyValue, greyValue];
  return distance(rgb, grey) < distance(rgb, cube) ? 232 + greyStep : cubeIndex;
}

function sgrColor(layer: 38 | 48, hex: string, depth: ColorDepth): string {
  if (depth === 1) return '';
  const rgb = parseHex(hex);
  if (depth === 24) return `${ESC}${layer};2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  return `${ESC}${layer};5;${nearest256(rgb)}m`;
}

/** SGR foreground for a #hex colour at the given depth ('' when monochrome). */
export function fg(hex: string, depth: ColorDepth): string {
  return sgrColor(38, hex, depth);
}

/** SGR background for a #hex colour at the given depth ('' when monochrome). */
export function bg(hex: string, depth: ColorDepth): string {
  return sgrColor(48, hex, depth);
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Text from outside (log messages, server URLs) made safe to print: no escapes, no control characters. */
export function sanitize(text: string): string {
  return stripAnsi(String(text)).replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

function isCombining(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Terminal columns one code point takes (0, 1 or 2). */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isCombining(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Display width of plain text (escape sequences excluded). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch.codePointAt(0)!);
  return width;
}

/**
 * Plain text cut to `width` columns, with "…" when cut. Escapes are not
 * expected here: styling is applied after measuring (see Segment).
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0)!);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/** Plain text split into lines of at most `width` columns (hard wrap; long words are cut). */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let line = '';
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0)!);
    if (used + w > width) {
      lines.push(line);
      line = '';
      used = 0;
    }
    line += ch;
    used += w;
  }
  lines.push(line);
  return lines;
}

export function padEnd(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? text : text + ' '.repeat(width - w);
}

/** A run of plain text with an optional SGR prefix. Rows are lists of segments, measured before styling. */
export interface Segment {
  text: string;
  style?: string;
}

/**
 * Joins segments into one row exactly `width` columns wide (cut with "…",
 * padded with spaces). `base` (a background SGR) is set first and re-set
 * after every styled segment's reset, so padding keeps the background too.
 */
export function renderRow(segments: readonly Segment[], width: number, base = ''): string {
  let out = base;
  let used = 0;
  for (const segment of segments) {
    if (used >= width) break;
    let text = segment.text;
    const w = displayWidth(text);
    if (used + w > width) text = truncate(text, width - used);
    used += displayWidth(text);
    out += segment.style ? `${segment.style}${text}${RESET}${base}` : text;
  }
  if (used < width) out += ' '.repeat(width - used);
  return out;
}
