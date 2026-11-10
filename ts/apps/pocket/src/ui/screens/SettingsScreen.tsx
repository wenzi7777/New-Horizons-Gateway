import Constants from 'expo-constants';
import { BatteryWarning, Check, Info, ShieldCheck, TriangleAlert, Wifi } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Locale, ThemeMode } from '@nhgw/ui-tokens';

import type { PocketSettings, ServerTarget, SyncPolicy } from '../../host/contract';
import { useToast } from '../components/feedback';
import { PocketMark } from '../components/PocketMark';
import {
  Body,
  Button,
  Caption,
  Card,
  Collapsible,
  Divider,
  FactRow,
  Mono,
  Notice,
  Screen,
  SectionHeader,
  SegmentedControl,
  StatusDot,
  SwitchRow,
  TextField,
  type Tone,
} from '../components/primitives';
import { formatBytes, formatTime, isValidPocketId, isValidServerUrl } from '../format';
import { useI18n } from '../i18n';
import { useSettings, useStatus, useStore } from '../store';
import { useTheme } from '../theme';

/** Language names are shown in their own language, as on the Desktop. */
const LANGUAGES: readonly { value: Locale | 'system'; label: string | null }[] = [
  { value: 'system', label: null },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'zh-CN', label: '简体中文' },
];

function useSave() {
  const store = useStore();
  const toast = useToast();
  const { t } = useI18n();
  return async (patch: Partial<PocketSettings>, announce = false) => {
    try {
      await store.updateSettings(patch);
      if (announce) toast.show(t('settingsSaved'));
    } catch (error) {
      toast.show(t('actionFailed', { error: String((error as Error)?.message ?? error) }), 'danger');
    }
  };
}

/** A text setting edited as a draft and saved on submit/blur when valid. */
function DraftField({
  label,
  hint,
  value,
  validate,
  onSave,
  autoCapitalize = 'none',
}: {
  label: string;
  hint?: string;
  value: string;
  validate?: (draft: string) => string | null;
  onSave: (draft: string) => void;
  autoCapitalize?: 'none' | 'sentences';
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const error = draft !== value ? validate?.(draft) ?? null : null;
  const commit = () => {
    setEditing(false);
    if (draft === value) return;
    if (error) {
      setDraft(value);
      return;
    }
    onSave(draft.trim());
  };
  return (
    <TextField
      label={label}
      hint={hint}
      error={error ?? undefined}
      value={draft}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      onFocus={() => setEditing(true)}
      onChangeText={setDraft}
      onBlur={commit}
      onSubmitEditing={commit}
      returnKeyType="done"
    />
  );
}

function ConnectionCard() {
  const theme = useTheme();
  const { t } = useI18n();
  const settings = useSettings();
  const status = useStatus();
  const save = useSave();
  const [manualDraft, setManualDraft] = useState(settings.manualUrl);
  useEffect(() => setManualDraft(settings.manualUrl), [settings.manualUrl]);
  const manualError = manualDraft && !isValidServerUrl(manualDraft) ? t('err_invalid_manual_url') : null;

  const tone: Tone = !settings.relayEnabled ? 'muted' : status.upstream === 'online' ? 'success' : status.upstream === 'connecting' ? 'warning' : 'danger';
  const label = !settings.relayEnabled
    ? t('statusDisabled')
    : status.upstream === 'online'
      ? t('statusOnline')
      : status.upstream === 'connecting'
        ? t('connConnecting')
        : t('statusOffline');

  return (
    <Card padded={false}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 16 }}>
        <StatusDot tone={tone} pulse={status.upstream === 'connecting'} />
        <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600' }}>{label}</Text>
      </View>
      <Caption style={{ paddingHorizontal: 16, paddingTop: 4 }} numberOfLines={2}>
        {`${t('effectiveServer')}: ${status.serverUrl || '-'}`}
      </Caption>
      <SwitchRow title={t('relayTitle')} subtitle={t('relayCopy')} value={settings.relayEnabled} onValueChange={(v) => save({ relayEnabled: v })} />
      <Divider />
      <View style={{ padding: 16, gap: 10 }}>
        <Caption>{t('targetLabel')}</Caption>
        <SegmentedControl<ServerTarget>
          accessibilityLabel={t('targetLabel')}
          options={[
            { value: 'production', label: t('targetProduction') },
            { value: 'local', label: t('targetLocal') },
            { value: 'manual', label: t('targetManual') },
          ]}
          value={settings.serverTarget}
          onChange={(v) => save({ serverTarget: v })}
        />
        {settings.serverTarget === 'manual' ? (
          <>
            <TextField
              label={t('manualUrlLabel')}
              value={manualDraft}
              onChangeText={setManualDraft}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="wss://"
              error={manualError ?? undefined}
            />
            {manualDraft !== settings.manualUrl ? (
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                <Button
                  label={t('manualUrlSave')}
                  variant="primary"
                  compact
                  disabled={!!manualError || !manualDraft}
                  onPress={() => save({ manualUrl: manualDraft.trim() }, true)}
                />
              </View>
            ) : null}
          </>
        ) : null}
      </View>
    </Card>
  );
}

