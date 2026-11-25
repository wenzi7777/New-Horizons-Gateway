// The "Illustrated" device page's power and data paths (@nhgw/host powerFlow /
// connectionFlow). A phone only relays its own devices over Wi-Fi, so the
// relay box is this phone and its server link is the app's own.
import { memo } from 'react';
import { View } from 'react-native';
import { connectionFlow, powerFlow, type DeviceView } from '@nhgw/host';

import { useI18n } from '../i18n';
import { useSettings, useStatus } from '../store';
import { FlowPath } from './FlowPath';
import { Caption } from './primitives';

export const DeviceFlows = memo(function DeviceFlows({ device }: { device: Omit<DeviceView, 'fps'> }) {
  const { t } = useI18n();
  const status = useStatus();
  const settings = useSettings();
  const battery = device.battery;
  const chargeState = battery?.chargeState ?? (battery?.charging ? 'charging' : '');
  const power = battery ? powerFlow({ chargerPresent: battery.usbPower ?? null, chargeState }) : null;
  const usb = power?.nodes.find((node) => node.id === 'usb')?.active ?? false;
  const upstream = settings.relayEnabled ? status.upstream === 'online' : false;
  const link = connectionFlow({ link: 'wifi', deviceOnline: device.online, upstreamOnline: upstream });
  const serverOn = link.nodes.find((node) => node.id === 'server')?.active ?? false;
  return (
    <View style={{ gap: 6 }}>
      {power ? (
        <>
          <Caption>{t('flowPower')}</Caption>
          <FlowPath
            graph={power}
            accessibilityLabel={t('flowPower')}
            labels={{
              usb: { title: t('flowUsb'), value: usb ? t('flowPowered') : t('flowNoUsb') },
              charger: { title: t('flowCharger'), value: chargeState === 'charging' ? t('flowCharging') : chargeState === 'charge_done' ? t('flowFull') : '–' },
              battery: { title: t('flowBattery'), value: battery?.percent === null || battery?.percent === undefined ? '–' : `${battery.percent}%` },
              system: { title: t('flowSystem'), value: usb ? 'USB' : t('flowBattery') },
            }}
          />
        </>
      ) : null}
      <Caption>{t('flowConnection')}</Caption>
      <FlowPath
        graph={link}
        accessibilityLabel={t('flowConnection')}
        labels={{
          device: { title: t('flowDevice'), value: device.displayName },
          relay: { title: t('flowRelay'), value: device.online ? t('flowOnline') : t('flowOffline') },
          server: { title: t('flowServer'), value: !settings.relayEnabled ? t('flowRelayOff') : serverOn ? t('flowOnline') : t('flowOffline') },
        }}
      />
    </View>
  );
});
