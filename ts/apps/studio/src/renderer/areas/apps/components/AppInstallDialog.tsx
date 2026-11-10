// Installing an app, start to finish in one dialog (the Desktop's
// AppInstallDialog): pick a device (compatible, online ones first), confirm,
// then watch each step -- maintenance, upload, install, restore. Maintenance
// is entered for the install and left again after it, but only when this
// dialog entered it. The package is a catalog app (downloaded and checked by
// the main process first) or one already validated (sideloaded / built in
// App Studio).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Circle, Loader2, X } from 'lucide-react';

import type { DeviceView } from '../../../../shared/contract';
import { Notice, Checkbox } from '../../../components/ui';
import { useStudio } from '../../../state/studio';
import { appsApi, errorCode } from '../api';
import { installBlocker, installMinFirmware, localised, type AppCatalogEntry, type AppPackage } from '../lib/appLibrary';
import { appErrorKey } from '../lib/deviceApps';
import { commandRunner, isMaintenance, runAppInstall, type InstallStep } from '../lib/deviceCommand';
import type { TransferProgress } from '../lib/deviceFileTransfer';
import { useAppsT } from '../strings';
import { PermissionList } from './LibraryPage';

type Stage = 'pick' | 'confirm' | 'installing' | 'done' | 'error';

type Props = {
  onClose: () => void;
  go: (path: string[]) => void;
  /** A device already chosen (the device's own Apps page): starts at confirm. */
  initialUid?: string;
} & ({ entry: AppCatalogEntry; pkg?: undefined } | { pkg: AppPackage; entry?: undefined });

