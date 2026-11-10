// App chrome: the left sidebar (Devices, Live, Recordings, the v2 areas,
// Settings at the bottom), the top bar (connection status, the global record
// indicator, theme, operation log) and the routed page.

import { TitleBarControls } from './components/TitleBarControls';
import { Onboarding } from './components/Onboarding';
import { appApi } from './areas/app/api';
import { syncBaseUrl } from '../../../../packages/host/src/sync/config';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import {
  AppWindow,
  Circle,
  Cpu,
  FolderOpen,
  LayoutGrid,
  ListChecks,
  MonitorSmartphone,
  Moon,
  Activity,
  Settings,
  Sun,
  SunMoon,
  Wrench,
  SlidersHorizontal,
} from 'lucide-react';
import { nextMode } from '@nhgw/ui-tokens';

import { BrandMark, StatusDot, Toasts } from './components/ui';
import { OperationLog } from './components/OperationLog';
import { activeRecordingCount } from './lib/recordings';
import { formatRoute, NAV_ITEMS, parseRoute, type AreaId, type Route } from './lib/navigation';
import { useStudio } from './state/studio';
import { DevicesPage } from './pages/DevicesPage';
import { RecordingsPage } from './pages/RecordingsPage';
import { SettingsPage } from './pages/SettingsPage';
import { formatTime } from './lib/format';

const LivePage = lazy(() => import('./pages/LivePage'));
const ProfilesPage = lazy(() => import('./areas/profiles/Page'));
const AppsPage = lazy(() => import('./areas/apps/Page'));
const ToolsPage = lazy(() => import('./areas/tools/Page'));

const ICONS: Record<AreaId, typeof Cpu> = {
  devices: Cpu,
  live: Activity,
  recordings: FolderOpen,
  profiles: LayoutGrid,
  apps: AppWindow,
  tools: Wrench,
  settings: Settings,
};

function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((next: Route) => {
    const hash = formatRoute(next);
    if (window.location.hash !== hash) window.location.hash = hash;
    setRoute(next);
  }, []);
  return [route, navigate];
}

function areaRoute(area: AreaId): Route {
  switch (area) {
    case 'devices':
      return { area, uid: null, tab: 'overview' };
    case 'live':
      return { area, uids: [] };
    case 'recordings':
      return { area, id: null };
    case 'settings':
      return { area, section: null };
    default:
      return { area, path: [] };
  }
}

