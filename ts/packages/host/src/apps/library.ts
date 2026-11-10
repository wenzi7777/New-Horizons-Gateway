// The NHOS App Library client: catalog fetch with an ETag/TTL cache, package
// download with size + sha256 checks and a host allowlist, library source
// fetch for App Studio, and local package import. A port of the Desktop's
// backend app_library.py; all I/O is injected (LibraryHttp, LibraryStore,
// clock, sha256) so NH Studio (Node) and NH Pocket can share it.
//
// The device conversation (maintenance, file_write_*, app_install) is not
// here: it runs where commands are sent (Studio's renderer, through
// api.sendCommand), exactly as the Desktop keeps it in the browser.

import { bytesToHex, utf8Decode, type Sha256 } from '@nhgw/core';

import { MAX_PACKAGE_BYTES } from './contract';
import { APP_ID_RE, AppPackageError, validatePackage, type PackageKind, type PackageSummary } from './validate';

export const DEFAULT_LIBRARY_INDEX_URL = 'https://raw.githubusercontent.com/wenzi7777/NHOS-App-Library/main/index.json';
/** package.url comes out of a remote file: restrict where it may point. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['raw.githubusercontent.com'];
export const FETCH_TIMEOUT_MS = 5000;
export const DEFAULT_TTL_MS = 900_000;
/** An app's source has no firmware limit, but it is remote input: cap it. */
export const MAX_SOURCE_BYTES = 64 * 1024;

/** A catalog or transport problem; `message` is the code. */
export class AppLibraryError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'AppLibraryError';
  }
}

export interface LibraryResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: Uint8Array;
}

/** HTTP GET that resolves for every status and rejects only when the server cannot be reached. */
export interface LibraryHttp {
  get(url: string, options: { headers?: Record<string, string>; timeoutMs: number; maxBytes?: number }): Promise<LibraryResponse>;
}

/** Files under the library's cache folder, by relative path ("index.json", "packages/x.nha"). */
export interface LibraryStore {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

export interface AppLibraryOptions {
  http: LibraryHttp;
  store: LibraryStore;
  sha256: Sha256;
  now?: () => number;
  indexUrl?: string;
  ttlMs?: number;
  allowedHosts?: readonly string[];
}

/** The catalog as the Desktop's /api/app-library/index answers it. */
export interface CatalogView {
  items: Record<string, unknown>[];
  generated_at?: unknown;
  cell_count?: unknown;
  source: 'cache' | 'remote';
  stale: boolean;
  error: string | null;
}

/** A validated package, ready to be written to a device. */
export interface ValidatedPackage extends PackageSummary {
  sha256: string;
  size: number;
  cache_key: string;
  /** Hex, because file_write_chunk takes hex. */
  data_hex: string;
}

export interface AppSourceView {
  id: string;
  version: unknown;
  kind: PackageKind;
  filename: string;
  source: string;
  package_sha256: unknown;
}

type Rec = Record<string, unknown>;
type Decorated = Rec & { source: 'cache' | 'remote'; stale: boolean; error?: string };

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const encoder = new TextEncoder();

function parseJson(bytes: Uint8Array | null): unknown {
  if (!bytes) return null;
  try {
    return JSON.parse(utf8Decode(bytes));
  } catch {
    return null;
  }
}

/** Serialise the way the library does, so a re-serialised package still hashes. */
export function canonicalPackageBytes(doc: unknown): Uint8Array {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
    return value;
  };
  return encoder.encode(`${JSON.stringify(sort(doc))}\n`);
}

export class AppLibrary {
  private readonly http: LibraryHttp;
  private readonly store: LibraryStore;
  private readonly sha256: Sha256;
  private readonly now: () => number;
  private readonly indexUrl: string;
  private readonly ttlMs: number;
  private readonly allowedHosts: readonly string[];
  /** One catalog refresh at a time; concurrent callers share it. */
  private inflight: Promise<Decorated> | null = null;

  constructor(options: AppLibraryOptions) {
    this.http = options.http;
    this.store = options.store;
    this.sha256 = options.sha256;
    this.now = options.now ?? Date.now;
    this.indexUrl = options.indexUrl ?? DEFAULT_LIBRARY_INDEX_URL;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  }

