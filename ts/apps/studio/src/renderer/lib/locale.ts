// The UI language: the setting, or "system" -> navigator.languages via
// @nhgw/ui-tokens resolveLocale() (first entry only, like the web UI).

import { resolveLocale, LOCALES, type Locale } from '@nhgw/ui-tokens';

export type LocaleSetting = Locale | 'system';
export const LOCALE_SETTINGS: readonly LocaleSetting[] = ['system', ...LOCALES];

export function effectiveLocale(setting: unknown, preferred: readonly string[]): Locale {
  if (setting === 'en' || setting === 'ja' || setting === 'zh-CN') return setting;
  return resolveLocale(preferred);
}

/** Each language in its own name, as language pickers show them. */
export const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', ja: '日本語', 'zh-CN': '简体中文' };

/** The lang attribute for <html>. */
export function htmlLang(locale: Locale): string {
  return locale === 'zh-CN' ? 'zh-Hans' : locale;
}
