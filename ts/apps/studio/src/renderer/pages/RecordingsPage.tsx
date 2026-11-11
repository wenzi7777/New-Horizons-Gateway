// Recordings: a table grouped by device and day, a detail panel with the
// timeline (min/max band + events), export / reveal / delete, and the data
// folder with its Change button.

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChartLine, Download, FolderOpen, FolderSearch, Trash2, X } from 'lucide-react';

import type { RecordingSummary, RecordingTimeline } from '../../shared/contract';
import { TimelineChart } from '../components/TimelineChart';
import { Card, Facts, Notice, useConfirm } from '../components/ui';
import { formatBytes, formatDate, formatDateTime, formatDuration, formatTime, relativeDay } from '../lib/format';
import type { Route } from '../lib/navigation';
import { groupRecordingsByDevice, totalBytes } from '../lib/recordings';
import { useStudio, type T } from '../state/studio';

type Props = { route: Extract<Route, { area: 'recordings' }>; navigate: (route: Route) => void };

export function syncLabel(t: T, r: RecordingSummary): string {
  if (r.inProgress) return t('inProgress');
  return r.syncState === 'synced' ? t('syncSynced') : r.syncState === 'uploading' ? t('syncUploading') : t('syncLocal');
}

export function RecordingsPage({ route, navigate }: Props) {
  const { t, snapshot, locale, exec, api, toast } = useStudio();
  const recordings = snapshot?.recordings ?? [];
  const groups = useMemo(() => groupRecordingsByDevice(recordings), [recordings]);
  const selected = route.id ? recordings.find((r) => r.id === route.id) ?? null : null;
  const now = Date.now();
  const dayTitle = (ms: number) => {
    const rel = relativeDay(ms, now);
    return rel === 'today' ? t('today') : rel === 'yesterday' ? t('yesterday') : formatDate(ms, locale);
  };

  return (
    <div className="stack">
      <Card
        title={t('dataFolder')}
        copy={t('dataFolderCopy')}
        actions={
          <button
            className="button"
            type="button"
            onClick={() =>
              void exec(t('dataFolder'), () => api.chooseDataFolder(), { success: false }).then((o) => {
                if (o.ok && o.data) toast('success', t('dataFolderChanged'));
              })
            }
          >
            <FolderOpen size={14} aria-hidden="true" />
            {t('changeFolder')}
          </button>
        }
      >
        <div className="path-line">
          <code className="mono">{snapshot?.settings.dataFolder}</code>
          <span className="muted">{t('totalSize', { size: formatBytes(totalBytes(recordings)) })}</span>
        </div>
      </Card>

      <div className={`recordings-layout${selected || route.id ? ' with-detail' : ''}`}>
        <section aria-label={t('navRecordings')}>
          <p className="list-hint">{t('recordingsCopy')}</p>
          {recordings.length === 0 ? (
            <p className="empty">{t('noRecordings')}</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table recordings-table">
                <thead>
                  <tr>
                    <th scope="col">{t('colTime')}</th>
                    <th scope="col">{t('colDuration')}</th>
                    <th scope="col" className="num">{t('colFrames')}</th>
                    <th scope="col" className="num">{t('colSize')}</th>
                    <th scope="col">{t('colSync')}</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <Fragment key={g.uid}>
                      <tr className="group-row device">
                        <th scope="rowgroup" colSpan={5}>
                          <span>{g.deviceName}</span>
                          <span className="muted mono">{g.uid}</span>
                          <span className="muted">{formatBytes(g.bytes)}</span>
                        </th>
                      </tr>
                      {g.days.map((day) => (
                        <Fragment key={day.key}>
                          <tr className="group-row day">
                            <th scope="rowgroup" colSpan={5}>{dayTitle(day.startMs)}</th>
                          </tr>
                          {day.items.map((r) => {
                            const active = r.id === route.id;
                            return (
                              <tr
                                key={r.id}
                                className={`rec-row${active ? ' active' : ''}`}
                                aria-selected={active}
                                tabIndex={0}
                                onClick={() => navigate({ area: 'recordings', id: r.id })}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    navigate({ area: 'recordings', id: r.id });
                                  }
                                }}
                              >
                                <td>
                                  {formatTime(r.startedAtMs, locale)}
                                  {r.inProgress ? <span className="tag rec">{t('recBadge')}</span> : null}
                                </td>
                                <td className="num-text">{formatDuration(r.durationMs)}</td>
                                <td className="num">{r.frames.toLocaleString(locale)}</td>
                                <td className="num">{formatBytes(r.bytes)}</td>
                                <td>
                                  <span className={`tag ${r.inProgress ? 'rec' : r.syncState === 'synced' ? 'accent' : r.syncState === 'uploading' ? 'waiting' : ''}`}>{syncLabel(t, r)}</span>
                                </td>
                              </tr>
                            );
                          })}
                        </Fragment>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {route.id ? (
          selected ? (
            <RecordingDetail recording={selected} onClose={() => navigate({ area: 'recordings', id: null })} dayTitle={dayTitle} onAnalyze={() => navigate({ area: 'tools', path: ['analysis', ...selected.id.split('/')] })} />
          ) : (
            <Card title={t('navRecordings')}>
              <p className="empty">{t('recordingGone')}</p>
            </Card>
          )
        ) : null}
      </div>
    </div>
  );
}

function RecordingDetail({ recording, onClose, dayTitle, onAnalyze }: { recording: RecordingSummary; onClose: () => void; dayTitle: (ms: number) => string; onAnalyze: () => void }) {
  const { t, locale, api, exec, platform, toast } = useStudio();
  const [timeline, setTimeline] = useState<RecordingTimeline | null>(null);
  const [error, setError] = useState('');
  const [dialog, ask] = useConfirm();
  // Reload when a running recording grows (every ~10 s) or another is chosen.
  const growth = recording.inProgress ? Math.floor(recording.durationMs / 10_000) : 0;

  useEffect(() => {
    let alive = true;
    setError('');
    api.timeline(recording.id).then(
      (next) => alive && setTimeline(next),
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [api, recording.id, growth]);

  const exportIt = async () => {
    const outcome = await exec(t('exportRecording'), () => api.exportRecording(recording.id), { success: false });
    if (outcome.ok && typeof outcome.data === 'string') toast('success', t('exportedTo', { path: outcome.data }));
  };

  const remove = async () => {
    const ok = await ask({
      title: t('confirmDeleteTitle'),
      message: t('confirmDeleteMessage', { device: recording.deviceName, time: formatDateTime(recording.startedAtMs, locale) }),
      confirmLabel: t('deleteAction'),
      danger: true,
    });
    if (!ok) return;
    const outcome = await exec(t('deleteRecording'), () => api.deleteRecording(recording.id), { success: t('recordingDeleted') });
    if (outcome.ok) onClose();
  };

  return (
    <aside className="card recording-detail" aria-label={`${recording.deviceName} ${formatDateTime(recording.startedAtMs, locale)}`}>
      <header className="card-head">
        <div>
          <h3>{recording.deviceName}</h3>
          <p className="card-copy">
            {dayTitle(recording.startedAtMs)} {formatTime(recording.startedAtMs, locale)}
          </p>
        </div>
        <button className="icon-button" type="button" aria-label={t('closeDetail')} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <Facts
        items={[
          [t('infoStarted'), formatDateTime(recording.startedAtMs, locale)],
          [t('infoDuration'), formatDuration(recording.durationMs)],
          [t('infoFrames'), recording.frames.toLocaleString(locale)],
          [t('infoSize'), formatBytes(recording.bytes)],
          [t('infoSync'), syncLabel(t, recording)],
          [t('infoDevice'), <span className="mono">{recording.uid}</span>],
        ]}
      />
      <div className="field-note path-line">
        <span>{t('infoFolder')}:</span> <code className="mono">{recording.id}</code>
      </div>

      <h4>{t('timelineTitle')}</h4>
      <p className="field-note">{t('timelineCopy')}</p>
      {error ? (
        <Notice kind="error">{t('timelineFailed', { error })}</Notice>
      ) : !timeline ? (
        <p className="muted">{t('timelineLoading')}</p>
      ) : (
        <>
          <TimelineChart timeline={timeline} label={t('timelineTitle')} />
          <Facts
            items={[
              [t('lostFrames'), timeline.lostFrames],
              [t('gapsLabel'), timeline.gaps],
            ]}
          />
          <h4>{t('eventsLabel')}</h4>
          {timeline.events.length === 0 ? (
            <p className="muted">{t('noEvents')}</p>
          ) : (
            <ul className="event-list">
              {timeline.events.map((ev, i) => (
                <li key={i}>
                  <span className="mono">{formatDuration(ev.atMs)}</span>
                  <span>{ev.label}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="actions detail-actions">
        <button className="button primary" type="button" disabled={recording.inProgress} onClick={() => void exportIt()} title={t('exportCopy')}>
          <Download size={14} aria-hidden="true" />
          {t('exportRecording')}
        </button>
        <button className="button" type="button" disabled={recording.inProgress} title={recording.inProgress ? t('analyzeBlockedInProgress') : t('analyzeRecordingCopy')} onClick={onAnalyze}>
          <ChartLine size={14} aria-hidden="true" />
          {t('analyzeRecording')}
        </button>
        <button className="button" type="button" onClick={() => void exec(platform === 'win32' ? t('revealInExplorer') : t('revealInFinder'), () => api.revealRecording(recording.id), { success: false })}>
          <FolderSearch size={14} aria-hidden="true" />
          {platform === 'win32' ? t('revealInExplorer') : t('revealInFinder')}
        </button>
        <span className="spacer" />
        <button className="button danger" type="button" disabled={recording.inProgress} title={recording.inProgress ? t('deleteBlockedInProgress') : undefined} onClick={() => void remove()}>
          <Trash2 size={14} aria-hidden="true" />
          {t('deleteRecording')}
        </button>
      </div>
      {recording.inProgress ? <p className="field-note">{t('deleteBlockedInProgress')}</p> : null}
      {dialog}
    </aside>
  );
}
