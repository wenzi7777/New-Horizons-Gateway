// The "apps" area's page (route #/apps/...):
//   #/apps                      App Library (catalog)
//   #/apps/app/<id>             one library app, with Install
//   #/apps/device/<uid>         moved: a device's apps are in its settings
//                               (#/devices/<uid>/settings/apps); kept as a redirect
//   #/apps/studio[/<project>]   App Studio (editor, build, emulator, reference)
import { lazy, Suspense, useEffect } from 'react';
import { Code2, Store } from 'lucide-react';

import type { Route } from '../../lib/navigation';
import { LibraryPage } from './components/LibraryPage';
import { useAppsT } from './strings';
import './apps.css';

// The studio pulls in CodeMirror and the whole SDK; load it only when opened.
const StudioPage = lazy(() => import('./components/StudioPage'));

export type AppsPageProps = { route: Extract<Route, { area: 'apps' }>; navigate: (route: Route) => void };

type Section = 'library' | 'studio';

export default function AppsPage({ route, navigate }: AppsPageProps) {
  const t = useAppsT();
  const [head = '', arg = ''] = route.path;
  const section: Section = head === 'studio' ? 'studio' : 'library';
  const go = (path: string[]) => navigate({ area: 'apps', path });
  // Old links (and "Open the device's apps" after an install) land on the
  // device's settings, where its apps now are.
  useEffect(() => {
    if (head === 'device') navigate(arg ? { area: 'devices', uid: arg, tab: 'settings', section: 'apps' } : { area: 'devices', uid: null, tab: 'overview' });
  }, [head, arg, navigate]);
  const tabs: { id: Section; label: string; icon: typeof Store; path: string[] }[] = [
    { id: 'library', label: t('appStoreTitle'), icon: Store, path: [] },
    { id: 'studio', label: t('sdkTitle'), icon: Code2, path: ['studio'] },
  ];

  return (
    <div className="apps-area stack">
      <nav className="tabs apps-tabs" aria-label={t('appsSections')}>
        {tabs.map((tab) => (
          <button key={tab.id} type="button" className={section === tab.id ? 'active' : undefined} aria-current={section === tab.id ? 'page' : undefined} onClick={() => go(tab.path)}>
            <tab.icon size={14} aria-hidden="true" />
            {tab.label}
          </button>
        ))}
      </nav>
      {section === 'library' ? <LibraryPage appId={head === 'app' ? arg || null : null} go={go} /> : null}
      {section === 'studio' ? (
        <Suspense fallback={<p className="empty">{t('loading')}</p>}>
          <StudioPage projectId={arg || null} go={go} />
        </Suspense>
      ) : null}
    </div>
  );
}