  // -- catalog --

  /** The catalog in the shape the UI reads. */
  async catalog(force = false): Promise<CatalogView> {
    const index = await this.fetchIndex(force);
    return {
      items: Array.isArray(index.apps) ? index.apps.filter(isRecord) : [],
      generated_at: index.generated_at,
      cell_count: index.cell_count,
      source: index.source,
      stale: Boolean(index.stale),
      error: index.error ?? null,
    };
  }

  /**
   * The catalog, falling back to the disk copy when offline: a stale catalog
   * is far better than an empty page, so a network failure is reported
   * alongside the cached content rather than instead of it.
   */
  fetchIndex(force = false): Promise<Decorated> {
    if (this.inflight) return this.inflight;
    const run = this.fetchIndexOnce(force).finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async fetchIndexOnce(force: boolean): Promise<Decorated> {
    const meta = (parseJson(await this.store.read('index.meta.json')) as Rec | null) ?? {};
    const cachedRaw = parseJson(await this.store.read('index.json'));
    const cached = isRecord(cachedRaw) && Object.keys(cachedRaw).length ? cachedRaw : null;
    if (cached && !force && !this.expired(meta)) return decorate(cached, 'cache', false);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cached && meta.etag) headers['If-None-Match'] = String(meta.etag);
    let response: LibraryResponse;
    try {
      response = await this.http.get(this.indexUrl, { headers, timeoutMs: FETCH_TIMEOUT_MS });
    } catch {
      if (cached) return decorate(cached, 'cache', true, 'unreachable');
      throw new AppLibraryError('unreachable');
    }
    if (response.status === 304 && cached) {
      await this.writeMeta(typeof meta.etag === 'string' ? meta.etag : null);
      return decorate(cached, 'cache', false);
    }
    if (response.status < 200 || response.status >= 300) {
      if (cached) return decorate(cached, 'cache', true, `http_${response.status}`);
      throw new AppLibraryError(`http_${response.status}`);
    }
    const index = parseJson(response.body);
    if (!isRecord(index)) {
      if (cached) return decorate(cached, 'cache', true, 'malformed_index');
      throw new AppLibraryError('malformed_index');
    }
    await this.store.write('index.json', encoder.encode(JSON.stringify(index)));
    await this.writeMeta(response.headers.etag ?? null);
    return decorate(index, 'remote', false);
  }

  async entry(appId: string): Promise<Rec> {
    const index = await this.fetchIndex();
    const apps = Array.isArray(index.apps) ? index.apps : [];
    const found = apps.find((item) => isRecord(item) && String(item.id) === appId);
    if (!isRecord(found)) throw new AppLibraryError('app_not_found');
    return found;
  }

  // -- packages --

