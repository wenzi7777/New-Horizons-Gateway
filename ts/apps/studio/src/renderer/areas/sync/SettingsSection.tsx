// The Sync section of the Settings page (owned by the sync area; the
// Settings page renders it under #/settings/sync): app token, connection
// test, upload policy, the upload queue, label / profile sync.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudUpload, Pause, Play, RefreshCw, Tags, FileJson, PlugZap, Trash2 } from 'lucide-react';

import type { SyncAreaStatus, SyncRecordingEntry } from '../../../shared/areas/sync';
import { Card, Facts, Field, Notice, Segmented } from '../../components/ui';
import { useStudio } from '../../state/studio';
import { useAreaT } from '../i18n';
import { syncApi } from './api';
import { SYNC_STRINGS, type SyncKey } from './strings';
import './sync.css';

type Policy = SyncAreaStatus['policy'];

const ERROR_KEYS: Record<string, SyncKey> = {
  network: 'errNetwork',
  unauthorized: 'errUnauthorized',
  forbidden: 'errForbidden',
  not_admin: 'errNotAdmin',
  no_token: 'errNoToken',
  no_server: 'errNoServer',
  token_invalid: 'errTokenInvalid',
  server_error: 'errServer',
  sync_unsupported: 'errUnsupported',
  recording_id_conflict: 'errConflict',
  data_file_missing: 'errMissing',
};

function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}

