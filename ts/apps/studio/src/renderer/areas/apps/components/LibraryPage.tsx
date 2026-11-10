// The App Library: the catalog (search, categories, stale/offline notice) and
// one app's detail with its README and Install (the Desktop's AppStorePage).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Download, FileUp, RefreshCw, Search } from 'lucide-react';

import { Facts, Notice, TextInput } from '../../../components/ui';
import { useStudio } from '../../../state/studio';
import { appsApi, errorCode } from '../api';
import { categoriesOf, localised, type AppCatalogEntry, type AppPackage } from '../lib/appLibrary';
import { useAppsT } from '../strings';
import { AppInstallDialog } from './AppInstallDialog';
import { AppIcon } from './AppIcon';

const ALL = '__all__';


export function LibraryPage({ appId, go }: { appId: string | null; go: (path: string[]) => void }) {
  const t = useAppsT();
  const { api, locale } = useStudio();
  const client = useMemo(() => appsApi(api), [api]);
  const [items, setItems] = useState<AppCatalogEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState(ALL);
  const [query, setQuery] = useState('');
  const [sideload, setSideload] = useState<AppPackage | null>(null);
  const [sideloadError, setSideloadError] = useState('');

  const load = useCallback(
    async (refresh = false) => {
      setStatus('loading');
      try {
        const catalog = await client.libraryIndex(refresh);
        setItems(catalog.items || []);
        setStale(Boolean(catalog.stale));
        setError(catalog.error || null);
        setStatus('ready');
      } catch (caught) {
        setError(errorCode(caught));
        setStatus('error');
      }
    },
    [client],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(() => categoriesOf(items), [items]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((entry) => {
      if (category !== ALL && (entry.category || 'other') !== category) return false;
      if (!needle) return true;
      return [entry.id, entry.author, localised(entry.name, locale), localised(entry.summary, locale)].join(' ').toLowerCase().includes(needle);
    });
  }, [items, category, query, locale]);

  const importPackage = async () => {
    setSideloadError('');
    try {
      const pkg = await client.importPackage();
      if (pkg) setSideload(pkg);
    } catch (caught) {
      setSideloadError(errorCode(caught));
    }
  };

  const active = appId ? items.find((entry) => entry.id === appId) ?? null : null;
  if (appId && status === 'ready' && !active) {
    return (
      <div className="stack">
        <Notice kind="error">{t('appNotFound')}</Notice>
        <div>
          <button type="button" className="button ghost" onClick={() => go([])}>
            <ChevronLeft size={16} aria-hidden="true" />
            {t('appStoreTitle')}
          </button>
        </div>
      </div>
    );
  }
  if (active) return <AppDetail entry={active} onBack={() => go([])} go={go} />;

  return (
    <div className="stack">
      <header className="apps-header">
        <div>
          <h1>{t('appStoreTitle')}</h1>
          <p className="muted">{t('appStoreSubtitle')}</p>
        </div>
        <div className="apps-header-actions">
          <button type="button" className="button" onClick={() => void importPackage()} title={t('appsSideloadHint')}>
            <FileUp size={14} aria-hidden="true" />
            {t('appsSideload')}
          </button>
          <button type="button" className="button ghost icon-button" onClick={() => void load(true)} disabled={status === 'loading'} aria-label={t('appLibraryRefresh')} title={t('appLibraryRefresh')}>
            <RefreshCw size={15} className={status === 'loading' ? 'spin' : undefined} aria-hidden="true" />
          </button>
        </div>
      </header>

      {stale ? <Notice kind="warning">{t('appLibraryStale')}</Notice> : null}
      {status === 'error' ? <Notice kind="error">{t('appLibraryError')}{error ? `: ${error}` : ''}</Notice> : null}
      {sideloadError ? <Notice kind="error">{t('appsSideloadFailed')}: {sideloadError}</Notice> : null}

      <div className="apps-filters">
        <label className="apps-search">
          <Search size={15} aria-hidden="true" />
          <TextInput type="search" value={query} placeholder={t('appLibrarySearch')} aria-label={t('appLibrarySearch')} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {categories.length > 1 ? (
          <div className="chip-list" role="group" aria-label={t('appCategory')}>
            {[ALL, ...categories].map((name) => (
              <button key={name} type="button" aria-pressed={category === name} className={`chip toggle${category === name ? ' on' : ''}`} onClick={() => setCategory(name)}>
                {name === ALL ? t('appCategoryAll') : name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {status === 'loading' && !items.length ? (
        <div className="apps-card-grid" aria-busy="true">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="apps-card skeleton" />
          ))}
        </div>
      ) : null}
      {status !== 'loading' && !visible.length ? <p className="empty">{t('appLibraryEmpty')}</p> : null}

      <div className="apps-card-grid">
        {visible.map((entry) => (
          <button key={entry.id} type="button" className="apps-card" onClick={() => go(['app', entry.id])}>
            <AppIcon entry={entry} />
            <span className="apps-card-body">
              <span className="apps-card-title">{localised(entry.name, locale)}</span>
              <span className="apps-card-summary">{localised(entry.summary, locale)}</span>
              <span className="apps-card-meta">
                <span>{entry.author}</span>
                <span>v{entry.version}</span>
                <span>
                  {t('appMinOs')} {entry.min_os}
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>

      {sideload ? <AppInstallDialog pkg={sideload} onClose={() => setSideload(null)} go={go} /> : null}
    </div>
  );
}

function AppDetail({ entry, onBack, go }: { entry: AppCatalogEntry; onBack: () => void; go: (path: string[]) => void }) {
  const t = useAppsT();
  const { api, locale } = useStudio();
  const client = useMemo(() => appsApi(api), [api]);
  const [readme, setReadme] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const url = entry.readme_url?.[locale] || entry.readme_url?.en;
    setReadme(null);
    if (!url) return undefined;
    let cancelled = false;
    client
      .libraryReadme(url)
      .then((text) => {
        if (!cancelled) setReadme(text);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, entry, locale]);

  const facts: [string, string][] = [
    [t('appVersion'), `v${entry.version}`],
    [t('appMinOs'), entry.min_os],
    ...(typeof entry.estimated_us === 'number' ? [[t('appEstimatedCost'), `~${entry.estimated_us} µs`] as [string, string]] : []),
    ...(typeof entry.nodes === 'number' ? [[t('appNodes'), String(entry.nodes)] as [string, string]] : []),
    [t('appSize'), `${entry.package.size} B`],
    ...(entry.category ? [[t('appCategory'), entry.category] as [string, string]] : []),
    ...(entry.license ? [[t('appLicense'), entry.license] as [string, string]] : []),
  ];

  return (
    <div className="stack apps-detail">
      <div>
        <button type="button" className="button ghost" onClick={onBack}>
          <ChevronLeft size={16} aria-hidden="true" />
          {t('appStoreTitle')}
        </button>
      </div>
      <div className="apps-detail-hero">
        <AppIcon entry={entry} large />
        <div>
          <h1>{localised(entry.name, locale)}</h1>
          <p className="muted">{entry.author}</p>
          <p>{localised(entry.summary, locale)}</p>
        </div>
      </div>
      <Facts items={facts} />
      {entry.capabilities?.length ? (
        <div className="chip-list" aria-label={t('appCapabilities')}>
          <span className="muted">{t('appCapabilities')}</span>
          {entry.capabilities.map((name) => (
            <span key={name} className="tag">
              {name}
            </span>
          ))}
        </div>
      ) : null}
      {entry.permissions?.length ? <PermissionList permissions={entry.permissions} /> : null}
      <div className="apps-install-row">
        <button type="button" className="button primary" onClick={() => setInstalling(true)}>
          <Download size={15} aria-hidden="true" />
          {t('appInstallButton')}
        </button>
        <span className="muted">{t('appInstallButtonCopy')}</span>
      </div>
      {readme ? (
        <section className="card apps-readme" aria-label={t('appReadme')}>
          <h2 className="section-title">{t('appReadme')}</h2>
          <div className="apps-readme-text">{readme}</div>
        </section>
      ) : null}
      {installing ? <AppInstallDialog entry={entry} onClose={() => setInstalling(false)} go={go} /> : null}
    </div>
  );
}

/** What a panel may do to a device, before it is installed. */
export function PermissionList({ permissions }: { permissions: readonly string[] }) {
  const t = useAppsT();
  if (!permissions.length) return null;
  return (
    <div className="notice warning apps-permissions" role="note">
      <div>
        <strong>{t('panelPermissionsTitle')}</strong>
        <ul>
          {permissions.map((permission) => (
            <li key={permission}>
              <code className="mono">{permission}</code> {t(`panelPermission_${permission}`)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
