// An installed app that is not running (the Desktop's InstalledAppRow.tsx):
// a settings-list row with a switch that starts it. When the device would
// refuse it, the row says why instead of letting the operator find out.
import { type AppResources, type DeviceApp, admissionBlocker, formatBytes } from '../../lib/deviceApps';
import { useAppsT } from '../../strings';
import { AppGlyph, AppSwitch, isViewKind } from './AppParts';

export function InstalledAppRow({
  app,
  resources,
  disabled,
  pending,
  onToggle,
  onOpen,
}: {
  app: DeviceApp;
  resources: AppResources | null;
  disabled: boolean;
  pending: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const t = useAppsT();
  const view = isViewKind(app.kind);
  const blocker = view ? null : admissionBlocker(app, resources);

  return (
    <li className={`dapps-row${pending ? ' pending' : ''}`}>
      <button type="button" className="dapps-row-main" onClick={onOpen}>
        <AppGlyph kind={app.kind} />
        <span className="dapps-row-body">
          <span className="dapps-row-title">
            <strong>{app.name}</strong>
            <span className="dapps-row-version">v{app.version}</span>
          </span>
          <span className="dapps-row-meta">
            {view ? t(app.kind === 'panel' ? 'appKindPanel' : 'appKindReadout') : formatBytes(app.memoryBytes > 0 ? app.memoryBytes : app.size)}
            {app.burst ? <span className="dapps-chip">{t('appsBurst')}</span> : null}
            {app.packageState === 'needs_update' ? (
              <span className="tag apps-danger" title={t('appNeedsUpdateHint')}>
                {t('appNeedsUpdate')}
              </span>
            ) : app.packageState === 'load_failed' ? (
              <span className="tag apps-danger">{t('appLoadFailed')}</span>
            ) : null}
          </span>
        </span>
      </button>
      {view ? null : (
        <span className="dapps-row-side">
          {blocker ? (
            <span className="dapps-row-blocker">
              {blocker.kind === 'memory' ? t('appsNoMemory', { need: formatBytes(blocker.needBytes) }) : t('appsNoTime', { need: blocker.needUs })}
            </span>
          ) : null}
          <AppSwitch
            checked={false}
            disabled={disabled || Boolean(blocker) || app.packageState === 'needs_update'}
            pending={pending}
            label={t('appsTurnOn', { app: app.name })}
            onChange={() => onToggle()}
          />
        </span>
      )}
    </li>
  );
}