export default function SyncSettingsSection() {
  const { api, snapshot, updateSettings, locale } = useStudio();
  const st = useAreaT(SYNC_STRINGS);
  const sync = useMemo(() => syncApi(api), [api]);
  const [status, setStatus] = useState<SyncAreaStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const errorText = useCallback((code: string) => (ERROR_KEYS[code] ? st(ERROR_KEYS[code]) : st('errOther', { code })), [st]);
  const when = useCallback((ms: number) => (ms > 0 ? new Date(ms).toLocaleString(locale) : st('never')), [locale, st]);

  useEffect(() => {
    let live = true;
    sync.status().then((s) => live && setStatus(s), () => undefined);
    const offState = sync.on('state', (s) => setStatus(s));
    const offProgress = sync.on('progress', (p) => setStatus((s) => (s ? { ...s, current: p } : s)));
    return () => {
      live = false;
      offState();
      offProgress();
    };
  }, [sync]);

  const act = useCallback(
    async (name: string, run: () => Promise<unknown>, ok?: string) => {
      setBusy(name);
      setMessage(null);
      try {
        await run();
        if (ok) setMessage({ kind: 'success', text: ok });
        setStatus(await sync.status());
      } catch (error) {
        setMessage({ kind: 'error', text: errorText(error instanceof Error ? (error.message.split(': ').pop() ?? '') : String(error)) });
      } finally {
        setBusy('');
      }
    },
    [errorText, sync],
  );

  const saveToken = () =>
    act('token', async () => {
      const result = await sync.setToken(token);
      setToken('');
      if (!result.ok) throw new Error(result.error);
    }, st('connected'));

  const test = () =>
    act('test', async () => {
      const result = await sync.testConnection();
      if (!result.ok) throw new Error(result.error);
    }, st('connected'));

  const policy = (snapshot?.settings.syncPolicy ?? status?.policy ?? 'manual') as Policy;
  const pending = (status?.recordings ?? []).filter((r) => r.state !== 'synced');
  const queue = pending.slice(0, 50);

  const stateLabel = (r: SyncRecordingEntry) => st(r.state === 'queued' ? 'stateQueued' : r.state === 'uploading' ? 'stateUploading' : r.state === 'failed' ? 'stateFailed' : 'stateLocal');

  return (
    <div className="sync-section">
      <Card title={st('accountTitle')} copy={st('accountCopy')}>
        {status?.configured ? (
          <Facts
            items={[
              [st('server'), status.baseUrl || '-'],
              [st('token'), <code key="t">{status.tokenMasked}</code>],
              [st('lastCheck'), status.connection ? `${when(status.connection.checkedAtMs)} · ${status.connection.ok ? st('ok') : errorText(status.connection.error)}` : st('never')],
            ]}
          />
        ) : (
          <Notice kind="info">{st('noTokenHelp', { server: status?.baseUrl || '-' })}</Notice>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveToken();
          }}
        >
          <Field label={status?.configured ? st('replaceToken') : st('tokenLabel')} hint={st('tokenHint')}>
            {(id) => (
              <div className="sync-token-row">
                <input id={id} type="password" autoComplete="off" spellCheck={false} placeholder="nhapp_…" value={token} onChange={(e) => setToken(e.target.value)} />
                <button className="button primary" type="submit" disabled={!token.trim() || busy !== ''}>
                  {st('saveToken')}
                </button>
              </div>
            )}
          </Field>
        </form>
        <div className="sync-actions">
          <button className="button" type="button" onClick={() => void test()} disabled={!status?.configured || busy !== ''}>
            <PlugZap size={14} aria-hidden="true" /> {st('test')}
          </button>
          {status?.configured ? (
            <button className="button danger" type="button" onClick={() => void act('clear', () => sync.clearToken())} disabled={busy !== ''}>
              <Trash2 size={14} aria-hidden="true" /> {st('removeToken')}
            </button>
          ) : null}
        </div>
        {message ? (
          <div role={message.kind === 'error' ? 'alert' : 'status'}>
            <Notice kind={message.kind}>{message.text}</Notice>
          </div>
        ) : null}
      </Card>

      <Card title={st('policyTitle')} copy={st('policyCopy')}>
        <Segmented<Policy>
          label={st('policyTitle')}
          value={policy}
          options={[
            { value: 'manual', label: st('policyManual') },
            { value: 'auto', label: st('policyAuto') },
            { value: 'wifi_only', label: st('policyWifi') },
          ]}
          onChange={(syncPolicy) => void updateSettings({ syncPolicy })}
        />
        <p className="field-note">{st(policy === 'manual' ? 'policyManualNote' : policy === 'auto' ? 'policyAutoNote' : 'policyWifiNote')}</p>
      </Card>

      <Card
        title={st('queueTitle')}
        copy={status ? st('queueCounts', { queued: status.counts.queued + status.counts.local, failed: status.counts.failed, synced: status.counts.synced }) : undefined}
        actions={
          <div className="sync-actions">
            <button className="button primary" type="button" disabled={!status?.configured || busy !== ''} onClick={() => void act('all', () => sync.uploadNow())}>
              <CloudUpload size={14} aria-hidden="true" /> {st('uploadAll')}
            </button>
            {status?.paused ? (
              <button className="button" type="button" disabled={busy !== ''} onClick={() => void act('resume', () => sync.resume())}>
                <Play size={14} aria-hidden="true" /> {st('resume')}
              </button>
            ) : (
              <button className="button" type="button" disabled={busy !== ''} onClick={() => void act('pause', () => sync.pause())}>
                <Pause size={14} aria-hidden="true" /> {st('pause')}
              </button>
            )}
          </div>
        }
      >
        {status?.paused ? <Notice kind="warning">{st('pausedNote')}</Notice> : null}
        <p className="field-note">{st('lastUpload', { time: when(status?.lastUploadMs ?? 0) })}</p>
        {queue.length === 0 ? (
          <p className="field-note">{st('queueEmpty')}</p>
        ) : (
          <ul className="sync-queue" aria-label={st('queueTitle')}>
            {queue.map((r) => {
              const current = status?.current?.id === r.id ? status.current : null;
              return (
                <li key={r.id}>
                  <div className="sync-queue-head">
                    <span className="sync-queue-name" title={r.id}>
                      {r.deviceName} · {new Date(r.startedAtMs).toLocaleString(locale)}
                    </span>
                    <span className={`tag ${r.state === 'failed' ? 'waiting' : r.state === 'uploading' ? 'accent' : ''}`}>{stateLabel(r)}</span>
                  </div>
                  {current ? (
                    <progress className="sync-progress" max={current.totalBytes || 1} value={current.sentBytes} aria-label={st('progressLabel', { name: r.deviceName })}>
                      {bytes(current.sentBytes)}
                    </progress>
                  ) : null}
                  <div className="sync-queue-head">
                    <span className="sync-queue-meta">{current ? `${bytes(current.sentBytes)} / ${bytes(current.totalBytes)}` : bytes(r.bytes)}</span>
                    {r.state === 'failed' ? (
                      <button className="button tiny" type="button" disabled={busy !== ''} onClick={() => void act(`retry-${r.id}`, () => sync.retry(r.id))}>
                        <RefreshCw size={12} aria-hidden="true" /> {st('retry')}
                      </button>
                    ) : r.state !== 'uploading' ? (
                      <button className="button tiny" type="button" disabled={!status?.configured || busy !== ''} onClick={() => void act(`up-${r.id}`, () => sync.uploadNow(r.id))}>
                        {st('uploadOne')}
                      </button>
                    ) : null}
                  </div>
                  {r.state === 'failed' ? (
                    <span className="sync-error">
                      {errorText(r.error)}
                      {r.nextAttemptMs > 0 ? ` ${st('nextTry', { time: new Date(r.nextAttemptMs).toLocaleTimeString(locale) })}` : ''}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title={st('metaTitle')} copy={st('metaCopy')}>
        <Facts
          items={[
            [st('labels'), status?.labels ? `${when(status.labels.atMs)} · ${status.labels.ok ? st('metaResult', { pushed: status.labels.pushed, pulled: status.labels.pulled }) : errorText(status.labels.error)}` : st('never')],
            [st('profiles'), status?.profiles ? `${when(status.profiles.atMs)} · ${status.profiles.ok ? st('metaResult', { pushed: status.profiles.pushed, pulled: status.profiles.pulled }) : errorText(status.profiles.error)}` : st('never')],
          ]}
        />
        <div className="sync-actions">
          <button className="button" type="button" disabled={!status?.configured || busy !== ''} onClick={() => void act('labels', () => sync.syncLabelsNow())}>
            <Tags size={14} aria-hidden="true" /> {st('syncLabels')}
          </button>
          <button className="button" type="button" disabled={!status?.configured || busy !== ''} onClick={() => void act('profiles', () => sync.syncProfilesNow())}>
            <FileJson size={14} aria-hidden="true" /> {st('syncProfiles')}
          </button>
        </div>
      </Card>
    </div>
  );
}
