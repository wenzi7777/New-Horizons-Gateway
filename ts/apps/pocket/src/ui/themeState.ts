// Theme resolution for the app, wired to @nhgw/ui-tokens exactly as the
// Desktop does it: Auto follows sunrise/sunset at the lab, Light/Dark are
// fixed. Pure (no React Native) so it is unit tested.

import {
  cubicBezier,
  dark,
  light,
  numeric,
  parseShadow,
  resolveTheme,
  nextThemeChange,
  type Theme,
  type ThemeMode,
  type ThemeTokens,
} from '@nhgw/ui-tokens';

/** RN's boxShadow object form (RN >= 0.76, New Architecture). */
export type NativeShadow = { offsetX: number; offsetY: number; blurRadius: number; spreadDistance: number; color: string };

export type ThemeState = {
  mode: ThemeMode;
  theme: Theme;
  colors: ThemeTokens;
  radius: { sm: number; md: number; lg: number; pill: number };
  shadow: { sm: NativeShadow[]; md: NativeShadow[] };
  /** Android elevation standing in for the shadows where boxShadow is not drawn. */
  elevation: { sm: number; md: number };
  motion: { easing: [number, number, number, number]; fast: number; med: number };
  /** When "auto" next flips, or null for a fixed mode. */
  nextChange: Date | null;
};

export function nativeShadow(value: string): NativeShadow[] {
  return parseShadow(value).map((layer) => ({
    offsetX: layer.offsetX,
    offsetY: layer.offsetY,
    blurRadius: layer.blur,
    spreadDistance: layer.spread,
    color: layer.color,
  }));
}

export function themeState(mode: ThemeMode, now: Date, reduceMotion = false): ThemeState {
  const theme = resolveTheme(mode, now);
  const colors = theme === 'dark' ? dark : light;
  return {
    mode,
    theme,
    colors,
    radius: {
      sm: numeric(colors.radiusSm),
      md: numeric(colors.radiusMd),
      lg: numeric(colors.radiusLg),
      pill: numeric(colors.radiusPill),
    },
    shadow: { sm: nativeShadow(colors.shadowSm), md: nativeShadow(colors.shadowMd) },
    elevation: { sm: 1, md: 4 },
    motion: {
      easing: cubicBezier(colors.easeOut),
      fast: reduceMotion ? 0 : numeric(colors.durFast),
      med: reduceMotion ? 0 : numeric(colors.durMed),
    },
    nextChange: nextThemeChange(mode, now),
  };
}

/** How long to wait before re-resolving: until the next flip, capped at a minute (catches sleep/clock changes). */
export function recheckDelayMs(state: ThemeState, now: Date): number {
  const minute = 60_000;
  if (!state.nextChange) return minute;
  return Math.max(1_000, Math.min(minute, state.nextChange.getTime() - now.getTime() + 500));
}
