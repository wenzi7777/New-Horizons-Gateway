import { NativeModule, requireOptionalNativeModule } from 'expo';

import type { NativeStats, NetworkInterfaceInfo, NhGatewayNativeEvents } from './NhGatewayNative.types';

declare class NhGatewayNativeModule extends NativeModule<NhGatewayNativeEvents> {
  startService(): boolean;
  stopService(): boolean;
  isRunning(): boolean;
  send(localPort: number, ip: string, dstPort: number, base64: string): void;
  nowEpochUs(): number;
  stats(): NativeStats;
  networkInterfaces(): NetworkInterfaceInfo[];
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): boolean;
}

// null in Expo Go (and on iOS): it only carries Expo's own native modules,
// so the app falls back to an upstream-only check there.
export default requireOptionalNativeModule<NhGatewayNativeModule>('NhGatewayNative');
