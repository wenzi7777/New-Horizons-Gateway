// Live: the Desktop's Visualization page (pages/VisualizationPage.tsx) for
// up to four devices side by side. Each card has its own 3D surface / 2D
// heatmap toggle, sensor-layout profile, row/column mirror, dot size, and
// the Desktop's stats (samples, device and render FPS, max P, COP). Range
// presets and "Show COP" apply to every card.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Square, X } from 'lucide-react';

import type { DeviceView } from '../../shared/contract';
import { ColourScale, Heatmap } from '../components/Heatmap';
import { Field, Notice, Segmented, StatusDot, Checkbox, NumberInput, Select, Slider } from '../components/ui';
import { useAreaT } from '../areas/i18n';
import { computeCop, interpolateGrid, mirrorValues } from '../lib/visualization';
import { LIVE_STRINGS } from './liveStrings';
import './live.css';
import { formatValue } from '../lib/format';
import { liveColumns, MAX_LIVE_DEVICES, toggleLiveDevice, type Route } from '../lib/navigation';
import { clampRange, DEFAULT_RANGE, presetIndexForRange, RANGE_PRESETS, type PressureRange } from '../lib/pressureColor';
import { useLiveFrame, useStudio } from '../state/studio';
import { useDeviceProfile, useProfileList, useProfilesClient } from '../areas/profiles/hooks';

const Surface3D = lazy(() => import('../components/Surface3D'));

type Props = { route: Extract<Route, { area: 'live' }>; navigate: (route: Route) => void };

