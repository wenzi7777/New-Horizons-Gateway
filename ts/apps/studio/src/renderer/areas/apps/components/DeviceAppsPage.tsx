// The apps on one device (the Desktop's DeviceAppsPage + DeviceAppsPanel +
// DeviceAppLivePreview): slots with budget meters and enable / disable /
// revive, installed packages and views with activate / deactivate /
// uninstall, the app event log, the maintenance switch, and the app_view live
// preview. Every command goes through api.sendCommand, one at a time; the
// preview's polls skip while an operator command holds the device.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, RefreshCw, Store, Wrench } from 'lucide-react';

import type { DeviceView } from '../../../../shared/contract';
import { Notice, StatusDot, useConfirm } from '../../../components/ui';
import { useStudio } from '../../../state/studio';
import { appsApi, errorCode } from '../api';
import { localised, type AppCatalogEntry } from '../lib/appLibrary';
import {
  appErrorKey,
  budgetPercent,
  freeSlots,
  isUnknownCommand,
  needsRevive,
  parseAppEvents,
  parseAppList,
  parseAppView,
  parsePackageList,
  type AppEventEntry,
  type AppPackageEntry,
  type AppViewState,
  type InstalledApp,
} from '../lib/deviceApps';
import { commandRunner, isMaintenance, resultFailure } from '../lib/deviceCommand';
import type { CommandRunner } from '../lib/deviceFileTransfer';
import { compareVersionCores } from '../lib/versioning';
import { useAppsT } from '../strings';
import { KindGlyph } from './AppIcon';
import { LedDot, OledPanel, StripPixels } from './IndicatorViews';

const isViewKind = (kind: string) => kind === 'readout' || kind === 'panel';

