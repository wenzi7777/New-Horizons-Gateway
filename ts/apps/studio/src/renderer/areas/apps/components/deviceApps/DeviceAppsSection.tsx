// The device's apps in its settings (the Desktop's DeviceAppsSection.tsx),
// the way a phone shows what is running: a resource summary, a card per
// running app with what it draws and how busy it is, and every other
// installed app as a row with a switch. Maintenance mode, which the device
// needs for turning apps on and off, is entered and left around the change.
//
// One pipe per device: operator commands queue; the live view's polls skip
// while one runs (a Hub relays one command per device at a time).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Store } from 'lucide-react';

import type { DeviceView } from '../../../../../shared/contract';
import { Notice, useConfirm } from '../../../../components/ui';
import { formatRoute } from '../../../../lib/navigation';
import { useStudio } from '../../../../state/studio';
import { appsApi, errorCode } from '../../api';
import { localised, type AppCatalogEntry } from '../../lib/appLibrary';
import {
  appErrorKey,
  isUnknownCommand,
  mergeDeviceApps,
  parseAppEvents,
  parseAppList,
  parseAppResources,
  parseAppView,
  parsePackageList,
  runtimeName,
  type AppEventEntry,
  type AppLoadStats,
  type AppPackageEntry,
  type AppResources,
  type AppViewState,
  type DeviceApp,
  type InstalledApp,
} from '../../lib/deviceApps';
import { commandRunner, isMaintenance, resultFailure, withMaintenance } from '../../lib/deviceCommand';
import type { CommandRunner } from '../../lib/deviceFileTransfer';
import { compareVersionCores } from '../../lib/versioning';
import { useAppsT } from '../../strings';
import '../../apps.css';
import { AppDetailSheet } from './AppDetailSheet';
import { isViewKind } from './AppParts';
import { AppResourceBar } from './AppResourceBar';
import { InstalledAppRow } from './InstalledAppRow';
import { RunningAppCard } from './RunningAppCard';

/** The fastest the live view asks; a slow link (ESP-NOW via a Hub) slows it further. */
const MIN_POLL_MS = 1000;
/** One point per poll: about a minute of history at the fastest rate. */
const HISTORY_POINTS = 60;
const COLOURS = 6;
/** AppGovernor::kDefaultCeilingPermille, until the device says otherwise. */
const DEFAULT_CEILING_PERMILLE = 250;

const go = (path: string[]) => {
  window.location.hash = formatRoute({ area: 'apps', path });
};

