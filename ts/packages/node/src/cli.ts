// nh-studio: NH Studio without a window (headless) -- the relay for machines
// with no screen, e.g. the lab's former Python Gateway hosts. Same engine and
// config as before; it connects as client_type "studio" and can carry an
// NH Studio app token (--set-token). The Node SEA executable runs this. It replaces the Python launcher chain -- scripts/start.py ->
// bootloader.py -> start_runtime.py -> main.run() -- with one loop:
//
//   run the host -> it ends with 'restart' (run again in-process), 'switch'
//   (a staged update was activated: launch it, wait for its health, exit or
//   roll back and run again) or 'exit'.

import { parseArgs } from 'node:util';

import { GatewayConfigStore } from '@nhgw/core';

import type { ThemeMode } from '@nhgw/ui-tokens';

import { HostLogger, PortInUseError } from './adapters';
import { JsonFileStore } from './adapters/jsonStore';
import { appTokenStatus, clearAppToken, loginAppToken, logoutAppToken, saveAppToken } from './appToken';
import { CONFIG_FLOAT_KEYS } from './pyJson';
import { runGateway } from './host';
import { cleanupAfterStart, createDesktopInstaller, runningAsSea, superviseSwitchDetailed } from './installer';
import { resolveRuntimePaths } from './paths';
import { runTui } from './tui';
import { GATEWAY_VERSION } from './version';

const HELP = `NH Studio ${GATEWAY_VERSION} (headless)

Usage: nh-studio [--headless] [options]

  --headless         Run without a window (the only mode of this executable)
  --login [--user <name>]
                     Sign in to the configured server with a New Horizons
                     Desktop account (asks for the password; it is not
                     stored, only the key the server returns) and exit
  --logout           Sign out (the server revokes this computer's key) and exit
  --token-status     Show who is signed in / whether a key is stored, and exit
  --set-token        Instead of signing in: read an app token from stdin
  --clear-token      Forget the stored key without telling the server
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
        'set-token': { type: 'boolean' },
        'clear-token': { type: 'boolean' },
        'token-status': { type: 'boolean' },
        login: { type: 'boolean' },
        logout: { type: 'boolean' },
        user: { type: 'string' },
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
  if (options.login || options.logout || options['set-token'] || options['clear-token'] || options['token-status']) {
    const action = options.login ? 'login' : options.logout ? 'logout' : options['set-token'] ? 'set' : options['clear-token'] ? 'clear' : 'status';
    await tokenCommand(paths.configFile, action, options.user);
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

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('Paste the app token, then press Enter and Ctrl-D:\n');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** One line from the terminal; with `hidden`, typed characters are not echoed (the password). */
async function prompt(question: string, hidden = false): Promise<string> {
  const input = process.stdin;
  process.stderr.write(question);
  if (!input.isTTY) {
    // Piped: the first line.
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(chunk as Buffer);
      if (Buffer.concat(chunks).includes(10)) break;
    }
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    const done = (result: string | null) => {
      input.setRawMode(wasRaw);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      if (result === null) reject(new Error('cancelled'));
      else resolve(result);
    };
    const onData = (data: Buffer) => {
      for (const ch of data.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(value);
        if (ch === '\u0003' || ch === '\u0004') return done(null);
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            if (!hidden) process.stderr.write('\b \b');
          }
          continue;
        }
        value += ch;
        if (!hidden) process.stderr.write(ch);
      }
    };
    input.on('data', onData);
  });
}

const TOKEN_ERRORS: Record<string, string> = {
  invalid_app_token: 'Not an NH Studio app token (nhapp_<id>_<secret>).',
  no_server: 'Set a usable server address first.',
  invalid_credentials: 'Wrong user name or password.',
  username_and_password_required: 'Enter a user name and password.',
  network: 'The server cannot be reached.',
  sync_unsupported: 'This server does not support signing in from NH Studio yet.',
  cancelled: 'Cancelled.',
};

/** --login / --logout / --set-token / --clear-token / --token-status. A running nh-studio picks the change up after a restart. */
async function tokenCommand(configFile: string, action: 'login' | 'logout' | 'set' | 'clear' | 'status', user?: string): Promise<void> {
  const store = await GatewayConfigStore.load(new JsonFileStore(configFile, { floatKeys: CONFIG_FLOAT_KEYS }), process.env);
  let status;
  try {
    if (action === 'login') {
      const server = String(store.snapshot().server_url ?? '');
      process.stderr.write(`Signing in to ${server}\n`);
      const username = user ?? (await prompt('User name: '));
      const password = await prompt('Password: ', true);
      status = await loginAppToken(store, username, password);
    } else if (action === 'logout') status = await logoutAppToken(store);
    else if (action === 'set') status = await saveAppToken(store, await readStdin());
    else if (action === 'clear') status = await clearAppToken(store);
    else status = appTokenStatus(store.snapshot() as unknown as Record<string, unknown>);
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    fail(TOKEN_ERRORS[code] ?? code);
  }
  const note = status.active ? '' : ' (not used: the server setting points elsewhere)';
  if (!status.set) process.stdout.write(action === 'logout' ? 'Signed out.\n' : 'Not signed in.\n');
  else if (status.account) process.stdout.write(`Signed in to ${status.server} as ${status.account}${note}\n`);
  else process.stdout.write(`App token ${status.masked} for ${status.server}${note}\n`);
  if (action !== 'status') process.stdout.write('Restart nh-studio (or use the web UI) for the relay to use it.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`nh-studio: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
