// The "profiles" area's page: #/profiles lists the sensor-layout profiles,
// #/profiles/<name> edits one (stage, matrix, background, sensors, which
// devices use it, live preview from a device).

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, Copy, Download, FilePlus2, ImagePlus, Pencil, Save, Trash2, Upload } from 'lucide-react';

import type { Profile, ProfileSensor } from '../../../shared/areas/profiles';
import type { DeviceView } from '../../../shared/contract';
import { Card, Field, Notice, Segmented, SwitchRow, useConfirm, NumberInput, Select, TextInput } from '../../components/ui';
import type { Route } from '../../lib/navigation';
import { useLiveFrame, useStudio } from '../../state/studio';
import { useAreaT } from '../i18n';
import { useAssignments, useProfileList, useProfilesClient, useProfilesEditable } from './hooks';
import { normalizeProfile, sensorLabel, serializeProfile } from './model';
import { ProfileStage } from './Stage';
import { PROFILE_STRINGS } from './strings';
import './profiles.css';

export type ProfilesPageProps = { route: Extract<Route, { area: 'profiles' }>; navigate: (route: Route) => void };

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ProfilesPage({ route, navigate }: ProfilesPageProps) {
  const name = route.path[0] ?? null;
  return name ? <ProfileEditor key={name} name={name} navigate={navigate} /> : <ProfileList navigate={navigate} />;
}

function deviceNames(devices: readonly DeviceView[], assignments: Record<string, string>, name: string): string[] {
  return Object.entries(assignments)
    .filter(([, n]) => n === name)
    .map(([uid]) => devices.find((d) => d.uid.replace(/[^a-fA-F0-9]/g, '').toUpperCase() === uid)?.displayName ?? uid);
}

