// Shown while NH Pocket is open and a newer release exists. The update used to be
// visible only in Settings, and the relay keeps the app alive for days.
import { Download } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

import { useI18n } from '../i18n';
import { usePocketUpdater } from '../store';
import { cardStyle, useTheme } from '../theme';
import { Body, Button, Caption, MAX_CONTENT_WIDTH } from './primitives';

export function UpdatePrompt() {
  const theme = useTheme();
  const { t } = useI18n();
  const { updater, state } = usePocketUpdater();
  const [later, setLater] = useState('');
  const working = state.phase === 'downloading' || state.phase === 'installing';
  const offer = state.phase === 'available' || state.phase === 'needsPermission' || (state.phase === 'error' && !!state.latestVersion);
  const visible = working || (offer && later !== state.latestVersion);
  const percent = state.totalBytes ? Math.floor((state.receivedBytes / state.totalBytes) * 100) : 0;
  return (
    <Modal visible={visible} transparent animationType={theme.reduceMotion ? 'none' : 'fade'} onRequestClose={() => {
        if (!working) setLater(state.latestVersion);
      }} statusBarTranslucent navigationBarTranslucent>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.colors.bg, opacity: 0.78 }} />
        <Pressable
          accessibilityRole="none"
          style={[cardStyle(theme), { backgroundColor: theme.colors.panelSolid, boxShadow: theme.shadow.md, width: '100%', maxWidth: Math.min(MAX_CONTENT_WIDTH, 440), padding: 20, gap: 12 }]}
        >
          <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 18, fontWeight: '600' }}>
            {t('updatePromptTitle')}
          </Text>
          <Body dim>{t('updatePromptCopy', { latest: state.latestVersion, current: state.currentVersion })}</Body>
          {state.phase === 'downloading' ? <Caption>{t('updateDownloading', { percent })}</Caption> : null}
          {state.phase === 'needsPermission' ? <Caption>{t('updateNeedsPermission')}</Caption> : null}
          {state.phase === 'installing' ? <Caption>{t('updateInstalling')}</Caption> : null}
          {state.phase === 'error' ? <Caption>{t('updateErrOther', { error: state.error })}</Caption> : null}
          {state.phase === 'downloading' ? (
            <View style={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(127,127,127,0.25)', overflow: 'hidden' }}>
              <View style={{ height: 4, width: `${percent}%`, backgroundColor: theme.colors.accent }} />
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
            {state.phase === 'needsPermission' ? (
              <>
                <Button label={t('updateAllow')} variant="secondary" onPress={() => updater.openInstallSettings()} />
                <Button label={t('updateContinue')} variant="primary" onPress={() => void updater.install()} />
              </>
            ) : (
              <>
                <Button label={t('updateLater')} variant="secondary" disabled={working} onPress={() => setLater(state.latestVersion)} />
                <Button label={t('updateInstall', { version: state.latestVersion })} icon={Download} variant="primary" disabled={working} onPress={() => void updater.install()} />
              </>
            )}
          </View>
        </Pressable>
      </View>
    </Modal>
  );
}
