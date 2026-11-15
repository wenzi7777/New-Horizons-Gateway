// Everything about one app, as a sheet over the list (the Desktop's
// AppDetailSheet.tsx): what it is and may do, how busy it has been, what it
// said lately, and what can be done to it.
import { useEffect } from 'react';
import { ArrowUpToLine, Pause, Play, RotateCcw, Store, Trash2, X } from 'lucide-react';

import { type AppEventEntry, type AppLoadStats, type AppViewState, type DeviceApp, formatBytes, formatCpu, runtimeName } from '../../lib/deviceApps';
import { CAPABILITIES, DANGEROUS_CAPABILITIES } from '../../sdk/lib/index.mjs';
import { useAppsT } from '../../strings';
import { AppGlyph, AppSwitch, LoadBadge, LoadSparkline } from './AppParts';
import { cardState } from './RunningAppCard';

/** Capability names in a mask, in the library's order. */
function capabilityNames(mask: number): string[] {
  return Object.entries(CAPABILITIES)
    .filter(([, bit]) => (mask & bit) !== 0)
    .map(([name]) => name);
}

/** Time since the previous event, from the device's own clock. */
function formatGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `+${Math.round(ms)} ms`;
  if (ms < 60000) return `+${(ms / 1000).toFixed(1)} s`;
  return `+${Math.round(ms / 60000)} min`;
}