function NetworkSection() {
  const theme = useTheme();
  const { t } = useI18n();
  const status = useStatus();
  return (
    <>
      <SectionHeader title={t('sectionNetwork')} />
      {status.isolationSuspected ? (
        <Notice tone="warning" icon={TriangleAlert} title={t('isolationTitle')}>
          {t('isolationMessage')}
        </Notice>
      ) : null}
      <Card>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
          <Wifi size={20} color={theme.colors.accent} style={{ marginTop: 1 }} />
          <View style={{ flex: 1, gap: 6 }}>
            {status.addresses.length > 0 ? (
              <>
                <Body dim>{t('networkHint')}</Body>
                {status.addresses.map((a) => (
                  <View key={`${a.name}-${a.address}`} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <Mono style={{ fontSize: 18, fontWeight: '600' }}>{a.address}</Mono>
                    <Caption>{a.name}</Caption>
                  </View>
                ))}
              </>
            ) : (
              <Body dim>{t('noAddress')}</Body>
            )}
          </View>
        </View>
      </Card>
    </>
  );
}

function BackgroundCard() {
  const theme = useTheme();
  const { t } = useI18n();
  const status = useStatus();
  const store = useStore();
  const ignored = status.batteryOptimizationIgnored;
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <StatusDot tone={status.serviceRunning ? 'success' : 'muted'} />
        <Body style={{ fontWeight: '600' }}>{status.serviceRunning ? t('serviceRunning') : t('serviceStopped')}</Body>
      </View>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        {ignored ? (
          <ShieldCheck size={20} color={theme.colors.success} />
        ) : (
          <BatteryWarning size={20} color={ignored === false ? theme.colors.warning : theme.colors.textMuted} />
        )}
        <Body dim style={{ flex: 1 }}>
          {ignored === true ? t('batteryOptIgnored') : ignored === false ? t('batteryOptActive') : t('batteryOptUnknown')}
        </Body>
      </View>
      {ignored !== true ? (
        <Button label={t('batteryOptButton')} variant="primary" onPress={() => store.requestIgnoreBatteryOptimizations()} />
      ) : null}
    </Card>
  );
}

function AppearanceCard() {
  const theme = useTheme();
  const { t, locale } = useI18n();
  const settings = useSettings();
  const save = useSave();
  const next =
    theme.nextChange && settings.theme === 'auto'
      ? t(theme.theme === 'light' ? 'themeNextDark' : 'themeNextLight', { time: formatTime(theme.nextChange.getTime(), locale) })
      : null;
  return (
    <Card>
      <SegmentedControl<ThemeMode>
        accessibilityLabel={t('themeLabel')}
        options={[
          { value: 'auto', label: t('themeAuto') },
          { value: 'light', label: t('themeLight') },
          { value: 'dark', label: t('themeDark') },
        ]}
        value={settings.theme}
        onChange={(v) => save({ theme: v })}
      />
      {next ? <Caption>{next}</Caption> : null}
    </Card>
  );
}