export default function LivePage({ route, navigate }: Props) {
  const { t, snapshot } = useStudio();
  const devices = snapshot?.devices ?? [];
  // Default: the first online devices with a matrix, when nothing is chosen.
  const chosen = route.uids.length ? route.uids : devices.filter((d) => d.online && d.matrix).slice(0, 2).map((d) => d.uid);
  const selected = chosen.map((uid) => devices.find((d) => d.uid === uid)).filter((d): d is DeviceView => Boolean(d));
  const [range, setRange] = useState<PressureRange>(DEFAULT_RANGE);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState({ min: String(DEFAULT_RANGE.min), max: String(DEFAULT_RANGE.max) });
  const lt = useAreaT(LIVE_STRINGS);
  const [showCop, setShowCop] = useState(true);
  const [no3d, setNo3d] = useState(false);
  const presetIndex = custom ? -1 : presetIndexForRange(range);

  useEffect(() => {
    if (!custom) return;
    const next = clampRange(Number(draft.min), Number(draft.max));
    if (next) setRange(next);
  }, [custom, draft]);

  const setSelection = (uids: string[]) => navigate({ area: 'live', uids });

  return (
    <div className="stack live-page">
      <div className="toolbar">
        <fieldset className="chooser">
          <legend>{t('liveChoose')}</legend>
          <div className="chip-list">
            {devices.map((d) => {
              const on = chosen.includes(d.uid);
              const full = !on && chosen.length >= MAX_LIVE_DEVICES;
              return (
                <label key={d.uid} className={`chip toggle${on ? ' on' : ''}${full ? ' disabled' : ''}`} title={full ? t('liveLimit') : undefined}>
                  <Checkbox checked={on} disabled={full} onChange={() => setSelection(toggleLiveDevice(chosen, d.uid))} />
                  <StatusDot state={d.online ? 'online' : 'offline'} />
                  {d.displayName}
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="toolbar-controls">
          <Field label={t('liveRange')}>
            {(id) => (
              <Select
                id={id}
                value={presetIndex >= 0 ? String(presetIndex) : 'custom'}
                onChange={(e) => {
                  if (e.target.value === 'custom') {
                    setCustom(true);
                    setDraft({ min: String(range.min), max: String(range.max) });
                    return;
                  }
                  setCustom(false);
                  setRange(RANGE_PRESETS[Number(e.target.value)] ?? DEFAULT_RANGE);
                }}
              >
                <option value="0">{t('rangeStandard')}</option>
                <option value="1">{t('rangeFull')}</option>
                <option value="custom">{t('rangeCustom')}</option>
              </Select>
            )}
          </Field>
          {custom ? (
            <div className="range-inputs">
              <Field label={t('rangeMin')}>{(id) => <NumberInput id={id} min={0} max={4990} value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} />}</Field>
              <Field label={t('rangeMax')}>{(id) => <NumberInput id={id} min={0} max={4990} value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })} />}</Field>
            </div>
          ) : null}
          <label className="viz-switch">
            <Checkbox checked={showCop} onChange={(e) => setShowCop(e.target.checked)} />
            <span>{lt('showCop')}</span>
          </label>
        </div>
      </div>
      <ColourScale range={range} label={t('colourScale')} />
      {no3d ? <Notice kind="warning">{lt('webglUnavailable')}</Notice> : null}

      {selected.length === 0 ? (
        <div className="empty-state">
          <p>{devices.length ? t('liveNoSelection') : t('noDevices')}</p>
        </div>
      ) : (
        <div className="live-grid" style={{ gridTemplateColumns: `repeat(${liveColumns(selected.length)}, minmax(0, 1fr))` }}>
          {selected.map((d) => (
            <LivePanel
              key={d.uid}
              device={d}
              range={range}
              showCop={showCop}
              no3d={no3d}
              onUnavailable3d={() => setNo3d(true)}
              onRemove={() => setSelection(chosen.filter((u) => u !== d.uid))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type CardView = { mode: '3d' | '2d'; rowMirror: boolean; colMirror: boolean; dotSize: number };

function LivePanel({ device, range, showCop, no3d, onRemove, onUnavailable3d }: { device: DeviceView; range: PressureRange; showCop: boolean; no3d: boolean; onRemove: () => void; onUnavailable3d: () => void }) {
  const { t, exec, api } = useStudio();
  const lt = useAreaT(LIVE_STRINGS);
  const frame = useLiveFrame(device.online && device.matrix ? device.uid : null);
  const rec = device.recording;
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<CardView>({ mode: '2d', rowMirror: false, colMirror: false, dotSize: 1 });
  const mode = no3d ? '2d' : view.mode;
  const label = t('heatmapLabel', { device: device.displayName });
  // A device's sensor-layout profile (Profiles page) places its sensors in 2D;
  // choosing one here assigns it to the device, as the Desktop card does.
  const profile = useDeviceProfile(device.uid);
  const profileList = useProfileList();
  const profiles = useProfilesClient();
  const rows = device.matrix?.rows ?? frame?.rows ?? 0;
  const cols = device.matrix?.cols ?? frame?.cols ?? 0;
  const values = useMemo(() => (frame ? mirrorValues(frame.values, rows, cols, view.rowMirror, view.colMirror) : null), [frame, rows, cols, view.rowMirror, view.colMirror]);
  const surface = useMemo(() => (values && mode === '3d' ? interpolateGrid(values, rows, cols) : null), [values, mode, rows, cols]);
  const cop = useMemo(() => computeCop(values ?? [], rows, cols), [values, rows, cols]);
  const maxPressure = values && values.length ? Math.max(...values) : 0;
  const shownProfile = useMemo(() => (profile ? { ...profile, display: { ...(profile.display ?? {}), dotSize: view.dotSize } } : null), [profile, view.dotSize]);
  // Samples and render FPS, counted here like the Desktop's card.
  const samples = useRef(0);
  const renders = useRef<number[]>([]);
  useEffect(() => {
    if (!frame) return;
    samples.current += 1;
    const now = performance.now();
    renders.current = [...renders.current.filter((at) => now - at < 1000), now];
  }, [frame]);
  const renderFps = renders.current.length;
  const badge = !device.online ? 'offline' : frame ? 'live' : 'waiting';
  const badgeLabel = badge === 'live' ? lt('live') : badge === 'waiting' ? lt('waitingForData') : lt('offline');
  const update = (patch: Partial<CardView>) => setView((v) => ({ ...v, ...patch }));
  return (
    <article className="card live-panel visualization-device-card" aria-label={device.displayName}>
      <header className="live-head viz-card-head">
        <StatusDot state={device.online ? 'online' : 'offline'} />
        <h3 className="viz-card-name">{device.displayName}</h3>
        {device.displayName !== device.uid ? <span className="viz-card-uid mono">{device.uid}</span> : null}
        <span className="spacer" />
        <span className={`tag viz-card-status ${badge}`}>{badgeLabel}</span>
        {rec.enabled ? <span className="tag rec">{t('recBadge')}</span> : null}
        <button
          className={`button tiny ${rec.enabled ? 'danger' : 'primary'}`}
          type="button"
          disabled={busy || rec.finishing || (!rec.enabled && !device.online)}
          aria-label={`${rec.enabled ? t('stopRecording') : t('startRecording')}: ${device.displayName}`}
          onClick={async () => {
            setBusy(true);
            await exec(rec.enabled ? t('stopRecording') : t('startRecording'), () => api.setRecording(device.uid, !rec.enabled), {
              uid: device.uid,
              success: rec.enabled ? t('recordingStopped') : t('recordingStarted'),
            });
            setBusy(false);
          }}
        >
          {rec.enabled ? <Square size={12} aria-hidden="true" /> : <Circle size={12} fill="currentColor" aria-hidden="true" />}
          {rec.finishing ? t('recordingFinishing') : rec.enabled ? t('stopRecording') : t('startRecording')}
        </button>
        <button className="icon-button small" type="button" aria-label={`${t('removeFromLive')}: ${device.displayName}`} onClick={onRemove}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="viz-card-toolbar">
        <Segmented<'3d' | '2d'>
          label={t('viewMode')}
          value={mode}
          options={[
            { value: '3d', label: lt('surface3d'), disabled: no3d },
            { value: '2d', label: lt('heatmap2d') },
          ]}
          onChange={(next) => update({ mode: next })}
        />
        <div className="viz-card-profile">
          <Select
            value={profile?.name ?? ''}
            aria-label={lt('profiles')}
            title={lt('profiles')}
            onChange={(e) => void exec(lt('profiles'), () => profiles.assign(device.uid, e.target.value || null).then(() => undefined), { uid: device.uid, success: false })}
          >
            <option value="">{lt('profileNoneStandard')}</option>
            {profileList.items.map((item) => (
              <option key={item.name} value={item.name}>
                {item.displayName || item.name}
              </option>
            ))}
          </Select>
        </div>
        <label className="viz-switch">
          <Checkbox checked={view.rowMirror} onChange={(e) => update({ rowMirror: e.target.checked })} />
          <span>{lt('rowMirror')}</span>
        </label>
        <label className="viz-switch">
          <Checkbox checked={view.colMirror} onChange={(e) => update({ colMirror: e.target.checked })} />
          <span>{lt('colMirror')}</span>
        </label>
        <span className="viz-card-shape" title={lt('matrixShape')}>
          {rows} × {cols}
        </span>
      </div>

      {profile ? (
        <label className="viz-card-dot-size">
          <span>
            {lt('dotSize')}: {view.dotSize.toFixed(2)}×
          </span>
          <Slider min={0.5} max={4} step={0.25} value={view.dotSize} onChange={(e) => update({ dotSize: Number(e.target.value) || 1 })} />
        </label>
      ) : null}

      <dl className="viz-card-stats" aria-live="off">
        <div>
          <dt>{lt('samples')}</dt>
          <dd>{frame ? samples.current : '-'}</dd>
        </div>
        <div>
          <dt>Device FPS</dt>
          <dd>{device.online ? (frame?.fps ?? device.fps).toFixed(1) : '-'}</dd>
        </div>
        <div>
          <dt>Render FPS</dt>
          <dd>{renderFps.toFixed(1)}</dd>
        </div>
        <div>
          <dt>Max P</dt>
          <dd>{values ? formatValue(maxPressure) : '-'}</dd>
        </div>
        {showCop ? (
          <div className={`viz-card-cop is-wide${cop.hasData ? ' has-data' : ''}`}>
            <dt>COP</dt>
            <dd>
              <span className="cop-mini-board">
                <span className="cop-mini-placeholder">--</span>
                <span className="cop-mini-dot" style={{ left: `${cop.xRatio * 100}%`, top: `${cop.yRatio * 100}%` }} />
              </span>
              <span className="fit-text">{`X ${cop.hasData ? cop.x.toFixed(2) : '--'} · Y ${cop.hasData ? cop.y.toFixed(2) : '--'}`}</span>
            </dd>
          </div>
        ) : null}
      </dl>

      {!device.matrix ? (
        <p className="empty">{t('liveNoMatrix')}</p>
      ) : mode === '3d' ? (
        <Suspense fallback={<p className="empty">{t('loading')}</p>}>
          <Surface3D values={surface?.values ?? null} rows={surface?.rows ?? rows} cols={surface?.cols ?? cols} range={range} label={label} onUnavailable={onUnavailable3d} />
        </Suspense>
      ) : (
        <Heatmap values={values} rows={rows} cols={cols} range={range} label={label} maxHeight={520} profile={shownProfile} />
      )}
      {!device.online ? <p className="muted">{t('deviceOffline')}</p> : device.matrix && !frame ? <p className="muted">{lt('noData')}</p> : null}
    </article>
  );
}
