import { describe, expect, it } from 'vitest';
import { daylightAt, THEME_LAST_KEY } from '@nhgw/ui-tokens';

import { applyTheme, firstPaintTheme, recheckDelayMs, themeSnapshot, THEME_FADE_MS } from '../../src/renderer/lib/theme';

function fakeRoot(theme?: string) {
  const classes = new Set<string>();
  return {
    dataset: { theme } as Record<string, string | undefined>,
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    classes,
  };
}

describe('theme wiring', () => {
  it('fixed modes ignore the time of day; unknown modes are auto', () => {
    const night = new Date(2026, 10, 10, 23);
    expect(themeSnapshot('light', night)).toEqual({ mode: 'light', theme: 'light', nextChange: null });
    expect(themeSnapshot('dark', new Date(2026, 10, 10, 12)).theme).toBe('dark');
    expect(themeSnapshot('bogus', night).mode).toBe('auto');
  });

  it('auto follows sunrise/sunset at the lab and re-checks at the next change', () => {
    const noon = new Date(2026, 10, 10, 12);
    const night = new Date(2026, 10, 10, 23);
    expect(themeSnapshot('auto', noon).theme).toBe('light');
    expect(themeSnapshot('auto', night).theme).toBe('dark');
    const snap = themeSnapshot('auto', noon);
    expect(snap.nextChange?.getTime()).toBe(daylightAt(noon).nextChange?.getTime());
    expect(recheckDelayMs(snap, noon)).toBe(60_000);
    const justBefore = new Date(snap.nextChange!.getTime() - 10_000);
    expect(recheckDelayMs(themeSnapshot('auto', justBefore), justBefore)).toBe(10_500);
    expect(recheckDelayMs(themeSnapshot('dark', noon), noon)).toBe(60_000);
  });

  it('applies data-theme, fades only on a real switch, remembers nh-theme-last', () => {
    const stored: Record<string, string> = {};
    const storage = { setItem: (k: string, v: string) => void (stored[k] = v) };
    const root = fakeRoot('light');
    expect(applyTheme(root, 'light', storage, true)).toBe(false);
    expect(root.classes.size).toBe(0);
    expect(applyTheme(root, 'dark', storage, true)).toBe(true);
    expect(root.dataset.theme).toBe('dark');
    expect(root.classes.has('theme-fading')).toBe(true);
    expect(stored[THEME_LAST_KEY]).toBe('dark');
    expect(THEME_LAST_KEY).toBe('nh-theme-last');
    const quiet = fakeRoot('dark');
    applyTheme(quiet, 'light', { setItem: () => { throw new Error('denied'); } }, false);
    expect(quiet.dataset.theme).toBe('light');
    expect(quiet.classes.size).toBe(0);
    expect(THEME_FADE_MS).toBe(400);
  });

  it('first paint reads only "dark" as dark', () => {
    expect([firstPaintTheme('dark'), firstPaintTheme('light'), firstPaintTheme(null), firstPaintTheme('x')]).toEqual(['dark', 'light', 'light', 'light']);
  });
});