export function AppInstallDialog({ entry, pkg, onClose, go, initialUid = '' }: Props) {
  const t = useAppsT();
  const { api, snapshot, locale } = useStudio();
  const client = useMemo(() => appsApi(api), [api]);
  const titleId = useId();
  const devices = useMemo(() => snapshot?.devices ?? [], [snapshot?.devices]);
  const [stage, setStage] = useState<Stage>(initialUid ? 'confirm' : 'pick');
  const [showAll, setShowAll] = useState(false);
  const [selectedUid, setSelectedUid] = useState(initialUid);
  const [step, setStep] = useState<InstallStep | null>(null);
  const [skipMaintenance, setSkipMaintenance] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef({ current: false });

  const app = entry ?? { id: pkg!.id, min_os: pkg!.min_os, version: pkg!.version, permissions: pkg!.permissions };
  const name = entry ? localised(entry.name, locale) : pkg!.id;
  const minFirmware = installMinFirmware(app);

  const candidates = useMemo(() => {
    const list = devices.map((device) => ({ device, blocker: installBlocker(app, device) }));
    return list.sort((a, b) => Number(Boolean(a.blocker)) - Number(Boolean(b.blocker)) || a.device.displayName.localeCompare(b.device.displayName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, app.min_os]);
  const usable = candidates.filter((item) => !item.blocker);
  const shown = showAll ? candidates : usable;
  const selected = candidates.find((item) => item.device.uid === selectedUid) ?? null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && stage !== 'installing') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage, onClose]);

  const describe = (raw: string) => {
    const key = appErrorKey(raw);
    return key ? t(key) : `${t('appErrorUnknown')}: ${raw}`;
  };
  const blockerText = (blocker: string) => (blocker === 'offline' ? t('appInstallBlockedOffline') : t('appInstallBlockedFirmware', { version: minFirmware }));

  async function install(device: DeviceView) {
    const already = isMaintenance(device.mode);
    setSkipMaintenance(already);
    setStage('installing');
    setError('');
    setProgress(null);
    abortRef.current.current = false;
    try {
      // Fetched and sha256-checked by the main process before touching the device.
      const validated = pkg ?? (await client.libraryPackage(app.id));
      await runAppInstall(commandRunner(api.sendCommand.bind(api), device.uid), {
        appId: validated.id,
        devicePath: validated.device_path,
        dataHex: validated.data_hex,
        sha256: validated.sha256,
        alreadyInMaintenance: already,
        onStep: setStep,
        onProgress: setProgress,
        abortRef: abortRef.current,
      });
      setStage('done');
    } catch (caught) {
      setError(describe(errorCode(caught)));
      setStage('error');
    }
  }

  const percent = progress && progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0;
  const steps: InstallStep[] = skipMaintenance ? ['upload', 'install'] : ['maintenance', 'upload', 'install', 'restore'];
  const stepIndex = step ? steps.indexOf(step) : stage === 'done' ? steps.length : -1;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && stage !== 'installing') onClose();
      }}
    >
      <div className="modal-panel apps-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="apps-dialog-head">
          <div>
            <h3 id={titleId}>{t('appInstallDialogTitle', { app: name })}</h3>
            <p className="muted">
              v{app.version} · {t('appMinOs')} {app.min_os}
            </p>
          </div>
          <button className="button ghost icon-button" type="button" aria-label={t('cancel')} disabled={stage === 'installing'} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {stage === 'pick' ? (
          <>
            <div className="apps-dialog-row">
              <span>{t('appInstallPickDevice')}</span>
              <label className="apps-check">
                <Checkbox checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
                {t('appInstallShowAll', { count: candidates.length - usable.length })}
              </label>
            </div>
            {shown.length ? (
              <div className="apps-device-picks" role="radiogroup" aria-label={t('appInstallPickDevice')}>
                {shown.map(({ device, blocker }) => (
                  <button
                    key={device.uid}
                    type="button"
                    role="radio"
                    aria-checked={selectedUid === device.uid}
                    disabled={Boolean(blocker)}
                    className={`apps-device-pick${selectedUid === device.uid ? ' selected' : ''}`}
                    onClick={() => setSelectedUid(device.uid)}
                  >
                    <strong>{device.displayName}</strong>
                    <span className="muted mono">{device.firmwareVersion || '-'}</span>
                    <span className={blocker ? 'apps-blocker' : 'muted'}>{blocker ? blockerText(blocker) : selectedUid === device.uid ? t('appInstallSelected') : t('appInstallChoose')}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="empty">{candidates.length ? t('appInstallNoCompatible') : t('appInstallNoDevices')}</p>
            )}
            <div className="actions">
              <button className="button" type="button" onClick={onClose}>
                {t('cancel')}
              </button>
              <button className="button primary" type="button" disabled={!selected || Boolean(selected.blocker)} onClick={() => setStage('confirm')}>
                {t('appInstallNext')}
              </button>
            </div>
          </>
        ) : null}

        {stage === 'confirm' && selected?.blocker ? (
          <>
            <Notice kind="error">
              {selected.device.displayName}: {blockerText(selected.blocker)}
            </Notice>
            <div className="actions">
              <button className="button" type="button" onClick={() => setStage('pick')}>
                {t('appInstallBack')}
              </button>
            </div>
          </>
        ) : null}
        {stage === 'confirm' && !selected ? (
          <>
            <Notice kind="error">{t('appInstallNoDevices')}</Notice>
            <div className="actions">
              <button className="button" type="button" onClick={() => setStage('pick')}>
                {t('appInstallBack')}
              </button>
            </div>
          </>
        ) : null}

        {stage === 'confirm' && selected && !selected.blocker ? (
          <>
            <p>
              <strong>{name}</strong> v{app.version} → <strong>{selected.device.displayName}</strong>
            </p>
            <p className="muted">{isMaintenance(selected.device.mode) ? t('appInstallMaintenanceKept') : t('appInstallMaintenanceNote')}</p>
            <PermissionList permissions={app.permissions ?? []} />
            <div className="actions">
              <button className="button" type="button" onClick={() => setStage('pick')}>
                {t('appInstallBack')}
              </button>
              <button className="button primary" type="button" onClick={() => void install(selected.device)}>
                {t('appInstallStart')}
              </button>
            </div>
          </>
        ) : null}

        {stage === 'installing' || stage === 'done' || stage === 'error' ? (
          <>
            <ol className="apps-steps" aria-live="polite">
              {steps.map((item, index) => {
                const state = stage === 'done' || index < stepIndex ? 'done' : index === stepIndex ? 'active' : 'pending';
                return (
                  <li key={item} className={`apps-step ${state}`}>
                    {state === 'done' ? <Check size={16} aria-hidden="true" /> : state === 'active' ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
                    <span>{t(`appInstallStep_${item}`)}</span>
                    {item === 'upload' && state === 'active' ? <span className="mono">{percent}%</span> : null}
                  </li>
                );
              })}
            </ol>
            {step === 'upload' ? (
              <div className="progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={t('appInstallStep_upload')}>
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
            ) : null}
            {stage === 'done' && selected ? <Notice kind="success">{t('appInstallDone', { device: selected.device.displayName })}</Notice> : null}
            {stage === 'error' ? (
              <Notice kind="error">
                {t('appInstallFailed')}: {error}
              </Notice>
            ) : null}
            <div className="actions">
              {stage === 'installing' ? (
                <button
                  className="button"
                  type="button"
                  onClick={() => {
                    abortRef.current.current = true;
                  }}
                >
                  {t('cancel')}
                </button>
              ) : (
                <>
                  {selected ? (
                    <button
                      className="button"
                      type="button"
                      onClick={() => {
                        onClose();
                        go(['device', selected.device.uid]);
                      }}
                    >
                      {t('appInstallOpenDeviceApps')}
                    </button>
                  ) : null}
                  {stage === 'error' ? (
                    <button className="button" type="button" onClick={() => setStage('pick')}>
                      {t('appInstallBack')}
                    </button>
                  ) : null}
                  <button className="button primary" type="button" onClick={onClose}>
                    {t('appInstallClose')}
                  </button>
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
