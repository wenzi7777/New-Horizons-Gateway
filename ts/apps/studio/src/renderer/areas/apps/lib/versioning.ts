// Version order, the same rules as the device firmware and Hub
// (NewHorizonsOS-OTA VersionCompare.cpp), checked against the shared vectors
// in NewHorizonsOS-OTA/spec/fixtures/versions.json.
//
// Versions are vMAJOR.MINOR.PATCH with an optional semver prerelease, and a
// prerelease sorts BELOW its release: v1.14.0-beta.1 < v1.14.0-beta.2 <
// v1.14.0. Two questions, two functions:
//
// - compareVersions: "is this update newer?" -- the full order.
// - compareVersionCores: "does this firmware have release X's features?"
//   (an app's min_os, a command added in vX) -- ignores the prerelease,
//   because a beta of X is the candidate for X and already carries them.
//   Matches the firmware's own min_os check (AppPackage::osVersionSatisfies).

type Parsed = { core: [number, number, number]; pre: string[] };

const VERSION_RE = /^\s*[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?[^-+]*(?:-([^+]*))?(?:\+.*)?$/;

function parse(value: string | null | undefined): Parsed {
  const match = VERSION_RE.exec(String(value ?? ""));
  if (!match) return { core: [0, 0, 0], pre: [] };
  const num = (part: string | undefined) => (part ? Number.parseInt(part, 10) || 0 : 0);
  return { core: [num(match[1]), num(match[2]), num(match[3])], pre: match[4] ? match[4].split(".") : [] };
}

function compareCore(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]! ? 1 : -1;
  }
  return 0;
}

function compareIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const diff = Number.parseInt(a, 10) - Number.parseInt(b, 10);
    return diff === 0 ? 0 : diff > 0 ? 1 : -1;
  }
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a === b ? 0 : a > b ? 1 : -1;
}

/** <0 if a is older than b, 0 if equal, >0 if a is newer. Prerelease-aware. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const left = parse(a);
  const right = parse(b);
  const core = compareCore(left, right);
  if (core !== 0) return core;
  if (left.pre.length === 0 || right.pre.length === 0) {
    if (left.pre.length === right.pre.length) return 0;
    return left.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i += 1) {
    const result = compareIdentifier(left.pre[i]!, right.pre[i]!);
    if (result !== 0) return result;
  }
  if (left.pre.length === right.pre.length) return 0;
  return left.pre.length > right.pre.length ? 1 : -1;
}

/** Like compareVersions, ignoring any prerelease suffix. */
export function compareVersionCores(a: string | null | undefined, b: string | null | undefined): number {
  return compareCore(parse(a), parse(b));
}

export function isPrereleaseVersion(value: string | null | undefined): boolean {
  return parse(value).pre.length > 0;
}

// --- update channels ------------------------------------------------------

export type UpdateChannel = "stable" | "beta";
export const UPDATE_CHANNELS: UpdateChannel[] = ["stable", "beta"];

/** Unknown or missing channels read as stable, never as beta. */
export function normalizeUpdateChannel(value: unknown): UpdateChannel {
  return String(value ?? "").trim().toLowerCase() === "beta" ? "beta" : "stable";
}

/** The manifest a board follows on `channel`, from its suffix-less base. */
export function manifestUrlForChannel(base: string, channel: UpdateChannel): string {
  return `${base}${channel === "beta" ? "-beta.json" : "-latest.json"}`;
}

/**
 * True while a device that has left beta is still running a beta build that
 * is newer than anything stable: it stays there (no downgrade) until a
 * stable release overtakes it.
 */
export function waitingForStableToCatchUp(channel: unknown, firmwareVersion: string | null | undefined): boolean {
  return normalizeUpdateChannel(channel) === "stable" && isPrereleaseVersion(firmwareVersion);
}
