// Settings: a two-pane page. Left: sections (#/settings/<section>); right:
// the section. Host settings go through api.updateSettings; Studio-only
// preferences, updates and maintenance through the "app" area.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, FileArchive, FolderOpen, Moon, RefreshCw, RotateCcw, Sun, SunMoon, Trash2 } from 'lucide-react';
import { LAB_NAME, LAB_URL, UNIVERSITY_URL, type ThemeMode } from '@nhgw/ui-tokens';

import type { AppInfo, AppPrefs, ConnectionInfo, PruneResult, UpdateState } from '../../shared/areas/app';
import type { ServerTarget, StudioSettings } from '../../shared/contract';
import { appApi } from '../areas/app/api';
import { useAreaT } from '../areas/i18n';
import SyncSettingsSection from '../areas/sync/SettingsSection';
import { AnimatedBrandMark, UAizuLogo } from '../components/BrandArt';
import { Card, Disclosure, Facts, Field, Notice, Segmented, StatusDot, SwitchRow, useConfirm, NumberInput, Select, TextInput } from '../components/ui';
import { formatBytes, formatDateTime, formatTime, isValidServerUrl, isValidStudioId } from '../lib/format';
import { LANGUAGE_NAMES, LOCALE_SETTINGS, type LocaleSetting } from '../lib/locale';
import type { Route } from '../lib/navigation';
import { useStudio } from '../state/studio';
import { nextSection, SECTION_LABELS, sectionOf, SETTINGS_SECTIONS, type SettingsSection } from './settings/sections';
import { SETTINGS_STRINGS, type SettingsKey } from './settings/strings';
import './settings/settings.css';

const DOWNLOAD_PAGE = 'https://wenzi7777.github.io/New-Horizons-Gateway/';
const GITHUB = 'https://github.com/wenzi7777/New-Horizons-Gateway';

type ST = (key: SettingsKey, vars?: Record<string, unknown>) => string;

function useAppClient() {
  const { api } = useStudio();
  return useMemo(() => appApi(api), [api]);
}

function usePrefs(): [AppPrefs | null, (patch: Partial<AppPrefs>) => void] {
  const app = useAppClient();
  const [prefs, setPrefs] = useState<AppPrefs | null>(null);
  useEffect(() => {
    void app.getPrefs().then(setPrefs, () => undefined);
    return app.on('prefs', setPrefs);
  }, [app]);
  return [prefs, (patch) => void app.setPrefs(patch).then(setPrefs, () => undefined)];
}

export function SettingsPage({ route, navigate }: { route: Extract<Route, { area: 'settings' }>; navigate: (route: Route) => void }) {
  const st = useAreaT(SETTINGS_STRINGS);
  const section = sectionOf(route.section);
  const refs = useRef<Partial<Record<SettingsSection, HTMLAnchorElement | null>>>({});
  const go = (next: SettingsSection, focus = false) => {
    navigate({ area: 'settings', section: next });
    if (focus) refs.current[next]?.focus();
  };
  return (
    <div className="settings-split">
      <nav className="settings-nav" aria-label={st('sectionsLabel')}>
        <ul>
          {SETTINGS_SECTIONS.map((id) => (
            <li key={id}>
              <a
                ref={(el) => {
                  refs.current[id] = el;
                }}
                href={`#/settings/${id}`}
                aria-current={id === section ? 'page' : undefined}
                className={id === section ? 'active' : ''}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    go(nextSection(section, event.key === 'ArrowDown' ? 1 : -1), true);
                  }
                }}
              >
                {st(SECTION_LABELS[id])}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-content" role="region" aria-label={st(SECTION_LABELS[section])}>
        <h2 className="settings-heading">{st(SECTION_LABELS[section])}</h2>
        {section === 'general' ? <GeneralSection st={st} /> : null}
        {section === 'connection' ? <ConnectionSection st={st} /> : null}
        {section === 'devices' ? <DevicesSection st={st} /> : null}
        {section === 'recording' ? <RecordingSection st={st} /> : null}
        {section === 'sync' ? <SyncSettingsSection /> : null}
        {section === 'updates' ? <UpdatesSection st={st} /> : null}
        {section === 'advanced' ? <AdvancedSection st={st} /> : null}
        {section === 'about' ? <AboutSection st={st} /> : null}
      </div>
    </div>
  );
}

