import { describe, expect, it } from 'vitest';
import { dark, daylightAt, light, numeric } from '@nhgw/ui-tokens';

import { nativeShadow, recheckDelayMs, themeState } from '../../src/ui/themeState';

describe('theme wiring', () => {
  it('fixed modes ignore the time of day', () => {
    const night = new Date(2026, 10, 10, 23);
    expect(themeState('light', night).theme).toBe('light');
    expect(themeState('light', night).colors).toBe(light);
    expect(themeState('dark', new Date(2026, 10, 10, 12)).colors).toBe(dark);
    expect(themeState('dark', night).nextChange).toBeNull();
  });

  it('auto follows sunrise/sunset at the lab', () => {
    const noon = new Date(2026, 10, 10, 12);
    const night = new Date(2026, 10, 10, 23);
    expect(themeState('auto', noon).theme).toBe('light');
    expect(themeState('auto', night).theme).toBe('dark');
    expect(themeState('auto', noon).nextChange?.getTime()).toBe(daylightAt(noon).nextChange?.getTime());
  });

  it('re-checks at the next change, at most a minute away', () => {
    const now = new Date(2026, 10, 10, 12);
    const state = themeState('auto', now);
    expect(recheckDelayMs(state, now)).toBe(60_000);
    const justBefore = new Date(state.nextChange!.getTime() - 10_000);
    expect(recheckDelayMs(themeState('auto', justBefore), justBefore)).toBe(10_500);
    expect(recheckDelayMs(themeState('dark', now), now)).toBe(60_000);
  });

  it('maps radii, shadows and motion from the tokens', () => {
    const s = themeState('light', new Date());
    expect(s.radius).toEqual({ sm: 8, md: 12, lg: 16, pill: 999 });
    expect(s.shadow.sm).toEqual([
      { offsetX: 0, offsetY: 1, blurRadius: 2, spreadDistance: 0, color: 'rgba(0, 0, 0, 0.04)' },
      { offsetX: 0, offsetY: 1, blurRadius: 3, spreadDistance: 0, color: 'rgba(0, 0, 0, 0.06)' },
    ]);
    expect(nativeShadow(dark.shadowMd)).toEqual([{ offsetX: 0, offsetY: 6, blurRadius: 20, spreadDistance: 0, color: 'rgba(0, 0, 0, 0.45)' }]);
    expect(s.motion).toEqual({ easing: [0.22, 1, 0.36, 1], fast: numeric(light.durFast), med: numeric(light.durMed) });
    expect(themeState('light', new Date(), true).motion.med).toBe(0);
  });
});
