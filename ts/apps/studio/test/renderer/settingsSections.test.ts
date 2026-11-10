import { describe, expect, it } from 'vitest';

import { formatRoute, parseRoute } from '../../src/renderer/lib/navigation';
import { nextSection, sectionOf, SETTINGS_SECTIONS } from '../../src/renderer/pages/settings/sections';
import { SETTINGS_STRINGS } from '../../src/renderer/pages/settings/strings';

describe('settings sections', () => {
  it('routes #/settings/<section> and falls back to general', () => {
    expect(sectionOf(null)).toBe('general');
    expect(sectionOf('nope')).toBe('general');
    for (const id of SETTINGS_SECTIONS) {
      const route = parseRoute(formatRoute({ area: 'settings', section: id }));
      expect(route.area === 'settings' && sectionOf(route.section)).toBe(id);
    }
  });

  it('arrow keys wrap', () => {
    expect(nextSection('general', -1)).toBe('about');
    expect(nextSection('about', 1)).toBe('general');
  });

  it('every language has every string', () => {
    const keys = Object.keys(SETTINGS_STRINGS.en).sort();
    expect(Object.keys(SETTINGS_STRINGS.ja).sort()).toEqual(keys);
    expect(Object.keys(SETTINGS_STRINGS['zh-CN']).sort()).toEqual(keys);
  });
});