export function App() {
  const { t, snapshot, source, platform, theme, updateSettings, locale, api } = useStudio();
  const [route, navigate] = useHashRoute();
  const [logOpen, setLogOpen] = useState(false);
  // The first-run guide: shown until finished or skipped; Settings can bring it back.
  const [onboarding, setOnboarding] = useState(false);
  useEffect(() => {
    const app = appApi(api);
    void app.getPrefs().then((prefs) => setOnboarding(!prefs.onboardingDone), () => undefined);
    return app.on('prefs', (prefs) => setOnboarding(!prefs.onboardingDone));
  }, [api]);

  const devices = snapshot?.devices ?? [];
  const recordingCount = activeRecordingCount(devices);
  const upstream = snapshot?.status.upstream ?? 'offline';
  const relayEnabled = snapshot?.settings.relayEnabled ?? true;
  // The Desktop web app of the server chosen in Settings (opened in the browser).
  const desktopUrl = snapshot ? syncBaseUrl({ serverTarget: snapshot.settings.serverTarget, manualUrl: snapshot.settings.manualUrl }) : '';
  const connState = !relayEnabled ? 'disabled' : upstream === 'online' ? 'online' : upstream === 'connecting' ? 'connecting' : 'offline';
  const connLabel = !relayEnabled ? t('connRelayOff') : upstream === 'online' ? t('connOnline') : upstream === 'connecting' ? t('connConnecting') : t('connOffline');

  const ThemeIcon = theme.mode === 'auto' ? SunMoon : theme.mode === 'light' ? Sun : Moon;
  const modeName = theme.mode === 'auto' ? t('themeAuto') : theme.mode === 'light' ? t('themeLight') : t('themeDark');
  const nextAt = theme.nextChange ? formatTime(theme.nextChange.getTime(), locale) : '';
  const themeDetail = theme.mode === 'auto' && nextAt ? (theme.theme === 'light' ? t('themeNextDark', { time: nextAt }) : t('themeNextLight', { time: nextAt })) : '';
  const themeLabel = `${t('themeLabel')}: ${modeName}${themeDetail ? ` · ${themeDetail}` : ''}`;

  const currentItem = NAV_ITEMS.find((item) => item.id === route.area);

  return (
    <div className={`app platform-${platform}`}>
      <a className="skip-link" href="#main">
        {t('navMain')}
      </a>
      <nav className="sidebar" aria-label={t('navMain')}>
        <div className="sidebar-brand drag">
          <BrandMark size={26} />
          <span className="sidebar-title">{t('appShortName')}</span>
        </div>
        <ul className="nav-list">
          {NAV_ITEMS.filter((item) => !item.bottom).map((item) => {
            const Icon = ICONS[item.id];
            const active = route.area === item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={`nav-item${active ? ' active' : ''}${item.later ? ' later' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => navigate(areaRoute(item.id))}
                  title={item.later ? t('comingLater') : undefined}
                >
                  <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
                  <span className="nav-label">{t(item.label)}</span>
                  {item.id === 'devices' && devices.length ? <span className="nav-count">{devices.length}</span> : null}
                  {item.id === 'live' && recordingCount ? <Circle className="nav-rec" size={9} fill="currentColor" aria-hidden="true" /> : null}
                  {item.later ? <span className="tag later-tag">{t('laterBadge')}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <ul className="nav-list nav-bottom">
          {NAV_ITEMS.filter((item) => item.bottom).map((item) => {
            const Icon = ICONS[item.id];
            const active = route.area === item.id;
            return (
              <li key={item.id}>
                <button type="button" className={`nav-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => navigate(areaRoute(item.id))}>
                  <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
                  <span className="nav-label">{t(item.label)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="main-column">
        <header className="topbar drag">
          <h1 className="topbar-title">{currentItem ? t(currentItem.label) : t('appShortName')}</h1>
          <div className="topbar-session no-drag">
            {recordingCount > 0 ? (
              <button
                type="button"
                className="rec-indicator"
                aria-label={t('recIndicatorLabel', { count: recordingCount })}
                title={t('recIndicatorLabel', { count: recordingCount })}
                onClick={() => navigate({ area: 'recordings', id: null })}
              >
                <span className="rec-dot" aria-hidden="true" />
                {t('recIndicator', { count: recordingCount })}
              </button>
            ) : null}
            {desktopUrl ? (
              <button type="button" className="icon-button" aria-label={t('openDesktop')} title={`${t('openDesktop')} — ${desktopUrl}`} onClick={() => void api.openExternal(`${desktopUrl}/`)}>
                <MonitorSmartphone size={17} strokeWidth={1.8} aria-hidden="true" />
              </button>
            ) : null}
            <button type="button" className="status-pill conn-pill" onClick={() => navigate({ area: 'settings', section: 'connection' })} title={snapshot?.status.serverUrl || connLabel}>
              <StatusDot state={connState} />
              <span>{connLabel}</span>
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={themeLabel}
              title={themeLabel}
              onClick={() => void updateSettings({ theme: nextMode(theme.mode) })}
            >
              <ThemeIcon size={17} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`icon-button${logOpen ? ' active' : ''}`}
              aria-label={logOpen ? t('opLogHide') : t('opLogShow')}
              aria-expanded={logOpen}
              aria-controls="op-log"
              title={t('opLogTitle')}
              onClick={() => setLogOpen((open) => !open)}
            >
              <ListChecks size={17} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
          <TitleBarControls />
        </header>
        {snapshot?.status.serviceError ? (
          <div className="service-error" role="alert">
            <strong>{t('serviceError', { error: snapshot.status.serviceError })}</strong>
            <span>{t('serviceErrorHint')}</span>
          </div>
        ) : null}
        {source === 'mock' ? (
          <div className="preview-banner" role="note">
            <SlidersHorizontal size={14} aria-hidden="true" />
            {t('previewBanner')}
          </div>
        ) : null}
        <div className="content-row">
          <main id="main" className="page" tabIndex={-1}>
            {!snapshot ? (
              <p className="empty">{t('loading')}</p>
            ) : route.area === 'devices' ? (
              <DevicesPage route={route} navigate={navigate} />
            ) : route.area === 'live' ? (
              <Suspense fallback={<p className="empty">{t('loading')}</p>}>
                <LivePage route={route} navigate={navigate} />
              </Suspense>
            ) : route.area === 'recordings' ? (
              <RecordingsPage route={route} navigate={navigate} />
            ) : route.area === 'settings' ? (
              <SettingsPage route={route} navigate={navigate} />
            ) : (
              <Suspense fallback={<p className="empty">{t('loading')}</p>}>
                {route.area === 'profiles' ? (
                  <ProfilesPage route={route} navigate={navigate} />
                ) : route.area === 'apps' ? (
                  <AppsPage route={route} navigate={navigate} />
                ) : (
                  <ToolsPage route={route} navigate={navigate} />
                )}
              </Suspense>
            )}
          </main>
          {logOpen ? <OperationLog onClose={() => setLogOpen(false)} /> : null}
        </div>
      </div>
      <Toasts />
      {onboarding ? <Onboarding onDone={() => setOnboarding(false)} /> : null}
    </div>
  );
}
