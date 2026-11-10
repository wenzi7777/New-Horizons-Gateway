import { describe, expect, it } from 'vitest';
import { dictionaries, isMessageKey, LOCALES } from '@nhgw/ui-tokens';

import { appDictionaries, errorText, SHARED_KEYS_USED, translate } from '../../src/i18n/strings';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('app strings', () => {
  const en = appDictionaries.en;
  const keys = Object.keys(en);

  it('has every key, non-empty, in every locale', () => {
    for (const locale of LOCALES) {
      const dict = appDictionaries[locale] as Record<string, string>;
      expect(Object.keys(dict).sort()).toEqual([...keys].sort());
      for (const key of keys) expect(dict[key]?.trim(), `${locale}.${key}`).toBeTruthy();
    }
  });

  it('uses the same placeholders in every locale', () => {
    for (const locale of LOCALES) {
      const dict = appDictionaries[locale] as Record<string, string>;
      for (const key of keys) expect(placeholders(dict[key]!), `${locale}.${key}`).toEqual(placeholders((en as Record<string, string>)[key]!));
    }
  });

  it('never redefines a shared ui-tokens key', () => {
    expect(keys.filter((key) => isMessageKey(key))).toEqual([]);
  });

  it('only reuses shared keys that exist in all locales', () => {
    for (const key of SHARED_KEYS_USED) {
      for (const locale of LOCALES) expect(dictionaries[locale][key], `${locale}.${key}`).toBeTruthy();
    }
  });

  it('translates app and shared keys with placeholders', () => {
    expect(translate('ja', 'tabDevices')).toBe('デバイス');
    expect(translate('zh-CN', 'themeAuto')).toBe(dictionaries['zh-CN'].themeAuto);
    expect(translate('en', 'deviceAdded', { device: 'Left insole' })).toBe('Left insole added');
    expect(translate('en', 'fpsValue', { fps: '' })).toBe('- fps');
  });

  it('maps error codes to shared err_ strings when present', () => {
    expect(errorText('en', 'upstream_offline')).toBe(dictionaries.en.err_upstream_offline);
    expect(errorText('en', 'device_offline')).toBe('device_offline');
  });
});