function GeneralSection({ st }: { st: ST }) {
  const { t, snapshot, updateSettings, exec, theme, locale, platform } = useStudio();
  const settings = snapshot?.settings as StudioSettings;
  const [identity, setIdentity] = useState({ id: settings.pocketId, name: settings.displayName });
  useEffect(() => setIdentity({ id: settings.pocketId, name: settings.displayName }), [settings.pocketId, settings.displayName]);
  const [prefs, setPrefs] = usePrefs();
  const idValid = isValidStudioId(identity.id.trim());
  const dirty = identity.id.trim() !== settings.pocketId || identity.name.trim() !== settings.displayName;
  const nextAt = theme.nextChange ? formatTime(theme.nextChange.getTime(), locale) : '';
  return (
    <div className="stack">
      <Card title={st('identityTitle')}>
        <form
          className="field-grid"
          onSubmit={(event) => {
            event.preventDefault();
            if (idValid) void exec(t('sectionStudio'), () => updateSettings({ pocketId: identity.id.trim(), displayName: identity.name.trim() }), { success: t('settingsSaved') });
          }}
        >
          <Field label={t('studioNameLabel')} hint={t('studioNameHint')}>
            {(id) => <TextInput id={id} type="text" maxLength={64} value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} />}
          </Field>
          <Field label={t('studioIdLabel')} hint={t('gatewayIdHint')} error={!idValid ? t('err_gateway_id_invalid') : undefined}>
            {(id) => <TextInput id={id} type="text" className={`mono${idValid ? '' : ' invalid'}`} spellCheck={false} aria-invalid={!idValid} value={identity.id} onChange={(e) => setIdentity({ ...identity, id: e.target.value })} />}
          </Field>
          <div className="form-footer span-all">
            {dirty ? <span className="dirty-indicator">{t('unsavedChanges')}</span> : null}
            <button className="button primary" type="submit" disabled={!dirty || !idValid}>
              {t('save')}
            </button>
          </div>
        </form>
      </Card>
      <Card title={st('appearanceTitle')}>
        <div className="field">
          <span className="field-label">{t('themeLabel')}</span>
          <Segmented<ThemeMode>
            label={t('themeLabel')}
            value={theme.mode}
            options={[
              { value: 'auto', label: <><SunMoon size={14} aria-hidden="true" /> {t('themeAuto')}</> },
              { value: 'light', label: <><Sun size={14} aria-hidden="true" /> {t('themeLight')}</> },
              { value: 'dark', label: <><Moon size={14} aria-hidden="true" /> {t('themeDark')}</> },
            ]}
            onChange={(mode) => void updateSettings({ theme: mode })}
          />
          {theme.mode === 'auto' && nextAt ? <p className="field-note">{theme.theme === 'light' ? t('themeNextDark', { time: nextAt }) : t('themeNextLight', { time: nextAt })}</p> : null}
        </div>
        <Field label={t('language')}>
          {(id) => (
            <Select id={id} value={settings.locale} onChange={(e) => void updateSettings({ locale: e.target.value as LocaleSetting })}>
              {LOCALE_SETTINGS.map((value) => (
                <option key={value} value={value}>
                  {value === 'system' ? `${t('languageSystem')} (${LANGUAGE_NAMES[locale]})` : LANGUAGE_NAMES[value]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </Card>
      {prefs ? (
        <Card title={st('systemTitle')}>
          <SwitchRow checked={prefs.openAtLogin} onChange={(openAtLogin) => setPrefs({ openAtLogin })} title={st('openAtLoginTitle')} copy={st('openAtLoginCopy')} />
          <SwitchRow
            checked={prefs.keepRunningInBackground}
            onChange={(keepRunningInBackground) => setPrefs({ keepRunningInBackground })}
            title={st('backgroundTitle')}
            copy={platform === 'darwin' ? st('backgroundCopyMac') : st('backgroundCopyWin')}
          />
          <div className="actions">
            <button type="button" className="button" onClick={() => setPrefs({ onboardingDone: false })}>
              {t('onbReopen')}
            </button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function ConnectionSection({ st }: { st: ST }) {
  const { t, snapshot, updateSettings, exec } = useStudio();
  const app = useAppClient();
  const settings = snapshot?.settings as StudioSettings;
  const status = snapshot?.status;
  const [manualUrl, setManualUrl] = useState(settings.manualUrl);
  useEffect(() => setManualUrl(settings.manualUrl), [settings.manualUrl]);
  const [conn, setConn] = useState<ConnectionInfo | null>(null);
  useEffect(() => {
    void app.connectionInfo().then(setConn, () => undefined);
  }, [app, snapshot]);
  const upstream = status?.upstream ?? 'offline';
  const urlValid = isValidServerUrl(manualUrl);
  const state = !settings.relayEnabled ? 'disabled' : upstream;
  return (
    <div className="stack">
      <Card title={st('serverTitle')}>
        <div className="conn-status" role="status">
          <StatusDot state={state} />
          <strong>{!settings.relayEnabled ? t('connRelayOff') : upstream === 'online' ? t('connOnline') : upstream === 'connecting' ? t('connConnecting') : t('connOffline')}</strong>
          {status?.serverUrl ? <code className="mono muted">{status.serverUrl}</code> : null}
        </div>
        <SwitchRow checked={settings.relayEnabled} onChange={(relayEnabled) => void exec(t('relayTitle'), () => updateSettings({ relayEnabled }), { success: false })} title={t('relayTitle')} copy={t('relayCopy')} />
        <div className="field">
          <span className="field-label">{t('targetLabel')}</span>
          <Segmented<ServerTarget>
            label={t('targetLabel')}
            value={settings.serverTarget}
            options={[
              { value: 'production', label: t('targetProduction') },
              { value: 'local', label: t('targetLocal') },
              { value: 'manual', label: t('targetManual') },
            ]}
            onChange={(serverTarget) => void exec(t('targetLabel'), () => updateSettings({ serverTarget }), { success: false })}
          />
        </div>
        {settings.serverTarget === 'manual' ? (
          <form
            className="field-row-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (urlValid) void exec(t('manualUrlLabel'), () => updateSettings({ manualUrl: manualUrl.trim() }), { success: t('settingsSaved') });
            }}
          >
            <Field label={t('manualUrlLabel')} error={manualUrl && !urlValid ? t('err_invalid_manual_url') : undefined}>
              {(id) => (
                <TextInput id={id} type="text" value={manualUrl} placeholder="wss://example.org/newhorizons/gateway/ws" spellCheck={false} aria-invalid={Boolean(manualUrl) && !urlValid} className={manualUrl && !urlValid ? 'invalid' : ''} onChange={(e) => setManualUrl(e.target.value)} />
              )}
            </Field>
            <button className="button primary" type="submit" disabled={!urlValid || manualUrl.trim() === settings.manualUrl}>
              {t('manualUrlSave')}
            </button>
          </form>
        ) : null}
        <Facts items={[[t('effectiveServer'), <code className="mono" key="u">{status?.serverUrl || '-'}</code>], [st('lastError'), conn?.lastError || st('noError')]]} />
      </Card>
      <Card title={st('portsTitle')}>
        {status?.serviceError ? (
          <Notice kind="error">
            {t('serviceError', { error: status.serviceError })} {t('serviceErrorHint')}
          </Notice>
        ) : null}
        <Facts
          items={[
            [`${st('portStream')} (UDP 13250)`, conn?.ports.boundStream != null ? st('portOpen') : st('portClosed')],
            [`${st('portDiscovery')} (UDP 22346)`, conn?.ports.boundDiscovery != null ? st('portOpen') : st('portClosed')],
          ]}
        />
      </Card>
      <Card title={st('networkTitle')} copy={st('networkCopy')}>
        {status?.addresses.length ? (
          <ul className="plain-list">
            {status.addresses.map((item) => (
              <li key={`${item.name}-${item.address}`}>
                <code className="mono">{item.address}</code> <span className="muted">{item.name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Notice kind="warning">{st('noAddresses')}</Notice>
        )}
        <p className="field-note">{st('findmeCount', { count: status?.findmeRequests ?? 0 })}</p>
        {status?.isolationSuspected ? <Notice kind="warning">{st('isolationHint')}</Notice> : null}
      </Card>
    </div>
  );
}

function DevicesSection({ st }: { st: ST }) {
  const { t, snapshot, updateSettings, exec, api } = useStudio();
  const [confirmUi, confirm] = useConfirm();
  const settings = snapshot?.settings as StudioSettings;
  const devices = snapshot?.devices ?? [];
  const nearby = snapshot?.nearby ?? [];
  const [editing, setEditing] = useState<{ uid: string; name: string } | null>(null);
  return (
    <div className="stack">
      {confirmUi}
      <Card title={t('sectionDevicePolicy')}>
        <Segmented<StudioSettings['offerPolicy']>
          label={t('sectionDevicePolicy')}
          value={settings.offerPolicy}
          options={[
            { value: 'managed', label: t('policyManaged') },
            { value: 'all', label: t('policyAll') },
          ]}
          onChange={(offerPolicy) => void exec(t('sectionDevicePolicy'), () => updateSettings({ offerPolicy }), { success: t('settingsSaved') })}
        />
        <p className="field-note">{settings.offerPolicy === 'managed' ? t('policyManagedCopy') : t('policyAllCopy')}</p>
      </Card>
      <Card title={st('managedTitle')} copy={st('managedCopy')}>
        {devices.length === 0 ? <p className="muted">{st('noManaged')}</p> : null}
        <ul className="settings-rows">
          {devices.map((device) => (
            <li key={device.uid}>
              <StatusDot state={device.online ? 'online' : 'offline'} label={device.online ? st('online') : st('offline')} />
              {editing?.uid === device.uid ? (
                <form
                  className="inline-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = editing.name.trim();
                    setEditing(null);
                    void exec(st('rename'), () => api.setNickname(device.uid, name), { success: false });
                  }}
                >
                  <TextInput aria-label={st('renameLabel', { device: device.displayName })} autoFocus maxLength={64} value={editing.name} onChange={(e) => setEditing({ uid: device.uid, name: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
                  <button className="button primary" type="submit">
                    {t('save')}
                  </button>
                </form>
              ) : (
                <span className="row-main">
                  <strong>{device.displayName}</strong> <code className="mono muted">{device.uid}</code>
                </span>
              )}
              <span className="row-actions">
                <button type="button" className="button" onClick={() => setEditing({ uid: device.uid, name: device.nickname })}>
                  {st('rename')}
                </button>
                <button
                  type="button"
                  className="button danger"
                  onClick={async () => {
                    const ok = await confirm({ title: st('removeConfirmTitle', { device: device.displayName }), message: st('removeConfirmMessage'), confirmLabel: st('remove'), danger: true });
                    if (ok) void exec(st('remove'), () => api.release(device.uid), { success: t('deviceRemoved', { device: device.displayName }) });
                  }}
                >
                  {st('remove')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={st('nearbyTitle')} copy={st('nearbyCopy', { count: nearby.length })}>
        <ul className="settings-rows">
          {nearby.map((item) => (
            <li key={item.uid}>
              <span className="row-main">
                <strong>{item.name || item.uid}</strong> <code className="mono muted">{item.ip}</code>
                {item.attachedTo ? <span className="muted"> · {st('attachedTo', { relay: item.attachedTo })}</span> : null}
              </span>
              <span className="row-actions">
                <button type="button" className="button" onClick={() => void exec(st('add'), () => api.adopt(item.uid))}>
                  {st('add')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function RecordingSection({ st }: { st: ST }) {
  const { t, snapshot, exec, api, toast, platform } = useStudio();
  const app = useAppClient();
  const [confirmUi, confirm] = useConfirm();
  const settings = snapshot?.settings as StudioSettings;
  const storage = snapshot?.status.storage;
  const [days, setDays] = useState(90);
  const [preview, setPreview] = useState<PruneResult | null>(null);
  const recCount = snapshot?.recordings.length ?? 0;
  useEffect(() => {
    if (days >= 1) void app.pruneRecordings(days, true).then(setPreview, () => setPreview(null));
  }, [app, days, recCount]);
  return (
    <div className="stack">
      {confirmUi}
      <Card
        title={t('dataFolder')}
        copy={t('dataFolderCopy')}
        actions={
          <>
            <button type="button" className="button" onClick={() => void exec(st('revealFolder'), () => app.revealDataFolder(), { success: false })}>
              <FolderOpen size={14} aria-hidden="true" />
              {platform === 'win32' ? st('revealFolderWin') : st('revealFolder')}
            </button>
            <button type="button" className="button" onClick={() => void exec(t('dataFolder'), () => api.chooseDataFolder(), { success: false }).then((o) => o.ok && o.data && toast('success', t('dataFolderChanged')))}>
              {t('changeFolder')}
            </button>
          </>
        }
      >
        <code className="mono path-line">{settings.dataFolder}</code>
      </Card>
      <Card title={st('storageTitle')}>
        <Facts
          items={[
            [st('recordingsUse'), formatBytes(storage?.recordingsBytes ?? 0)],
            [st('freeSpace'), formatBytes(storage?.freeBytes ?? 0)],
            [st('recordingCount'), String(recCount)],
          ]}
        />
      </Card>
      <Card title={st('cleanupTitle')} copy={st('cleanupCopy')}>
        <div className="field-row-form">
          <Field label={st('olderThan')}>
            {(id) => <NumberInput id={id} min={1} max={3650} value={days} onChange={(e) => setDays(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />}
          </Field>
          <button
            type="button"
            className="button danger"
            disabled={!preview || preview.count === 0}
            onClick={async () => {
              if (!preview) return;
              const size = formatBytes(preview.bytes);
              const ok = await confirm({ title: st('cleanupConfirmTitle', { count: preview.count }), message: st('cleanupConfirmMessage', { days, size }), confirmLabel: st('delete'), danger: true });
              if (!ok) return;
              const outcome = await exec(st('cleanupAction'), () => app.pruneRecordings(days, false) as unknown as Promise<string>, { success: false });
              const result = outcome.data as PruneResult | undefined;
              if (result) {
                toast('success', st('cleanupDone', { count: result.count }));
                if (result.failed) toast('error', st('cleanupFailed', { count: result.failed }));
              }
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
            {st('cleanupAction')}
          </button>
        </div>
        <p className="field-note" role="status">
          {preview ? (preview.count ? st('cleanupPreview', { count: preview.count, size: formatBytes(preview.bytes) }) : st('cleanupNone')) : ''}
        </p>
      </Card>
    </div>
  );
}

export function updateLine(st: ST, state: UpdateState): string {
  switch (state.phase) {
    case 'available':
      return st('u_available', { version: state.latestVersion });
    case 'current':
      return state.noAssetForPlatform ? st('u_noAsset', { version: state.latestVersion, platform: state.platformKey }) : st('u_current');
    case 'downloading':
      return st('u_downloading', { percent: state.totalBytes ? Math.floor((state.downloadedBytes / state.totalBytes) * 100) : 0 });
    case 'error':
      return st('u_error', { error: state.error });
    default:
      return st(`u_${state.phase}` as SettingsKey);
  }
}

function UpdatesSection({ st }: { st: ST }) {
  const { locale, exec } = useStudio();
  const app = useAppClient();
  const [prefs, setPrefs] = usePrefs();
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    void app.updateState().then(setState, () => undefined);
    return app.on('update', setState);
  }, [app]);
  if (!state || !prefs) return null;
  const busy = ['checking', 'downloading', 'verifying', 'installing'].includes(state.phase);
  return (
    <div className="stack">
      <Card title={st('updatesTitle')}>
        <Facts
          items={[
            [st('currentVersion'), state.currentVersion],
            [st('latestVersion'), state.latestVersion || '-'],
            [st('lastChecked'), state.checkedAtMs ? formatDateTime(state.checkedAtMs, locale) : st('never')],
          ]}
        />
        <p role="status" aria-live="polite" className={state.phase === 'error' ? 'field-error' : ''}>
          {updateLine(st, state)}
        </p>
        {state.phase === 'downloading' ? <progress max={state.totalBytes || 1} value={state.downloadedBytes} aria-label={updateLine(st, state)} /> : null}
        <div className="actions">
          <button type="button" className="button" disabled={busy} onClick={() => void app.checkForUpdate()}>
            <RefreshCw size={14} aria-hidden="true" />
            {st('checkNow')}
          </button>
          {state.notesUrl ? (
            <button type="button" className="button" onClick={() => void app.openReleaseNotes()}>
              <ExternalLink size={14} aria-hidden="true" />
              {st('releaseNotes')}
            </button>
          ) : null}
          {state.phase === 'available' || state.phase === 'ready' || (state.phase === 'error' && state.latestVersion && !state.noAssetForPlatform) ? (
            <button type="button" className="button primary" onClick={() => void exec(st('install', { version: state.latestVersion }), () => app.installUpdate() as unknown as Promise<string>, { success: false })}>
              <Download size={14} aria-hidden="true" />
              {st('install', { version: state.latestVersion })}
            </button>
          ) : null}
        </div>
        <Notice>{st('unsignedNote')}</Notice>
      </Card>
      <Card title={st('channel')} copy={st('channelCopy')}>
        <Segmented<'stable' | 'beta'>
          label={st('channel')}
          value={prefs.updateChannel}
          disabled={busy}
          options={[
            { value: 'stable', label: st('channelStable') },
            { value: 'beta', label: st('channelBeta') },
          ]}
          onChange={(updateChannel) => setPrefs({ updateChannel })}
        />
        <SwitchRow checked={prefs.checkUpdatesOnStart} onChange={(checkUpdatesOnStart) => setPrefs({ checkUpdatesOnStart })} title={st('checkOnStart')} />
      </Card>
    </div>
  );
}

function AdvancedSection({ st }: { st: ST }) {
  const { exec, toast } = useStudio();
  const app = useAppClient();
  const [confirmUi, confirm] = useConfirm();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void app.info().then(setInfo, () => undefined);
  }, [app]);
  return (
    <div className="stack">
      {confirmUi}
      <Card title={st('diagnosticsTitle')} copy={st('diagnosticsCopy')}>
        <div className="actions">
          <button type="button" className="button" onClick={() => void exec(st('openLogs'), () => app.openLogFolder(), { success: false })}>
            <FolderOpen size={14} aria-hidden="true" />
            {st('openLogs')}
          </button>
          <button
            type="button"
            className="button"
            onClick={() =>
              void exec(st('exportDiagnostics'), () => app.exportDiagnostics(), { success: false }).then((o) => {
                if (o.ok && o.data) toast('success', st('diagnosticsSaved'));
              })
            }
          >
            <FileArchive size={14} aria-hidden="true" />
            {st('exportDiagnostics')}
          </button>
        </div>
      </Card>
      <Card title={st('resetTitle')} copy={st('resetCopy')}>
        <div className="actions">
          <button
            type="button"
            className="button danger"
            onClick={async () => {
              const ok = await confirm({ title: st('resetConfirmTitle'), message: st('resetConfirmMessage'), confirmLabel: st('reset'), danger: true });
              if (ok) void exec(st('resetAction'), () => app.resetSettings(), { success: st('resetDone') });
            }}
          >
            <RotateCcw size={14} aria-hidden="true" />
            {st('resetAction')}
          </button>
        </div>
      </Card>
      {info ? (
        <Disclosure summary={st('developerTitle')}>
          <Facts
            items={[
              [st('currentVersion'), info.version],
              [st('build'), info.packaged ? st('packaged') : st('development')],
              [st('platform'), `${info.platform}-${info.arch} (${info.osRelease})`],
              ['Electron', info.electron],
              ['Chromium', info.chrome],
              ['Node', info.node],
              [st('userData'), <code className="mono" key="u">{info.userDataDir}</code>],
              [st('logFolder'), <code className="mono" key="l">{info.logDir}</code>],
            ]}
          />
        </Disclosure>
      ) : null}
    </div>
  );
}

function AboutSection({ st }: { st: ST }) {
  const { t, snapshot, api } = useStudio();
  const open = (url: string) => (event: { preventDefault(): void }) => {
    event.preventDefault();
    void api.openExternal(url);
  };
  return (
    <Card>
      <div className="about">
        {/* Remounted each time the section opens, so the planet rises once per visit. */}
        <AnimatedBrandMark size={128} />
        <div>
          <h3>{t('appFullName')}</h3>
          <p className="muted">{t('versionValue', { version: snapshot?.version ?? '-' })}</p>
        </div>
        <p className="about-copy">{t('aboutCopy')}</p>
        <div className="actions">
          <button type="button" className="button" onClick={() => void api.openExternal(DOWNLOAD_PAGE)}>
            <ExternalLink size={14} aria-hidden="true" />
            {st('downloadPage')}
          </button>
          <button type="button" className="button" onClick={() => void api.openExternal(GITHUB)}>
            <ExternalLink size={14} aria-hidden="true" />
            {st('github')}
          </button>
        </div>
        <p className="field-note about-copy">{st('licenses')}</p>
        <div className="about-credits">
          <a className="about-lab" href={LAB_URL} onClick={open(LAB_URL)}>
            {LAB_NAME}
          </a>
          <a className="about-university" href={UNIVERSITY_URL} onClick={open(UNIVERSITY_URL)}>
            <UAizuLogo className="about-uaizu-logo" title={st('university')} />
            <span>{st('university')}</span>
          </a>
        </div>
      </div>
    </Card>
  );
}
