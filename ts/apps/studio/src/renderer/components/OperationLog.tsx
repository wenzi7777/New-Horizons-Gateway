// The operation log panel: every action the user started, newest first,
// with its payload and outcome.

import { CheckCircle2, CircleAlert, Loader2, X } from 'lucide-react';

import { formatTime } from '../lib/format';
import { payloadSummary } from '../lib/opLog';
import { useStudio } from '../state/studio';

export function OperationLog({ onClose }: { onClose: () => void }) {
  const { opLog, clearOpLog, t, locale, snapshot } = useStudio();
  const nameOf = (uid: string) => snapshot?.devices.find((d) => d.uid === uid)?.displayName ?? uid;
  return (
    <aside id="op-log" className="op-log" aria-label={t('opLogTitle')}>
      <header className="op-log-head">
        <h2>{t('opLogTitle')}</h2>
        <div className="actions">
          <button className="button ghost tiny" type="button" disabled={opLog.length === 0} onClick={clearOpLog}>
            {t('opLogClear')}
          </button>
          <button className="icon-button" type="button" aria-label={t('opLogHide')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      {opLog.length === 0 ? (
        <p className="empty">{t('opLogEmpty')}</p>
      ) : (
        <ol className="op-list" aria-live="polite">
          {opLog.map((entry) => (
            <li key={entry.id} className={`op-entry ${entry.status}`}>
              <span className="op-icon" aria-label={entry.status === 'ok' ? t('opOk') : entry.status === 'error' ? t('opError') : t('opRunning')} role="img">
                {entry.status === 'ok' ? <CheckCircle2 size={14} /> : entry.status === 'error' ? <CircleAlert size={14} /> : <Loader2 size={14} className="spin" />}
              </span>
              <div className="op-main">
                <div className="op-title">
                  <strong>{entry.label}</strong>
                  <time className="op-time">{formatTime(entry.atMs, locale, true)}</time>
                </div>
                {entry.uid ? <span className="op-device">{nameOf(entry.uid)}</span> : null}
                {entry.payload ? <code className="op-payload">{payloadSummary(entry.payload)}</code> : null}
                {entry.status === 'error' && entry.message ? <span className="op-error">{entry.message}</span> : null}
                {entry.durationMs !== null ? <span className="op-duration">{entry.durationMs} ms</span> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