function ProfileList({ navigate }: { navigate: (route: Route) => void }) {
  const pt = useAreaT(PROFILE_STRINGS);
  const { snapshot, toast, errorText } = useStudio();
  const client = useProfilesClient();
  const { items, loaded, error } = useProfileList();
  const editable = useProfilesEditable();
  const assignments = useAssignments();
  const [newName, setNewName] = useState('');
  const open = (n: string) => navigate({ area: 'profiles', path: [n] });
  const fail = (e: unknown) => toast('error', errorText(errMessage(e)));

  return (
    <div className="stack profiles-page">
      <header className="profiles-head">
        <div>
          <h1>{pt('title')}</h1>
          <p className="muted">{pt('intro')}</p>
        </div>
        <button
          className="button"
          type="button"
          disabled={editable !== true}
          onClick={() =>
            client.importFile().then((n) => {
              if (!n) return;
              toast('success', pt('imported', { name: n }));
              open(n);
            }, fail)
          }
        >
          <Upload size={14} aria-hidden="true" />
          {pt('import')}
        </button>
      </header>
      <form
        className="profiles-create"
        onSubmit={(e) => {
          e.preventDefault();
          client.create(newName.trim() || 'new_profile').then(open, fail);
        }}
      >
        <Field label={pt('newName')}>{(id) => <TextInput id={id} value={newName} placeholder="new_profile" onChange={(e) => setNewName(e.target.value)} />}</Field>
        <button className="button primary" type="submit" disabled={editable !== true}>
          <FilePlus2 size={14} aria-hidden="true" />
          {pt('create')}
        </button>
      </form>
      {error ? <Notice kind="error">{errorText(error)}</Notice> : null}
      {editable === false ? <Notice kind="warning">{errorText('server_unavailable')}</Notice> : null}
      {loaded && items.length === 0 ? (
        <div className="empty-state">
          <p>{pt('noProfiles')}</p>
        </div>
      ) : (
        <ul className="profiles-grid" aria-label={pt('title')}>
          {items.map((item) => {
            const users = deviceNames(snapshot?.devices ?? [], assignments, item.name);
            return (
              <li key={item.name}>
                <button className="card profiles-item" type="button" onClick={() => open(item.name)}>
                  <strong>{item.displayName}</strong>
                  {item.displayName !== item.name ? <span className="mono muted">{item.name}</span> : null}
                  <span className="muted">
                    {pt('matrixShape', { rows: item.rows, cols: item.cols })} · {pt('sensorsCount', { count: item.sensorCount })} · {item.deviceType}
                  </span>
                  {users.length ? <span className="tag accent">{pt('usedBy', { devices: users.join(', ') })}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function measureAspect(dataUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1);
    img.onerror = () => resolve(1);
    img.src = dataUrl;
  });
}

function parseCsvInts(value: string): number[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

function gridSensors(rows: number, cols: number): ProfileSensor[] {
  return Array.from({ length: rows * cols }, (_, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    return { index: i, x: cols <= 1 ? 0.5 : 0.08 + (c / (cols - 1)) * 0.84, y: rows <= 1 ? 0.5 : 0.08 + (r / (rows - 1)) * 0.84, label: sensorLabel(i), enabled: true };
  });
}

function ProfileEditor({ name, navigate }: { name: string; navigate: (route: Route) => void }) {
  const editable = useProfilesEditable();
  const pt = useAreaT(PROFILE_STRINGS);
  const { snapshot, toast, errorText } = useStudio();
  const client = useProfilesClient();
  const assignments = useAssignments();
  const [confirmEl, ask] = useConfirm();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [missing, setMissing] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const devices = snapshot?.devices ?? [];
  const [previewUid, setPreviewUid] = useState<string | null>(null);
  const frame = useLiveFrame(previewUid);
  const fail = useCallback((e: unknown) => toast('error', errorText(errMessage(e))), [toast, errorText]);

  const load = useCallback(() => {
    client.get(name).then(
      (p) => {
        setProfile(p);
        setSavedJson(JSON.stringify(serializeProfile(p)));
        setMissing(false);
      },
      () => setMissing(true),
    );
  }, [client, name]);
  useEffect(load, [load]);

  // Default preview: a device that uses this profile and is online.
  useEffect(() => {
    if (previewUid) return;
    const user = devices.find((d) => d.online && assignments[d.uid.replace(/[^a-fA-F0-9]/g, '').toUpperCase()] === name);
    if (user) setPreviewUid(user.uid);
  }, [devices, assignments, name, previewUid]);

  const dirty = useMemo(() => (profile ? JSON.stringify(serializeProfile(profile)) !== savedJson : false), [profile, savedJson]);
  const update = (fn: (p: Profile) => Profile) => setProfile((p) => (p ? normalizeProfile(fn(p)) : p));
  const updateSensor = (position: number, patch: Partial<ProfileSensor>) =>
    setProfile((p) => (p ? { ...p, sensors: p.sensors.map((s, i) => (i === position ? { ...s, ...patch } : s)) } : p));
  const removeSensor = (position: number) => {
    setProfile((p) => (p ? { ...p, sensors: p.sensors.filter((_, i) => i !== position) } : p));
    setSelected(null);
  };

  const save = useCallback(async () => {
    if (!profile) return;
    try {
      await client.save(name, profile);
      setSavedJson(JSON.stringify(serializeProfile(profile)));
      toast('success', pt('saved'));
    } catch (e) {
      fail(e);
    }
  }, [client, name, profile, toast, pt, fail]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const leave = async (route: Route) => {
    if (dirty && !(await ask({ title: pt('discardTitle'), message: pt('discardMessage', { name }), confirmLabel: pt('discard'), danger: true }))) return;
    navigate(route);
  };

  if (missing) {
    return (
      <div className="stack profiles-page">
        <button className="button ghost profiles-back" type="button" onClick={() => navigate({ area: 'profiles', path: [] })}>
          <ArrowLeft size={14} aria-hidden="true" />
          {pt('back')}
        </button>
        <Notice kind="warning">{pt('notFound')}</Notice>
      </div>
    );
  }
  if (!profile) return <p className="empty">…</p>;

  const sel = selected !== null ? profile.sensors[selected] : undefined;
  const values = frame?.values ?? null;
  const uidKey = (uid: string) => uid.replace(/[^a-fA-F0-9]/g, '').toUpperCase();

  return (
    <div className="stack profiles-page">
      {confirmEl}
      {editable === false ? <Notice kind="warning">{errorText('server_unavailable')}</Notice> : null}
      <header className="profiles-editor-head">
        <button className="button ghost profiles-back" type="button" onClick={() => void leave({ area: 'profiles', path: [] })}>
          <ArrowLeft size={14} aria-hidden="true" />
          {pt('back')}
        </button>
        {renaming !== null ? (
          <form
            className="profiles-rename"
            onSubmit={(e) => {
              e.preventDefault();
              const target = renaming.trim();
              setRenaming(null);
              if (!target || target === name) return;
              const run = async () => {
                if (dirty) await client.save(name, profile);
                const stored = await client.rename(name, target);
                navigate({ area: 'profiles', path: [stored] });
              };
              run().catch(fail);
            }}
          >
            <Field label={pt('renameTo')}>{(id) => <TextInput id={id} autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} />}</Field>
            <button className="button primary" type="submit">{pt('rename')}</button>
          </form>
        ) : (
          <h1 className="profiles-title">
            {profile.name || name}
            {dirty ? <span className="tag waiting">{pt('unsaved')}</span> : null}
          </h1>
        )}
        <span className="spacer" />
        <div className="profiles-actions">
          <button className="button primary" type="button" disabled={!dirty || editable !== true} title={editable === false ? errorText('server_unavailable') : undefined} onClick={() => void save()}>
            <Save size={14} aria-hidden="true" />
            {pt('save')}
          </button>
          <button className="button" type="button" onClick={() => setRenaming(name)}>
            <Pencil size={14} aria-hidden="true" />
            {pt('rename')}
          </button>
          <button
            className="button"
            type="button"
            onClick={() =>
              (async () => {
                if (dirty) await client.save(name, profile);
                const copy = await client.duplicate(name);
                navigate({ area: 'profiles', path: [copy] });
              })().catch(fail)
            }
          >
            <Copy size={14} aria-hidden="true" />
            {pt('duplicate')}
          </button>
          <button
            className="button"
            type="button"
            onClick={() =>
              (async () => {
                if (dirty) await save();
                const path = await client.exportFile(name);
                if (path) toast('success', pt('exported', { path }));
              })().catch(fail)
            }
          >
            <Download size={14} aria-hidden="true" />
            {pt('export')}
          </button>
          <button
            className="button danger"
            type="button"
            onClick={async () => {
              if (!(await ask({ title: pt('deleteTitle'), message: pt('deleteMessage', { name }), confirmLabel: pt('delete'), danger: true }))) return;
              client.remove(name).then(() => navigate({ area: 'profiles', path: [] }), fail);
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
            {pt('delete')}
          </button>
        </div>
      </header>

      <div className="profiles-editor">
        <div className="profiles-stage-col">
          <ProfileStage
            profile={profile}
            selected={selected}
            values={values}
            onSelect={setSelected}
            onAdd={(x, y) => {
              const used = new Set(profile.sensors.map((s) => s.index));
              let index = 0;
              while (used.has(index)) index++;
              setProfile({ ...profile, sensors: [...profile.sensors, { index, x, y, label: sensorLabel(index), enabled: true }] });
              setSelected(profile.sensors.length);
            }}
            onMove={(position, x, y) => updateSensor(position, { x, y })}
            onRemove={removeSensor}
          />
          <Card title={pt('preview')}>
            <Field label={pt('previewDevice')}>
              {(id) => (
                <Select id={id} value={previewUid ?? ''} onChange={(e) => setPreviewUid(e.target.value || null)}>
                  <option value="">{pt('none')}</option>
                  {devices.filter((d) => d.matrix).map((d) => (
                    <option key={d.uid} value={d.uid} disabled={!d.online}>
                      {d.displayName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {values ? (
              <>
                <p className="muted">{pt('channelsHint')}</p>
                <div className="profiles-channels" role="group" aria-label={pt('channels')}>
                  {values.map((v, i) => {
                    const taken = profile.sensors.some((s) => s.index === i);
                    return (
                      <button
                        key={i}
                        type="button"
                        className={`chip${taken ? ' taken' : ''}${sel?.index === i ? ' current' : ''}`}
                        disabled={selected === null}
                        onClick={() => selected !== null && updateSensor(selected, { index: i, label: sel && sel.label === sensorLabel(sel.index) ? sensorLabel(i) : sel?.label ?? sensorLabel(i) })}
                      >
                        <span>{sensorLabel(i)}</span> <span className="mono">{Math.round(v)}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </Card>
        </div>

        <div className="profiles-side">
          <Card title={pt('sensor')}>
            {sel && selected !== null ? (
              <div className="profiles-fields">
                <Field label={pt('sensorLabel')}>{(id) => <TextInput id={id} value={sel.label} onChange={(e) => updateSensor(selected, { label: e.target.value })} />}</Field>
                <Field label={pt('sensorIndex')}>
                  {(id) => <NumberInput id={id} min={0} value={sel.index} onChange={(e) => updateSensor(selected, { index: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />}
                </Field>
                <Field label="x">{(id) => <NumberInput id={id} min={0} max={1} step={0.001} value={Number(sel.x.toFixed(4))} onChange={(e) => updateSensor(selected, { x: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })} />}</Field>
                <Field label="y">{(id) => <NumberInput id={id} min={0} max={1} step={0.001} value={Number(sel.y.toFixed(4))} onChange={(e) => updateSensor(selected, { y: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })} />}</Field>
                <SwitchRow checked={sel.enabled} onChange={(on) => updateSensor(selected, { enabled: on })} title={pt('sensorEnabled')} />
                <button className="button danger" type="button" onClick={() => removeSensor(selected)}>
                  <Trash2 size={14} aria-hidden="true" />
                  {pt('removeSensor')}
                </button>
              </div>
            ) : (
              <p className="muted">{pt('noSensorSelected')}</p>
            )}
          </Card>

          <Card title={pt('devices')} copy={pt('devicesHint')}>
            {devices.length === 0 ? (
              <p className="muted">{pt('noDevices')}</p>
            ) : (
              <ul className="profiles-device-list">
                {devices.map((d) => {
                  const on = assignments[uidKey(d.uid)] === name;
                  return (
                    <li key={d.uid}>
                      <SwitchRow
                        checked={on}
                        onChange={(next) => void client.assign(d.uid, next ? name : null).catch(fail)}
                        title={d.displayName}
                        copy={!on && assignments[uidKey(d.uid)] ? `${pt('assigned')}: ${assignments[uidKey(d.uid)]}` : undefined}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title={pt('general')}>
            <div className="profiles-fields">
              <Field label={pt('displayName')}>{(id) => <TextInput id={id} value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />}</Field>
              <Field label={pt('deviceType')}>
                {(id) => (
                  <TextInput id={id} list="profiles-device-types" value={profile.deviceType} onChange={(e) => setProfile({ ...profile, deviceType: e.target.value })} />
                )}
              </Field>
              <datalist id="profiles-device-types">
                <option value="glove" />
                <option value="insole" />
                <option value="custom" />
              </datalist>
              <Field label={pt('notes')}>{(id) => <textarea id={id} rows={3} value={profile.notes} onChange={(e) => setProfile({ ...profile, notes: e.target.value })} />}</Field>
            </div>
          </Card>

          <Card title={pt('matrix')}>
            <div className="profiles-fields two">
              <NumberField label={pt('rows')} value={profile.matrix.rows} min={1} max={64} onChange={(rows) => update((p) => ({ ...p, matrix: { ...p.matrix, rows } }))} />
              <NumberField label={pt('cols')} value={profile.matrix.cols} min={1} max={64} onChange={(cols) => update((p) => ({ ...p, matrix: { ...p.matrix, cols } }))} />
              <CsvField label={pt('activeRows')} hint={pt('csvHint')} value={profile.activeRows} onChange={(activeRows) => setProfile({ ...profile, activeRows })} />
              <CsvField label={pt('activeCols')} hint={pt('csvHint')} value={profile.activeCols} onChange={(activeCols) => setProfile({ ...profile, activeCols })} />
            </div>
            <div className="profiles-row-actions">
              <button
                className="button"
                type="button"
                onClick={async () => {
                  const { rows, cols } = profile.matrix;
                  if (profile.sensors.length && !(await ask({ title: pt('fillGridTitle'), message: pt('fillGridMessage', { count: profile.sensors.length, rows, cols }), confirmLabel: pt('fillGrid') }))) return;
                  setProfile({ ...profile, sensors: gridSensors(rows, cols) });
                  setSelected(null);
                }}
              >
                {pt('fillGrid')}
              </button>
              <button
                className="button danger"
                type="button"
                disabled={!profile.sensors.length}
                onClick={async () => {
                  if (!(await ask({ title: pt('clearTitle'), message: pt('clearMessage', { count: profile.sensors.length }), confirmLabel: pt('clearSensors'), danger: true }))) return;
                  setProfile({ ...profile, sensors: [] });
                  setSelected(null);
                }}
              >
                {pt('clearSensors')}
              </button>
            </div>
          </Card>

          <Card title={pt('background')}>
            <div className="profiles-row-actions">
              <button
                className="button"
                type="button"
                onClick={() =>
                  (async () => {
                    const data = await client.chooseImage();
                    if (!data) return;
                    const aspectRatio = await measureAspect(data);
                    setProfile((p) => (p ? { ...p, background: { ...p.background, imageData: data, aspectRatio } } : p));
                  })().catch(fail)
                }
              >
                <ImagePlus size={14} aria-hidden="true" />
                {pt('chooseImage')}
              </button>
              {profile.background.imageData ? (
                <button className="button ghost" type="button" onClick={() => setProfile({ ...profile, background: { ...profile.background, imageData: '' } })}>
                  {pt('removeImage')}
                </button>
              ) : null}
            </div>
            <NumberField label={pt('aspect')} value={Number(profile.background.aspectRatio.toFixed(4))} min={0.01} max={100} step={0.01} onChange={(aspectRatio) => update((p) => ({ ...p, background: { ...p.background, aspectRatio } }))} />
          </Card>

          <Card title={pt('display')}>
            <div className="profiles-fields two">
              <div className="field">
                <span className="field-label">{pt('displayMode')}</span>
                <Segmented<'2d' | '3d'>
                  label={pt('displayMode')}
                  value={profile.display.mode}
                  options={[
                    { value: '2d', label: '2D' },
                    { value: '3d', label: '3D' },
                  ]}
                  onChange={(mode) => setProfile({ ...profile, display: { ...profile.display, mode } })}
                />
              </div>
              <NumberField label={pt('dotSize')} value={profile.display.dotSize} min={0.5} max={4} step={0.1} onChange={(dotSize) => update((p) => ({ ...p, display: { ...p.display, dotSize } }))} />
              <NumberField label={pt('pressureMin')} value={profile.display.pressureMin} min={0} max={4990} onChange={(pressureMin) => update((p) => ({ ...p, display: { ...p.display, pressureMin } }))} />
              <NumberField label={pt('pressureMax')} value={profile.display.pressureMax} min={1} max={5000} onChange={(pressureMax) => update((p) => ({ ...p, display: { ...p.display, pressureMax } }))} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** A number input that edits freely and commits valid values on change / blur. */
function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
    else setText(String(value));
  };
  return (
    <Field label={label}>
      {(id) => (
        <NumberInput
          id={id}
         
          min={min}
          max={max}
          step={step}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => commit(text)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(text);
          }}
        />
      )}
    </Field>
  );
}

function CsvField({ label, hint, value, onChange }: { label: string; hint: ReactNode; value: number[]; onChange: (value: number[]) => void }) {
  const [text, setText] = useState(value.join(','));
  useEffect(() => setText(value.join(',')), [value]);
  return (
    <Field label={label} hint={hint}>
      {(id) => <TextInput id={id} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(parseCsvInts(text))} />}
    </Field>
  );
}
