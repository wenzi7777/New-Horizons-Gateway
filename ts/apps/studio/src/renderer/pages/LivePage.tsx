// Live: up to four devices side by side, each a 2D heatmap (or a lazy-loaded
// three.js surface) with max / mean / fps and its record button. Range
// presets as on the Desktop's Visualization page.

import { lazy, Suspense, useEffect, useState } from 'react';
import { Circle, Square, X } from 'lucide-react';

import type { DeviceView } from '../../shared/contract';
import { ColourScale, Heatmap } from '../components/Heatmap';
import { Field, Notice, Segmented, StatusDot } from '../components/ui';
import { formatValue, frameStats } from '../lib/format';
import { liveColumns, MAX_LIVE_DEVICES, toggleLiveDevice, type Route } from '../lib/navigation';
import { clampRange, DEFAULT_RANGE, presetIndexForRange, RANGE_PRESETS, type PressureRange } from '../lib/pressureColor';
import { useLiveFrame, useStudio } from '../state/studio';
import { useDeviceProfile } from '../areas/profiles/hooks';

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
  const [mode, setMode] = useState<'2d' | '3d'>('2d');
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
                  <input type="checkbox" checked={on} disabled={full} onChange={() => setSelection(toggleLiveDevice(chosen, d.uid))} />
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
              <select
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
              </select>
            )}
          </Field>
          {custom ? (
            <div className="range-inputs">
              <Field label={t('rangeMin')}>{(id) => <input id={id} type="number" min={0} max={4990} value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} />}</Field>
              <Field label={t('rangeMax')}>{(id) => <input id={id} type="number" min={0} max={4990} value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })} />}</Field>
            </div>
          ) : null}
          <div className="field">
            <span className="field-label">{t('viewMode')}</span>
            <Segmented<'2d' | '3d'>
              label={t('viewMode')}
              value={mode}
              options={[
                { value: '2d', label: t('view2d') },
                { value: '3d', label: t('view3d'), disabled: no3d },
              ]}
              onChange={setMode}
            />
          </div>
        </div>
      </div>
      <ColourScale range={range} label={t('colourScale')} />
      {no3d && mode === '3d' ? <Notice kind="warning">{t('view3dUnavailable')}</Notice> : null}

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
              mode={no3d ? '2d' : mode}
              onUnavailable3d={() => {
                setNo3d(true);
                setMode('2d');
              }}
              onRemove={() => setSelection(chosen.filter((u) => u !== d.uid))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LivePanel({ device, range, mode, onRemove, onUnavailable3d }: { device: DeviceView; range: PressureRange; mode: '2d' | '3d'; onRemove: () => void; onUnavailable3d: () => void }) {
  const { t, exec, api } = useStudio();
  const frame = useLiveFrame(device.online && device.matrix ? device.uid : null);
  const stats = frame ? frameStats(frame.values) : null;
  const rec = device.recording;
  const [busy, setBusy] = useState(false);
  const label = t('heatmapLabel', { device: device.displayName });
  // A device's sensor-layout profile (Profiles page) places its sensors in 2D.
  const profile = useDeviceProfile(device.uid);
  return (
    <article className="card live-panel" aria-label={device.displayName}>
      <header className="live-head">
        <StatusDot state={device.online ? 'online' : 'offline'} />
        <h3>{device.displayName}</h3>
        {profile ? <span className="tag accent">{profile.name}</span> : null}
        {rec.enabled ? <span className="tag rec">{t('recBadge')}</span> : null}
        <span className="spacer" />
        <button
          className={`button tiny ${rec.enabled ? 'danger' : ''}`}
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
      {!device.matrix ? (
        <p className="empty">{t('liveNoMatrix')}</p>
      ) : mode === '3d' ? (
        <Suspense fallback={<p className="empty">{t('loading')}</p>}>
          <Surface3D values={frame?.values ?? null} rows={device.matrix.rows} cols={device.matrix.cols} range={range} label={label} onUnavailable={onUnavailable3d} />
        </Suspense>
      ) : (
        <Heatmap values={frame?.values ?? null} rows={device.matrix.rows} cols={device.matrix.cols} range={range} label={label} maxHeight={520} profile={profile} />
      )}
      <div className="metric-row compact" aria-live="off">
        <div className="metric">
          <div className="metric-label">{t('liveMax')}</div>
          <div className="metric-value">{stats ? formatValue(stats.max) : '-'}</div>
        </div>
        <div className="metric">
          <div className="metric-label">{t('liveMean')}</div>
          <div className="metric-value">{stats ? formatValue(stats.mean) : '-'}</div>
        </div>
        <div className="metric">
          <div className="metric-label">{t('liveFps')}</div>
          <div className="metric-value">{device.online ? (frame?.fps ?? device.fps) : '-'}</div>
        </div>
      </div>
      {!device.online ? <p className="muted">{t('deviceOffline')}</p> : device.matrix && !frame ? <p className="muted">{t('liveWaiting')}</p> : null}
    </article>
  );
}
