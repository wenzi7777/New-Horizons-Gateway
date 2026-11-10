import { Stack } from 'expo-router';
import { nativeChromeColor } from '@nhgw/ui-tokens';

import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { onboardingDone, subscribeOnboarding } from '../host/firstRun';
import { AppProviders } from '../ui/AppProviders';
import { OnboardingScreen } from '../ui/screens/OnboardingScreen';
import { useI18n } from '../ui/i18n';
import { useTheme } from '../ui/theme';

export const unstable_settings = {
  anchor: '(tabs)',
};

function RootStack() {
  const theme = useTheme();
  const { t } = useI18n();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: nativeChromeColor(theme.colors) },
        headerTintColor: theme.colors.accent,
        headerTitleStyle: { color: theme.colors.text },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.colors.bg },
        animation: theme.reduceMotion ? 'none' : 'default',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false, title: t('appShortName') }} />
      <Stack.Screen name="device/[uid]" options={{ title: t('deviceTitle') }} />
      <Stack.Screen name="live/[uid]" options={{ title: t('liveTitle') }} />
      <Stack.Screen name="recording/[...id]" options={{ title: t('recordingTitle') }} />
    </Stack>
  );
}

/** The app, with the first-run guide over it until finished or skipped. */
function Root() {
  const [guide, setGuide] = useState(false);
  useEffect(() => {
    void onboardingDone().then((done) => setGuide(!done));
    return subscribeOnboarding((done) => setGuide(!done));
  }, []);
  return (
    <View style={{ flex: 1 }}>
      <RootStack />
      {guide ? <OnboardingScreen onDone={() => setGuide(false)} /> : null}
    </View>
  );
}

export default function RootLayout() {
  return (
    <AppProviders>
      <Root />
    </AppProviders>
  );
}
