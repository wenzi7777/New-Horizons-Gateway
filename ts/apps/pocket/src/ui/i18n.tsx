// The active language: settings.locale, or the phone's language for
// "system" (re-read when the app returns to the foreground).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import type { Locale } from '@nhgw/ui-tokens';

import { translate, type Key } from '../i18n/strings';
import { systemLocale } from '../i18n/systemLocale';
import { useSettings } from './store';

type TFunction = (key: Key, vars?: Readonly<Record<string, unknown>>) => string;
type I18nValue = { locale: Locale; t: TFunction };

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { locale: chosen } = useSettings();
  const [system, setSystem] = useState<Locale>(() => systemLocale());
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') setSystem(systemLocale());
    });
    return () => sub.remove();
  }, []);
  const locale: Locale = chosen === 'system' ? system : chosen;
  const t = useCallback<TFunction>((key, vars) => translate(locale, key, vars), [locale]);
  const value = useMemo(() => ({ locale, t }), [locale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('I18nProvider missing');
  return value;
}
