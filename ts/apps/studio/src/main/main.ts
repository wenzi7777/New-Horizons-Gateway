// NH Studio (New Horizons Studio) -- Electron main process.
//
// The host (StudioController: @nhgw/host AppHost on Node sockets and files)
// starts when the app is ready and runs until Quit: on macOS closing the
// window keeps relaying and recording (the Dock icon reopens it); on Windows
// closing the last window quits, after asking when devices are recording.
// The renderer is sandboxed and reaches the host only through the preload's
// window.nhStudio (ipc.ts).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir, release as osRelease } from 'node:os';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Tray,
  type MenuItemConstructorOptions,
  protocol,
  session,
  shell,
  type WebContents,
} from 'electron';
import type { HostPlatform } from '@nhgw/core';
import { dark, light, resolveTheme } from '@nhgw/ui-tokens';

import type { SplashPrompt } from '../shared/areas/app';
import { AREA_MODULES, AreaRegistry } from './areas';
import { appService, configureAppArea } from './areas/app';
import { QuitRequested, StartupSequence, waitFor, type StepBody, type StepResult } from './app/startup';
import { WINDOW_CH } from './ipcChannels';
import { registerStudioIpc, type DesktopPorts, type IpcEventLike } from './ipc';
import { HostLogger, NodeWsConnector } from './nodeAdapters';
import { APP_ENTRY, APP_SCHEME, SPLASH_ENTRY, contentSecurityPolicy, isExternalWebUrl, isRendererUrl, serveAppRequest } from './security';
import { StudioController } from './studioController';

