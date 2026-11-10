import { Stack, useRouter } from 'expo-router';
import { Share2, Trash2 } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import type { RecordingTimeline } from '../../host/contract';
import { useConfirm, useToast } from '../components/feedback';
import { ActionRow, Body, Button, Caption, Card, Divider, Empty, FactRow, Screen, SectionHeader } from '../components/primitives';
import { TimelineChart } from '../components/TimelineChart';
import { formatBytes, formatDateTime, formatDuration } from '../format';
import { useI18n } from '../i18n';
import { useRecordings, useStore } from '../store';
import { useTheme } from '../theme';
import { SyncBadge } from './recordingText';

export function RecordingScreen({ id }: { id: string }) {
  const theme = useTheme();
  const { t, locale } = useI18n();
  const router = useRouter();
  const store = useStore();
  const toast = useToast();
  const confirm = useConfirm();
  const recording = useRecordings().find((r) => r.id === id) ?? null;
  const [timeline, setTimeline] = useState<RecordingTimeline | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inProgress = recording?.inProgress ?? false;

  const load = useCallback(() => {
    let alive = true;
    setTimelineError(null);
    store
      .timeline(id)
      .then((value) => alive && setTimeline(value))
      .catch((error: unknown) => alive && setTimelineError(String((error as Error)?.message ?? error)));
    return () => {
      alive = false;
    };
  }, [store, id]);
  // Load once, and again when a recording in progress finishes.
  useEffect(load, [load, inProgress]);

  if (!recording) {
    return (
      <Screen topInset={false}>
        <Stack.Screen options={{ title: t('recordingTitle') }} />
        <Card>
          <Empty>{t('recordingGone')}</Empty>
        </Card>
      </Screen>
    );
  }

  const share = async () => {
    setExporting(true);
    try {
      await store.exportRecording(id);
    } catch (error) {
      toast.show(t('exportFailed', { error: String((error as Error)?.message ?? error) }), 'danger');
    } finally {
      setExporting(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: t('confirmDeleteTitle'),
      message: t('confirmDeleteMessage', { device: recording.deviceName, time: formatDateTime(recording.startedAtMs, locale) }),
      confirmLabel: t('deleteAction'),
      destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await store.deleteRecording(id);
      toast.show(t('recordingDeleted'));
      if (router.canGoBack()) router.back();
    } catch (error) {
      toast.show(t('actionFailed', { error: String((error as Error)?.message ?? error) }), 'danger');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Screen topInset={false}>
      <Stack.Screen options={{ title: recording.deviceName }} />

      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <Body style={{ fontWeight: '600', flexShrink: 1 }}>{t('timelineTitle')}</Body>
          {inProgress ? null : <SyncBadge state={recording.syncState} />}
        </View>
        <Caption>{t('timelineCopy')}</Caption>
        {timeline ? (
          <TimelineChart timeline={timeline} />
        ) : timelineError ? (
          <View style={{ gap: 8, alignItems: 'flex-start' }}>
            <Caption style={{ color: theme.colors.danger }}>{t('timelineFailed', { error: timelineError })}</Caption>
            <Button label={t('retry')} compact onPress={load} />
          </View>
        ) : (
          <View style={{ height: 160, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <ActivityIndicator color={theme.colors.accent} />
            <Caption>{t('timelineLoading')}</Caption>
          </View>
        )}
      </Card>

      <Card padded={false}>
        <FactRow label={t('infoStarted')} value={formatDateTime(recording.startedAtMs, locale)} />
        <Divider />
        <FactRow label={t('infoDuration')} value={formatDuration(recording.durationMs)} />
        <Divider />
        <FactRow label={t('infoSize')} value={formatBytes(recording.bytes)} />
        <Divider />
        <FactRow label={t('infoFrames')} value={recording.frames.toLocaleString(locale)} />
        {timeline ? (
          <>
            <Divider />
            <FactRow label={t('lostFrames')} value={String(timeline.lostFrames)} />
            <Divider />
            <FactRow label={t('gapsLabel')} value={String(timeline.gaps)} />
          </>
        ) : null}
      </Card>

      {timeline && timeline.events.length > 0 ? (
        <>
          <SectionHeader title={t('eventsLabel')} />
          <Card padded={false}>
            {timeline.events.map((event, i) => (
              <View key={`${event.atMs}-${i}`}>
                {i > 0 ? <Divider /> : null}
                <FactRow label={formatDuration(event.atMs)} value={event.label} mono />
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <Card padded={false}>
        <ActionRow label={t('exportRecording')} icon={Share2} busy={exporting} disabled={inProgress} onPress={share} />
        <Caption style={{ paddingHorizontal: 16, paddingBottom: 12 }}>{t('exportCopy')}</Caption>
        <Divider inset={0} />
        <ActionRow label={t('deleteRecording')} icon={Trash2} destructive busy={deleting} disabled={inProgress} onPress={remove} />
      </Card>
    </Screen>
  );
}
