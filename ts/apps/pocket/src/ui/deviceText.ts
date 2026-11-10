// Small device wording helpers shared by the device screens.
import type { DeviceView } from '../host/contract';
import type { Key } from '../i18n/strings';

type T = (key: Key, vars?: Readonly<Record<string, unknown>>) => string;

export function modeLabel(t: T, mode: string): string {
  if (mode === 'normal' || mode === '') return t('modeNormal');
  if (mode === 'maintenance') return t('modeMaintenance');
  if (mode === 'safe') return t('modeSafe');
  return mode;
}

export function batteryLabel(t: T, device: Pick<DeviceView, 'battery'>): string | null {
  const b = device.battery;
  if (!b || b.percent === null) return null;
  return b.charging ? `${b.percent}% · ${t('batteryCharging')}` : `${b.percent}%`;
}