export function DevicePicker({ go }: { go: (path: string[]) => void }) {
  const t = useAppsT();
  const { snapshot } = useStudio();
  const devices = snapshot?.devices ?? [];
  return (
    <div className="stack">
      <header className="apps-header">
        <div>
          <h1>{t('deviceApps')}</h1>
          <p className="muted">{t('appsDevicePickCopy')}</p>
        </div>
      </header>
      {devices.length === 0 ? <p className="empty">{t('appInstallNoDevices')}</p> : null}
      <ul className="apps-list" aria-label={t('appsDevicesTab')}>
        {devices.map((device) => (
          <li key={device.uid}>
            <button type="button" className="apps-list-row" onClick={() => go(['device', device.uid])}>
              <StatusDot state={device.online ? 'online' : 'offline'} label={device.online ? t('appsOnline') : t('appsOffline')} />
              <strong>{device.displayName}</strong>
              <span className="muted mono">{device.firmwareVersion || '-'}</span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DeviceAppsPage({ uid, go }: { uid: string; go: (path: string[]) => void }) {
  const t = useAppsT();
  const { api, snapshot } = useStudio();
  const device: DeviceView | undefined = snapshot?.devices.find((item) => item.uid === uid);
  const maintenanceMode = isMaintenance(device?.mode);
  const firmware = device?.firmwareVersion && device.firmwareVersion !== 'unknown' ? device.firmwareVersion : '';
  // The registry exists from v1.1.0; on an older device its controls are hidden rather than failing.
  const supportsRegistry = !firmware || compareVersionCores(firmware, 'v1.1.0') >= 0;

  // One pipe per device: operator commands queue; preview polls skip while one runs.
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
  const [events, setEvents] = useState<AppEventEntry[]>([]);
  const [rolledOff, setRolledOff] = useState(0);
  const [notice, setNotice] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalog, setCatalog] = useState<Map<string, AppCatalogEntry>>(() => new Map());
  const [confirmElement, confirm] = useConfirm();
  const { locale } = useStudio();

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
  const nameOf = (entry: AppPackageEntry) => localised(catalog.get(entry.id)?.name, locale) || entry.name;
  const summaryOf = (entry: AppPackageEntry) => localised(catalog.get(entry.id)?.summary, locale) || entry.summary;

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
      if (supportsRegistry) {
        setPackages(parsePackageList((await queue({ command: 'app_list_packages' })).result));
        const page = parseAppEvents((await queue({ command: 'app_events', since_seq: 0 })).result);
        setEvents([...page.events].sort((a, b) => b.seq - a.seq));
        setRolledOff(Math.max(0, page.seq - page.events.length));
      }
    } catch (error) {
      setNotice({ text: describe(errorCode(error)), kind: 'error' });
    } finally {
      setLoading(false);
    }
  }, [queue, supportsRegistry, describe]);

  const online = device?.online ?? false;
  useEffect(() => {
    if (online) void refresh();
  }, [refresh, online]);

  const run = async (payload: Record<string, unknown>, success: string) => {
    setNotice(null);
    try {
      const failure = resultFailure((await queue(payload)).result);
      if (failure) throw new Error(failure);
      setNotice({ text: success, kind: 'success' });
      await refresh();
    } catch (error) {
      setNotice({ text: describe(errorCode(error)), kind: 'error' });
    }
  };

  const toggleMaintenance = () =>
    run(maintenanceMode ? { command: 'exit_maintenance' } : { command: 'enter_maintenance', reason: 'app_install' }, maintenanceMode ? t('normalModeLabel') : t('maintenanceModeLabel'));

  const uninstall = async (entry: AppPackageEntry) => {
    const ok = await confirm({ title: `${t('appUninstall')} ${nameOf(entry)}`, message: t('appUninstallConfirm'), confirmLabel: t('appUninstall'), danger: true });
    if (ok) await run({ command: 'app_uninstall', id: entry.id }, t('appUninstalled'));
  };

  const flowPackages = packages.filter((p) => !isViewKind(p.kind));
  const viewPackages = packages.filter((p) => isViewKind(p.kind));
  const available = freeSlots(apps, packages);
  const bySlot = new Map(packages.filter((p) => p.slot >= 0).map((p) => [p.slot, p] as const));
  const disabled = busy || !online;
  const needsMaintenance = maintenanceMode ? undefined : t('appRequiresMaintenance');
  const anyRunning = apps.some((app) => app.state === 'running' && !app.idle);

  const packageRow = (entry: AppPackageEntry) => (
    <li key={entry.id} className="apps-row">
      <KindGlyph kind={entry.kind} />
      <div className="apps-row-body">
        <div className="apps-row-title">
          <strong>{nameOf(entry)}</strong>
          <span className="muted">v{entry.version}</span>
          {entry.state === 'load_failed' ? <span className="tag apps-danger">{t('appLoadFailed')}</span> : null}
        </div>
        {summaryOf(entry) ? <div className="muted">{summaryOf(entry)}</div> : null}
        <div className="apps-row-meta">
          <span className="mono">{entry.id}</span>
          <span>{entry.size} B</span>
          {isViewKind(entry.kind) ? (
            <span>{entry.kind === 'panel' ? t('appKindPanel') : t('appKindReadout')}</span>
          ) : (
            <>
              <span>~{entry.estimatedUs} µs</span>
              <span>{entry.slot >= 0 ? `${t('appSlot')} ${entry.slot}` : t('appNotActivated')}</span>
            </>
          )}
        </div>
      </div>
      <div className="apps-row-actions">
        {!isViewKind(entry.kind) && entry.slot < 0 && available.length ? (
          <button type="button" className="button tiny" disabled={disabled || !maintenanceMode} title={needsMaintenance} onClick={() => void run({ command: 'app_activate', id: entry.id, slot: available[0] }, t('appActivated'))}>
            {t('appActivate')}
          </button>
        ) : null}
        <button type="button" className="button tiny danger" disabled={disabled || !maintenanceMode} title={needsMaintenance} onClick={() => void uninstall(entry)}>
          {t('appUninstall')}
        </button>
      </div>
    </li>
  );

  return (
    <div className="stack">
      <header className="apps-header">
        <div>
          <p className="muted">{device?.displayName || uid}</p>
          <h1>{t('deviceApps')}</h1>
        </div>
        <div className="apps-header-actions">
          <button type="button" className="button" onClick={() => go([])}>
            <Store size={14} aria-hidden="true" />
            {t('appStoreTitle')}
          </button>
          <button type="button" className="button ghost icon-button" onClick={() => void refresh()} disabled={disabled || loading} aria-label={t('refresh')} title={t('refresh')}>
            <RefreshCw size={15} className={loading ? 'spin' : undefined} aria-hidden="true" />
          </button>
        </div>
      </header>

      {!device ? <Notice kind="warning">{t('appsDeviceUnknown')}</Notice> : !online ? <Notice kind="warning">{t('appInstallBlockedOffline')}</Notice> : null}

      {supportsRegistry ? (
        <div className={`apps-maintenance${maintenanceMode ? ' active' : ''}`}>
          <Wrench size={18} aria-hidden="true" />
          <div>
            <strong>{maintenanceMode ? t('maintenanceModeLabel') : t('normalModeLabel')}</strong>
            <span className="muted">{maintenanceMode ? t('appMaintenanceActive') : t('appMaintenanceNeeded')}</span>
          </div>
          {/* Never silent: entering maintenance stops the scan, so it is always the operator's step. */}
          <button type="button" className={`button${maintenanceMode ? '' : ' primary'}`} disabled={disabled} onClick={() => void toggleMaintenance()}>
            {maintenanceMode ? t('appInstallExitMaintenance') : t('appInstallEnterMaintenance')}
          </button>
        </div>
      ) : (
        <Notice kind="warning">{t('appRegistryUnsupported')}</Notice>
      )}

      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}

      <LivePreview poll={poll} active={anyRunning && online} paused={busy || loading} />

      <section className="card" aria-labelledby="apps-slots-title">
        <div className="card-head">
          <h2 id="apps-slots-title" className="section-title">
            {t('installedApps')}
          </h2>
          {apps.length ? (
            <span className="muted">
              {t('appSlotsUsed')} {apps.length - available.length}/{apps.length}
            </span>
          ) : null}
        </div>
        <div className="apps-slot-grid">
          {apps.map((app, index) => {
            const bound = bySlot.get(index);
            const empty = app.idle;
            const percent = budgetPercent(app);
            return (
              <article key={app.name} className={`apps-slot state-${app.state}${empty ? ' free' : ''}`}>
                <header className="apps-slot-head">
                  <span className="mono">{app.name}</span>
                  {empty ? null : <span className={`tag apps-state ${app.state}`}>{t(`appState_${app.state}`)}</span>}
                </header>
                <div>{bound ? <strong title={summaryOf(bound)}>{nameOf(bound)}</strong> : !empty && app.graph ? <strong>{app.graph}</strong> : <span className="muted">{t('appSlotFree')}</span>}</div>
                {!empty ? (
                  <div className="apps-budget" title={`${app.lastUs}µs / ${app.budgetUs}µs`}>
                    <div className="apps-budget-caption">
                      <span>{t('appBudget')}</span>
                      <span className={percent > 100 ? 'apps-danger' : undefined}>{percent}%</span>
                    </div>
                    <div className="progress-track" role="meter" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={t('appBudget')}>
                      <div className={`progress-fill${percent > 100 ? ' over' : ''}`} style={{ width: `${Math.min(percent, 100)}%` }} />
                    </div>
                    <span className="muted mono">
                      {app.lastUs} / {app.budgetUs} µs{app.maxUs > 0 ? ` · ${t('appMaxCost')} ${app.maxUs} µs` : ''}
                    </span>
                  </div>
                ) : null}
                {app.degraded ? <span className="tag apps-warning" title={t('appDegradedHint')}>{t('appDegraded')}</span> : null}
                {app.overruns > 0 ? <span className="tag">{t('appOverruns')} {app.overruns}</span> : null}
                {needsRevive(app) ? <p className="apps-danger">{t('appKilledHint')}</p> : app.state === 'suspended' ? <p className="muted">{t('appSuspendedHint')}</p> : null}
                <footer className="apps-row-actions">
                  {needsRevive(app) ? (
                    <button type="button" className="button tiny primary" disabled={disabled} onClick={() => void run({ command: 'app_revive', name: app.name }, t('appRevived'))}>
                      {t('appRevive')}
                    </button>
                  ) : empty ? null : app.state === 'running' ? (
                    <button type="button" className="button tiny" disabled={disabled} onClick={() => void run({ command: 'app_disable', name: app.name }, t('appDisabled'))}>
                      {t('appDisable')}
                    </button>
                  ) : app.state === 'suspended' ? null : (
                    <button type="button" className="button tiny" disabled={disabled} onClick={() => void run({ command: 'app_enable', name: app.name }, t('appEnabled'))}>
                      {t('appEnable')}
                    </button>
                  )}
                  {supportsRegistry && bound ? (
                    <button type="button" className="button tiny ghost" disabled={disabled || !maintenanceMode} title={needsMaintenance} onClick={() => void run({ command: 'app_deactivate', id: bound.id }, t('appDeactivated'))}>
                      {t('appDeactivate')}
                    </button>
                  ) : null}
                </footer>
              </article>
            );
          })}
          {!apps.length ? <p className="empty">{loading ? t('loading') : t('appNoApps')}</p> : null}
        </div>
      </section>

      {supportsRegistry ? (
        <>
          <section className="card" aria-labelledby="apps-packages-title">
            <div className="card-head">
              <h2 id="apps-packages-title" className="section-title">
                {t('installedPackages')}
              </h2>
              {!maintenanceMode ? <span className="muted">{t('appRequiresMaintenance')}</span> : null}
            </div>
            <ul className="apps-rows">
              {flowPackages.map(packageRow)}
              {!flowPackages.length ? <li className="empty">{t('appNoPackages')}</li> : null}
            </ul>
          </section>
          <section className="card" aria-labelledby="apps-views-title">
            <div className="card-head">
              <h2 id="apps-views-title" className="section-title">
                {t('installedReadouts')}
              </h2>
              <span className="muted">{t('appsViewsNotRendered')}</span>
            </div>
            <ul className="apps-rows">
              {viewPackages.map(packageRow)}
              {!viewPackages.length ? <li className="empty">{t('appNoReadouts')}</li> : null}
            </ul>
          </section>
          <section className="card" aria-labelledby="apps-events-title">
            <div className="card-head">
              <h2 id="apps-events-title" className="section-title">
                {t('appEvents')}
              </h2>
              {events.length ? <span className="muted">{events.length}</span> : null}
            </div>
            {rolledOff > 0 ? <p className="muted">{t('appEventsRolledOff', { shown: events.length, older: rolledOff })}</p> : null}
            <ol className="apps-events">
              {events.map((event, index) => {
                const next = events[index + 1];
                return (
                  <li key={event.seq}>
                    <span className="mono muted">#{event.seq}</span>
                    <span className="mono muted" title={t('appEventGap')}>
                      {next ? formatGap(event.ms - next.ms) : ''}
                    </span>
                    <span className="mono muted" title={t('appEventFrame')}>
                      f{event.frameSeq}
                    </span>
                    <span className="mono">{event.app}</span>
                    <strong>{event.event}</strong>
                    {event.detail ? <span className="tag">{event.detail}</span> : null}
                    {event.value !== undefined ? <em>{event.value}</em> : null}
                  </li>
                );
              })}
              {!events.length ? <li className="empty">{t('appEventsEmpty')}</li> : null}
            </ol>
          </section>
        </>
      ) : null}
      {confirmElement}
    </div>
  );
}

function formatGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `+${Math.round(ms)} ms`;
  if (ms < 60000) return `+${(ms / 1000).toFixed(1)} s`;
  return `+${Math.round(ms / 60000)} min`;
}

const MIN_INTERVAL_MS = 500;

/** What the running apps put on the OLED, the status LED and the strip, as the device reports it (app_view, firmware v1.7.0). */
function LivePreview({ poll, active, paused }: { poll: CommandRunner; active: boolean; paused: boolean }) {
  const t = useAppsT();
  const [enabled, setEnabled] = useState(true);
  const [view, setView] = useState<AppViewState | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [stale, setStale] = useState(false);
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!active) setView(null);
  }, [active]);

  useEffect(() => {
    if (!enabled || !active || unsupported) return undefined;
    let cancelled = false;
    let timer = 0;
    let interval = MIN_INTERVAL_MS;
    const tick = async () => {
      if (cancelled) return;
      if (!pausedRef.current && document.visibilityState === 'visible') {
        const started = performance.now();
        try {
          const { result } = await pollRef.current({ command: 'app_view' });
          if (!cancelled && result) {
            if (isUnknownCommand(result)) setUnsupported(true);
            else if (!resultFailure(result)) {
              setView(parseAppView(result));
              setStale(false);
            }
            // Twice the round trip, so the preview never takes more than half the link.
            interval = Math.max(MIN_INTERVAL_MS, Math.round((performance.now() - started) * 2));
          }
        } catch {
          if (!cancelled) setStale(true);
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), interval);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, active, unsupported]);

  return (
    <section className={`card apps-live${stale ? ' stale' : ''}`} aria-labelledby="apps-live-title">
      <div className="card-head">
        <h2 id="apps-live-title" className="section-title">
          {t('appLiveTitle')}
        </h2>
        {!unsupported ? (
          <label className="apps-check">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            {t('appLiveToggle')}
          </label>
        ) : null}
      </div>
      {unsupported ? (
        <p className="muted">{t('appLiveUnsupported')}</p>
      ) : !active ? (
        <p className="muted">{t('appLiveIdle')}</p>
      ) : (
        <div className="apps-live-grid">
          {view?.oled.hw !== false ? (
            <div>
              <OledPanel rows={view?.oled.rows ?? [null, null, null, null]} />
              {view && !view.oled.onScreen ? <p className="muted">{t('appLiveOffScreen')}</p> : null}
            </div>
          ) : null}
          <LedDot rgb={view?.statusLed.rgb ?? [0, 0, 0]} />
          {view?.extLed.pixels?.length ? <StripPixels pixels={view.extLed.pixels} /> : null}
        </div>
      )}
    </section>
  );
}
