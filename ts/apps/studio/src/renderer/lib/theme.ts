// Theme wiring for the renderer, exactly as the Desktop does it: Auto
// follows sunrise/sunset at the lab (@nhgw/ui-tokens theme.ts), Light/Dark
// are fixed; the resolved theme goes on <html data-theme>, a switch eases
// in with the theme-fading class, and the last theme is remembered in
// localStorage "nh-theme-last" so index.html paints it before React loads.

import { nextThemeChange, parseMode, resolveTheme, THEME_LAST_KEY, type Theme, type ThemeMode } from '@nhgw/ui-tokens';

export { THEME_LAST_KEY };
export const THEME_FADE_MS = 400;

export type ThemeSnapshot = { mode: ThemeMode; theme: Theme; nextChange: Date | null };

export function themeSnapshot(mode: unknown, now: Date): ThemeSnapshot {
  const m = parseMode(mode);
  return { mode: m, theme: resolveTheme(m, now), nextChange: nextThemeChange(m, now) };
}

/** Re-resolve at the next flip, at most a minute away (also catches sleep and clock changes). */
export function recheckDelayMs(snapshot: ThemeSnapshot, now: Date): number {
  const minute = 60_000;
  if (!snapshot.nextChange) return minute;
  return Math.max(1_000, Math.min(minute, snapshot.nextChange.getTime() - now.getTime() + 500));
}

type RootLike = { dataset: Record<string, string | undefined>; classList: { add(c: string): void; remove(c: string): void } };
type StorageLike = { setItem(key: string, value: string): void };

/**
 * Put `theme` on the root element. Returns true when it changed (the caller
 * removes "theme-fading" after THEME_FADE_MS). `fade` is false on the first
 * application and under prefers-reduced-motion.
 */
export function applyTheme(root: RootLike, theme: Theme, storage: StorageLike | null, fade: boolean): boolean {
  if (root.dataset.theme === theme) return false;
  if (fade) root.classList.add('theme-fading');
  root.dataset.theme = theme;
  try {
    storage?.setItem(THEME_LAST_KEY, theme);
  } catch {
    // Storage may be unavailable; the next first paint is then light.
  }
  return true;
}

/** The theme index.html paints before first render (same rule as its inline script). */
export function firstPaintTheme(stored: string | null): Theme {
  return stored === 'dark' ? 'dark' : 'light';
}
