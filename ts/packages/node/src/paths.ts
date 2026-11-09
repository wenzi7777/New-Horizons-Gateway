// Where a running Gateway keeps its files: the Python bootloader's .run/
// layout, so the new binary dropped into an old Gateway's folder picks its
// config up in place.
//
//   <root>/.run/config/config.json   NEWHORIZONS_GATEWAY_CONFIG(_PATH)
//   <root>/.run/logs/gateway.log     NEWHORIZONS_GATEWAY_LOG_PATH
//   <root>/.run/health.json          NEWHORIZONS_GATEWAY_HEALTH_PATH
//   <root>/.run/gateway.pid          (scripts/stop.py of the Python Gateway reads it)
//   <root>/.run/downloads/
//
// <root>: the executable's directory for a packaged build, else the working
// directory; NEWHORIZONS_GATEWAY_APP_ROOT overrides it and
// NEWHORIZONS_GATEWAY_RUNTIME_ROOT names the .run directory itself (Python's meaning).
import { dirname, join, resolve } from 'node:path';

import { isSea } from './assets';
import type { RuntimePaths } from './hostApi';

export interface ResolvePathsOptions {
  /** The directory that holds .run/. Wins over the environment. */
  root?: string;
  /** The config file. Wins over the environment. */
  configFile?: string;
  /** Default process.env. */
  env?: Record<string, string | undefined>;
  /** Default process.cwd(). */
  cwd?: string;
  /** Default: isSea(). */
  packaged?: boolean;
  /** Default process.execPath. */
  execPath?: string;
}

export function defaultRoot(options: Pick<ResolvePathsOptions, 'cwd' | 'packaged' | 'execPath'> = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const packaged = options.packaged ?? isSea();
  return packaged ? dirname(resolve(cwd, options.execPath ?? process.execPath)) : resolve(cwd);
}

export function resolveRuntimePaths(options: ResolvePathsOptions = {}): RuntimePaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const fromEnv = (name: string): string | null => {
    const value = env[name];
    return value ? resolve(cwd, value) : null;
  };

  let root: string;
  let runDir: string;
  if (options.root !== undefined) {
    root = resolve(cwd, options.root);
    runDir = join(root, '.run');
  } else {
    const envRunDir = fromEnv('NEWHORIZONS_GATEWAY_RUNTIME_ROOT');
    const envRoot = fromEnv('NEWHORIZONS_GATEWAY_APP_ROOT');
    root = envRoot ?? (envRunDir ? dirname(envRunDir) : defaultRoot(options));
    runDir = envRunDir ?? join(root, '.run');
  }
  const envOr = (name: string, fallback: string): string => (options.root !== undefined ? fallback : (fromEnv(name) ?? fallback));

  const configFile =
    options.configFile !== undefined
      ? resolve(cwd, options.configFile)
      : options.root !== undefined
        ? join(runDir, 'config', 'config.json')
        : (fromEnv('NEWHORIZONS_GATEWAY_CONFIG') ?? fromEnv('NEWHORIZONS_GATEWAY_CONFIG_PATH') ?? join(runDir, 'config', 'config.json'));

  return {
    root,
    runDir,
    configFile,
    logFile: envOr('NEWHORIZONS_GATEWAY_LOG_PATH', join(runDir, 'logs', 'gateway.log')),
    healthFile: envOr('NEWHORIZONS_GATEWAY_HEALTH_PATH', join(runDir, 'health.json')),
    pidFile: join(runDir, 'gateway.pid'),
    downloadsDir: join(runDir, 'downloads'),
  };
}

/** <runDir>/console-status.json (console_runtime.STATUS_FILE_NAME). */
export function consoleStatusFile(paths: RuntimePaths): string {
  return join(paths.runDir, 'console-status.json');
}

/** <runDir>/legacy-import.json: written when settings were taken over from the Python Gateway. */
export function legacyImportFile(paths: RuntimePaths): string {
  return join(paths.runDir, 'legacy-import.json');
}
