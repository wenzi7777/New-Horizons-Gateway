// The real PocketStore: the shared app host (@nhgw/host) on the native module
// and expo-sharing. Screens import this (or src/host/mockStore.ts).
import * as Sharing from 'expo-sharing';
import { AppHost, type HostNative } from '@nhgw/host';

import NhGatewayNative from '../../modules/nh-gateway-native/src/NhGatewayNativeModule';
import type { PocketStore } from './contract';

export type { PocketStore } from './contract';

/** Reported upstream (hello / gateway_status). */
export const POCKET_VERSION = 'v2.0.0';

let instance: AppHost | null = null;

/**
 * The app's one host. null where the native module is missing (Expo Go,
 * iOS, web): the UI then falls back to the mock store or says so.
 */
export function createPocketStore(): PocketStore | null {
  if (instance !== null) return instance;
  if (NhGatewayNative === null) return null;
  instance = new AppHost({
    native: NhGatewayNative as unknown as HostNative,
    clientType: 'pocket',
    platform: 'android',
    version: POCKET_VERSION,
    share: (fileUri, options) => Sharing.shareAsync(fileUri, options),
  });
  return instance;
}