const PRODUCT_NAME = 'NH Studio';
const FULL_NAME = 'New Horizons Studio';
const APP_ID = 'jp.ac.uaizu.newhorizons.studio';
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || null;
const IS_MAC = process.platform === 'darwin';
/** DevTools only outside packaged builds. */
const DEVTOOLS = !app.isPackaged;
/** How long Quit waits for recordings to be finalised. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

app.setName(PRODUCT_NAME);
// Development / smoke tests: keep userData and the default data folder out of the user's home.
const STUDIO_HOME = !app.isPackaged ? process.env.NH_STUDIO_HOME || null : null;
if (STUDIO_HOME) app.setPath('userData', join(STUDIO_HOME, 'userData'));
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main(): void {
  const rendererDir = join(__dirname, '..', 'renderer');
  const preloadPath = join(__dirname, '..', 'preload', 'preload.cjs');
  const csp = contentSecurityPolicy(DEV_SERVER_URL);
  let controller: StudioController | null = null;
  let areas: AreaRegistry | null = null;
  let logger: HostLogger | null = null;
  let mainWindow: BrowserWindow | null = null;
  let quitConfirmed = false;
  let shuttingDown = false;
  let stopped = false;
  let startupDone = false;
  let splashWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;

  const keepInBackground = (): boolean => appService()?.prefs().keepRunningInBackground ?? IS_MAC;

  /** Windows/Linux: a tray icon while running in the background, so the window can come back. */
  const updateTray = () => {
    const want = !IS_MAC && keepInBackground() && startupDone;
    if (!want) {
      tray?.destroy();
      tray = null;
      return;
    }
    if (tray) return;
    const icon = nativeImage.createFromPath(join(rendererDir, 'tray-icon.png'));
    tray = new Tray(icon);
    tray.setToolTip(PRODUCT_NAME);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${PRODUCT_NAME}`, click: () => showWindow() },
        { type: 'separator' },
        { label: `Quit ${PRODUCT_NAME}`, click: () => app.quit() },
      ]),
    );
    tray.on('click', () => showWindow());
  };

  const backgroundColor = (): string => {
    const mode = controller?.settings().theme ?? 'auto';
    return resolveTheme(mode, new Date()) === 'dark' ? dark.bg : light.bg;
  };

  const recordingCount = () => controller?.recordingCount() ?? 0;

  /** Asks before recordings are stopped by quitting; true = go ahead. */
  const confirmStopRecording = (window: BrowserWindow | null): boolean => {
    const count = recordingCount();
    if (count === 0) return true;
    const options = {
      type: 'warning' as const,
      buttons: ['Keep Recording', 'Stop Recording and Quit'],
      defaultId: 0,
      cancelId: 0,
      message: count === 1 ? 'A device is recording.' : `${count} devices are recording.`,
      detail: `Quitting ${PRODUCT_NAME} stops the recording. What has been recorded so far is kept.`,
    };
    const choice = window ? dialog.showMessageBoxSync(window, options) : dialog.showMessageBoxSync(options);
    return choice === 1;
  };

  const createWindow = (): BrowserWindow => {
    const window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 640,
      title: PRODUCT_NAME,
      show: false,
      backgroundColor: backgroundColor(),
      // macOS keeps its own title bar (traffic lights over the top bar); Windows and
      // Linux draw theirs in the renderer (TitleBarControls), without a menu bar.
      ...(IS_MAC ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: DEVTOOLS,
        spellcheck: false,
      },
    });
    window.once('ready-to-show', () => window.show());
    lockDown(window.webContents);
    window.on('close', (event) => {
      // Keeping running in the background (macOS default): closing never quits, nothing to ask.
      if (keepInBackground() || quitConfirmed || BrowserWindow.getAllWindows().length > 1) return;
      if (!confirmStopRecording(window)) event.preventDefault();
      else quitConfirmed = true;
    });
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = null;
    });
    const pushMaximized = () => {
      if (!window.isDestroyed()) window.webContents.send(WINDOW_CH.maximized, window.isMaximized());
    };
    window.on('maximize', pushMaximized);
    window.on('unmaximize', pushMaximized);
    void (DEV_SERVER_URL ? window.loadURL(DEV_SERVER_URL) : window.loadURL(APP_ENTRY)).catch((error: unknown) => {
      logger?.error(`renderer load: ${error instanceof Error ? error.message : String(error)}`);
    });
    mainWindow = window;
    return window;
  };

  const showWindow = () => {
    const window = mainWindow ?? createWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  /** Navigation stays on the renderer; http(s) links open in the browser; nothing else. */
  const lockDown = (contents: WebContents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalWebUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (isRendererUrl(url, DEV_SERVER_URL)) return;
      event.preventDefault();
      if (isExternalWebUrl(url)) void shell.openExternal(url);
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    if (!DEVTOOLS) contents.on('devtools-opened', () => contents.closeDevTools());
  };

  const isTrustedSender = (event: IpcEventLike): boolean => {
    const frame = (event as unknown as { senderFrame?: { url: string } | null }).senderFrame;
    return frame != null && isRendererUrl(frame.url, DEV_SERVER_URL);
  };

  const desktopPorts = (): DesktopPorts => ({
    async saveZip(defaultName, sender) {
      const window = BrowserWindow.fromWebContents(sender as unknown as WebContents);
      const options = {
        title: 'Export Recording',
        defaultPath: join(app.getPath('downloads'), defaultName),
        filters: [{ name: 'Zip archive', extensions: ['zip'] }],
      };
      const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    async chooseFolder(current, sender) {
      const window = BrowserWindow.fromWebContents(sender as unknown as WebContents);
      const options = {
        title: 'Choose the NH Studio Data Folder',
        defaultPath: current,
        buttonLabel: 'Use Folder',
        properties: ['openDirectory' as const, 'createDirectory' as const],
      };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    },
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openExternal: (url) => shell.openExternal(url),
    zipName: (recordingId) => StudioController.zipName(recordingId),
  });

  const buildMenu = () => {
    const about = () => {
      const options = {
        type: 'info' as const,
        title: `About ${PRODUCT_NAME}`,
        message: `${FULL_NAME}`,
        detail: `${PRODUCT_NAME} ${app.getVersion()}\nElectron ${process.versions.electron} · Node ${process.versions.node}`,
        buttons: ['OK'],
      };
      if (mainWindow) void dialog.showMessageBox(mainWindow, options);
      else void dialog.showMessageBox(options);
    };
    const view: MenuItemConstructorOptions[] = [
      ...(DEVTOOLS
        ? ([{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[])
        : []),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ];
    const template: MenuItemConstructorOptions[] = IS_MAC
      ? [
          {
            label: PRODUCT_NAME,
            submenu: [
              { role: 'about', label: `About ${PRODUCT_NAME}` },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: `Hide ${PRODUCT_NAME}` },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: `Quit ${PRODUCT_NAME}` },
            ],
          },
          { role: 'editMenu' },
          { label: 'View', submenu: view },
          { role: 'windowMenu' },
        ]
      : [
          { label: 'File', submenu: [{ role: 'quit', label: 'Exit' }] },
          { role: 'editMenu' },
          { label: 'View', submenu: view },
          { role: 'windowMenu' },
          { role: 'help', submenu: [{ label: `About ${PRODUCT_NAME}`, click: about }] },
        ];
    // Windows / Linux: no menu bar (the window draws its own title bar).
    Menu.setApplicationMenu(IS_MAC ? Menu.buildFromTemplate(template) : null);
  };

  /**
   * Hands a verified download to the OS and quits. macOS: opens the dmg
   * (Finder mounts it; the user drags NH Studio into Applications), or shows
   * a zip in Finder. Windows: runs the NSIS installer (with its normal UI, so
   * the install folder and SmartScreen prompt stay visible).
   */
  const installDownloaded = async (file: string) => {
    if (process.platform === 'win32' && /\.exe$/i.test(file)) {
      const child = spawn(file, [], { detached: true, stdio: 'ignore' });
      child.unref();
    } else if (/\.dmg$/i.test(file)) {
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
    } else {
      shell.showItemInFolder(file);
    }
    logger?.info(`update: handed ${file} to the OS; quitting`);
    setTimeout(() => app.quit(), 800);
  };

  const shutdown = async () => {
    const stop = (areas?.dispose() ?? Promise.resolve()).then(() => controller?.stop());
    await Promise.race([stop, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))]).catch((error: unknown) => {
      logger?.error(`shutdown: ${error instanceof Error ? error.message : String(error)}`);
    });
    logger?.info(`${PRODUCT_NAME} stopped`);
  };

  app.on('second-instance', () => {
    if (app.isReady() && startupDone) showWindow();
    else splashWindow?.focus();
  });

  app.on('before-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    if (!quitConfirmed && !confirmStopRecording(mainWindow)) return;
    quitConfirmed = true;
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown().finally(() => {
      stopped = true;
      // The host is down and its files are closed: leave without another round of quit events.
      app.exit(0);
    });
  });

  app.on('window-all-closed', () => {
    // Keep relaying / recording until Quit when the preference says so (macOS default; Windows: the tray icon reopens).
    if (!startupDone) return;
    if (keepInBackground()) {
      updateTray();
      return;
    }
    app.quit();
  });

  app.on('activate', () => {
    if (app.isReady() && startupDone) showWindow();
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      quitConfirmed = true;
      app.quit();
    });
  }

  app.whenReady().then(async () => {
    // Unpackaged (npm start) the Dock shows Electron's own icon; packaged builds get it from the .icns.
    if (!app.isPackaged && process.platform === 'darwin') {
      const devIcon = nativeImage.createFromPath(join(__dirname, '..', '..', '..', '..', '..', 'brand', 'macos', 'nh-studio-1024.png'));
      if (!devIcon.isEmpty()) app.dock?.setIcon(devIcon);
    }
    const userData = app.getPath('userData');
    logger = new HostLogger({
      file: join(userData, 'logs', 'studio.log'),
      ...(DEVTOOLS ? { echo: (text: string) => console.log(text) } : {}),
    });
    app.setAboutPanelOptions({
      applicationName: PRODUCT_NAME,
      applicationVersion: app.getVersion(),
      version: '',
      credits: FULL_NAME,
      copyright: `${FULL_NAME} · University of Aizu`,
    });

    // The renderer: its files only, with the CSP on every response; no permissions.
    protocol.handle(APP_SCHEME, (request) => serveAppRequest(rendererDir, request.url, csp));
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      if (isRendererUrl(details.url, DEV_SERVER_URL)) headers['Content-Security-Policy'] = [csp];
      callback({ responseHeaders: headers });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    app.on('web-contents-created', (_event, contents) => lockDown(contents));

    const platform: HostPlatform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
    controller = new StudioController({
      userDataDir: userData,
      defaultDataFolder: STUDIO_HOME ? join(STUDIO_HOME, 'data') : join(app.getPath('documents') || join(homedir(), 'Documents'), PRODUCT_NAME),
      tempDir: join(app.getPath('temp'), PRODUCT_NAME),
      version: `v${app.getVersion()}`,
      platform,
      upstreamPlatform: `${platform}-${process.arch}`,
      logger,
      // The host's default is React Native's WebSocket (url, protocols, {headers}); Node's takes {headers} second.
      connector: new NodeWsConnector({ logger }),
    });
    registerStudioIpc(ipcMain, controller, desktopPorts(), { isTrustedSender, logger });
    ipcMain.handle(WINDOW_CH.control, (event, action: unknown) => {
      if (!isTrustedSender(event as unknown as IpcEventLike)) throw new Error('untrusted_sender');
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return false;
      if (action === 'minimize') window.minimize();
      else if (action === 'toggleMaximize') {
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
      } else if (action === 'close') window.close();
      else if (action !== 'isMaximized') throw new Error('unknown_action');
      return window.isMaximized();
    });
    areas = new AreaRegistry(
      { controller, logger, userDataDir: userData, version: `v${app.getVersion()}` },
      {
        isTrustedSender,
        senders: () => BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).map((window) => window.webContents),
      },
    );
    configureAppArea({
      platform: process.platform,
      arch: process.arch,
      versions: { electron: process.versions.electron ?? '', node: process.versions.node, chrome: process.versions.chrome ?? '' },
      osRelease: osRelease(),
      packaged: app.isPackaged,
      loginItem: {
        get: () => app.getLoginItemSettings().openAtLogin,
        set: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
      },
      openPath: async (path) => {
        const error = await shell.openPath(path);
        if (error) throw new Error(error);
      },
      showItemInFolder: (path) => shell.showItemInFolder(path),
      openExternal: (url) => shell.openExternal(url),
      saveDialog: async (defaultName) => {
        const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
        const options = {
          title: 'Export Diagnostics',
          defaultPath: join(app.getPath('downloads'), defaultName),
          filters: [{ name: 'Zip archive', extensions: ['zip'] }],
        };
        const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
        return result.canceled || !result.filePath ? null : result.filePath;
      },
      http: async (url, signal) => {
        const response = await net.fetch(url, { cache: 'no-store', ...(signal ? { signal } : {}) });
        return { status: response.status, text: () => response.text(), body: response.body };
      },
      install: async (file) => installDownloaded(file),
    });
    for (const module of AREA_MODULES) areas.add(module);
    areas.attach(ipcMain);
    buildMenu();

    // Follow the theme setting for the window background (no white flash on reload).
    let lastBg = backgroundColor();
    controller.subscribe(() => {
      const bg = backgroundColor();
      if (bg !== lastBg) {
        lastBg = bg;
        for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(bg);
      }
    });

    await runStartup(controller, logger);
    startupDone = true;
    createWindow();
    splashWindow?.close();
    splashWindow = null;
    updateTray();
  });

  /** The splash and its steps (src/main/app/startup.ts); never blocks start-up on the network. */
  const runStartup = async (host: StudioController, log: HostLogger) => {
    const service = appService();
    const theme = resolveTheme(host.settings().theme, new Date());
    const sequence = new StartupSequence({ version: `v${app.getVersion()}`, theme, locale: app.getLocale() }, (state) => {
      if (splashWindow && !splashWindow.isDestroyed()) areas?.emit('app', 'splash', state);
    });
    if (service) service.splash = sequence;
    splashWindow = createSplash(theme);
    const quit = () => {
      quitConfirmed = true;
      app.quit();
      return new QuitRequested();
    };
    const ask = async (prompt: SplashPrompt, context: Parameters<StepBody>[0]) => context.ask(prompt);
    let recoveries = 0;
    const bodies: Partial<Record<'settings' | 'recovery' | 'ports' | 'server' | 'update', StepBody>> = {
      settings: async () => {
        await host.loadPrefs();
        return { status: 'done' };
      },
      recovery: async (context) => {
        recoveries = host.pendingRecoveries();
        if (recoveries > 0) context.progress('recovering', { count: recoveries });
        await host.start();
        // The host's settings are loaded now: follow their theme and language.
        const settings = host.settings();
        sequence.patch({
          theme: resolveTheme(settings.theme, new Date()),
          locale: settings.locale === 'system' ? app.getLocale() : settings.locale,
        });
        log.info(`${PRODUCT_NAME} ${app.getVersion()} ready (data folder ${host.settings().dataFolder})`);
        if (recoveries === 0) return { status: 'done', detail: 'none' };
        const finished = await waitFor(() => host.pendingRecoveries() === 0, 8_000, 200);
        return finished ? { status: 'done', detail: 'recovered', vars: { count: recoveries } } : { status: 'warn', detail: 'recoveringBackground', vars: { count: recoveries } };
      },
      ports: async (context) => {
        for (;;) {
          await waitFor(() => host.snapshot().status.serviceRunning || host.snapshot().status.serviceError !== '', 3_000);
          const status = host.snapshot().status;
          if (status.serviceRunning) return { status: 'done' };
          if (!status.serviceError) return { status: 'warn', detail: 'portsSlow' };
          const answer = await ask({ kind: 'ports', message: status.serviceError }, context);
          if (answer === 'quit') throw quit();
          if (answer === 'continue') return { status: 'warn', detail: 'portsBusy' };
          // retry: the native layer retries binding on its own; wait for it again.
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
      },
      server: async () => {
        if (!host.settings().relayEnabled) return { status: 'skipped', detail: 'relayOff' };
        const online = await waitFor(() => host.snapshot().status.upstream === 'online', 5_000, 150);
        return online ? { status: 'done' } : { status: 'warn', detail: 'serverLater' };
      },
      update: async (context): Promise<StepResult> => {
        if (!service || !service.prefs().checkUpdatesOnStart) return { status: 'skipped', detail: 'updateOff' };
        const state = await service.updater.check();
        if (state.phase === 'none') return { status: 'done', detail: 'noRelease' };
        if (state.phase === 'error') return { status: 'warn', detail: 'updateCheckFailed' };
        if (state.phase !== 'available') return { status: 'done', detail: 'upToDate' };
        const answer = await ask({ kind: 'update', version: state.latestVersion, notesUrl: state.notesUrl }, context);
        if (answer !== 'install') return { status: 'done', detail: 'updateLater', vars: { version: state.latestVersion } };
        const after = await service.updater.install();
        if (after.phase === 'installing') throw new QuitRequested();
        return { status: 'warn', detail: 'updateFailed', vars: { error: after.error || 'unknown' } };
      },
    };
    try {
      await sequence.run(bodies);
      // Give the last line a moment to be read.
      await new Promise((resolve) => setTimeout(resolve, 350));
    } catch (error) {
      if (error instanceof QuitRequested) await new Promise(() => undefined); // quitting; never open the main window
      throw error;
    } finally {
      if (service) service.splash = null;
    }
  };

  const createSplash = (theme: 'light' | 'dark'): BrowserWindow => {
    const window = new BrowserWindow({
      width: 420,
      height: 300,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      center: true,
      show: false,
      title: PRODUCT_NAME,
      backgroundColor: theme === 'dark' ? dark.bg : light.bg,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: DEVTOOLS,
        spellcheck: false,
      },
    });
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => {
      if (splashWindow === window) splashWindow = null;
      // Closing the splash before start-up finished (Alt+F4, Cmd+W) quits.
      if (!startupDone && !shuttingDown) {
        quitConfirmed = true;
        app.quit();
      }
    });
    const url = DEV_SERVER_URL ? new URL('splash.html', DEV_SERVER_URL).toString() : SPLASH_ENTRY;
    void window.loadURL(url).catch((error: unknown) => logger?.error(`splash load: ${error instanceof Error ? error.message : String(error)}`));
    return window;
  };

}
