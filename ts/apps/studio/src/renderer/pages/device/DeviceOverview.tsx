// Device Overview: status, a live mini-preview, recording start/stop, name and
// group, refresh / reboot, and releasing the device.

import { useEffect, useState } from 'react';
import { Activity, Circle, RefreshCw, RotateCcw, Square, Unlink } from 'lucide-react';

import type { DeviceView } from '../../../shared/contract';
import { Heatmap } from '../../components/Heatmap';
import { Card, Facts, Notice, useConfirm } from '../../components/ui';
import { rebootCommand, statusCommand } from '../../lib/commands';
import { formatAgo, frameStats, formatValue } from '../../lib/format';
import type { Route } from '../../lib/navigation';
import { DEFAULT_RANGE } from '../../lib/pressureColor';
import { useLiveFrame, useStudio } from '../../state/studio';
import { batteryText, modeLabel } from '../DevicesPage';

export function DeviceOverview({ device, navigate }: { device: DeviceView; navigate: (route: Route) => void }) {
  const { t, exec, api } = useStudio();
  const [dialog, ask] = useConfirm();
  const frame = useLiveFrame(device.online && device.matrix ? device.uid : null);
  const stats = frame ? frameStats(frame.values) : null;
  const [nickname, setNickname] = useState(device.nickname);
  const [group, setGroup] = useState(device.group);
  const [busy, setBusy] = useState('');
  useEffect(() => setNickname(device.nickname), [device.uid, device.nickname]);
  useEffect(() => setGroup(device.group), [device.uid, device.group]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy('');
    }
  };

  const rec = device.recording;
  const toggleRecording = () =>
    run('rec', () =>
      exec(rec.enabled ? t('stopRecording') : t('startRecording'), () => api.setRecording(device.uid, !rec.enabled), {
        uid: device.uid,
        success: rec.enabled ? t('recordingStopped') : t('recordingStarted'),
      }),
    );

  const refresh = () => run('status', () => exec(t('actionStatus'), () => api.sendCommand(device.uid, statusCommand()), { uid: device.uid, payload: statusCommand(), success: t('statusRefreshed') }));

  const reboot = async () => {
    if (!(await ask({ title: t('confirmRebootTitle', { device: device.displayName }), message: t('confirmRebootMessage'), confirmLabel: t('actionReboot') }))) return;
    await run('reboot', () => exec(t('actionReboot'), () => api.sendCommand(device.uid, rebootCommand()), { uid: device.uid, payload: rebootCommand() }));
  };

  const release = async () => {
    if (
      !(await ask({
        title: t('confirmRemoveTitle', { device: device.displayName }),
        message: t('confirmRemoveMessage'),
        confirmLabel: t('releaseAction'),
        danger: true,
      }))
    )
      return;
    const name = device.displayName;
    const outcome = await exec(t('removeDevice'), () => api.release(device.uid), { uid: device.uid, success: t('deviceRemoved', { device: name }) });
    if (outcome.ok) navigate({ area: 'devices', uid: null, tab: 'overview' });
  };

  return (
    <div className="stack">
      {!device.online ? <Notice kind="warning">{t('deviceOfflineNotice')}</Notice> : null}
      {rec.error ? <Notice kind="error">{t('recordingError', { error: rec.error })}</Notice> : null}

      <div className="overview-grid">
        <Card
          title={t('livePreview')}
          actions={
            <button className="button tiny" type="button" disabled={!device.matrix} onClick={() => navigate({ area: 'live', uids: [device.uid] })}>
              <Activity size={13} aria-hidden="true" />
              {t('openLive')}
            </button>
          }
        >
          {device.matrix ? (
            <>
              <Heatmap
                values={frame?.values ?? null}
                rows={device.matrix.rows}
                cols={device.matrix.cols}
                range={DEFAULT_RANGE}
                maxHeight={240}
                label={t('heatmapLabel', { device: device.displayName })}
              />
              <div className="metric-row compact">
                <div className="metric">
                  <div className="metric-label">{t('liveMax')}</div>
                  <div className="metric-value">{stats ? formatValue(stats.max) : '-'}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">{t('liveMean')}</div>
                  <div className="metric-value">{stats ? formatValue(stats.mean) : '-'}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">{t('liveFps')}</div>
                  <div className="metric-value">{device.online ? device.fps : '-'}</div>
                </div>
              </div>
              {!device.online ? <p className="muted">{t('deviceOffline')}</p> : !frame ? <p className="muted">{t('liveWaiting')}</p> : null}
            </>
          ) : (
            <p className="empty">{t('liveNoMatrix')}</p>
          )}
        </Card>

        <div className="stack">
          <Card title={t('recordingSection')}>
            <div className="record-row">
              <span className={`record-state${rec.enabled ? ' on' : ''}`}>
                <span className="rec-dot" aria-hidden="true" />
                {rec.finishing ? t('recordingFinishing') : rec.enabled ? t('recordingActive') : t('recordingIdle')}
              </span>
              <button
                className={`button ${rec.enabled ? 'danger' : 'primary'}`}
                type="button"
                disabled={busy !== '' || rec.finishing || (!rec.enabled && !device.online)}
                onClick={() => void toggleRecording()}
              >
                {rec.enabled ? <Square size={13} aria-hidden="true" /> : <Circle size={13} fill="currentColor" aria-hidden="true" />}
                {rec.enabled ? t('stopRecording') : t('startRecording')}
              </button>
            </div>
          </Card>
          <Card title={t('quickActions')}>
            <div className="actions">
              <button className="button" type="button" disabled={busy !== '' || !device.online} onClick={() => void refresh()}>
                <RefreshCw size={13} aria-hidden="true" />
                {busy === 'status' ? t('running') : t('actionStatus')}
              </button>
              <button className="button" type="button" disabled={busy !== '' || !device.online} onClick={() => void reboot()}>
                <RotateCcw size={13} aria-hidden="true" />
                {busy === 'reboot' ? t('running') : t('actionReboot')}
              </button>
            </div>
          </Card>
        </div>
      </div>

      <Card title={t('cardStatus')}>
        <Facts
          items={[
            [t('infoMode'), modeLabel(t, device.mode)],
            [t('infoBattery'), batteryText(t, device) || '-'],
            [t('infoFps'), device.online ? t('fpsValue', { fps: device.fps }) : '-'],
            [t('infoMatrix'), device.matrix ? t('matrixValue', { rows: device.matrix.rows, cols: device.matrix.cols }) : '-'],
            [t('infoModel'), device.hardwareModel],
            [t('infoFirmware'), device.firmwareVersion],
            [t('infoUid'), <span className="mono">{device.uid}</span>],
            [t('infoLastSeen'), device.lastSeenMs ? formatAgo(device.lastSeenMs, Date.now()) : '-'],
          ]}
        />
      </Card>

      <Card title={t('nameAndGroup')}>
        <form
          className="field-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              if (nickname.trim() !== device.nickname) {
                await exec(t('nicknameLabel'), () => api.setNickname(device.uid, nickname.trim()), { uid: device.uid, success: t('nicknameSaved') });
              }
              if (group.trim() !== device.group) {
                await exec(t('groupLabel'), () => api.setGroup(device.uid, group.trim()), { uid: device.uid, success: t('groupSaved') });
              }
            })();
          }}
        >
          <div className="field">
            <label htmlFor="nickname">{t('nicknameLabel')}</label>
            <input id="nickname" type="text" value={nickname} maxLength={64} placeholder={device.displayName} onChange={(e) => setNickname(e.target.value)} />
            <span className="field-note">{t('nicknameHint')}</span>
          </div>
          <div className="field">
            <label htmlFor="group">{t('groupLabel')}</label>
            <input id="group" type="text" value={group} maxLength={64} onChange={(e) => setGroup(e.target.value)} />
            <span className="field-note">{t('groupHint')}</span>
          </div>
          <div className="form-footer">
            <button className="button primary" type="submit" disabled={nickname.trim() === device.nickname && group.trim() === device.group}>
              {t('save')}
            </button>
          </div>
        </form>
      </Card>

      <Card className="danger-zone" title={t('removeDevice')} copy={t('removeDeviceCopy')}>
        <div className="actions">
          <button className="button danger" type="button" onClick={() => void release()}>
            <Unlink size={13} aria-hidden="true" />
            {t('releaseAction')}
          </button>
        </div>
      </Card>
      {dialog}
    </div>
  );
}
