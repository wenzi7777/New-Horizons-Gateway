// The first-run guide: which server, sign in with a Desktop account, whether
// recordings upload on their own, and which devices this app takes. Shown
// once after the splash (AppPrefs.onboardingDone); Settings → General opens
// it again. Every step can be skipped; each answer is saved as it is made.
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, LogIn } from 'lucide-react';

import type { ServerTarget } from '../../shared/contract';
import { appApi } from '../areas/app/api';
import { syncApi } from '../areas/sync/api';
import { isValidServerUrl } from '../lib/format';
import { useStudio } from '../state/studio';
import { AnimatedBrandMark } from './BrandArt';
import { Field, Notice, Segmented, TextInput } from './ui';

const STEPS = ['server', 'account', 'sync', 'devices'] as const;
type Step = (typeof STEPS)[number];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { t, api, snapshot, updateSettings, errorText } = useStudio();
  const sync = useMemo(() => syncApi(api), [api]);
  const app = useMemo(() => appApi(api), [api]);
  const [step, setStep] = useState<Step>('server');
  const settings = snapshot?.settings;
  const [manualUrl, setManualUrl] = useState(settings?.manualUrl ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [account, setAccount] = useState('');

  useEffect(() => {
    void sync.status().then((s) => setAccount(s.configured ? s.account || '…' : ''), () => undefined);
  }, [sync, step]);

  const index = STEPS.indexOf(step);
  const finish = async () => {
    await app.setPrefs({ onboardingDone: true }).catch(() => undefined);
    onDone();
  };
  const next = () => {
    setMessage(null);
    if (index === STEPS.length - 1) void finish();
    else setStep(STEPS[index + 1]!);
  };
  const back = () => {
    setMessage(null);
    if (index > 0) setStep(STEPS[index - 1]!);
  };

  const target = settings?.serverTarget ?? 'production';
  const manualInvalid = target === 'manual' && !isValidServerUrl(manualUrl);

  const signIn = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await sync.login(username, password);
      if (!result.ok) throw new Error(result.error);
      setMessage({ kind: 'success', text: t('onbSignedIn') });
      setAccount(username.trim());
    } catch (error) {
      const code = error instanceof Error ? (error.message.split(': ').pop() ?? '') : String(error);
      setMessage({ kind: 'error', text: code === 'invalid_credentials' ? t('onbBadLogin') : errorText(code) });
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-labelledby="onb-title">
      <div className="onboarding">
        <div className="onboarding-hero">
          <AnimatedBrandMark size={72} />
          <div>
            <h2 id="onb-title">{t('onbTitle')}</h2>
            <p className="muted">{t('onbStep', { n: index + 1, total: STEPS.length })}</p>
          </div>
        </div>
        <ol className="onboarding-dots" aria-hidden="true">
          {STEPS.map((s, i) => (
            <li key={s} className={i === index ? 'current' : i < index ? 'done' : ''} />
          ))}
        </ol>

        {step === 'server' ? (
          <section className="onboarding-body">
            <h3>{t('onbServerTitle')}</h3>
            <p>{t('onbServerCopy')}</p>
            <Segmented<ServerTarget>
              label={t('onbServerTitle')}
              value={target}
              options={[
                { value: 'production', label: t('onbServerProduction') },
                { value: 'local', label: t('onbServerLocal') },
                { value: 'manual', label: t('onbServerManual') },
              ]}
              onChange={(serverTarget) => void updateSettings({ serverTarget })}
            />
            {target === 'manual' ? (
              <Field label={t('onbServerAddress')} error={manualUrl && manualInvalid ? t('onbServerAddressInvalid') : undefined}>
                {(id) => (
                  <TextInput
                    id={id}
                    className="text-input"
                    value={manualUrl}
                    placeholder="ws://192.168.1.10:5051/newhorizons/gateway/ws"
                    spellCheck={false}
                    onChange={(e) => setManualUrl(e.target.value)}
                    onBlur={() => {
                      if (isValidServerUrl(manualUrl)) void updateSettings({ manualUrl });
                    }}
                  />
                )}
              </Field>
            ) : null}
          </section>
        ) : null}

        {step === 'account' ? (
          <section className="onboarding-body">
            <h3>{t('onbAccountTitle')}</h3>
            <p>{t('onbAccountCopy')}</p>
            {account ? (
              <Notice kind="success">{t('onbSignedInAs', { account })}</Notice>
            ) : (
              <form
                className="onboarding-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (username.trim() && password) void signIn();
                }}
              >
                <Field label={t('onbUsername')}>{(id) => <TextInput id={id} className="text-input" autoComplete="username" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
                <Field label={t('onbPassword')}>{(id) => <TextInput id={id} className="text-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
                <button className="button primary" type="submit" disabled={busy || !username.trim() || !password}>
                  <LogIn size={16} aria-hidden="true" /> {busy ? t('onbSigningIn') : t('onbSignIn')}
                </button>
              </form>
            )}
            {message ? <Notice kind={message.kind}>{message.text}</Notice> : null}
            <p className="field-note">{t('onbAccountLater')}</p>
          </section>
        ) : null}

        {step === 'sync' ? (
          <section className="onboarding-body">
            <h3>{t('onbSyncTitle')}</h3>
            <p>{t('onbSyncCopy')}</p>
            <Segmented
              label={t('onbSyncTitle')}
              value={settings?.syncPolicy ?? 'manual'}
              options={[
                { value: 'auto', label: t('onbSyncAuto') },
                { value: 'wifi_only', label: t('onbSyncWifi') },
                { value: 'manual', label: t('onbSyncManual') },
              ]}
              onChange={(syncPolicy) => void updateSettings({ syncPolicy })}
            />
            <p className="field-note">{t(settings?.syncPolicy === 'auto' ? 'onbSyncAutoNote' : settings?.syncPolicy === 'wifi_only' ? 'onbSyncWifiNote' : 'onbSyncManualNote')}</p>
          </section>
        ) : null}

        {step === 'devices' ? (
          <section className="onboarding-body">
            <h3>{t('onbDevicesTitle')}</h3>
            <p>{t('onbDevicesCopy')}</p>
            <div className="onboarding-choices" role="radiogroup" aria-label={t('onbDevicesTitle')}>
              {(['managed', 'all'] as const).map((policy) => (
                <button
                  key={policy}
                  type="button"
                  role="radio"
                  aria-checked={(settings?.offerPolicy ?? 'managed') === policy}
                  className={`onboarding-choice${(settings?.offerPolicy ?? 'managed') === policy ? ' selected' : ''}`}
                  onClick={() => void updateSettings({ offerPolicy: policy })}
                >
                  <strong>{t(policy === 'managed' ? 'onbDevicesManaged' : 'onbDevicesAll')}</strong>
                  <span>{t(policy === 'managed' ? 'onbDevicesManagedCopy' : 'onbDevicesAllCopy')}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <footer className="onboarding-actions">
          <button className="button ghost" type="button" onClick={() => void finish()}>
            {t('onbSkipAll')}
          </button>
          <span className="spacer" />
          {index > 0 ? (
            <button className="button" type="button" onClick={back}>
              <ArrowLeft size={16} aria-hidden="true" /> {t('back')}
            </button>
          ) : null}
          <button className="button primary" type="button" disabled={step === 'server' && manualInvalid} onClick={next}>
            {index === STEPS.length - 1 ? <Check size={16} aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}
            {index === STEPS.length - 1 ? t('onbFinish') : step === 'account' && !account ? t('onbSkipStep') : t('onbNext')}
          </button>
        </footer>
      </div>
    </div>
  );
}