function LanguageCard() {
  const theme = useTheme();
  const { t } = useI18n();
  const settings = useSettings();
  const save = useSave();
  return (
    <Card padded={false}>
      {LANGUAGES.map((lang, i) => {
        const selected = settings.locale === lang.value;
        const label = lang.label ?? t('languageSystem');
        return (
          <View key={lang.value}>
            {i > 0 ? <Divider /> : null}
            <Pressable
              onPress={() => save({ locale: lang.value })}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={label}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                minHeight: 48,
                paddingHorizontal: 16,
                backgroundColor: pressed ? theme.colors.panelSoft : 'transparent',
              })}
            >
              <Text style={{ flex: 1, color: theme.colors.text, fontSize: 16 }}>{label}</Text>
              {selected ? <Check size={20} color={theme.colors.accent} /> : null}
            </Pressable>
          </View>
        );
      })}
    </Card>
  );
}

export function SettingsScreen() {
  const theme = useTheme();
  const { t } = useI18n();
  const settings = useSettings();
  const status = useStatus();
  const save = useSave();
  const version = Constants.expoConfig?.version ?? '-';

  return (
    <Screen title={t('tabSettings')}>
      <SectionHeader title={t('sectionConnection')} />
      <ConnectionCard />

      <NetworkSection />

      <SectionHeader title={t('sectionPocket')} />
      <Card>
        <DraftField
          label={t('pocketIdLabel')}
          hint={t('gatewayIdHint')}
          value={settings.pocketId}
          validate={(d) => (isValidPocketId(d.trim()) ? null : t('err_gateway_id_invalid'))}
          onSave={(v) => save({ pocketId: v }, true)}
        />
        <DraftField
          label={t('pocketNameLabel')}
          hint={t('pocketNameHint')}
          value={settings.displayName}
          autoCapitalize="sentences"
          onSave={(v) => save({ displayName: v }, true)}
        />
      </Card>

      <SectionHeader title={t('sectionDevicePolicy')} />
      <Card>
        <SegmentedControl<PocketSettings['offerPolicy']>
          accessibilityLabel={t('sectionDevicePolicy')}
          options={[
            { value: 'managed', label: t('policyManaged') },
            { value: 'all', label: t('policyAll') },
          ]}
          value={settings.offerPolicy}
          onChange={(v) => save({ offerPolicy: v })}
        />
        <Caption>{settings.offerPolicy === 'managed' ? t('policyManagedCopy') : t('policyAllCopy')}</Caption>
      </Card>

      <SectionHeader title={t('sectionSync')} />
      <Card>
        <SegmentedControl<SyncPolicy>
          accessibilityLabel={t('sectionSync')}
          options={[
            { value: 'manual', label: t('syncManual') },
            { value: 'auto', label: t('syncAuto') },
            { value: 'wifi_only', label: t('syncWifiOnly') },
          ]}
          value={settings.syncPolicy}
          onChange={(v) => save({ syncPolicy: v })}
        />
        {settings.syncPolicy !== 'manual' ? (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
            <Info size={16} color={theme.colors.textDim} style={{ marginTop: 2 }} />
            <Caption style={{ flex: 1 }}>{t('syncComingSoon')}</Caption>
          </View>
        ) : null}
      </Card>

      <SectionHeader title={t('sectionBackground')} />
      <BackgroundCard />

      <SectionHeader title={t('themeLabel')} />
      <AppearanceCard />

      <SectionHeader title={t('language')} />
      <LanguageCard />

      <Collapsible title={t('techDetails')}>
        <FactRow label={t('pocketIdLabel')} value={settings.pocketId} mono />
        <Divider />
        <FactRow label={t('serverUrlLabel')} value={status.serverUrl || '-'} mono />
        <Divider />
        <FactRow label={t('findmeCount')} value={String(status.findmeRequests)} />
        <Divider />
        <FactRow label={t('storageFree')} value={formatBytes(status.storage.freeBytes)} />
      </Collapsible>

      <SectionHeader title={t('sectionAbout')} />
      <Card style={{ alignItems: 'center', paddingVertical: 24 }}>
        <PocketMark size={72} />
        <Text style={{ color: theme.colors.text, fontSize: 18, fontWeight: '600', textAlign: 'center' }}>{t('appFullName')}</Text>
        <Caption>{t('versionValue', { version })}</Caption>
        <Caption style={{ textAlign: 'center' }}>{t('aboutCopy')}</Caption>
      </Card>
    </Screen>
  );
}
