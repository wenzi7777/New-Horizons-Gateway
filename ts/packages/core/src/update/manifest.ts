// Single-binary release manifests. The Python Gateway reads gateway-latest.json
// / gateway-beta.json (one zip for every host); the TS Gateway ships a
// different artifact per platform, so it reads gateway-bin-latest.json /
// gateway-bin-beta.json beside them:
//
//   { "version": "vX.Y.Z", "notes_url": "...",
//     "assets": { "<platformKey>": { "url": "...", "sha256": "...", "size": N } } }
//
// The Python manifests stay untouched, so Python Gateways keep updating among
// themselves. A manifest without an asset for this platform is valid -- that
// release simply is not built for it.
import { isPlainObject, pyFloat, pyStr, pyStrip, pyTruthy } from '../py';
import { MANIFEST_BASE_URL, normalizeChannel } from '../versioning';

/** Platform keys the release scripts publish. Hosts pass one of these (other strings work, they just never match). */
export const PLATFORM_KEYS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64', 'android'] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export function binManifestUrlFor(channel: unknown, baseUrl: string = MANIFEST_BASE_URL): string {
  return `${baseUrl}${normalizeChannel(channel) === 'beta' ? '-bin-beta.json' : '-bin-latest.json'}`;
}

/**
 * Release notes: vX.Y.Z.md is the original (Traditional Chinese, the URL every
 * manifest carries); vX.Y.Z.ja.md / vX.Y.Z.en.md sit beside it when the release
 * was translated. Older releases have only the original.
 */
export const NOTES_TRANSLATIONS = ['ja', 'en'] as const;

export function localizedNotesUrl(notesUrl: string, language: string): string {
  const match = /^(.*\/v[^/?#]+?)\.md([?#][^\n]*)?$/.exec(pyStrip(pyTruthy(notesUrl) ? pyStr(notesUrl) : ''));
  if (!match || /\.(ja|en)$/.test(match[1]!)) return '';
  return `${match[1]}.${language}.md${match[2] ?? ''}`;
}

export interface PlatformAsset {
  url: string;
  sha256: string;
  size: number;
}

export interface BinManifest {
  version: string;
  notesUrl: string;
  /** This platform's asset, or null when the release does not ship for it. */
  asset: PlatformAsset | null;
  raw: Record<string, unknown>;
}

const text = (value: unknown) => pyStrip(pyTruthy(value) ? pyStr(value) : '');

/** Throws Error('invalid_manifest' | 'manifest_missing_<field>'), as check() reported them in Python. */
export function parseBinManifest(body: string, platformKey: string): BinManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch (exc) {
    throw new Error(exc instanceof Error ? exc.message : 'invalid_manifest');
  }
  if (!isPlainObject(decoded)) throw new Error('invalid_manifest');
  const version = text(decoded.version);
  if (!version) throw new Error('manifest_missing_version');
  if (!isPlainObject(decoded.assets)) throw new Error('manifest_missing_assets');
  const entry = decoded.assets[platformKey];
  let asset: PlatformAsset | null = null;
  if (entry !== undefined && entry !== null) {
    if (!isPlainObject(entry)) throw new Error('manifest_invalid_asset');
    const url = text(entry.url);
    if (!url) throw new Error('manifest_missing_url');
    const sha256 = text(entry.sha256).toLowerCase();
    if (!sha256) throw new Error('manifest_missing_sha256');
    let size: number;
    try {
      size = pyFloat(entry.size);
    } catch {
      throw new Error('manifest_missing_size');
    }
    if (!Number.isInteger(size) || size <= 0) throw new Error('manifest_missing_size');
    asset = { url, sha256, size };
  }
  return { version, notesUrl: text(decoded.notes_url), asset, raw: decoded };
}
