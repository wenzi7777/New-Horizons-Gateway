// The phone's language as one of the app's locales. expo-localization is not
// installed: Hermes' Intl reports the default locale, and React Native's
// I18nManager has the Android locale identifier as a fallback.
import { I18nManager } from 'react-native';
import { resolveLocale, type Locale } from '@nhgw/ui-tokens';

export function systemLocaleTag(): string {
  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale;
    if (tag) return tag;
  } catch {
    // No Intl: fall through.
  }
  const constants = (I18nManager as unknown as { getConstants?: () => { localeIdentifier?: string } }).getConstants?.();
  return constants?.localeIdentifier ?? 'en';
}

export function systemLocale(): Locale {
  return resolveLocale([systemLocaleTag()]);
}
