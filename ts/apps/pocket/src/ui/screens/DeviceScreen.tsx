import { Stack, useRouter } from 'expo-router';
import {
  Activity,
  CircleDot,
  Crosshair,
  Eraser,
  Power,
  RefreshCw,
  Square,
  Trash2,
  WifiOff,
  Wrench,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import type { QuickCommand } from '../../host/contract';
import { errorText } from '../../i18n/strings';
import { useConfirm, useToast, type ConfirmOptions } from '../components/feedback';
import {
  ActionRow,
  Badge,
  Body,
  Button,
  Caption,
  Card,
  Collapsible,
  Divider,
  Empty,
  FactRow,
  ListRow,
  Notice,
  Screen,
  SectionHeader,
  SegmentedControl,
  StatusDot,
  TextField,
} from '../components/primitives';
import { batteryLabel, modeLabel } from '../deviceText';
import { formatDateTime, formatDuration } from '../format';
import { useI18n } from '../i18n';
import { useDevice, useNow, usePocketSync, useRecordings, useStore } from '../store';
import { syncErrorCode } from '../../host/sync';
import { useTheme } from '../theme';

type CommandKey = QuickCommand['kind'] | 'release' | 'recording';

/** The elapsed time of a device's recording in progress (null when none). */
export function useRecordingElapsed(uid: string | undefined): number | null {
  const recordings = useRecordings();
  const now = useNow(1000);
  const active = recordings.find((r) => r.uid === uid && r.inProgress);
  return active ? Math.max(0, now - active.startedAtMs) : null;
}

/** Start/stop a device's recording with toasts; shared by the device and live screens. */
export function useRecordingToggle(uid: string | undefined) {
  const store = useStore();
  const toast = useToast();
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const toggle = async (on: boolean) => {
    if (!uid) return;
    setBusy(true);
    try {
      const outcome = await store.setRecording(uid, on);
      if (outcome.ok) toast.show(on ? t('recordingStarted') : t('recordingStopped'));
      else toast.show(t('recordingError', { error: errorText(locale, outcome.message) }), 'danger');
    } catch (error) {
      toast.show(t('recordingError', { error: String((error as Error)?.message ?? error) }), 'danger');
    } finally {
      setBusy(false);
    }
  };
  return { busy, toggle };
}

export function DeviceScreen({ uid }: { uid: string }) {
  const theme = useTheme();
  const { t, locale } = useI18n();
  const router = useRouter();
  const { sync, status: syncStatus } = usePocketSync();
  const labelsEditable = syncStatus.editable;
  const store = useStore();
  const toast = useToast();
  const confirm = useConfirm();
  const device = useDevice(uid);
  const elapsed = useRecordingElapsed(uid);
  const recording = useRecordingToggle(uid);
  const [busy, setBusy] = useState<CommandKey | null>(null);
  const [nickname, setNickname] = useState(device?.nickname ?? '');
  const [nicknameDirty, setNicknameDirty] = useState(false);
  const [scanRate, setScanRate] = useState<60 | 90>(device && device.fps > 75 ? 90 : 60);

  useEffect(() => {
    if (!nicknameDirty) setNickname(device?.nickname ?? '');
  }, [device?.nickname, nicknameDirty]);

  if (!device) {
    return (
      <Screen topInset={false}>
        <Stack.Screen options={{ title: t('deviceTitle') }} />
        <Card>
          <Empty>{t('deviceGone')}</Empty>
        </Card>
      </Screen>
    );
  }

  const name = device.displayName;
  const offline = !device.online;
  const maintenance = device.mode === 'maintenance';

  const run = async (key: CommandKey, command: QuickCommand, ask?: ConfirmOptions, done?: string) => {
    if (ask && !(await confirm(ask))) return;
    setBusy(key);
    try {
      const outcome = await store.run(uid, command);
      if (outcome.ok) toast.show(done ?? t('actionDone'));
      else toast.show(t('actionFailed', { error: errorText(locale, outcome.message) }), 'danger');
      return outcome.ok;
    } catch (error) {
      toast.show(t('actionFailed', { error: String((error as Error)?.message ?? error) }), 'danger');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const changeScanRate = async (fps: 60 | 90) => {
    const ok = await run('scan_rate', { kind: 'scan_rate', fps }, { title: t('confirmScanRateTitle', { fps }), message: t('confirmScanRateMessage') });
    if (ok) setScanRate(fps);
  };

  // Nicknames live on the server: edited there, then mirrored here.
  const saveNickname = async () => {
    try {
      await sync.setLabel(uid, { nickname: nickname.trim() });
    } catch (error) {
      toast.show(syncErrorCode(error) === 'server_unavailable' ? t('labelsNeedServer') : t('actionFailed', { error: syncErrorCode(error) }), 'danger');
      return;
    }
    setNicknameDirty(false);
    toast.show(t('nicknameSaved'));
  };

  const remove = async () => {
    const ok = await confirm({
      title: t('confirmRemoveTitle', { device: name }),
      message: t('confirmRemoveMessage'),
      confirmLabel: t('remove'),
      destructive: true,
    });
    if (!ok) return;
    setBusy('release');
    try {
      const outcome = await store.release(uid);
      if (outcome.ok) {
        toast.show(t('deviceRemoved', { device: name }));
        if (router.canGoBack()) router.back();
      } else {
        toast.show(t('actionFailed', { error: errorText(locale, outcome.message) }), 'danger');
      }
    } finally {
      setBusy(null);
    }
  };

  const battery = batteryLabel(t, device);
  const recState = device.recording;

  return (
    <Screen topInset={false}>
      <Stack.Screen options={{ title: name }} />

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <StatusDot tone={offline ? 'muted' : 'success'} />
          <Body style={{ fontWeight: '600' }}>{offline ? t('deviceOffline') : t('deviceOnline')}</Body>
          {device.online && device.fps > 0 ? <Caption>{t('fpsValue', { fps: device.fps })}</Caption> : null}
          {maintenance ? <Badge label={t('modeMaintenance')} tone="warning" icon={Wrench} /> : null}
          {recState.enabled ? <Badge label={t('recBadge')} tone="danger" solid /> : null}
        </View>
        {offline && device.lastSeenMs ? <Caption>{t('lastSeen', { time: formatDateTime(device.lastSeenMs, locale) })}</Caption> : null}
      </Card>

      {offline ? (
        <Notice tone="warning" icon={WifiOff}>
          {t('deviceOfflineNotice')}
        </Notice>
      ) : null}

      <Card padded={false}>
        <ListRow
          title={t('openLive')}
          subtitle={device.matrix ? `${t('openLiveCopy')} · ${t('matrixValue', { rows: device.matrix.rows, cols: device.matrix.cols })}` : t('liveNoMatrix')}
          leading={<Activity size={22} color={theme.colors.accent} />}
          disabled={!device.matrix}
          onPress={() => router.push({ pathname: '/live/[uid]', params: { uid } })}
        />
      </Card>

      <SectionHeader title={t('recordingSection')} />
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <StatusDot tone={recState.enabled ? 'danger' : 'muted'} pulse={recState.enabled && !recState.finishing} />
          <View style={{ flex: 1 }}>
            <Body style={{ fontWeight: '600' }}>
              {recState.finishing ? t('recordingFinishing') : recState.enabled ? t('recordingActive') : t('recordingIdle')}
            </Body>
            {elapsed !== null ? <Caption style={{ fontVariant: ['tabular-nums'] }}>{formatDuration(elapsed)}</Caption> : null}
          </View>
          {recState.enabled ? (
            <Button
              label={t('stopRecording')}
              icon={Square}
              variant="destructive"
              busy={recording.busy || recState.finishing}
              onPress={() => recording.toggle(false)}
            />
          ) : (
            <Button
              label={t('startRecording')}
              icon={CircleDot}
              variant="primary"
              busy={recording.busy}
              disabled={offline}
              onPress={() => recording.toggle(true)}
            />
          )}
        </View>
        {recState.error ? <Caption style={{ color: theme.colors.danger }}>{t('recordingError', { error: recState.error })}</Caption> : null}
      </Card>

      <SectionHeader title={t('quickActions')} />
      <Card padded={false}>
        <ActionRow
          label={t('actionStatus')}
          icon={RefreshCw}
          busy={busy === 'status'}
          disabled={offline}
          onPress={() => run('status', { kind: 'status' }, undefined, t('statusRefreshed'))}
        />
        <Divider inset={48} />
        <ActionRow
          label={t('actionTare')}
          icon={Crosshair}
          busy={busy === 'tare'}
          disabled={offline}
          onPress={() =>
            run('tare', { kind: 'tare' }, { title: t('confirmTareTitle', { device: name }), message: t('confirmTareMessage') })
          }
        />
        <Divider inset={48} />
        <ActionRow
          label={t('actionTareClear')}
          icon={Eraser}
          busy={busy === 'tare_clear'}
          disabled={offline}
          onPress={() => run('tare_clear', { kind: 'tare_clear' }, { title: t('confirmTareClearTitle'), message: t('confirmTareClearMessage') })}
        />
        <Divider inset={48} />
        <ActionRow
          label={maintenance ? t('actionMaintenanceOff') : t('actionMaintenanceOn')}
          icon={Wrench}
          busy={busy === 'enter_maintenance' || busy === 'exit_maintenance'}
          disabled={offline}
          onPress={() =>
            maintenance
              ? run('exit_maintenance', { kind: 'exit_maintenance' })
              : run(
                  'enter_maintenance',
                  { kind: 'enter_maintenance' },
                  { title: t('confirmMaintenanceTitle'), message: t('confirmMaintenanceMessage', { device: name }) },
                )
          }
        />
        <Divider inset={48} />
        <ActionRow
          label={t('actionReboot')}
          icon={Power}
          busy={busy === 'reboot'}
          disabled={offline}
          onPress={() =>
            run(
              'reboot',
              { kind: 'reboot' },
              { title: t('confirmRebootTitle', { device: name }), message: t('confirmRebootMessage'), confirmLabel: t('actionReboot'), destructive: true },
            )
          }
        />
        <Divider inset={0} />
        <View style={{ padding: 16, gap: 8 }}>
          <Caption>{t('actionScanRate')}</Caption>
          <SegmentedControl
            accessibilityLabel={t('actionScanRate')}
            options={[
              { value: 60 as const, label: '60 fps' },
              { value: 90 as const, label: '90 fps' },
            ]}
            value={scanRate}
            disabled={offline || busy === 'scan_rate'}
            onChange={changeScanRate}
          />
        </View>
      </Card>

      <SectionHeader title={t('nicknameLabel')} />
      <Card>
        <TextField
          label={t('nicknameLabel')}
          hint={labelsEditable ? t('nicknameHint') : t('labelsNeedServer')}
          editable={labelsEditable}
          value={nickname}
          placeholder={device.displayName}
          onChangeText={(text) => {
            setNickname(text);
            setNicknameDirty(true);
          }}
          onSubmitEditing={saveNickname}
          returnKeyType="done"
          maxLength={48}
        />
        {nicknameDirty ? (
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            <Button label={t('save')} variant="primary" compact onPress={saveNickname} />
          </View>
        ) : null}
      </Card>

      <Card padded={false}>
        <FactRow label={t('infoModel')} value={device.hardwareModel || '-'} />
        <Divider />
        <FactRow label={t('infoFirmware')} value={device.firmwareVersion || '-'} />
        <Divider />
        <FactRow label={t('infoMode')} value={modeLabel(t, device.mode)} />
        <Divider />
        <FactRow label={t('infoBattery')} value={battery ?? '-'} />
        <Divider />
        <FactRow label={t('infoMatrix')} value={device.matrix ? t('matrixValue', { rows: device.matrix.rows, cols: device.matrix.cols }) : '-'} />
      </Card>

      <Collapsible title={t('techDetails')}>
        <FactRow label={t('infoUid')} value={device.uid} mono />
        <Divider />
        <FactRow label={t('infoGroup')} value={device.group || '-'} />
        <Divider />
        <FactRow label={t('liveFps')} value={String(device.fps)} />
      </Collapsible>

      <Card padded={false}>
        <ActionRow label={t('removeDevice')} icon={Trash2} destructive busy={busy === 'release'} onPress={remove} />
        <Caption style={{ paddingHorizontal: 16, paddingBottom: 14 }}>{t('removeDeviceCopy')}</Caption>
      </Card>
    </Screen>
  );
}
