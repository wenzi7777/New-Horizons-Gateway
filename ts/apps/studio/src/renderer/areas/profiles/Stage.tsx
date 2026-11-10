// The profile editor's stage: the background image fitted into the
// viewport, sensors on it, zoom (wheel, trackpad pinch, buttons, keys) and
// pan (scroll, Pan tool, middle button, Space-drag), pointer-driven
// add / select / drag, keyboard nudging. Positions are 0..1 ratios.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Hand, Maximize, MousePointer2, Plus, ZoomIn, ZoomOut } from 'lucide-react';

import { cssColorForValue } from '../../lib/pressureColor';
import { useAreaT } from '../i18n';
import { clamp, clampZoom, fitProfileRect, nearestSensorIndex, nudge, zoomStageAt, type Profile, type StageView } from './model';
import { PROFILE_STRINGS } from './strings';

export type StageTool = 'add' | 'select' | 'pan';

const FIT: StageView = { zoom: 1, panX: 0, panY: 0 };

export function ProfileStage({
  profile,
  selected,
  onSelect,
  onAdd,
  onMove,
  onRemove,
  values,
}: {
  profile: Profile;
  selected: number | null;
  onSelect: (position: number | null) => void;
  onAdd: (x: number, y: number) => void;
  /** Live drag / nudge of one sensor (by position in profile.sensors). */
  onMove: (position: number, x: number, y: number) => void;
  onRemove: (position: number) => void;
  /** Live frame values for the preview, or null. */
  values: readonly number[] | null;
}) {
  const pt = useAreaT(PROFILE_STRINGS);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<StageView>(FIT);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [tool, setTool] = useState<StageTool>('add');
  const [space, setSpace] = useState(false);
  const drag = useRef<{ kind: 'pan'; x: number; y: number; panX: number; panY: number } | { kind: 'sensor'; position: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const rect = fitProfileRect(size.width, size.height, profile.background.aspectRatio);
  const range = { min: profile.display.pressureMin, max: profile.display.pressureMax };
  const shortSide = Math.min(rect.drawWidth, rect.drawHeight);
  const marker = clamp(shortSide > 0 ? shortSide * 0.028 * profile.display.dotSize : 18, 16, 40);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      setView((v) => zoomStageAt(v, clientX - box.left - rect.offsetX, clientY - box.top - rect.offsetY, factor));
    },
    [rect.offsetX, rect.offsetY],
  );
  const zoomCentre = (factor: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    zoomAt(box.left + box.width / 2, box.top + box.height / 2, factor);
  };

  // Native wheel listener: React's is passive, and the page must not scroll.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Trackpad pinch arrives as ctrl+wheel; a mouse wheel as whole-line or large integer steps.
      const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
      if (e.ctrlKey || e.metaKey || mouseWheel) {
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        zoomAt(e.clientX, e.clientY, Math.exp(-clamp(delta, -100, 100) * (e.ctrlKey ? 0.01 : 0.002)));
      } else {
        setView((v) => ({ ...v, panX: v.panX - e.deltaX, panY: v.panY - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const ratioAt = (clientX: number, clientY: number) => {
    const scene = sceneRef.current;
    if (!scene) return null;
    const box = scene.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return { x: clamp((clientX - box.left) / box.width, 0, 1), y: clamp((clientY - box.top) / box.height, 0, 1), inside: clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    viewportRef.current?.focus({ preventScroll: true });
    const p = ratioAt(e.clientX, e.clientY);
    const hit = p ? nearestSensorIndex(profile.sensors, p.x, p.y, 0.045 / viewRef.current.zoom) : -1;
    const pan = tool === 'pan' || space || e.button === 1 || (tool === 'select' && hit < 0);
    if (pan) {
      drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, panX: viewRef.current.panX, panY: viewRef.current.panY };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0 || !p) return;
    if (hit >= 0) {
      onSelect(hit);
      drag.current = { kind: 'sensor', position: hit };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === 'add' && p.inside) onAdd(p.x, p.y);
    else onSelect(null);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = ratioAt(e.clientX, e.clientY);
    setCursor(p && p.inside ? { x: p.x, y: p.y } : null);
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') setView((v) => ({ ...v, panX: d.panX + e.clientX - d.x, panY: d.panY + e.clientY - d.y }));
    else if (p) onMove(d.position, p.x, p.y);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.02 : e.altKey ? 0.001 : 0.005;
    const s = selected !== null ? profile.sensors[selected] : undefined;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const dir = arrows[e.key];
    if (dir && s && selected !== null) {
      e.preventDefault();
      const next = nudge(s.x, s.y, dir[0] / view.zoom, dir[1] / view.zoom);
      onMove(selected, next.x, next.y);
    } else if (dir) {
      e.preventDefault();
      setView((v) => ({ ...v, panX: v.panX - dir[0] * 2000, panY: v.panY - dir[1] * 2000 }));
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
      e.preventDefault();
      onRemove(selected);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomCentre(1.25);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomCentre(0.8);
    } else if (e.key === '0') {
      e.preventDefault();
      setView(FIT);
    } else if (e.key === 'Escape') {
      onSelect(null);
    } else if (e.key === ' ') {
      e.preventDefault();
      setSpace(true);
    } else if (e.key === 'Tab' && profile.sensors.length && !e.metaKey && !e.ctrlKey) {
      // Tab walks the sensors while the stage has focus; past either end it leaves the stage.
      const next = selected === null ? (e.shiftKey ? profile.sensors.length - 1 : 0) : selected + (e.shiftKey ? -1 : 1);
      if (next >= 0 && next < profile.sensors.length) {
        e.preventDefault();
        onSelect(next);
      }
    }
  };

  const cursorText = cursor ? `${cursor.x.toFixed(3)}, ${cursor.y.toFixed(3)}` : '–';
  const selectedSensor = selected !== null ? profile.sensors[selected] : undefined;

  return (
    <div className="profile-stage-wrap">
      <div className="profile-stage-tools" role="toolbar" aria-label={pt('tools')}>
        {([
          ['add', pt('toolAdd'), <Plus key="i" size={15} aria-hidden="true" />],
          ['select', pt('toolSelect'), <MousePointer2 key="i" size={15} aria-hidden="true" />],
          ['pan', pt('toolPan'), <Hand key="i" size={15} aria-hidden="true" />],
        ] as const).map(([id, label, icon]) => (
          <button key={id} type="button" className={`icon-button${tool === id ? ' active' : ''}`} aria-pressed={tool === id} aria-label={label} title={label} onClick={() => setTool(id)}>
            {icon}
          </button>
        ))}
        <span className="profile-stage-sep" aria-hidden="true" />
        <button type="button" className="icon-button" aria-label={pt('zoomOut')} title={pt('zoomOut')} onClick={() => zoomCentre(0.8)} disabled={view.zoom <= 0.2}>
          <ZoomOut size={15} aria-hidden="true" />
        </button>
        <span className="mono profile-stage-zoom" aria-live="polite">{Math.round(view.zoom * 100)}%</span>
        <button type="button" className="icon-button" aria-label={pt('zoomIn')} title={pt('zoomIn')} onClick={() => zoomCentre(1.25)} disabled={view.zoom >= 12}>
          <ZoomIn size={15} aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label={pt('fit')} title={pt('fit')} onClick={() => setView(FIT)}>
          <Maximize size={15} aria-hidden="true" />
        </button>
        <span className="spacer" />
        <span className="mono muted profile-stage-cursor">{cursorText}</span>
      </div>
      <div
        ref={viewportRef}
        className={`profile-stage tool-${space ? 'pan' : tool}`}
        tabIndex={0}
        role="application"
        aria-label={pt('stageLabel')}
        aria-describedby="profile-stage-help"
        aria-activedescendant={selected !== null ? `profile-sensor-${selected}` : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          if (e.key === ' ') setSpace(false);
        }}
        onBlur={() => setSpace(false)}
      >
        <div
          ref={sceneRef}
          className="profile-scene"
          style={{
            left: rect.offsetX,
            top: rect.offsetY,
            width: rect.drawWidth,
            height: rect.drawHeight,
            transform: `translate(${view.panX}px, ${view.panY}px) scale(${clampZoom(view.zoom)})`,
          }}
        >
          {profile.background.imageData ? <img className="profile-scene-image" src={profile.background.imageData} alt="" draggable={false} /> : <div className="profile-scene-blank" aria-hidden="true" />}
          {profile.sensors.map((s, i) => {
            const value = values ? values[s.index] : undefined;
            const live = typeof value === 'number' && Number.isFinite(value);
            return (
              <div
                key={i}
                id={`profile-sensor-${i}`}
                role="img"
                aria-label={pt('sensorButton', { label: s.label, index: s.index })}
                className={`profile-marker${i === selected ? ' selected' : ''}${s.enabled ? '' : ' disabled'}${live ? ' live' : ''}`}
                style={{
                  left: `${s.x * 100}%`,
                  top: `${s.y * 100}%`,
                  width: marker / view.zoom,
                  height: marker / view.zoom,
                  fontSize: clamp(marker * 0.3, 7, 11) / view.zoom,
                  ...(live ? { background: cssColorForValue(value, range) } : {}),
                }}
              >
                <span>{s.label}</span>
              </div>
            );
          })}
        </div>
      </div>
      <p id="profile-stage-help" className="muted profile-stage-help">
        {selectedSensor ? `${selectedSensor.label} · ${pt('position', { x: selectedSensor.x.toFixed(3), y: selectedSensor.y.toFixed(3) })} · ` : ''}
        {pt('stageHelp')}
      </p>
    </div>
  );
}
