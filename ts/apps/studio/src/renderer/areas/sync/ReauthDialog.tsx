// Shown when the server refuses this Studio's app token (revoked, or the server
// was reset): a sign-in form that gets a fresh token, applied right away.
import { useEffect, useMemo, useState } from 'react';
import { LogIn } from 'lucide-react';

import { Field, Notice, TextInput } from '../../components/ui';
import { useStudio } from '../../state/studio';
import { useAreaT } from '../i18n';
import { syncApi } from './api';
import { SYNC_STRINGS } from './strings';

export default function ReauthDialog({ onLater }: { onLater: () => void }) {
  const { api, snapshot } = useStudio();
  const st = useAreaT(SYNC_STRINGS);
  const sync = useMemo(() => syncApi(api), [api]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    sync.status().then((s) => s.account && setUsername((u) => u || s.account), () => undefined);
  }, [sync]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await sync.login(username, password);
      if (!result.ok) setError(result.error === 'invalid_credentials' ? st('errCredentials') : st('errOther', { code: result.error }));
    } catch (e) {
      setError(st('errOther', { code: e instanceof Error ? e.message : String(e) }));
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <form
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={st('reauthTitle')}
        onKeyDown={(e) => e.key === 'Escape' && onLater()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>{st('reauthTitle')}</h3>
        <p>{st('reauthCopy', { server: snapshot?.status.serverUrl.replace(/^wss?:/, 'https:').replace(/\/gateway\/ws$/, '') || '-' })}</p>
        <Field label={st('username')}>
          {(id) => <TextInput id={id} autoFocus autoComplete="username" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />}
        </Field>
        <Field label={st('password')}>
          {(id) => <TextInput id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        {error ? (
          <div role="alert">
            <Notice kind="error">{error}</Notice>
          </div>
        ) : null}
        <div className="actions">
          <button className="button" type="button" onClick={onLater} disabled={busy}>
            {st('reauthLater')}
          </button>
          <button className="button primary" type="submit" disabled={!username.trim() || !password || busy}>
            <LogIn size={14} aria-hidden="true" /> {busy ? st('signingIn') : st('signIn')}
          </button>
        </div>
      </form>
    </div>
  );
}
