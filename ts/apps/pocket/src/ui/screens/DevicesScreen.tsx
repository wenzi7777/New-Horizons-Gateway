import { useRouter } from 'expo-router';
import {
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  Link2,
  Plus,
  RadioTower,
  Smartphone,
} from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';

import type { DeviceView, NearbyDeviceView } from '../../host/contract';
import { useToast } from '../components/feedback';
import { Badge, Button, Caption, Card, Divider, Empty, ListRow, Screen, SectionHeader, StatusDot } from '../components/primitives';
import { errorText } from '../../i18n/strings';
import { useI18n } from '../i18n';
import { useDevices, useNearby, useStore } from '../store';
import { useTheme } from '../theme';

function BatteryIcon({ device }: { device: DeviceView }) {
  const { colors } = useTheme();
  const b = device.battery;
  if (!b || b.percent === null) return null;
  const Icon = b.charging ? BatteryCharging : b.percent >= 70 ? BatteryFull : b.percent >= 25 ? BatteryMedium : BatteryLow;
  const color = b.charging ? colors.success : b.percent < 15 ? colors.danger : colors.textDim;
  return <Icon size={16} color={color} />;
}

function DeviceSubtitle({ device }: { device: DeviceView }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const parts: string[] = [device.online ? t('deviceOnline') : t('deviceOffline')];
  if (device.online && device.fps > 0) parts.push(t('fpsValue', { fps: device.fps }));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Caption>{parts.join(' · ')}</Caption>
      {device.battery?.percent != null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <BatteryIcon device={device} />
          <Text style={{ color: colors.textDim, fontSize: 13, fontVariant: ['tabular-nums'] }}>{device.battery.percent}%</Text>
        </View>
      ) : null}
    </View>
  );
}

function DeviceRow({ device }: { device: DeviceView }) {
  const router = useRouter();
  const { t } = useI18n();
  return (
    <ListRow
      title={device.displayName}
      subtitle={<DeviceSubtitle device={device} />}
      leading={<StatusDot tone={device.online ? 'success' : 'muted'} />}
      trailing={device.recording.enabled ? <Badge label={t('recBadge')} tone="danger" solid /> : undefined}
      onPress={() => router.push({ pathname: '/device/[uid]', params: { uid: device.uid } })}
    />
  );
}

function NearbyRow({ device }: { device: NearbyDeviceView }) {
  const { t, locale } = useI18n();
  const { colors } = useTheme();
  const store = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const attached = device.attachedTo !== '';

  const add = async () => {
    setBusy(true);
    try {
      const outcome = await store.adopt(device.uid);
      if (outcome.ok) toast.show(t('deviceAdded', { device: device.name }));
      else toast.show(t('actionFailed', { error: errorText(locale, outcome.message) }), 'danger');
    } catch (error) {
      toast.show(t('actionFailed', { error: String((error as Error)?.message ?? error) }), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 16, paddingVertical: 10 }}>
      {attached ? <Link2 size={18} color={colors.textMuted} /> : <RadioTower size={18} color={colors.accent} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.text, fontSize: 16, fontWeight: '500' }}>
          {device.name}
        </Text>
        <Caption numberOfLines={2}>
          {attached ? `${t('attachedTo', { name: device.attachedTo })} · ${t('attachedNote')}` : device.ip}
        </Caption>
      </View>
      {attached ? null : (
        <Button label={busy ? t('addingDevice') : t('addDevice')} icon={Plus} variant="primary" compact busy={busy} onPress={add} />
      )}
    </View>
  );
}

export function DevicesScreen() {
  const { t } = useI18n();
  const devices = useDevices();
  const nearby = useNearby();
  return (
    <Screen title={t('tabDevices')}>
      <SectionHeader title={t('myDevices')} />
      <Card padded={false}>
        {devices.length === 0 ? (
          <Empty icon={Smartphone}>{t('noDevices')}</Empty>
        ) : (
          devices.map((device, i) => (
            <View key={device.uid}>
              {i > 0 ? <Divider inset={38} /> : null}
              <DeviceRow device={device} />
            </View>
          ))
        )}
      </Card>

      <SectionHeader title={t('nearbyTitle')} caption={t('nearbyHint')} />
      <Card padded={false}>
        {nearby.length === 0 ? (
          <Empty icon={RadioTower}>{t('noNearbyPocket')}</Empty>
        ) : (
          nearby.map((device, i) => (
            <View key={device.uid}>
              {i > 0 ? <Divider inset={46} /> : null}
              <NearbyRow device={device} />
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}
