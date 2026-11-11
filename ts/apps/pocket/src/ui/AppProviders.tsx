// Everything the screens rely on, outermost first: the store, theme,
// language, safe areas, navigation theme, toasts and confirm dialogs.

import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider, type Theme as NavigationTheme } from 'expo-router';
import { useEffect, useMemo, type ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { nativeChromeColor } from '@nhgw/ui-tokens';

import { getPocketUpdater } from '../host/updates';
import { FeedbackProvider } from './components/feedback';
import { UpdatePrompt } from './components/UpdatePrompt';
import { I18nProvider } from './i18n';
import { StoreProvider } from './store';
import { ThemeProvider, useTheme } from './theme';

function NavigationTheming({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const navTheme = useMemo<NavigationTheme>(() => {
    const base = theme.theme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: theme.theme === 'dark',
      colors: {
        ...base.colors,
        primary: theme.colors.accent,
        background: theme.colors.bg,
        card: nativeChromeColor(theme.colors),
        text: theme.colors.text,
        border: theme.colors.line,
        notification: theme.colors.danger,
      },
    };
  }, [theme.theme, theme.colors]);
  return <NavigationThemeProvider value={navTheme}>{children}</NavigationThemeProvider>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  // Looks for an update once per start (Settings shows the result).
  useEffect(() => void getPocketUpdater(), []);
  return (
    <StoreProvider>
      <ThemeProvider>
        <I18nProvider>
          <SafeAreaProvider>
            <NavigationTheming>
              <FeedbackProvider>
                {children}
                <UpdatePrompt />
              </FeedbackProvider>
            </NavigationTheming>
          </SafeAreaProvider>
        </I18nProvider>
      </ThemeProvider>
    </StoreProvider>
  );
}
