// The "Illustrated" device card: the board (v1.0.F / v1.5.F / v2.0.F) with its
// live values pointing at the parts they come from. Null on boards without a
// drawing (GCU LTS): the screen keeps its plain status card then.
import { useRouter } from 'expo-router';
import { memo, useMemo } from 'react';
import { boardArtFor } from '@nhgw/host';

import type { DeviceView } from '../../host/contract';
import { modeLabel } from '../deviceText';
import { formatDateTime } from '../format';
import { useI18n } from '../i18n';
import { useDeviceFps } from '../store';
import { CalloutDiagram, type CalloutItem } from './CalloutDiagram';

/** Memoized: redrawn when a shown field changes; the fps line is read here on its own. */
export const DeviceHero = memo(function DeviceHero({ device }: { device: Omit<DeviceView, 'fps'> }) {
  const { t, locale } = useI18n();
  const fps = useDeviceFps(device.uid);
  const router = useRouter();
  const art = boardArtFor(device.hardwareModel);

  const items = useMemo<CalloutItem[]>(() => {
    const out: CalloutItem[] = [];
    out.push({
      id: 'connection',
      target: 'antenna',
      title: t('calloutConnection'),
      value: device.takenOver ? t('takenOver') : device.online ? t('deviceOnline') : t('deviceOffline'),
      detail: device.takenOver
        ? device.takenOverBy ? t('takenOverBy', { name: device.takenOverBy }) : undefined
        : device.online
          ? t('connectedHere')
          : device.lastSeenMs ? formatDateTime(device.lastSeenMs, locale) : undefined,
      tone: device.takenOver || device.streamBlocked ? 'warn' : device.online ? 'ok' : 'muted',
    });
    out.push({
      id: 'firmware',
      target: 'mcu',
      title: t('calloutFirmware'),
      value: device.firmwareVersion || '-',
      detail: modeLabel(t, device.mode),
      tone: device.mode && device.mode !== 'normal' ? 'warn' : 'ok',
    });
    if (device.battery && device.battery.percent !== null) {
      const percent = device.battery.percent;
      const charging = device.battery.charging;
      out.push({
        id: 'battery',
        target: 'battery',
        title: t('calloutBattery'),
        value: `${percent}%`,
        detail: charging ? t('batteryCharging') : t('batteryOnBattery'),
        tone: percent <= 10 && !charging ? 'danger' : percent <= 20 && !charging ? 'warn' : 'ok',
      });
    }
    if (device.vref) {
      const vref = device.vref;
      out.push({
        id: 'vref',
        target: 'vref',
        title: t('calloutVref'),
        value: vref.mv !== null ? `${Math.round(vref.mv)} mV` : '-',
        detail: vref.mode === 'auto' ? t('readingAuto') : vref.mode === 'conductance' ? t('readingConductance') : t('readingRaw'),
        tone: vref.zone === 'risk' ? 'danger' : vref.zone === 'near' ? 'warn' : 'ok',
      });
    }
    // The matrix is rows on the analog FPC times columns on the digital one:
    // one label, its line split to both connectors.
    const rows = device.pins?.analog.length ?? device.matrix?.rows;
    const cols = device.pins?.select.length ?? device.matrix?.cols;
    out.push({
      id: 'matrix',
      target: 'analogFpc',
      branches: ['digitalFpc'],
      title: t('calloutMatrix'),
      value: rows !== undefined && cols !== undefined ? t('pinsValue', { rows, cols }) : '-',
      detail: device.online ? t('fpsValue', { fps }) : undefined,
      tone: device.online ? 'ok' : 'muted',
      onPress: () => router.push({ pathname: '/pins/[uid]', params: { uid: device.uid } }),
    });
    return out;
  }, [device, fps, t, locale, router]);

  if (!art) return null;
  return <CalloutDiagram art={art} items={items} accessibilityLabel={t('heroLabel')} />;
});
