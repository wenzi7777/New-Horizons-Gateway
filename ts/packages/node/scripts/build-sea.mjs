#!/usr/bin/env node
// Builds the Gateway as one Node single executable (SEA) for the platform it
// runs on:
//
//   esbuild  src/cli.ts -> dist/<platform>/build/gateway.cjs   (CommonJS, node22)
//   node --experimental-sea-config  -> sea-prep.blob  (web UI files as SEA assets)
//   copy the node binary -> dist/<platform>/nh-gateway[.exe]
//   macOS: codesign --remove-signature
//   postject NODE_SEA_BLOB (sentinel fuse; Mach-O segment NODE_SEA on macOS)
//   macOS: codesign --sign -   (ad-hoc; Apple Silicon refuses unsigned code)
//   print path, sha256 and size (what gateway-bin-*.json lists per platform)
//
// Usage (from ts/):  npm run build:sea -- [options]
//   --entry <file>        entry module (default packages/node/src/cli.ts)
//   --out-dir <dir>       output directory (default dist/<platform>-<arch>)
//   --name <name>         executable name (default nh-gateway, + .exe on Windows)
//   --node <file>         the node binary to embed into (default: this node);
//                         it also generates the blob, so it must run here
//   --platform-key <key>  directory/key override (default <platform>-<arch> of this process)
//   --no-sign             skip codesign on macOS
//   --dry-run             print the plan, build nothing
//   --json                print the plan / result as JSON
//
// Cross-building: see packages/node/README.md ("Building the executables").

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
export const BLOB_RESOURCE = 'NODE_SEA_BLOB';
export const MACHO_SEGMENT = 'NODE_SEA';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = resolve(scriptDir, '..');
export const TS_ROOT = resolve(PACKAGE_DIR, '..', '..');

const HELP = `usage: build-sea.mjs [--entry <file>] [--out-dir <dir>] [--name <name>] [--node <file>]
                    [--platform-key <key>] [--no-sign] [--dry-run] [--json]`;

