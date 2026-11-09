// Terminal UI wording: every string comes from the shared dictionaries in
// @nhgw/ui-tokens (i18n.ts, kept identical to packages/node/webui/i18n.js),
// including the terminal-only tui* keys.

import { t, type Locale, type MessageKey } from '@nhgw/ui-tokens';

export function tuiText(locale: Locale, key: MessageKey, vars?: Readonly<Record<string, unknown>>): string {
  return t(locale, key, vars);
}
