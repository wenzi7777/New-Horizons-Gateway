// The first-run guide over the whole app: which server, sign in with a
// Desktop account, whether recordings upload on their own, and which devices
// this phone takes. Each answer is saved as it is made; any step can be
// skipped. Settings → About opens it again.
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PocketSettings, ServerTarget, SyncPolicy } from '../../host/contract';
import { syncErrorCode } from '../../host/sync';
import { setOnboardingDone } from '../../host/firstRun';
import { PocketMark } from '../components/PocketMark';
import { Body, Button, Caption, Card, Notice, SegmentedControl, TextField } from '../components/primitives';
import { isValidServerUrl } from '../format';
import { useI18n } from '../i18n';
import { usePocketSync, useSettings, useStore } from '../store';
import { useTheme } from '../theme';

const STEPS = ['server', 'account', 'sync', 'devices'] as const;

export function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const store = useStore();
  const settings = useSettings();
  const { sync, status } = usePocketSync();
  const [index, setIndex] = useState(0);
  const [manualUrl, setManualUrl] = useState(settings.manualUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);
  const step = STEPS[index]!;
  useEffect(() => setMessage(null), [index]);

  const save = (patch: Partial<PocketSettings>) => void store.updateSettings(patch).catch(() => undefined);
  const finish = async () => {
    await setOnboardingDone(true).catch(() => undefined);
    onDone();
  };
  const manualInvalid = settings.serverTarget === 'manual' && !isValidServerUrl(manualUrl);

  const signIn = async () => {
    setBusy(true);
    try {
      await sync.login(username, password);
      setMessage({ tone: 'success', text: t('onbSignedIn') });
    } catch (error) {
      const code = syncErrorCode(error);
      setMessage({ tone: 'danger', text: code === 'invalid_credentials' ? t('syncErrCredentials') : t('actionFailed', { error: code }) });
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24, gap: 16 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <PocketMark size={64} playKey={1} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.colors.text, fontSize: 22, fontWeight: '700' }}>{t('onbTitle')}</Text>
            <Caption>{t('onbStep', { n: index + 1, total: STEPS.length })}</Caption>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 6 }} accessibilityElementsHidden>
          {STEPS.map((s, i) => (
            <View key={s} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i <= index ? theme.colors.accent : theme.colors.lineStrong }} />
          ))}
        </View>

        {step === 'server' ? (
          <Card>
            <Body style={{ fontWeight: '600', fontSize: 17 }}>{t('onbServerTitle')}</Body>
            <Caption>{t('onbServerCopy')}</Caption>
            <SegmentedControl<ServerTarget>
              accessibilityLabel={t('onbServerTitle')}
              options={[
                { value: 'production', label: t('onbServerProduction') },
                { value: 'local', label: t('onbServerLocal') },
                { value: 'manual', label: t('onbServerManual') },
              ]}
              value={settings.serverTarget}
              onChange={(serverTarget) => save({ serverTarget })}
            />
            {settings.serverTarget === 'manual' ? (
              <TextField
                label={t('onbServerAddress')}
                value={manualUrl}
                onChangeText={setManualUrl}
                onEndEditing={() => isValidServerUrl(manualUrl) && save({ manualUrl })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="ws://192.168.1.10:5051/newhorizons/gateway/ws"
                error={manualUrl && manualInvalid ? t('onbServerAddressInvalid') : undefined}
              />
            ) : null}
          </Card>
        ) : null}

        {step === 'account' ? (
          <Card>
            <Body style={{ fontWeight: '600', fontSize: 17 }}>{t('onbAccountTitle')}</Body>
            <Caption>{t('onbAccountCopy')}</Caption>
            {status.configured ? (
              <Notice tone="success" title={t('onbSignedInAs', { account: status.account || '…' })} />
            ) : (
              <>
                <TextField label={t('syncUsername')} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" />
                <TextField label={t('syncPassword')} value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" />
                <Button label={busy ? t('onbSigningIn') : t('syncSignIn')} variant="primary" busy={busy} disabled={busy || !username.trim() || !password} onPress={() => void signIn()} />
              </>
            )}
            {message ? <Notice tone={message.tone} title={message.text} /> : null}
            <Caption>{t('onbAccountLater')}</Caption>
          </Card>
        ) : null}

        {step === 'sync' ? (
          <Card>
            <Body style={{ fontWeight: '600', fontSize: 17 }}>{t('onbSyncTitle')}</Body>
            <Caption>{t('onbSyncCopy')}</Caption>
            <SegmentedControl<SyncPolicy>
              accessibilityLabel={t('onbSyncTitle')}
              options={[
                { value: 'wifi_only', label: t('syncWifiOnly') },
                { value: 'auto', label: t('syncAuto') },
                { value: 'manual', label: t('syncManual') },
              ]}
              value={settings.syncPolicy}
              onChange={(syncPolicy) => save({ syncPolicy })}
            />
            <Caption>{t(settings.syncPolicy === 'manual' ? 'syncManualCopy' : settings.syncPolicy === 'auto' ? 'syncAutoCopy' : 'syncWifiCopy')}</Caption>
          </Card>
        ) : null}

        {step === 'devices' ? (
          <Card>
            <Body style={{ fontWeight: '600', fontSize: 17 }}>{t('onbDevicesTitle')}</Body>
            <Caption>{t('onbDevicesCopy')}</Caption>
            {(['managed', 'all'] as const).map((policy) => {
              const selected = settings.offerPolicy === policy;
              return (
                <Pressable
                  key={policy}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  onPress={() => save({ offerPolicy: policy })}
                  style={({ pressed }) => ({
                    gap: 4,
                    padding: 14,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: selected ? theme.colors.accent : theme.colors.line,
                    backgroundColor: selected ? theme.colors.accentSoft : theme.colors.panelSoft,
                    opacity: pressed ? 0.85 : 1,
                  })}
                >
                  <Text style={{ color: theme.colors.text, fontWeight: '600' }}>{t(policy === 'managed' ? 'onbDevicesManaged' : 'onbDevicesAll')}</Text>
                  <Caption>{t(policy === 'managed' ? 'onbDevicesManagedCopy' : 'onbDevicesAllCopy')}</Caption>
                </Pressable>
              );
            })}
          </Card>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Button label={t('onbSkipAll')} variant="plain" compact onPress={() => void finish()} />
          <View style={{ flex: 1 }} />
          {index > 0 ? <Button label={t('back')} compact onPress={() => setIndex(index - 1)} /> : null}
          <Button
            label={index === STEPS.length - 1 ? t('onbFinish') : step === 'account' && !status.configured ? t('onbSkipStep') : t('onbNext')}
            variant="primary"
            compact
            disabled={step === 'server' && manualInvalid}
            onPress={() => (index === STEPS.length - 1 ? void finish() : setIndex(index + 1))}
          />
        </View>
      </ScrollView>
    </View>
  );
}
