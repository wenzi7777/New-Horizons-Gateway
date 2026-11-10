// Ported from New-Horizons-Desktop/frontend/src/lib/deviceStatus.ts (same
// behaviour, tests/deviceStatus.test.mjs ported to test/renderer). Studio's
// DeviceView only says online/offline, so connectionStateOf() maps it.

import type { DeviceView } from '../../shared/contract';

export type DeviceConnectionState = 'online' | 'reconnecting' | 'offline' | 'booting';

type StatusShapedDevice = {
  connectionState: DeviceConnectionState;
  mode: string;
};

export function connectionStateOf(device: Pick<DeviceView, 'online'>): DeviceConnectionState {
  return device.online ? 'online' : 'offline';
}

export function deviceClassName(device: StatusShapedDevice) {
  if (device.connectionState === 'reconnecting') return 'reconnecting';
  if (device.connectionState === 'offline') return 'offline';
  if (device.mode === 'maintenance' || device.mode === 'safe_maintenance') return 'maintenance';
  if (device.connectionState === 'booting') return 'booting';
  return 'normal';
}

export function statusDot(device: StatusShapedDevice) {
  if (device.connectionState === 'booting') return 'status-dot booting';
  if (device.connectionState === 'reconnecting') return 'status-dot reconnecting';
  if (device.connectionState === 'offline') return 'status-dot offline';
  return 'status-dot online';
}

export function connectionStateLabel(device: StatusShapedDevice, label: (key: 'booting' | 'reconnecting' | 'offline' | 'online') => string) {
  if (device.connectionState === 'booting') return label('booting');
  if (device.connectionState === 'reconnecting') return label('reconnecting');
  if (device.connectionState === 'offline') return label('offline');
  return label('online');
}

export function connectionRank(device: StatusShapedDevice) {
  switch (device.connectionState) {
    case 'online':
      return 0;
    case 'booting':
      return 1;
    case 'reconnecting':
      return 2;
    default:
      return 3;
  }
}
