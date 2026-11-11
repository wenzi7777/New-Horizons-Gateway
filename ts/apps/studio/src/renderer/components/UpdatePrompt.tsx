// Shown while NH Studio is open and a newer release exists: the update used to be
// visible only in Settings, and an app left running for days never looked again.
import { Download, ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { UpdateState } from '../../shared/areas/app';
import { appApi } from '../areas/app/api';
import { useAreaT } from '../areas/i18n';
import { SETTINGS_STRINGS } from '../pages/settings/strings';
import { updateLine } from '../pages/SettingsPage';
import { useStudio } from '../state/studio';
import { Notice } from './ui';

export function UpdatePrompt() {
  const { api } = useStudio();
  const st = useAreaT(SETTINGS_STRINGS);
  const app = useMemo(() => appApi(api), [api]);
  const [state, setState] = useState<UpdateState | null>(null);
  const [later, setLater] = useState('');
  useEffect(() => {
    let live = true;
    void app.updateState().then((s) => live && setState(s), () => undefined);
    const off = app.on('update', setState);
    return () => {
      live = false;
      off();
    };
  }, [app]);

  if (!state) return null;
  const working = state.phase === 'downloading' || state.phase === 'verifying' || state.phase === 'installing';
  const offer = state.phase === 'available' || state.phase === 'ready' || (state.phase === 'error' && !!state.latestVersion && !state.noAssetForPlatform);
  if (!working && !(offer && later !== state.latestVersion)) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label={st('updatePromptTitle')} onKeyDown={(e) => e.key === 'Escape' && !working && setLater(state.latestVersion)}>
        <h3>{st('updatePromptTitle')}</h3>
        <p>{st('updatePromptCopy', { latest: state.latestVersion, current: state.currentVersion })}</p>
        {working || state.phase === 'error' ? <p aria-live="polite">{updateLine(st, state)}</p> : null}
        {state.phase === 'downloading' ? <progress max={state.totalBytes || 1} value={state.downloadedBytes} aria-label={updateLine(st, state)} /> : null}
        <Notice>{st('unsignedNote')}</Notice>
        <div className="actions">
          {state.notesUrl ? (
            <button type="button" className="button" onClick={() => void app.openReleaseNotes()}>
              <ExternalLink size={14} aria-hidden="true" /> {st('releaseNotes')}
            </button>
          ) : null}
          <button type="button" className="button" disabled={working} onClick={() => setLater(state.latestVersion)}>
            {st('updateLater')}
          </button>
          <button type="button" className="button primary" disabled={working} onClick={() => void app.installUpdate()}>
            <Download size={14} aria-hidden="true" /> {st('install', { version: state.latestVersion })}
          </button>
        </div>
      </div>
    </div>
  );
}
