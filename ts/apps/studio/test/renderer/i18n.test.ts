import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dictionaries, isMessageKey, LOCALES } from '@nhgw/ui-tokens';

import { appDictionaries, errorText, isAppKey, SHARED_KEYS_USED, translate } from '../../src/renderer/i18n/strings';
import { NAV_ITEMS } from '../../src/renderer/lib/navigation';
import { effectiveLocale, htmlLang, LANGUAGE_NAMES, LOCALE_SETTINGS } from '../../src/renderer/lib/locale';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('NH Studio strings', () => {
  const en = appDictionaries.en as Record<string, string>;
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
      for (const key of keys) expect(placeholders(dict[key]!), `${locale}.${key}`).toEqual(placeholders(en[key]!));
    }
  });

  it('is translated: Japanese and Chinese differ from English where words are involved', () => {
    const same = (locale: 'ja' | 'zh-CN') => keys.filter((k) => (appDictionaries[locale] as Record<string, string>)[k] === en[k] && /[a-z]{4,}/.test(en[k]!.replace(/\{\w+\}|NH Studio|New Horizons Studio|Studio|Pocket|Gateway|Finder|WebGL|NTP|IMU|ADC|UID|JSON|FPS|REC/g, '')));
    expect(same('ja')).toEqual([]);
    expect(same('zh-CN')).toEqual([]);
  });

  it('never redefines a shared ui-tokens key, and shared keys exist everywhere', () => {
    expect(keys.filter((key) => isMessageKey(key))).toEqual([]);
    for (const key of SHARED_KEYS_USED) for (const locale of LOCALES) expect(dictionaries[locale][key], `${locale}.${key}`).toBeTruthy();
  });

  it('every t("…") key used in the renderer exists (global dictionary or the nearest area strings)', () => {
    const root = join(__dirname, '../../src/renderer');
    // Areas, the settings page and the splash keep their own strings*.ts
    // beside their code; a key counts as defined if it is in the global
    // dictionary or in a strings file in the same folder or any parent.
    const localKeys = new Map<string, Set<string>>();
    for (const file of sources(root)) {
      if (!/\/[A-Za-z]*[Ss]trings[^/]*\.ts$/.test(file) || file.endsWith('/i18n/strings.ts')) continue;
      const dir = dirname(file);
      const keys = localKeys.get(dir) ?? new Set<string>();
      for (const m of readFileSync(file, 'utf8').matchAll(/^\s*([A-Za-z_][\w]*)\s*:\s*['"`]/gm)) keys.add(m[1]!);
      localKeys.set(dir, keys);
    }
    const definedNear = (file: string, key: string) => {
      for (let dir = dirname(file); dir.startsWith(root); dir = dirname(dir)) {
        if (localKeys.get(dir)?.has(key)) return true;
        if (dir === root) break;
      }
      return false;
    };
    const missing: string[] = [];
    const sharedUsed = new Set<string>();
    for (const file of sources(root)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([A-Za-z_][\w]*)'/g)) {
        const key = m[1]!;
        if (isAppKey(key)) continue;
        if (isMessageKey(key)) {
          sharedUsed.add(key);
          continue;
        }
        if (!definedNear(file, key)) missing.push(`${relative(root, file)}: ${key}`);
      }
    }
    for (const item of NAV_ITEMS) if (!isAppKey(item.label)) missing.push(`navigation: ${item.label}`);
    expect(missing).toEqual([]);
    expect([...sharedUsed].filter((key) => !(SHARED_KEYS_USED as readonly string[]).includes(key))).toEqual([]);
  });

  it('translates app and shared keys, fills placeholders, maps errors', () => {
    expect(translate('ja', 'navDeviceList')).toBe('デバイス');
    expect(translate('zh-CN', 'themeAuto')).toBe(dictionaries['zh-CN'].themeAuto);
    expect(translate('en', 'deviceAdded', { device: 'Left insole' })).toBe('Left insole added');
    expect(translate('en', 'fpsValue', { fps: '' })).toBe('- fps');
    expect(errorText('ja', 'device_offline')).toBe('デバイスはオフラインです。');
    expect(errorText('en', 'upstream_offline')).toBe(dictionaries.en.err_upstream_offline);
    expect(errorText('en', 'weird_code')).toBe('weird_code');
  });

  it('chooses the language from the setting or navigator.languages', () => {
    expect(LOCALE_SETTINGS).toEqual(['system', 'en', 'ja', 'zh-CN']);
    expect(effectiveLocale('system', ['ja-JP', 'en-US'])).toBe('ja');
    expect(effectiveLocale('system', ['zh-Hans-CN'])).toBe('zh-CN');
    expect(effectiveLocale('system', ['zh-TW'])).toBe('en');
    expect(effectiveLocale('system', [])).toBe('en');
    expect(effectiveLocale('ja', ['en-US'])).toBe('ja');
    expect(htmlLang('zh-CN')).toBe('zh-Hans');
    expect(LANGUAGE_NAMES).toEqual({ en: 'English', ja: '日本語', 'zh-CN': '简体中文' });
  });
});
