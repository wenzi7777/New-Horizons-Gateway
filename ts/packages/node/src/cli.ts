// nh-gateway: the desktop Gateway's entry point (the Node SEA executable runs
// this). It replaces the Python launcher chain -- scripts/start.py ->
// bootloader.py -> start_runtime.py -> main.run() -- with one loop:
//
//   run the host -> it ends with 'restart' (run again in-process), 'switch'
//   (a staged update was activated: launch it, wait for its health, exit or
//   roll back and run again) or 'exit'.

import { parseArgs } from 'node:util';

import type { ThemeMode } from '@nhgw/ui-tokens';

import { HostLogger, PortInUseError } from './adapters';
import { runGateway } from './host';
import { cleanupAfterStart, createDesktopInstaller, runningAsSea, superviseSwitchDetailed } from './installer';
import { resolveRuntimePaths } from './paths';
import { runTui } from './tui';
import { GATEWAY_VERSION } from './version';

const HELP = `NH Gateway ${GATEWAY_VERSION}

Usage: nh-gateway [options]

  --root <dir>       Directory that holds .run/ (default: beside the executable)
  --config <file>    Config file (default: <root>/.run/config/config.json)
  --theme <mode>     Terminal UI theme: auto (sunrise/sunset), light, dark
  --lang <locale>    Terminal UI language: en, ja, zh-CN (default: system)
  --plain            No terminal UI: print log lines instead
  --version          Print the version and exit
  --help             Show this help

The web UI listens on http://127.0.0.1:5052 by default.`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  // Under SEA argv is [exe, exe, ...user args]; under node it is [node, script, ...].
  const args = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        root: { type: 'string' },
        config: { type: 'string' },
        theme: { type: 'string' },
        lang: { type: 'string' },
        plain: { type: 'boolean' },
        version: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
    });
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
  }
  const options = parsed.values;
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (options.version) {
    process.stdout.write(`${GATEWAY_VERSION}\n`);
    return;
  }
  const theme = (options.theme ?? 'auto') as ThemeMode;
  if (!['auto', 'light', 'dark'].includes(theme)) fail(`--theme must be auto, light or dark\n\n${HELP}`);

  const paths = resolveRuntimePaths({ root: options.root, configFile: options.config });
  const useTui = !options.plain && Boolean(process.stdout.isTTY);
  // One logger for every in-process run, so the terminal UI keeps its history across restarts.
  const logger = new HostLogger({
    file: paths.logFile,
    echo: useTui ? undefined : (text) => process.stderr.write(`${text}\n`),
  });
  const executable = process.execPath;
  // A dev run (node + script) must never replace the node binary.
  const installerFactory = runningAsSea() ? createDesktopInstaller : undefined;

  for (;;) {
    let host;
    try {
      host = await runGateway({ paths, logger, installerFactory, executable, echoLogs: false });
    } catch (error) {
      if (error instanceof PortInUseError) fail(error.message);
      throw error;
    }
    // The host writes its health file once the web UI listens, before resolving.
    void cleanupAfterStart(host.paths, executable, logger).catch((error: unknown) =>
      logger.warn(`update cleanup: ${error instanceof Error ? error.message : String(error)}`),
    );
    const tui = useTui ? runTui(host, { theme, locale: options.lang }) : null;
    const outcome = await host.done;
    tui?.stop();
    await host.stop();
    if (outcome === 'restart') continue;
    if (outcome === 'exit') return;

    const result = await superviseSwitchDetailed({ paths: host.paths, executable, args, logger });
    if (result.outcome === 'rolled_back') {
      logger.warn(`update rolled back (${result.rollbackReason ?? 'unknown'}); running ${GATEWAY_VERSION} again`);
      continue;
    }
    if (result.exited) {
      // Attached to this terminal: stay as a thin parent, or the shell takes
      // the terminal back and job control stops the new UI (Python's
      // bootloader waited on its child for the same reason).
      process.on('SIGINT', () => {});
      process.exit(await result.exited);
    }
    process.exit(0);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`nh-gateway: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
