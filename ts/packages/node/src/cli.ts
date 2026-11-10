// nh-studio: NH Studio headless -- a relay for machines without a screen
// (e.g. the lab's former Python Gateway hosts), with the Hub's standing: it
// relays devices to the server (client_type "relay"), needs no sign-in and
// records nothing (recording is NH Studio's / NH Pocket's). The Node SEA
// executable runs this. It replaces the Python launcher chain -- scripts/start.py ->
// bootloader.py -> start_runtime.py -> main.run() -- with one loop:
//
//   run the host -> it ends with 'restart' (run again in-process), 'switch'
//   (a staged update was activated: launch it, wait for its health, exit or
//   roll back and run again) or 'exit'.

import { parseArgs } from 'node:util';

import { GatewayConfigStore } from '@nhgw/core';
import type { ThemeMode } from '@nhgw/ui-tokens';

import { estimateCapacity, runCpuBench, runLinkBench } from '../../host/src/tools/relayBench';
import { serverChoiceOf, syncBaseUrl } from '../../host/src/sync/config';

import { HostLogger, PortInUseError } from './adapters';
import { JsonFileStore } from './adapters/jsonStore';
import { CONFIG_FLOAT_KEYS } from './pyJson';
import { runGateway } from './host';
import { cleanupAfterStart, createDesktopInstaller, runningAsSea, superviseSwitchDetailed } from './installer';
import { resolveRuntimePaths } from './paths';
import { runTui } from './tui';
import { GATEWAY_VERSION } from './version';

const HELP = `NH Studio ${GATEWAY_VERSION} (headless)

Usage: nh-studio [--headless] [options]

  --headless         Run without a window (the only mode of this executable)
  --bench            Relay performance test: how many devices this machine and
                     its link to the configured server can relay, then exit
  --fps <n>          Frame rate for --bench (default 60)
  --sensors <n>      Sensors per device for --bench (default 112)
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
        headless: { type: 'boolean' },
        bench: { type: 'boolean' },
        fps: { type: 'string' },
        sensors: { type: 'string' },
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
  if (options.bench) {
    await bench(paths.configFile, Number(options.fps ?? 60), Number(options.sensors ?? 112));
    return;
  }
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

/** --bench: this machine's relay throughput and the round trip to the configured server. */
async function bench(configFile: string, fps: number, sensors: number): Promise<void> {
  if (!(fps > 0 && fps <= 1000) || !(sensors > 0 && sensors <= 4096)) fail('--fps must be 1-1000 and --sensors 1-4096');
  const store = await GatewayConfigStore.load(new JsonFileStore(configFile, { floatKeys: CONFIG_FLOAT_KEYS }), process.env);
  const config = store.snapshot() as unknown as Record<string, unknown>;
  const baseUrl = syncBaseUrl(serverChoiceOf(config));
  process.stdout.write(`NH Studio headless ${GATEWAY_VERSION} relay test: ${sensors} sensors at ${fps} fps\n`);
  process.stdout.write('Measuring this machine (3 s)…\n');
  const cpu = await runCpuBench({ sensors, durationMs: 3000 });
  process.stdout.write(`  ${Math.round(cpu.framesPerSecond).toLocaleString('en')} frames/s (${cpu.packetBytes} B a frame)\n`);
  process.stdout.write(`Measuring the link to ${baseUrl || '(no server)'}…\n`);
  const link = await runLinkBench(
    {
      baseUrl,
      request: async (method, url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetch(url, { method, signal: controller.signal });
          await response.arrayBuffer();
          return { status: response.status };
        } finally {
          clearTimeout(timer);
        }
      },
    },
    { upload: false },
  );
  if (link.ok) process.stdout.write(`  round trip ${Math.round(link.rttMs ?? 0)} ms (upload is not measured without a sign-in)\n`);
  else process.stdout.write(`  not measured: ${link.error}\n`);
  const estimate = estimateCapacity({ cpu, link, fps, sensors });
  const perDevice = (estimate.bytesPerDevicePerSecond / 1024).toFixed(1);
  process.stdout.write(`\nThis machine can relay about ${estimate.devicesByMachine} devices (with headroom).\n`);
  process.stdout.write(`Each device needs about ${perDevice} KiB/s of upload to the server; check the link can carry ${estimate.devicesByMachine} x ${perDevice} KiB/s.\n`);
  if (link.ok && (link.rttMs ?? 0) > 250) process.stdout.write('The round trip is long: live views on the server will lag.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`nh-studio: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