/** argv (after the script) as options; throws on unknown or incomplete flags. */
export function parseArgs(argv, { platform = process.platform, arch = process.arch, cwd = process.cwd(), execPath = process.execPath } = {}) {
  const opts = {
    entry: join(PACKAGE_DIR, 'src', 'cli.ts'),
    outDir: '',
    name: '',
    node: execPath,
    platformKey: `${platform}-${arch}`,
    platform,
    sign: true,
    dryRun: false,
    json: false,
    help: false,
  };
  const valueFlags = { '--entry': 'entry', '--out-dir': 'outDir', '--name': 'name', '--node': 'node', '--platform-key': 'platformKey' };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg in valueFlags) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) {
        throw new Error(`${arg} needs a value`);
      }
      opts[valueFlags[arg]] = value;
    } else if (arg === '--no-sign') opts.sign = false;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${argv[i]}\n${HELP}`);
  }
  // The platform of the executable follows --platform-key (e.g. a darwin-x64 node on an arm64 Mac).
  opts.platform = opts.platformKey.split('-')[0] || platform;
  opts.entry = resolve(cwd, opts.entry);
  opts.node = resolve(cwd, opts.node);
  opts.outDir = resolve(cwd, opts.outDir || join(TS_ROOT, 'dist', opts.platformKey));
  if (!opts.name) opts.name = opts.platform === 'win32' ? 'nh-gateway.exe' : 'nh-gateway';
  else if (opts.platform === 'win32' && !opts.name.toLowerCase().endsWith('.exe')) opts.name += '.exe';
  return opts;
}

function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile() && !entry.name.startsWith('.')) out.push(full);
  }
  return out.sort();
}

/**
 * SEA assets: every file under packages/node/webui (named by its path
 * relative to webui/, "/"-separated: "index.html", "app.js", ...) plus the
 * shared tokens.css as "tokens.css". Read at run time with
 * require('node:sea').getAsset(name).
 */
export function collectAssets(webuiDir = join(PACKAGE_DIR, 'webui'), tokensCss = join(TS_ROOT, 'packages', 'ui-tokens', 'src', 'tokens.css')) {
  const assets = {};
  for (const file of listFiles(webuiDir)) assets[relative(webuiDir, file).split(sep).join('/')] = file;
  if (existsSync(tokensCss)) assets['tokens.css'] = tokensCss;
  return assets;
}

/** Everything the build will do, without doing it. */
export function planBuild(opts, assets = collectAssets()) {
  const buildDir = join(opts.outDir, 'build');
  const bundle = join(buildDir, 'gateway.cjs');
  const blob = join(buildDir, 'sea-prep.blob');
  const seaConfigFile = join(buildDir, 'sea-config.json');
  const output = join(opts.outDir, opts.name);
  const macos = opts.platform === 'darwin';
  return {
    entry: opts.entry,
    platformKey: opts.platformKey,
    node: opts.node,
    buildDir,
    bundle,
    blob,
    seaConfigFile,
    seaConfig: {
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets,
    },
    output,
    removeSignature: macos && opts.sign,
    postject: {
      resource: BLOB_RESOURCE,
      sentinelFuse: SENTINEL_FUSE,
      machoSegmentName: macos ? MACHO_SEGMENT : undefined,
    },
    adhocSign: macos && opts.sign,
  };
}

/** A path for log lines: relative to ts/ when inside it. */
function shown(file) {
  const rel = relative(TS_ROOT, file);
  return rel.startsWith('..') ? file : rel;
}

function run(cmd, args, label) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status})`);
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export async function build(opts, log = (line) => console.error(line)) {
  if (!existsSync(opts.entry)) throw new Error(`entry not found: ${opts.entry}`);
  if (!existsSync(opts.node)) throw new Error(`node binary not found: ${opts.node}`);
  const plan = planBuild(opts);
  if (!plan.seaConfig.assets['index.html']) log('warning: packages/node/webui/index.html not found: the web UI will be missing');
  rmSync(plan.buildDir, { recursive: true, force: true });
  mkdirSync(plan.buildDir, { recursive: true });

  log(`esbuild ${shown(opts.entry)} -> ${shown(plan.bundle)}`);
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [opts.entry],
    outfile: plan.bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // SEA's main script gets a require() for built-ins only: everything else must be in the bundle.
    packages: 'bundle',
    // import.meta.url does not exist in CommonJS: point it at the executable (SEA sets __filename to it).
    banner: { js: 'var __nhgw_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
    define: { 'import.meta.url': '__nhgw_import_meta_url' },
    legalComments: 'none',
    logLevel: 'warning',
  });

  writeFileSync(plan.seaConfigFile, `${JSON.stringify(plan.seaConfig, null, 2)}\n`);
  log(`${opts.node} --experimental-sea-config ${shown(plan.seaConfigFile)}`);
  run(opts.node, ['--experimental-sea-config', plan.seaConfigFile], 'node --experimental-sea-config');

  mkdirSync(dirname(plan.output), { recursive: true });
  rmSync(plan.output, { force: true });
  copyFileSync(opts.node, plan.output);
  chmodSync(plan.output, 0o755);
  if (plan.removeSignature) {
    log('codesign --remove-signature');
    run('codesign', ['--remove-signature', plan.output], 'codesign --remove-signature');
  }

  log(`postject ${BLOB_RESOURCE}`);
  const { inject } = await import('postject');
  await inject(plan.output, BLOB_RESOURCE, readFileSync(plan.blob), {
    sentinelFuse: SENTINEL_FUSE,
    ...(plan.postject.machoSegmentName ? { machoSegmentName: plan.postject.machoSegmentName } : {}),
  });
  if (plan.adhocSign) {
    log('codesign --sign - (ad-hoc)');
    run('codesign', ['--sign', '-', '--force', plan.output], 'codesign --sign -');
  }

  const size = statSync(plan.output).size;
  const sha256 = sha256File(plan.output);
  return { output: plan.output, platformKey: opts.platformKey, sha256, size };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (opts.dryRun) {
    const plan = planBuild(opts);
    console.log(opts.json ? JSON.stringify(plan, null, 2) : plan);
    return;
  }
  const result = await build(opts);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`output: ${result.output}`);
    console.log(`platform: ${result.platformKey}`);
    console.log(`sha256: ${result.sha256}`);
    console.log(`size: ${result.size}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
