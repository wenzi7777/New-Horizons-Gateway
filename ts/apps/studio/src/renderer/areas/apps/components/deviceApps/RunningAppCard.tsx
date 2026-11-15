// One running app, the way a phone's app switcher shows it (the Desktop's
// RunningAppCard.tsx): what it draws now, how busy it is, a switch that ends it.
import { type AppLoadStats, type AppViewState, type DeviceApp, formatBytes, formatCpu, runtimeName } from '../../lib/deviceApps';
import { useAppsT } from '../../strings';
import { LedDot, OledPanel } from '../IndicatorViews';
import { AppGlyph, AppSwitch, LoadBadge, LoadSparkline } from './AppParts';

/** What the card's status dot says. An idle "running" app has nothing to run. */
export function cardState(app: DeviceApp): 'running' | 'stopped' | 'suspended' | 'killed' | 'faulted' {
  const runtime = app.runtime;
  if (!runtime) return 'faulted';
  if (runtime.state === 'running') return runtime.idle ? 'faulted' : 'running';
  if (runtime.state === 'stopped' || runtime.state === 'installed') return 'stopped';
  if (runtime.state === 'suspended') return 'suspended';
  if (runtime.state === 'killed') return 'killed';
  return 'faulted';
}

export function RunningAppCard({
  app,
  colour,
  view,
  load,
  history,
  disabled,
  pending,
  onToggle,
  onOpen,
}: {
  app: DeviceApp;
  colour: number;
  view: AppViewState | null;
  /** Live from app_view when there is one, else from the last app_list. */
  load: AppLoadStats | null;
  history: readonly number[];
  disabled: boolean;
  pending: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const t = useAppsT();
  const state = cardState(app);
  const name = runtimeName(app);
  const rows = (view?.oled.rows ?? []).map((row) => (row && row.app === name ? row : null));
  const drawsOled = rows.some(Boolean);
  const ledRequest = view?.statusLed.request && view.statusLed.request.app === name ? view.statusLed.request : null;
  const level = state === 'running' ? load?.level ?? 'low' : 'low';

  return (
    <article
      className={`dapps-card state-${state}${pending ? ' pending' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <header className="dapps-card-head">
        <AppGlyph kind={app.kind} colour={colour} />
        <div className="dapps-card-title">
          <strong>{app.name}</strong>
          <span className={`dapps-status ${state}`}>
            <i aria-hidden="true" />
            {t(`appsState_${state}`)}
            {load && load.borrowedUs > 0 && state === 'running' ? <em className="dapps-borrowing">{t('appsBorrowing')}</em> : null}
          </span>
        </div>
        <AppSwitch checked disabled={disabled} pending={pending} label={t('appsTurnOff', { app: app.name })} onChange={() => onToggle()} />
      </header>

      <div className={`dapps-card-preview${drawsOled || ledRequest ? '' : ' empty'}`}>
        {drawsOled ? <OledPanel rows={rows} /> : null}
        {ledRequest ? (
          <div className="dapps-card-led">
            <LedDot rgb={ledRequest.rgb} />
            {ledRequest.suppressed ? <small>{t('appsLedHeld')}</small> : null}
          </div>
        ) : null}
        {!drawsOled && !ledRequest ? <span>{t('appsNoOutput')}</span> : null}
      </div>

      {state === 'running' && load ? (
        <div className="dapps-card-load">
          <LoadBadge load={load.load} level={load.level} />
          <LoadSparkline points={history} level={level} />
        </div>
      ) : (
        <p className={`dapps-card-hint ${state}`}>{t(`appsHint_${state}`)}</p>
      )}

      <footer className="dapps-card-meta">
        <span>{formatBytes(app.memoryBytes)}</span>
        {state === 'running' && load ? <span>CPU {formatCpu(load.cpu10)}</span> : null}
        {app.burst ? <span className="dapps-chip">{t('appsBurst')}</span> : null}
        {app.runtime?.degraded ? (
          <span className="tag apps-warning" title={t('appDegradedHint')}>
            {t('appDegraded')}
          </span>
        ) : null}
      </footer>
    </article>
  );
}
