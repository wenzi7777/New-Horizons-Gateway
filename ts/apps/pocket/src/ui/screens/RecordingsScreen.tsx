import { useRouter } from 'expo-router';
import { HardDrive, Video } from 'lucide-react-native';
import { useMemo } from 'react';
import { Text, View } from 'react-native';

import type { RecordingSummary } from '../../host/contract';
import { Badge, Caption, Card, Divider, Empty, ListRow, Screen, SectionHeader, StatusDot } from '../components/primitives';
import { formatBytes, formatDate, formatDuration, formatTime, groupByDay, relativeDay } from '../format';
import { useI18n } from '../i18n';
import { useNow, useRecordings, useStatus } from '../store';
import { useTheme } from '../theme';
import { SyncBadge } from './recordingText';

function StorageCard() {
  const theme = useTheme();
  const { t } = useI18n();
  const { storage } = useStatus();
  const total = storage.recordingsBytes + storage.freeBytes;
  const ratio = total > 0 ? storage.recordingsBytes / total : 0;
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <HardDrive size={20} color={theme.colors.accent} />
        <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600' }}>{t('storageUsage')}</Text>
      </View>
      <View style={{ height: 8, borderRadius: theme.radius.pill, backgroundColor: theme.colors.panelSoft, overflow: 'hidden' }}>
        <View style={{ width: `${Math.max(1, Math.min(100, ratio * 100))}%`, height: 8, backgroundColor: theme.colors.accent }} />
      </View>
      <Caption>{t('storageUsed', { used: formatBytes(storage.recordingsBytes), free: formatBytes(storage.freeBytes) })}</Caption>
    </Card>
  );
}

function RecordingRow({ recording }: { recording: RecordingSummary }) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const subtitle = [formatTime(recording.startedAtMs, locale), formatDuration(recording.durationMs), formatBytes(recording.bytes)].join(' · ');
  return (
    <ListRow
      title={recording.deviceName}
      subtitle={
        <View style={{ gap: 6 }}>
          <Caption style={{ fontVariant: ['tabular-nums'] }}>{subtitle}</Caption>
          <View style={{ flexDirection: 'row' }}>
            {recording.inProgress ? <Badge label={t('inProgress')} tone="danger" /> : <SyncBadge state={recording.syncState} />}
          </View>
        </View>
      }
      leading={recording.inProgress ? <StatusDot tone="danger" pulse /> : undefined}
      onPress={() => router.push({ pathname: '/recording/[...id]', params: { id: recording.id.split('/') } })}
    />
  );
}

export function RecordingsScreen() {
  const { t, locale } = useI18n();
  const recordings = useRecordings();
  const now = useNow(60_000);
  const groups = useMemo(() => groupByDay(recordings, (r) => r.startedAtMs), [recordings]);
  return (
    <Screen title={t('tabRecordings')}>
      <StorageCard />
      {groups.length === 0 ? (
        <Card>
          <Empty icon={Video}>{t('noRecordings')}</Empty>
        </Card>
      ) : (
        groups.map((group) => {
          const rel = relativeDay(group.startMs, now);
          const title = rel === 'today' ? t('today') : rel === 'yesterday' ? t('yesterday') : formatDate(group.startMs, locale);
          return (
            <View key={group.key} style={{ gap: 8 }}>
              <SectionHeader title={title} />
              <Card padded={false}>
                {group.items.map((recording, i) => (
                  <View key={recording.id}>
                    {i > 0 ? <Divider /> : null}
                    <RecordingRow recording={recording} />
                  </View>
                ))}
              </Card>
            </View>
          );
        })
      )}
    </Screen>
  );
}