export function AppDetailSheet({
  app,
  colour,
  load,
  history,
  view,
  events,
  eventsLoading,
  canReorder,
  isFirst,
  disabled,
  onClose,
  onToggle,
  onPause,
  onResume,
  onRevive,
  onMoveFirst,
  onOpenStore,
  onUninstall,
}: {
  app: DeviceApp;
  colour: number;
  load: AppLoadStats | null;
  history: readonly number[];
  view: AppViewState | null;
  events: AppEventEntry[];
  eventsLoading: boolean;
  canReorder: boolean;
  isFirst: boolean;
  disabled: boolean;
  onClose: () => void;
  onToggle: () => void;
  onPause: () => void;
  onResume: () => void;
  onRevive: () => void;
  onMoveFirst: () => void;
  onOpenStore: () => void;
  onUninstall: () => void;
}) {
  const t = useAppsT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const state = app.active ? cardState(app) : null;
  const runtime = app.runtime;
  const name = runtimeName(app);
  const capabilities = capabilityNames(app.capabilities);
  const dangerous = new Set<string>(DANGEROUS_CAPABILITIES);
  const grantedNames = new Set(capabilityNames(app.granted));
  const contended = (view?.oled.rows ?? []).flatMap((row, index) =>
    row && (row.app === name || row.contended.includes(name)) && row.contended.length ? [{ row: index + 1, winner: row.app }] : [],
  );

  return (
    <div className="modal-backdrop dapps-sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="dapps-sheet" role="dialog" aria-modal="true" aria-labelledby="dapps-sheet-title" onClick={(event) => event.stopPropagation()}>
        <header className="dapps-sheet-head">
          <AppGlyph kind={app.kind} colour={app.active ? colour : undefined} size={22} />
          <div className="dapps-sheet-title">
            <h3 id="dapps-sheet-title">{app.name}</h3>
            <span>
              v{app.version} · <span className="mono">{app.id}</span>
            </span>
          </div>
          <AppSwitch
            checked={app.active}
            disabled={disabled || (!app.active && app.packageState === 'needs_update')}
            label={t(app.active ? 'appsTurnOff' : 'appsTurnOn', { app: app.name })}
            onChange={() => onToggle()}
          />
          <button type="button" className="button ghost icon-button" aria-label={t('readoutClose')} title={t('readoutClose')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {app.summary ? <p className="dapps-sheet-summary">{app.summary}</p> : null}

        {state ? (
          <section className="dapps-sheet-group">
            <div className="dapps-sheet-status">
              <span className={`dapps-status ${state}`}>
                <i aria-hidden="true" />
                {t(`appsState_${state}`)}
              </span>
              {state === 'running' && load ? <LoadBadge load={load.load} level={load.level} /> : null}
            </div>
            {state === 'running' && load ? (
              <>
                <LoadSparkline points={history} level={load.level} />
                <dl className="dapps-sheet-stats">
                  <div><dt>{t('appsCpu1')}</dt><dd>{formatCpu(load.cpu1)}</dd></div>
                  <div><dt>{t('appsCpu10')}</dt><dd>{formatCpu(load.cpu10)}</dd></div>
                  <div><dt>{t('appsCpu60')}</dt><dd>{formatCpu(load.cpu60)}</dd></div>
                  <div><dt>{t('appsShare')}</dt><dd>{load.baseUs} µs</dd></div>
                  {load.borrowedUs > 0 ? <div><dt>{t('appsBorrowed')}</dt><dd>+{load.borrowedUs} µs</dd></div> : null}
                  {load.lentUs > 0 ? <div><dt>{t('appsLent')}</dt><dd>−{load.lentUs} µs</dd></div> : null}
                  {runtime ? <div><dt>{t('appsPressure')}</dt><dd>{runtime.suspensions} / {runtime.framesSkipped}</dd></div> : null}
                  {runtime && runtime.overruns > 0 ? <div><dt>{t('appOverruns')}</dt><dd>{runtime.overruns}</dd></div> : null}
                </dl>
                {load.level === 'overloaded' ? <p className="dapps-sheet-note warning">{t('appsOverloadedHint')}</p> : null}
              </>
            ) : (
              <p className={`dapps-sheet-note ${state}`}>{t(`appsHint_${state}`)}</p>
            )}
            {contended.length ? <p className="dapps-sheet-note">{contended.map((entry) => t('appsRowShared', { row: entry.row, winner: entry.winner })).join(' ')}</p> : null}
          </section>
        ) : null}

        <section className="dapps-sheet-group">
          <h4>{t('appsAbout')}</h4>
          <dl className="dapps-sheet-stats">
            <div><dt>{t('appsMemory')}</dt><dd>{app.memoryBytes ? formatBytes(app.memoryBytes) : '—'}</dd></div>
            <div><dt>{t('appsPackageSize')}</dt><dd>{formatBytes(app.size)}</dd></div>
            <div><dt>{t('appsEstimate')}</dt><dd>{app.estimatedUs ? `~${app.estimatedUs} µs` : t('appsTimeSliced')}</dd></div>
            {app.burst ? <div><dt>{t('appsBurst')}</dt><dd>{t('appsBurstHint')}</dd></div> : null}
          </dl>
          {capabilities.length ? (
            <ul className="dapps-caps">
              {capabilities.map((cap) => (
                <li key={cap} className={dangerous.has(cap) ? 'dangerous' : undefined}>
                  {cap}
                  {dangerous.has(cap) ? <small>{grantedNames.has(cap) ? t('appsGranted') : t('appsNotGranted')}</small> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="dapps-sheet-actions">
          {state === 'killed' ? (
            <button type="button" className="button tiny primary" disabled={disabled} onClick={onRevive}>
              <RotateCcw size={14} aria-hidden="true" />
              {t('appRevive')}
            </button>
          ) : null}
          {state === 'running' || state === 'suspended' ? (
            <button type="button" className="button tiny" disabled={disabled} onClick={onPause}>
              <Pause size={14} aria-hidden="true" />
              {t('appsPause')}
            </button>
          ) : null}
          {state === 'stopped' ? (
            <button type="button" className="button tiny" disabled={disabled} onClick={onResume}>
              <Play size={14} aria-hidden="true" />
              {t('appsResume')}
            </button>
          ) : null}
          {app.active && canReorder && !isFirst ? (
            <button type="button" className="button tiny" disabled={disabled} onClick={onMoveFirst}>
              <ArrowUpToLine size={14} aria-hidden="true" />
              {t('appsMoveFirst')}
            </button>
          ) : null}
          <button type="button" className="button tiny" onClick={onOpenStore}>
            <Store size={14} aria-hidden="true" />
            {t('appsInStore')}
          </button>
          <button type="button" className="button tiny danger dapps-destructive" disabled={disabled} onClick={onUninstall}>
            <Trash2 size={14} aria-hidden="true" />
            {t('appUninstall')}
          </button>
        </section>

        {app.active ? (
          <section className="dapps-sheet-group">
            <h4>{t('appEvents')}</h4>
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
                    <strong>{event.event}</strong>
                    {event.detail ? <span className="tag">{event.detail}</span> : null}
                    {event.value !== undefined ? <em>{event.value}</em> : null}
                  </li>
                );
              })}
              {!events.length ? <li className="empty">{eventsLoading ? t('loading') : t('appEventsEmpty')}</li> : null}
            </ol>
          </section>
        ) : null}
      </div>
    </div>
  );
}
