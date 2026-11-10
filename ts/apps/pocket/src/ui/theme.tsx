// The app's theme: Auto / Light / Dark from store.settings().theme, resolved
// with @nhgw/ui-tokens like the Desktop (Auto follows sunrise and sunset at
// the lab) and re-evaluated at the next change (and when the app returns to
// the foreground). Status bar, navigation bar and native widgets follow it.

import { NavigationBar } from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Appearance, AppState, Easing, Platform } from 'react-native';

import { useSettings } from './store';
import { recheckDelayMs, themeState, type ThemeState } from './themeState';

type ThemeContextValue = ThemeState & { reduceMotion: boolean; easing: (t: number) => number };

const ThemeContext = createContext<ThemeContextValue | null>(null);

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => alive && setReduce(value))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme: mode } = useSettings();
  const reduceMotion = useReduceMotion();
  const [now, setNow] = useState(() => new Date());
  const state = useMemo(() => themeState(mode, now, reduceMotion), [mode, now, reduceMotion]);

  // Re-resolve at the next sunrise/sunset (capped at a minute) and on resume.
  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), recheckDelayMs(state, new Date()));
    return () => clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') setNow(new Date());
    });
    return () => sub.remove();
  }, []);

  // Native side: dialogs, switches and the system bars follow the app's theme.
  useEffect(() => {
    Appearance.setColorScheme?.(state.theme);
    if (Platform.OS === 'android') NavigationBar.setStyle(state.theme === 'dark' ? 'light' : 'dark');
  }, [state.theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ ...state, reduceMotion, easing: Easing.bezier(...state.motion.easing) }),
    [state, reduceMotion],
  );
  return (
    <ThemeContext.Provider value={value}>
      <StatusBar style={state.theme === 'dark' ? 'light' : 'dark'} />
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('ThemeProvider missing');
  return value;
}

/** Card chrome: panel + radius-lg + shadow-sm (the token parsed into RN boxShadow layers; New Architecture). */
export function cardStyle(theme: ThemeState) {
  return {
    backgroundColor: theme.colors.panel,
    borderRadius: theme.radius.lg,
    boxShadow: theme.shadow.sm,
  } as const;
}