  async downloadPackage(appId: string, version?: string | null): Promise<ValidatedPackage> {
    if (!APP_ID_RE.test(appId)) throw new AppPackageError('invalid_id');
    const entry = await this.entry(appId);
    if (version && String(entry.version) !== version) throw new AppLibraryError('version_not_available');
    const pkg = isRecord(entry.package) ? entry.package : {};
    const url = String(pkg.url ?? '');
    const expectedSha = String(pkg.sha256 ?? '');
    const expectedSize = Number(pkg.size ?? 0) || 0;
    this.checkHost(url);

    const cacheKey = `${appId}-${String(entry.version)}`;
    let raw = await this.store.read(packagePath(cacheKey));
    if (raw === null || (expectedSha && (await this.sha256(raw)) !== expectedSha)) {
      let response: LibraryResponse;
      try {
        response = await this.http.get(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_PACKAGE_BYTES + 1 });
      } catch {
        throw new AppLibraryError('package_unreachable');
      }
      if (response.status < 200 || response.status >= 300) throw new AppLibraryError('package_unreachable');
      raw = response.body.subarray(0, MAX_PACKAGE_BYTES + 1);
    }
    return this.accept(raw, cacheKey, expectedSha, expectedSize);
  }

  /**
   * The source an app's package was built from, for App Studio to open: found
   * where the library keeps it (apps/<id>/app.nhs | readout.json | panel.json
   * beside dist/). No checksum: Studio recompiles it and compares the result
   * with the package's sha256 instead.
   */
  async fetchSource(appId: string): Promise<AppSourceView> {
    if (!APP_ID_RE.test(appId)) throw new AppPackageError('invalid_id');
    const entry = await this.entry(appId);
    const kind: PackageKind = entry.kind === 'readout' || entry.kind === 'panel' ? entry.kind : 'flow';
    const filename = kind === 'readout' ? 'readout.json' : kind === 'panel' ? 'panel.json' : 'app.nhs';
    const pkg = isRecord(entry.package) ? entry.package : {};
    const packageUrl = String(pkg.url ?? '');
    if (!packageUrl.includes('/dist/')) throw new AppLibraryError('source_unavailable');
    const url = `${packageUrl.split('/dist/')[0]}/apps/${appId}/${filename}`;
    this.checkHost(url);

    const cachePath = `sources/${appId}-${String(entry.version)}-${filename}`;
    let raw: Uint8Array | null = null;
    try {
      const response = await this.http.get(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_SOURCE_BYTES + 1 });
      if (response.status >= 200 && response.status < 300) raw = response.body;
    } catch {
      raw = null;
    }
    if (raw === null) {
      raw = await this.store.read(cachePath);
      if (raw === null) throw new AppLibraryError('source_unreachable');
    }
    if (raw.length > MAX_SOURCE_BYTES) throw new AppPackageError('source_too_large');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new AppPackageError('malformed_source');
    }
    await this.store.write(cachePath, raw);
    return { id: appId, version: entry.version, kind, filename, source: text, package_sha256: pkg.sha256 };
  }

  /** A package from a local file (sideload / App Studio build). */
  async importPackage(raw: Uint8Array): Promise<ValidatedPackage> {
    const digest = await this.sha256(raw);
    return this.accept(raw, `local-${digest.slice(0, 8)}`);
  }

  async cachedPackage(cacheKey: string): Promise<ValidatedPackage> {
    if (!cacheKey || cacheKey.includes('/') || cacheKey.includes('\\') || cacheKey.includes('..')) throw new AppLibraryError('invalid_cache_key');
    const raw = await this.store.read(packagePath(cacheKey));
    if (raw === null) throw new AppLibraryError('not_cached');
    return this.accept(raw, cacheKey);
  }

  private async accept(raw: Uint8Array, cacheKey: string, expectedSha = '', expectedSize = 0): Promise<ValidatedPackage> {
    if (raw.length > MAX_PACKAGE_BYTES) throw new AppPackageError('package_too_large');
    if (expectedSize && raw.length !== expectedSize) throw new AppPackageError('size_mismatch');
    const digest = await this.sha256(raw);
    if (expectedSha && digest !== expectedSha) throw new AppPackageError('checksum_mismatch');
    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      throw new AppPackageError('malformed_package');
    }
    const summary = validatePackage(doc);
    await this.store.write(packagePath(cacheKey), raw);
    return { ...summary, sha256: digest, size: raw.length, cache_key: cacheKey, data_hex: bytesToHex(raw).toLowerCase() };
  }

  // -- helpers --

  private checkHost(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppLibraryError('package_host_not_allowed');
    }
    if (parsed.protocol !== 'https:' || !this.allowedHosts.includes(parsed.hostname)) throw new AppLibraryError('package_host_not_allowed');
  }

  private expired(meta: Rec): boolean {
    const fetchedAt = Number(meta.fetched_at ?? 0) || 0;
    return this.now() - fetchedAt > this.ttlMs;
  }

  private async writeMeta(etag: string | null): Promise<void> {
    await this.store.write('index.meta.json', encoder.encode(JSON.stringify({ etag, fetched_at: this.now() })));
  }
}

function packagePath(cacheKey: string): string {
  return `packages/${cacheKey}.nha`;
}

function decorate(index: Rec, source: 'cache' | 'remote', stale: boolean, error?: string): Decorated {
  const result: Decorated = { ...index, source, stale };
  if (error) result.error = error;
  return result;
}
