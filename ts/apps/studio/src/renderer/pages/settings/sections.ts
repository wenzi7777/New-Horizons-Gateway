// Settings sub-navigation: #/settings/<section>. Unknown or missing -> general.
import type { SettingsKey } from './strings';

export const SETTINGS_SECTIONS = ['general', 'connection', 'devices', 'recording', 'sync', 'updates', 'advanced', 'about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SECTION_LABELS: Record<SettingsSection, SettingsKey> = {
  general: 'navGeneral',
  connection: 'navConnection',
  devices: 'navDevices',
  recording: 'navRecording',
  sync: 'navSync',
  updates: 'navUpdates',
  advanced: 'navAdvanced',
  about: 'navAbout',
};

export function sectionOf(value: string | null | undefined): SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value ?? '') ? (value as SettingsSection) : 'general';
}

/** Arrow-key movement in the section list (wraps). */
export function nextSection(current: SettingsSection, delta: number): SettingsSection {
  const i = SETTINGS_SECTIONS.indexOf(current);
  const n = SETTINGS_SECTIONS.length;
  return SETTINGS_SECTIONS[(((i + delta) % n) + n) % n]!;
}
