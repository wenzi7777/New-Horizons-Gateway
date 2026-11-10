import { Tabs } from 'expo-router/js-tabs';
import { Film, Settings, Smartphone } from 'lucide-react-native';
import { StyleSheet } from 'react-native';
import { nativeChromeColor } from '@nhgw/ui-tokens';

import { useI18n } from '../../ui/i18n';
import { useTheme } from '../../ui/theme';

export default function TabLayout() {
  const theme = useTheme();
  const { t } = useI18n();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textDim,
        tabBarStyle: {
          backgroundColor: nativeChromeColor(theme.colors),
          borderTopColor: theme.colors.line,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        sceneStyle: { backgroundColor: theme.colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: t('tabDevices'), tabBarIcon: ({ color, size }) => <Smartphone color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="recordings"
        options={{ title: t('tabRecordings'), tabBarIcon: ({ color, size }) => <Film color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: t('tabSettings'), tabBarIcon: ({ color, size }) => <Settings color={color} size={size} /> }}
      />
    </Tabs>
  );
}
