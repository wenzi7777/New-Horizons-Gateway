// App Studio's emulator: runs the compiled flow package in the SDK's
// Simulator (plain JavaScript, no eval) on frames from a virtual device
// (preset patterns, a mouse press on the matrix, noise) or from a real
// device's live stream, and shows what the device would show: events, the
// status LED, the OLED and the external strip. A smaller port of the
// Desktop's EmulatorPanel (no recording replay; see the report).
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CirclePlay, MousePointerClick, RotateCcw } from 'lucide-react';

import { Heatmap } from '../../../components/Heatmap';
import { useStudio } from '../../../state/studio';
import { PRESSURE_FULL_SCALE, type Analysis, type SimEvent, type Simulator } from '../sdk/lib/index.mjs';
import { SYNTH_FPS, SyntheticFeed, emulatorSimulator, frameFromLiveFrame, linesForEvents } from '../lib/sdkEmulator';
import { BOARDS, SYNTH_PATTERNS, VIRTUAL_TARGET_KEY, boardById, clampShape, type MatrixTarget, type SynthPattern, type VirtualDevice } from '../lib/sdkProject';
import { useAppsT } from '../strings';
import { LedDot, OledPanel, StripPixels } from './IndicatorViews';

type Props = {
  analysis: Analysis;
  target: MatrixTarget;
  targets: MatrixTarget[];
  virtual: VirtualDevice;
  onVirtualChange: (device: VirtualDevice) => void;
  onSelectTarget: (key: string) => void;
  onMarkLines: (lines: Set<number>) => void;
};

type Shown = { values: number[]; rows: number; cols: number; led: readonly number[]; oled: ReturnType<Simulator['oledRows']>; strip: [number, number, number][] | null; frames: number };

const MAX_EVENTS = 60;
const RENDER_MS = 66;

