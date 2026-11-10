// The app's one PocketUpdater: on Android the native module downloads and
// installs; elsewhere (Expo Go, web) a stand-in that says updates need the
// installed app. Checked once at start, then from Settings.
import Constants from 'expo-constants';

import NhGatewayNative from '../../modules/nh-gateway-native/src/NhGatewayNativeModule';
import { createPocketStore } from '.';
import { CHANNEL_KEY, PocketUpdater, type UpdateChannel } from './updater';

let instance: PocketUpdater | null = null;

function installedVersion(): string {
  try {
    const name = NhGatewayNative?.installedVersion().versionName;
    if (name) return name.startsWith('v') ? name : `v${name}`;
  } catch {
    // older native module
  }
  const fallback = Constants.expoConfig?.version ?? '0.0.0';
  return fallback.startsWith('v') ? fallback : `v${fallback}`;
}

export function getPocketUpdater(): PocketUpdater {
  if (instance) return instance;
  const native = NhGatewayNative;
  const host = createPocketStore() as unknown as { appConfig?(): Promise<Record<string, unknown>>; saveAppConfig?(patch: Record<string, unknown>): Promise<void> } | null;
  instance = new PocketUpdater({
    currentVersion: installedVersion(),
    fetchText: async (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
        return { status: response.status, text: await response.text() };
      } catch {
        throw new Error('network');
      } finally {
        clearTimeout(timer);
      }
    },
    download: async (asset, onProgress) => {
      if (!native) throw new Error('unsupported');
      const subscription = native.addListener('onUpdateProgress', (event) => onProgress(event.received, event.total));
      try {
        return await native.updateDownload(asset.url, asset.sha256, asset.size);
      } finally {
        subscription.remove();
      }
    },
    canInstall: () => native?.updateCanInstall() ?? false,
    openInstallSettings: () => void native?.updateOpenInstallSettings(),
    install: (path) => {
      if (!native) throw new Error('unsupported');
      native.updateInstall(path);
    },
    loadChannel: async () => String((await host?.appConfig?.())?.[CHANNEL_KEY] ?? ''),
    saveChannel: async (channel: UpdateChannel) => {
      await host?.saveAppConfig?.({ [CHANNEL_KEY]: channel });
    },
  });
  const updater = instance;
  void updater.loadChannel().then(() => updater.check());
  return updater;
}
