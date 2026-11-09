import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { LOCALES, dictionaries, isMessageKey, resolveLocale, t } from '../src/i18n';

const I18N_JS = resolve(dirname(fileURLToPath(import.meta.url)), '../../node/webui/i18n.js');

function webUiDictionaries(): Record<string, Record<string, string>> {
  const window: Record<string, unknown> = {};
  runInNewContext(readFileSync(I18N_JS, 'utf8'), { window });
  return JSON.parse(JSON.stringify(window.NHG_I18N)) as Record<string, Record<string, string>>;
}

describe('i18n', () => {
  it('every locale has the same keys', () => {
    const keys = Object.keys(dictionaries.en).sort();
    for (const locale of LOCALES) expect(Object.keys(dictionaries[locale]).sort()).toEqual(keys);
  });

  it('is identical to the web UI webui/i18n.js', () => {
    expect(JSON.parse(JSON.stringify(dictionaries))).toEqual(webUiDictionaries());
  });

  it('t() fills placeholders and falls back like the web UI', () => {
    expect(t('en', 'nearbyCount', { count: 3 })).toBe('3 nearby');
    expect(t('en', 'trafficValue', { in: 5 })).toBe('UDP in 5/s · sent {out}/s');
    expect(t('en', 'upstreamErrorNotice', { error: '' })).toBe('Cannot reach the server: -');
    expect(t('ja', 'themeAuto')).toBe(dictionaries.ja.themeAuto);
    expect(isMessageKey('err_Failed to fetch')).toBe(true);
    expect(isMessageKey('err_nope')).toBe(false);
  });

  it('resolveLocale maps system locales, first preference only, English otherwise', () => {
    expect(resolveLocale(['ja-JP', 'en-US'])).toBe('ja');
    expect(resolveLocale(['ja'])).toBe('ja');
    expect(resolveLocale(['ja_JP.UTF-8'])).toBe('ja');
    expect(resolveLocale(['zh-CN'])).toBe('zh-CN');
    expect(resolveLocale(['zh'])).toBe('zh-CN');
    expect(resolveLocale(['zh-Hans-CN'])).toBe('zh-CN');
    expect(resolveLocale(['zh-SG'])).toBe('zh-CN');
    expect(resolveLocale(['zh-TW'])).toBe('en');
    expect(resolveLocale(['zh-Hant'])).toBe('en');
    expect(resolveLocale(['fr-FR', 'ja-JP'])).toBe('en');
    expect(resolveLocale(['en-GB'])).toBe('en');
    expect(resolveLocale([])).toBe('en');
    expect(resolveLocale([undefined])).toBe('en');
  });
});
