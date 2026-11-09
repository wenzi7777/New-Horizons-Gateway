// Version order and update channels for Gateway self-updates (versioning.py).
// The same rules as the firmware and Hub (VersionCompare.cpp / UpdateChannel.h),
// pinned by NewHorizonsOS-OTA/spec/fixtures/versions.json:
// - `vMAJOR.MINOR.PATCH` with an optional prerelease, which sorts below its release;
// - `stable` reads gateway-latest.json (the only manifest older Gateways know),
//   `beta` reads gateway-beta.json;
// - leaving beta never downgrades: an older stable is simply "not newer".
import { PY_WS_CLASS, pyCompareStr, pyStr, pyStrip, pyTruthy } from './py';

export const UPDATE_CHANNELS = ['stable', 'beta'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable';
export const MANIFEST_BASE_URL = 'https://raw.githubusercontent.com/wenzi7777/New-Horizons-Gateway/main/releases/gateway';

// Python's pattern, with its re semantics spelled out: `.` excludes only '\n'
// and `$` also matches before one trailing '\n'.
const VERSION_RE = new RegExp(
  `^${PY_WS_CLASS}*[vV]?(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?[^-+]*(?:-([^+]*))?(?:\\+[^\\n]*)?(?=\\n?$)`,
);

function str(value: unknown): string {
  return pyTruthy(value) ? pyStr(value) : '';
}

/** Unknown or missing channels fall back to stable, never to beta. */
export function normalizeChannel(value: unknown): UpdateChannel {
  const channel = pyStrip(str(value)).toLowerCase();
  return (UPDATE_CHANNELS as readonly string[]).includes(channel) ? (channel as UpdateChannel) : DEFAULT_UPDATE_CHANNEL;
}

export function manifestUrlFor(channel: unknown, baseUrl: string = MANIFEST_BASE_URL): string {
  return `${baseUrl}${normalizeChannel(channel) === 'beta' ? '-beta.json' : '-latest.json'}`;
}

function parse(version: unknown): { core: [number, number, number]; pre: string[] } {
  const match = VERSION_RE.exec(str(version));
  if (!match) return { core: [0, 0, 0], pre: [] };
  const part = (text: string | undefined) => (text ? parseInt(text, 10) : 0);
  const pre = match[4];
  return { core: [part(match[1]), part(match[2]), part(match[3])], pre: pre ? pre.split('.') : [] };
}

const isDigits = (text: string) => /^[0-9]+$/.test(text);

function compareIdentifier(a: string, b: string): number {
  const aNum = isDigits(a);
  const bNum = isDigits(b);
  if (aNum && bNum) return Math.sign(parseInt(a, 10) - parseInt(b, 10));
  if (aNum !== bNum) return aNum ? -1 : 1;
  return pyCompareStr(a, b);
}

/** <0 if a is older than b, 0 if equal, >0 if a is newer. */
export function compareVersions(a: unknown, b: unknown): number {
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i]! > right.core[i]! ? 1 : -1;
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return Number(left.pre.length === 0) - Number(right.pre.length === 0);
  }
  const n = Math.min(left.pre.length, right.pre.length);
  for (let i = 0; i < n; i++) {
    const result = compareIdentifier(left.pre[i]!, right.pre[i]!);
    if (result) return result;
  }
  return Math.sign(left.pre.length - right.pre.length);
}

export function isNewerVersion(candidate: unknown, current: unknown): boolean {
  return compareVersions(candidate, current) > 0;
}

export function isPrerelease(version: unknown): boolean {
  return parse(version).pre.length > 0;
}
