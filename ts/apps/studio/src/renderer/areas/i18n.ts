// Per-area strings: each area keeps its own dictionary (en, ja, zh-CN with
// the same keys) next to its code instead of growing i18n/strings.ts, and
// reads it with useAreaT(strings), which follows the app's language.
import { useCallback } from 'react';
import type { Locale } from '@nhgw/ui-tokens';

import { useStudio } from '../state/studio';

export type AreaStrings<K extends string> = Readonly<Record<Locale, Readonly<Record<K, string>>>>;

/** Typed helper so ja and zh-CN must have exactly en's keys. */
export function defineAreaStrings<K extends string>(en: Readonly<Record<K, string>>, ja: Readonly<Record<K, string>>, zhCN: Readonly<Record<K, string>>): AreaStrings<K> {
  return { en, ja, 'zh-CN': zhCN };
}

export function fillVars(text: string, vars?: Readonly<Record<string, unknown>>): string {
  for (const [name, value] of Object.entries(vars ?? {})) {
    text = text.split(`{${name}}`).join(value === undefined || value === null || value === '' ? '-' : String(value));
  }
  return text;
}

export function translateArea<K extends string>(strings: AreaStrings<K>, locale: Locale, key: K, vars?: Readonly<Record<string, unknown>>): string {
  return fillVars(strings[locale]?.[key] || strings.en[key] || key, vars);
}

export function useAreaT<K extends string>(strings: AreaStrings<K>): (key: K, vars?: Readonly<Record<string, unknown>>) => string {
  const { locale } = useStudio();
  return useCallback((key: K, vars?: Readonly<Record<string, unknown>>) => translateArea(strings, locale, key, vars), [locale, strings]);
}
