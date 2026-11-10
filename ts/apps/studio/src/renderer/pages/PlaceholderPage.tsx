// The v2 areas (Profiles, Apps, Tools): in the navigation now so the
// information architecture is final, marked as coming in a later version.

import { AppWindow, LayoutGrid, Wrench } from 'lucide-react';

import { useStudio } from '../state/studio';

const COPY = {
  profiles: { icon: LayoutGrid, title: 'navProfiles', copy: 'placeholderProfilesCopy' },
  apps: { icon: AppWindow, title: 'navApps', copy: 'placeholderAppsCopy' },
  tools: { icon: Wrench, title: 'navTools', copy: 'placeholderToolsCopy' },
} as const;

export function PlaceholderPage({ area }: { area: 'profiles' | 'apps' | 'tools' }) {
  const { t } = useStudio();
  const { icon: Icon, title, copy } = COPY[area];
  return (
    <div className="placeholder-page">
      <div className="placeholder-icon" aria-hidden="true">
        <Icon size={34} strokeWidth={1.5} />
      </div>
      <span className="tag later-tag">{t('comingLater')}</span>
      <h2>{t(title)}</h2>
      <p>{t(copy)}</p>
      <p className="muted">{t('placeholderNote')}</p>
    </div>
  );
}