export function DeviceAppsSection({ device }: { device: DeviceView }) {
  const t = useAppsT();
  const { api, locale } = useStudio();
  const uid = device.uid;
  const online = device.online;
  const inMaintenance = isMaintenance(device.mode);
  const recording = device.recording?.enabled === true;
  const firmware = device.firmwareVersion && device.firmwareVersion !== 'unknown' ? device.firmwareVersion : '';
  // The registry exists from v1.1.0; on an older device the section says so.
  const supportsRegistry = !firmware || compareVersionCores(firmware, 'v1.1.0') >= 0;

  const base = useMemo(() => commandRunner(api.sendCommand.bind(api), uid), [api, uid]);
  const actions = useRef(0);
  const polling = useRef<Promise<unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const queue = useCallback<CommandRunner>(
    async (payload, timeoutMs) => {
      actions.current += 1;
      setBusy(true);
      try {
        if (polling.current) await polling.current.catch(() => undefined);
        return await base(payload, timeoutMs);
      } finally {
        actions.current -= 1;
        if (actions.current === 0) setBusy(false);
      }
    },
    [base],
  );
  const poll = useCallback<CommandRunner>(
    async (payload, timeoutMs) => {
      if (actions.current > 0 || polling.current) return { result: null };
      const pending = base(payload, timeoutMs);
      polling.current = pending;
      try {
        return await pending;
      } finally {
        polling.current = null;
      }
    },
    [base],
  );

  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [packages, setPackages] = useState<AppPackageEntry[]>([]);
  const [resources, setResources] = useState<AppResources | null>(null);
  const [ceilingPermille, setCeilingPermille] = useState(DEFAULT_CEILING_PERMILLE);
  const [view, setView] = useState<AppViewState | null>(null);
  const [history, setHistory] = useState<Map<string, number[]>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [events, setEvents] = useState<AppEventEntry[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [catalog, setCatalog] = useState<Map<string, AppCatalogEntry>>(() => new Map());
  const [confirmElement, confirm] = useConfirm();

  // The catalog's localised name and summary, by package id.
  useEffect(() => {
    let cancelled = false;
    appsApi(api)
      .libraryIndex()
      .then((index) => {
        if (!cancelled) setCatalog(new Map((index.items || []).map((item) => [item.id, item])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  const describe = useCallback(
    (raw: string) => {
      const key = appErrorKey(raw);
      return key ? t(key) : `${t('appErrorUnknown')}: ${raw}`;
    },
    [t],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const listed = await queue({ command: 'app_list' });
      const failure = resultFailure(listed.result);
      if (failure) throw new Error(failure);
      setApps(parseAppList(listed.result));
      const data = (listed.result?.data ?? {}) as Record<string, unknown>;
      const governor = (data.governor ?? {}) as Record<string, unknown>;
      if (Number(governor.ceiling_permille) > 0) setCeilingPermille(Number(governor.ceiling_permille));
      if (supportsRegistry) {
        const registry = await queue({ command: 'app_list_packages' });
        setPackages(parsePackageList(registry.result));
        setResources(parseAppResources(registry.result));
      }
    } catch (error) {
      setNotice({ text: describe(errorCode(error)), kind: 'error' });
    } finally {
      setLoading(false);
    }
  }, [queue, supportsRegistry, describe]);

  useEffect(() => {
    if (online) void refresh();
  }, [refresh, online]);

  const merged = useMemo(
    () =>
      mergeDeviceApps(apps, packages).map((app) => {
        const known = catalog.get(app.id);
        return known ? { ...app, name: localised(known.name, locale) || app.name, summary: localised(known.summary, locale) || app.summary } : app;
      }),
    [apps, packages, catalog, locale],
  );
  const running = useMemo(() => merged.filter((app) => app.active && !isViewKind(app.kind)), [merged]);
  const installed = useMemo(() => merged.filter((app) => !app.active && !isViewKind(app.kind)), [merged]);
  const views = useMemo(() => merged.filter((app) => isViewKind(app.kind)), [merged]);
  const colourOf = useCallback(
    (id: string) => {
      const index = running.findIndex((app) => app.id === id);
      return (index < 0 ? 0 : index) % COLOURS;
    },
    [running],
  );

  // --- the live view: app_view every second or so, while something runs ---
  const pausedRef = useRef(false);
  pausedRef.current = busy || pending !== null || loading;
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const anyActive = running.length > 0 && online;
  const [liveUnsupported, setLiveUnsupported] = useState(false);
  useEffect(() => {
    if (!anyActive || liveUnsupported) return undefined;
    let cancelled = false;
    let timer = 0;
    let intervalMs = MIN_POLL_MS;
    const tick = async () => {
      if (cancelled) return;
      if (!pausedRef.current && document.visibilityState === 'visible') {
        const started = performance.now();
        try {
          const { result } = await pollRef.current({ command: 'app_view' });
          if (!cancelled && result) {
            if (isUnknownCommand(result)) setLiveUnsupported(true);
            else if (!resultFailure(result)) {
              const parsed = parseAppView(result);
              setView(parsed);
              if (parsed.load) {
                setHistory((previous) => {
                  const next = new Map(previous);
                  for (const entry of parsed.load?.apps ?? []) {
                    next.set(entry.name, [...(next.get(entry.name) ?? []), entry.load].slice(-HISTORY_POINTS));
                  }
                  return next;
                });
              }
            }
            // Twice the round trip, so the view never takes more than half the link.
            intervalMs = Math.max(MIN_POLL_MS, Math.round((performance.now() - started) * 2));
          }
        } catch {
          // Retried on the next tick.
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), intervalMs);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [anyActive, liveUnsupported]);

  // A state the live view reports that the last app_list did not (an app was
  // killed, or the governor held everything back): fetch the list again.
  const liveStates = (view?.load?.apps ?? []).map((entry) => `${entry.name}:${entry.state}`).join(',');
  const listedStates = running.map((app) => `${runtimeName(app)}:${app.runtime?.state ?? ''}`).join(',');
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!liveStates || pausedRef.current) return;
    const live = new Map(liveStates.split(',').map((pair) => pair.split(':') as [string, string]));
    const differs = listedStates
      .split(',')
      .filter(Boolean)
      .some((pair) => {
        const [name = '', state] = pair.split(':');
        return live.has(name) && live.get(name) !== state;
      });
    if (differs) void refreshRef.current();
  }, [liveStates, listedStates]);

  const loadOf = useCallback((app: DeviceApp): AppLoadStats | null => view?.load?.apps.find((entry) => entry.name === runtimeName(app)) ?? app.runtime?.load ?? null, [view]);
  const cpuByApp = useMemo(() => new Map(running.map((app) => [app.id, loadOf(app)?.cpu10 ?? 0] as const)), [running, loadOf]);

  // --- actions ---
  const perform = useCallback(
    async (id: string, success: string, work: () => Promise<void>) => {
      setPending(id);
      setNotice(null);
      try {
        await work();
        setNotice({ text: success, kind: 'success' });
      } catch (error) {
        setNotice({ text: describe(errorCode(error)), kind: 'error' });
      } finally {
        setPending(null);
        await refresh();
      }
    },
    [describe, refresh],
  );

  const send = useCallback(
    async (payload: Record<string, unknown>) => {
      const failure = resultFailure((await queue(payload)).result);
      if (failure) throw new Error(failure);
    },
    [queue],
  );

  const maintained = (id: string, success: string, payload: Record<string, unknown>) =>
    perform(id, success, () => withMaintenance(queue, inMaintenance, 'apps', () => send(payload)));

  const toggle = async (app: DeviceApp) => {
    // Switching an app pauses the scan for about a second; while the device
    // records, that is a gap in the data, so it is asked first.
    if (recording && !inMaintenance) {
      const ok = await confirm({
        title: t(app.active ? 'appsTurnOff' : 'appsTurnOn', { app: app.name }),
        message: t('appsRecordingConfirm'),
        confirmLabel: t(app.active ? 'appsTurnOffShort' : 'appsTurnOnShort'),
      });
      if (!ok) return;
    }
    await maintained(app.id, app.active ? t('appsTurnedOff') : t('appsTurnedOn'), { command: app.active ? 'app_deactivate' : 'app_activate', id: app.id });
  };

  const uninstall = async (app: DeviceApp) => {
    const ok = await confirm({ title: `${t('appUninstall')} ${app.name}`, message: t('appUninstallConfirm'), confirmLabel: t('appUninstall'), danger: true });
    if (!ok) return;
    setSheetId(null);
    await maintained(app.id, t('appUninstalled'), { command: 'app_uninstall', id: app.id });
  };

  const sheetApp = sheetId ? merged.find((app) => app.id === sheetId) ?? null : null;
  const sheetName = sheetApp ? runtimeName(sheetApp) : '';
  const sheetActive = Boolean(sheetApp?.active);
  useEffect(() => {
    if (!sheetName || !sheetActive || !supportsRegistry) {
      setEvents([]);
      return undefined;
    }
    let cancelled = false;
    setEventsLoading(true);
    queue({ command: 'app_events', since_seq: 0 })
      .then((page) => {
        if (!cancelled) setEvents(parseAppEvents(page.result).events.filter((event) => event.app === sheetName).sort((a, b) => b.seq - a.seq));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sheetName, sheetActive, supportsRegistry, queue]);

  const disabled = busy || pending !== null || !online;

  if (!supportsRegistry) return <Notice kind="warning">{t('appRegistryUnsupported')}</Notice>;

  return (
    <section className="dapps-section">
      <p className="muted">{t('appsSectionCopy')}</p>
      <div className="dapps-toolbar">
        <p className="dapps-toolbar-note">{t('appsScanPauseNote')}</p>
        <div className="apps-header-actions">
          <button type="button" className="button ghost icon-button" onClick={() => void refresh()} disabled={disabled || loading} aria-label={t('refresh')} title={t('refresh')}>
            <RefreshCw size={15} className={loading ? 'spin' : undefined} aria-hidden="true" />
          </button>
          <button type="button" className="button" onClick={() => go([])}>
            <Store size={14} aria-hidden="true" />
            {t('appsGetMore')}
          </button>
        </div>
      </div>

      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}

      <AppResourceBar running={running} resources={resources} cpuByApp={cpuByApp} ceilingPermille={ceilingPermille} colourOf={colourOf} />

      <div className="dapps-group">
        <h4 className="dapps-group-title">
          {t('appsRunning')}
          {running.length ? <span>{running.length}</span> : null}
        </h4>
        {running.length ? (
          <div className="dapps-cards">
            {running.map((app) => (
              <RunningAppCard
                key={app.id}
                app={app}
                colour={colourOf(app.id)}
                view={view}
                load={loadOf(app)}
                history={history.get(runtimeName(app)) ?? []}
                disabled={disabled}
                pending={pending === app.id}
                onToggle={() => void toggle(app)}
                onOpen={() => setSheetId(app.id)}
              />
            ))}
          </div>
        ) : (
          <p className="dapps-empty">{loading ? t('loading') : t('appsNoneRunning')}</p>
        )}
        {liveUnsupported ? <p className="dapps-footnote">{t('appLiveUnsupported')}</p> : null}
      </div>

      <div className="dapps-group">
        <h4 className="dapps-group-title">
          {t('appsInstalled')}
          {installed.length ? <span>{installed.length}</span> : null}
        </h4>
        <ul className="dapps-list">
          {installed.map((app) => (
            <InstalledAppRow
              key={app.id}
              app={app}
              resources={resources}
              disabled={disabled}
              pending={pending === app.id}
              onToggle={() => void toggle(app)}
              onOpen={() => setSheetId(app.id)}
            />
          ))}
          {!installed.length ? <li className="dapps-empty">{running.length ? t('appsAllRunning') : t('appNoPackages')}</li> : null}
        </ul>
      </div>

      {views.length ? (
        <div className="dapps-group">
          <h4 className="dapps-group-title">
            {t('installedReadouts')}
            <small>{t('appsViewsNotRendered')}</small>
          </h4>
          <ul className="dapps-list">
            {views.map((app) => (
              <InstalledAppRow key={app.id} app={app} resources={resources} disabled={disabled} pending={pending === app.id} onToggle={() => undefined} onOpen={() => setSheetId(app.id)} />
            ))}
          </ul>
        </div>
      ) : null}

      {sheetApp ? (
        <AppDetailSheet
          app={sheetApp}
          colour={colourOf(sheetApp.id)}
          load={loadOf(sheetApp)}
          history={history.get(runtimeName(sheetApp)) ?? []}
          view={view}
          events={events}
          eventsLoading={eventsLoading}
          canReorder={resources !== null && running.length > 1}
          isFirst={running[0]?.id === sheetApp.id}
          disabled={disabled}
          onClose={() => setSheetId(null)}
          onToggle={() => void toggle(sheetApp)}
          onPause={() => void perform(sheetApp.id, t('appsPaused'), () => send({ command: 'app_stop', name: runtimeName(sheetApp) }))}
          onResume={() => void perform(sheetApp.id, t('appsResumed'), () => send({ command: 'app_start', name: runtimeName(sheetApp) }))}
          onRevive={() => void perform(sheetApp.id, t('appRevived'), () => send({ command: 'app_revive', name: runtimeName(sheetApp) }))}
          onMoveFirst={() => void perform(sheetApp.id, t('appsMovedFirst'), () => send({ command: 'app_reorder', id: sheetApp.id, to: 0 }))}
          onOpenStore={() => go(['app', sheetApp.id])}
          onUninstall={() => void uninstall(sheetApp)}
        />
      ) : null}
      {confirmElement}
    </section>
  );
}
