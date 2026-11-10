// The start-up splash (splash.html): brand, version and the start-up steps
// the main process runs (src/main/app/startup.ts), pushed as the app area's
// "splash" event. Questions (ports in use, an update) are answered with
// app.splashAnswer. No inline scripts (CSP), no network: works offline.
import '@nhgw/ui-tokens/tokens.css';
import './splash.css';

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, Check, Circle, Loader2, Minus } from 'lucide-react';
import { resolveLocale, type Locale } from '@nhgw/ui-tokens';

import type { SplashAnswer, SplashState, SplashStep } from '../../shared/areas/app';
import type { StudioApi } from '../../shared/contract';
import brandUrl from '../assets/nh-studio-rounded.svg';
import { splashT, type SplashKey } from './strings';

function bridge(): StudioApi | null {
  const api = (window as { nhStudio?: StudioApi }).nhStudio;
  return api && typeof api.call === 'function' ? api : null;
}

function StepIcon({ step }: { step: SplashStep }) {
  switch (step.status) {
    case 'done':
      return <Check size={14} className="ok" aria-hidden="true" />;
    case 'warn':
    case 'blocked':
      return <AlertTriangle size={14} className="warn" aria-hidden="true" />;
    case 'skipped':
      return <Minus size={14} className="dim" aria-hidden="true" />;
    case 'running':
      return <Loader2 size={14} className="spin" aria-hidden="true" />;
    default:
      return <Circle size={10} className="dim" aria-hidden="true" />;
  }
}

function Splash() {
  const api = bridge();
  const [state, setState] = useState<SplashState | null>(null);
  useEffect(() => {
    if (!api) return;
    const off = api.onAreaEvent('app', 'splash', (payload) => setState(payload as SplashState));
    void api.call<SplashState | null>('app', 'splashState').then((s) => s && setState((prev) => prev ?? s), () => undefined);
    return off;
  }, [api]);
  useEffect(() => {
    if (state) document.documentElement.dataset.theme = state.theme;
  }, [state?.theme]);

  const locale: Locale = resolveLocale([state?.locale ?? navigator.language]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const tr = (key: SplashKey, vars?: Record<string, string | number>) => splashT(locale, key, vars);
  const answer = (value: SplashAnswer) => void api?.call('app', 'splashAnswer', value);

  const current = state?.steps.find((step) => step.status === 'running' || step.status === 'blocked') ?? null;
  const last = [...(state?.steps ?? [])].reverse().find((step) => step.status !== 'pending') ?? null;
  const shown = current ?? last;
  const detailOf = (step: SplashStep) => (step.detail ? tr(`d_${step.detail}` as SplashKey, { error: '-', count: 0, version: '', ...step.vars }) : '');
  const update = state?.update;
  let progress = shown && shown.status !== 'pending' ? `${tr(`step_${shown.id}` as SplashKey)}${detailOf(shown) ? ` — ${detailOf(shown)}` : ''}` : tr('starting');
  if (update && (update.phase === 'downloading' || update.phase === 'verifying' || update.phase === 'installing')) {
    progress =
      update.phase === 'downloading'
        ? tr('downloading', { percent: update.totalBytes ? Math.floor((update.downloadedBytes / update.totalBytes) * 100) : 0 })
        : tr(update.phase);
  }
  const prompt = state?.prompt ?? null;
  const done = state?.steps.filter((step) => step.status !== 'pending' && step.status !== 'running' && step.status !== 'blocked').length ?? 0;
  const total = state?.steps.length ?? 5;

  return (
    <main className="splash" aria-busy={!state?.done}>
      <div className="splash-brand">
        <img src={brandUrl} width={64} height={64} alt="" draggable={false} />
        <div>
          <h1>{tr('fullName')}</h1>
          <p className="dim">{tr('version', { version: state?.version ?? '' })}</p>
        </div>
      </div>

      {prompt ? (
        <section className="splash-prompt" role="alertdialog" aria-labelledby="splash-prompt-title" aria-describedby="splash-prompt-copy">
          {prompt.kind === 'ports' ? (
            <>
              <h2 id="splash-prompt-title">{tr('portsTitle')}</h2>
              <p id="splash-prompt-copy">{tr('portsCopy')}</p>
              <p className="mono dim small">{prompt.message}</p>
              <div className="splash-actions">
                <button type="button" className="splash-button" onClick={() => answer('quit')}>
                  {tr('quit')}
                </button>
                <button type="button" className="splash-button" onClick={() => answer('continue')}>
                  {tr('continueAnyway')}
                </button>
                <button type="button" className="splash-button primary" autoFocus onClick={() => answer('retry')}>
                  {tr('retry')}
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 id="splash-prompt-title">{tr('updateTitle', { version: prompt.version })}</h2>
              <p id="splash-prompt-copy">{tr('updateCopy')}</p>
              <div className="splash-actions">
                {/^https:\/\//.test(prompt.notesUrl) ? (
                  <a className="splash-link" href={prompt.notesUrl} target="_blank" rel="noreferrer">
                    {tr('releaseNotes')}
                  </a>
                ) : null}
                <button type="button" className="splash-button" onClick={() => answer('later')}>
                  {tr('later')}
                </button>
                <button type="button" className="splash-button primary" autoFocus onClick={() => answer('install')}>
                  {tr('install')}
                </button>
              </div>
            </>
          )}
        </section>
      ) : (
        <section className="splash-progress">
          <ol className="splash-steps" aria-label={tr('starting')}>
            {(state?.steps ?? []).map((step) => (
              <li key={step.id} className={step.status} title={tr(`step_${step.id}` as SplashKey)}>
                <StepIcon step={step} />
              </li>
            ))}
          </ol>
          <div className="splash-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
            <span style={{ width: `${(done / total) * 100}%` }} />
          </div>
          <p className="splash-status" role="status" aria-live="polite">
            {progress}
          </p>
        </section>
      )}
    </main>
  );
}

const root = document.getElementById('splash-root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Splash />
    </StrictMode>,
  );
}
