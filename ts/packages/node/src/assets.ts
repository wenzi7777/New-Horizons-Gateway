// Every file the host serves or ships (the web UI and tokens.css), read the
// same way whether it runs from the source tree (dev, tests) or as a Node
// single executable, where the files are SEA assets. scripts/build-sea.mjs
// (collectAssets) embeds each webui/ file under its bare name ("index.html",
// "app.js", ...) and tokens.css as "tokens.css": the keys readAsset() asks for.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The web UI files (packages/node/webui/), served at / and /assets/<name>. */
export const WEBUI_FILES = ['index.html', 'app.css', 'app.js', 'i18n.js', 'markdown.js', 'select.js', 'theme.js'] as const;
/** Served at /assets/tokens.css; comes from @nhgw/ui-tokens (src/tokens.css). */
export const TOKENS_CSS = 'tokens.css';
/** SEA asset keys are the bare file names (build-sea.mjs collectAssets), tokens.css included. */
export const SEA_ASSET_PREFIX = '';

export type AssetName = (typeof WEBUI_FILES)[number] | typeof TOKENS_CSS;

interface SeaModule {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
}

/** node:sea when this is a single executable, else null. Works from ESM and from a CommonJS bundle. */
export function seaModule(): SeaModule | null {
  try {
    const sea = process.getBuiltinModule?.('node:sea') as SeaModule | undefined;
    return sea && sea.isSea() ? sea : null;
  } catch {
    return null;
  }
}

export function isSea(): boolean {
  return seaModule() !== null;
}

/** This module's directory: __dirname in the CommonJS bundle, import.meta.url under ESM (vitest, tsx). */
function moduleDir(): string | null {
  if (typeof __dirname === 'string') return __dirname;
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

let webuiDirOverride: string | null = null;

/** Tests and dev launchers may point at another web UI directory (also: env NHGW_WEBUI_DIR). */
export function setWebuiDir(dir: string | null): void {
  webuiDirOverride = dir === null ? null : resolve(dir);
}

/** packages/node/webui on disk, found from this module, the env, or the working directory. */
export function webuiDir(): string {
  const candidates: string[] = [];
  if (webuiDirOverride) candidates.push(webuiDirOverride);
  if (process.env.NHGW_WEBUI_DIR) candidates.push(resolve(process.env.NHGW_WEBUI_DIR));
  const here = moduleDir();
  if (here) candidates.push(resolve(here, '../webui'), resolve(here, '../../webui'), resolve(here, 'webui'));
  candidates.push(resolve(process.cwd(), 'packages/node/webui'), resolve(process.cwd(), 'webui'));
  for (const dir of candidates) if (existsSync(join(dir, 'index.html'))) return dir;
  return candidates[0]!;
}

/** @nhgw/ui-tokens' tokens.css on disk. */
export function tokensCssPath(): string {
  const candidates: string[] = [];
  const here = moduleDir();
  for (const base of [here, process.cwd()]) {
    if (!base) continue;
    try {
      candidates.push(createRequire(join(base, 'noop.js')).resolve('@nhgw/ui-tokens/tokens.css'));
    } catch {
      // not resolvable from here
    }
  }
  candidates.push(resolve(webuiDir(), '../../ui-tokens/src/tokens.css'));
  for (const file of candidates) if (existsSync(file)) return file;
  return candidates[candidates.length - 1]!;
}

/** SEA asset key -> file on disk, for scripts/build-sea.mjs (sea-config.json "assets"). */
export function webAssetSources(): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = webuiDir();
  for (const name of WEBUI_FILES) out[SEA_ASSET_PREFIX + name] = join(dir, name);
  out[SEA_ASSET_PREFIX + TOKENS_CSS] = tokensCssPath();
  return out;
}

export function isAssetName(name: string): name is AssetName {
  return name === TOKENS_CSS || (WEBUI_FILES as readonly string[]).includes(name);
}

/**
 * The bytes of one served file, or null if it is not one or is missing.
 * Read per call (Python read per request too): never stale in dev.
 */
export function readAsset(name: string): Buffer | null {
  if (!isAssetName(name)) return null;
  const sea = seaModule();
  if (sea) {
    try {
      return Buffer.from(sea.getAsset(SEA_ASSET_PREFIX + name));
    } catch {
      return null;
    }
  }
  const file = name === TOKENS_CSS ? tokensCssPath() : join(webuiDir(), name);
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}