export function EmulatorPanel({ analysis, target, targets, virtual, onVirtualChange, onSelectTarget, onMarkLines }: Props) {
  const t = useAppsT();
  const { api } = useStudio();
  const pkg = analysis.kind === 'flow' && analysis.ok ? (analysis.package as Record<string, unknown>) : null;
  const nodeLines = analysis.report?.nodeLines ?? [];
  const [running, setRunning] = useState(true);
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [shown, setShown] = useState<Shown | null>(null);
  const [epoch, setEpoch] = useState(0);
  const simRef = useRef<Simulator | null>(null);
  const feedRef = useRef<SyntheticFeed | null>(null);
  const isVirtual = target.key === VIRTUAL_TARGET_KEY;
  const deviceUid = isVirtual ? '' : target.key.replace(/^device:/, '');
  const board = target.board;
  const stripCount = board?.externalLeds ?? 0;

  // A fresh simulator whenever the package or the board changes, or on reset.
  const pkgKey = useMemo(() => (analysis.bytes ? new TextDecoder().decode(analysis.bytes) : ''), [analysis.bytes]);
  useEffect(() => {
    simRef.current = pkg ? emulatorSimulator(pkg) : null;
    setEvents([]);
    setShown(null);
    onMarkLines(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkgKey, target.key, target.rows, target.cols, epoch]);

  useEffect(() => {
    if (!isVirtual) {
      feedRef.current = null;
      return;
    }
    feedRef.current = new SyntheticFeed(target.rows, target.cols, { pattern: virtual.pattern, noise: virtual.noise });
  }, [isVirtual, target.rows, target.cols, epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.pattern = virtual.pattern;
      feedRef.current.noise = virtual.noise;
    }
  }, [virtual.pattern, virtual.noise]);

  // One step per frame; React state is refreshed at most ~15 times a second.
  const pending = useRef<{ events: SimEvent[]; last: { values: Float32Array | ArrayLike<number>; rows: number; cols: number } | null; at: number }>({ events: [], last: null, at: 0 });
  const stepFrame = (frame: Parameters<Simulator['step']>[0]) => {
    const sim = simRef.current;
    if (!sim) return;
    const produced = sim.step(frame);
    if (produced.length) pending.current.events.push(...produced);
    pending.current.last = frame;
  };
  const flush = (now: number, force = false) => {
    const sim = simRef.current;
    const state = pending.current;
    if (!sim || !state.last || (!force && now - state.at < RENDER_MS)) return;
    state.at = now;
    const fresh = state.events.splice(0);
    if (fresh.length) setEvents((current) => [...fresh.reverse(), ...current].slice(0, MAX_EVENTS));
    if (pkg) onMarkLines(linesForEvents(pkg, nodeLines, fresh));
    setShown({ values: Array.from(state.last.values as ArrayLike<number>), rows: state.last.rows, cols: state.last.cols, led: sim.led, oled: sim.oledRows(), strip: stripCount ? sim.extLeds(stripCount) : null, frames: sim.frames });
  };

  // Virtual device: SYNTH_FPS frames a second of generated pressure.
  useEffect(() => {
    if (!isVirtual || !running || !pkg) return undefined;
    let last = performance.now();
    let clock = Date.now();
    const period = 1000 / SYNTH_FPS;
    const timer = window.setInterval(() => {
      const now = performance.now();
      const feed = feedRef.current;
      if (!feed) return;
      let budget = Math.min(30, Math.floor((now - last) / period));
      while (budget-- > 0) {
        clock += period;
        last += period;
        stepFrame(feed.frame(clock));
      }
      flush(now);
    }, 33);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVirtual, running, pkgKey, epoch]);

  // A real device: its live frames (Studio sends ~30 a second; the simulator sees those, not every scanned frame).
  useEffect(() => {
    if (isVirtual || !deviceUid || !running || !pkg) return undefined;
    let seq = 0;
    return api.subscribeLive(deviceUid, (live) => {
      const frame = frameFromLiveFrame(live, seq++);
      if (frame) stepFrame(frame);
      flush(performance.now());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, isVirtual, deviceUid, running, pkgKey, epoch]);

  const cellAt = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const col = Math.min(target.cols - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * target.cols)));
    const row = Math.min(target.rows - 1, Math.max(0, Math.floor(((event.clientY - rect.top) / rect.height) * target.rows)));
    return { row, col };
  };

  if (analysis.kind !== 'flow') return <div className="sdk-panel-body"><p className="sdk-hint">{t('appsEmuFlowOnly')}</p></div>;

  const boardSpec = boardById(virtual.boardId);
  const sim = simRef.current;
  return (
    <div className="sdk-panel-body">
      <section className="sdk-section">
        <div className="field">
          <label htmlFor="apps-emu-target">{t('sdkTarget')}</label>
          <select id="apps-emu-target" value={target.key} onChange={(event) => onSelectTarget(event.target.value)}>
            <option value={VIRTUAL_TARGET_KEY}>{t('sdkEmuVirtual')}</option>
            {targets.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        {isVirtual ? (
          <div className="field-grid">
            <div className="field">
              <label htmlFor="apps-emu-board">{t('appsEmuBoard')}</label>
              <select
                id="apps-emu-board"
                value={virtual.boardId}
                onChange={(event) => {
                  const next = boardById(event.target.value);
                  onVirtualChange({ ...virtual, boardId: next.id, rows: next.rows, cols: next.cols });
                }}
              >
                {BOARDS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="apps-emu-pattern">{t('appsEmuPattern')}</label>
              <select id="apps-emu-pattern" value={virtual.pattern} onChange={(event) => onVirtualChange({ ...virtual, pattern: event.target.value as SynthPattern })}>
                {SYNTH_PATTERNS.map((pattern) => (
                  <option key={pattern} value={pattern}>
                    {t(`appsEmuPattern_${pattern}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="apps-emu-rows">{t('appsEmuRows')}</label>
              <input id="apps-emu-rows" type="number" min={1} max={boardSpec.rows} value={virtual.rows} onChange={(event) => onVirtualChange({ ...virtual, ...clampShape(boardSpec, Number(event.target.value), virtual.cols) })} />
            </div>
            <div className="field">
              <label htmlFor="apps-emu-cols">{t('appsEmuCols')}</label>
              <input id="apps-emu-cols" type="number" min={1} max={boardSpec.cols} value={virtual.cols} onChange={(event) => onVirtualChange({ ...virtual, ...clampShape(boardSpec, virtual.rows, Number(event.target.value)) })} />
            </div>
            <div className="field span-all">
              <label htmlFor="apps-emu-noise">
                {t('appsEmuNoise')} {Math.round(virtual.noise * 100)}%
              </label>
              <input id="apps-emu-noise" type="range" min={0} max={1} step={0.05} value={virtual.noise} onChange={(event) => onVirtualChange({ ...virtual, noise: Number(event.target.value) })} />
            </div>
          </div>
        ) : (
          <p className="sdk-hint">{t('appsEmuLiveNote')}</p>
        )}
      </section>

      {!pkg ? <p className="notice warning">{t('appsEmuNeedsBuild')}</p> : null}

      <div className="sdk-export">
        <button type="button" className="button" onClick={() => setRunning((value) => !value)} aria-pressed={running}>
          <CirclePlay size={14} aria-hidden="true" />
          {running ? t('appsEmuPause') : t('appsEmuRun')}
        </button>
        <button type="button" className="button" onClick={() => setEpoch((value) => value + 1)}>
          <RotateCcw size={14} aria-hidden="true" />
          {t('appsEmuReset')}
        </button>
        {sim?.hearsButton ? (
          <button type="button" className="button" onClick={() => sim.pressButton()}>
            <MousePointerClick size={14} aria-hidden="true" />
            {t('appsEmuButton')}
          </button>
        ) : null}
        {shown ? <span className="sdk-hint">{t('appsEmuFrames', { count: shown.frames })}</span> : null}
      </div>

      <section className="sdk-section">
        <div
          className={`apps-emu-matrix${isVirtual ? ' pressable' : ''}`}
          onPointerDown={(event) => {
            if (!isVirtual || !feedRef.current) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            feedRef.current.press(cellAt(event), Date.now());
          }}
          onPointerMove={(event) => {
            if (isVirtual && feedRef.current && event.buttons) feedRef.current.press(cellAt(event), Date.now());
          }}
          onPointerUp={() => feedRef.current?.press(null, Date.now())}
          onPointerCancel={() => feedRef.current?.press(null, Date.now())}
        >
          <Heatmap values={shown?.values ?? null} rows={shown?.rows ?? target.rows} cols={shown?.cols ?? target.cols} range={{ min: 0, max: PRESSURE_FULL_SCALE }} label={t('appsEmuMatrix')} maxHeight={260} />
        </div>
        {isVirtual ? <p className="sdk-hint">{t('appsEmuPressHint')}</p> : null}
      </section>

      <section className="sdk-section">
        <h3>{t('appsEmuOutputs')}</h3>
        <div className="apps-live-grid">
          {board?.oled !== false ? <OledPanel rows={shown?.oled ?? [null, null, null, null]} /> : null}
          <LedDot rgb={shown?.led ?? [0, 0, 0]} />
          {shown?.strip ? <StripPixels pixels={shown.strip} /> : null}
        </div>
      </section>

      <section className="sdk-section">
        <h3>{t('appEvents')}</h3>
        <ol className="apps-events" aria-live="polite">
          {events.map((event) => (
            <li key={`${event.seq}-${event.frameSeq}`}>
              <span className="mono muted">#{event.seq}</span>
              <span className="mono muted">f{event.frameSeq}</span>
              <strong>{event.event}</strong>
              {event.detail ? <span className="tag">{event.detail}</span> : null}
              {event.value !== null ? <em>{event.value}</em> : null}
            </li>
          ))}
          {!events.length ? <li className="empty">{t('appEventsEmpty')}</li> : null}
        </ol>
      </section>
    </div>
  );
}
