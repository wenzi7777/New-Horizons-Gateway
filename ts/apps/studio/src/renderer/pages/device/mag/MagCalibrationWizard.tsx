// The magnetometer calibration wizard -- NH Studio's copy of the Desktop's
// (components/magCalibration/MagCalibrationWizard.tsx): (use existing?) ->
// prepare -> turn the board while the live stream fills a coverage sphere ->
// result -> apply. The fitting is @nhgw/host's MagCalibrationSession.
//
// It fits the stream's samples, already calibrated with what the device
// holds, so the new fit is composed onto that one and a cancel leaves the old
// calibration untouched.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, X } from 'lucide-react';
import {
  boardArtFor,
  calibrationDue,
  calibrationFromStatus,
  MAG_CAL_FULL_MIN_COVERAGE,
  MAG_CAL_FULL_MIN_POINTS,
  MAG_REFERENCE_FIELD_UT,
  MagCalibrationSession,
  magCalibrationPayload,
  type MagCalibrationResult,
  type MagCalibrationStatus,
} from '@nhgw/host';

import { useStudio } from '../../../state/studio';
import type { Payload } from '../../../lib/commands';
import { BoardTurnAnimation } from './BoardTurnAnimation';
import { CoverageSphere } from './CoverageSphere';
import { CalibrationResultPlot } from './CalibrationResultPlot';
import { useMagT, type MagKey } from './magStrings';
import './mag.css';

export type MagSend = (label: string, payload: Payload, options?: { success?: string | false }) => Promise<{ ok: boolean; data: unknown }>;

type Phase = 'choose' | 'prepare' | 'collect' | 'result';

const NO_SAMPLE_WARN_MS = 3000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function magModeLabel(m: ReturnType<typeof useMagT>, mode: unknown): string {
  return mode === 'full' ? m('magCalModeFull') : mode === 'hard_iron' ? m('magCalModeHardIron') : m('magCalModeNone');
}

export function MagCalibrationWizard({
  uid,
  hardwareModel,
  magnetometer,
  fromEnable,
  send,
  onClose,
}: {
  uid: string;
  hardwareModel: string;
  magnetometer: Record<string, unknown>;
  /** Opened by switching the magnetometer on: cancelling switches it off again (the caller does). */
  fromEnable: boolean;
  send: MagSend;
  onClose: (applied: boolean) => void;
}) {
  const { t, api } = useStudio();
  const m = useMagT();
  const calStatus = record(magnetometer.calibration) as MagCalibrationStatus & Record<string, unknown>;
  const existing = useMemo(() => calibrationFromStatus(calStatus), [calStatus.mode, calStatus.calibrated_at_ms]); // eslint-disable-line react-hooks/exhaustive-deps
  const existingDue = calibrationDue(calStatus, Date.now());
  const offerExisting = fromEnable && existing !== null && (existingDue.state === 'ok' || existingDue.state === 'soon');

  const sessionRef = useRef<MagCalibrationSession | null>(null);
  if (!sessionRef.current) sessionRef.current = new MagCalibrationSession(existing);
  const session = sessionRef.current;

  const [phase, setPhase] = useState<Phase>(offerExisting ? 'choose' : 'prepare');
  const [, setTick] = useState(0);
  const [result, setResult] = useState<MagCalibrationResult | null>(null);
  const [applying, setApplying] = useState(false);
  const lastSampleAtRef = useRef(0);
  const [collectStartedAt, setCollectStartedAt] = useState(0);
  const art = useMemo(() => boardArtFor(hardwareModel), [hardwareModel]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !applying) onClose(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applying, onClose]);

  // Live samples while collecting (the host's live feed, ~20 per second).
  useEffect(() => {
    if (phase !== 'collect') return undefined;
    const off = api.subscribeLive(uid, (frame) => {
      if (!frame.mag || frame.mag.length < 3) return;
      lastSampleAtRef.current = Date.now();
      session.add(frame.mag);
    });
    const timer = window.setInterval(() => setTick((n) => n + 1), 200);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [api, uid, phase, session]);

  function startCollecting() {
    session.start();
    lastSampleAtRef.current = 0;
    setCollectStartedAt(Date.now());
    setResult(null);
    setPhase('collect');
  }

  function compute() {
    const next = session.compute();
    if (!next) return;
    setResult(next);
    setPhase('result');
  }

  async function apply() {
    if (!result || result.problem) return;
    setApplying(true);
    try {
      const outcome = await send(m('magCalApply'), magCalibrationPayload(result.calibration, Date.now()) as Payload);
      if (outcome.ok) onClose(true);
    } finally {
      setApplying(false);
    }
  }

  const coverage = session.coverage();
  const pointCount = session.points.length;
  const progress = Math.min(1, Math.min(pointCount / MAG_CAL_FULL_MIN_POINTS, coverage.fraction / MAG_CAL_FULL_MIN_COVERAGE));
  const ready = session.ready();
  const canCompute = session.canCompute();
  const noSamples = phase === 'collect' && Date.now() - Math.max(lastSampleAtRef.current, collectStartedAt) > NO_SAMPLE_WARN_MS;
  const magState = String(magnetometer.state ?? '');
  const ringRadius = 26;
  const ringLength = 2 * Math.PI * ringRadius;
  const steps = ['prepare', 'collect', 'result'] as const;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="mag-cal-title" onClick={() => !applying && onClose(false)}>
      <div className="modal-panel mag-cal-panel" onClick={(event) => event.stopPropagation()}>
        <header className="mag-cal-header">
          <div className="mag-cal-title">
            <Compass size={20} strokeWidth={1.75} aria-hidden="true" />
            <h3 id="mag-cal-title">{m('magCalTitle')}</h3>
          </div>
          <ol className="mag-cal-steps">
            {steps.map((step, index) => (
              <li key={step} className={phase === step ? 'active' : steps.indexOf(phase as (typeof steps)[number]) > index ? 'done' : ''}>
                {m(`magCalStep_${step}` as MagKey)}
              </li>
            ))}
          </ol>
          <button className="button tiny ghost" type="button" aria-label={t('cancel')} disabled={applying} onClick={() => onClose(false)}>
            <X size={16} />
          </button>
        </header>

        {phase === 'choose' && existing ? (
          <div className="mag-cal-body">
            <p>{m('magCalChooseCopy')}</p>
            <div className="notice">
              {magModeLabel(m, existing.mode)}
              {Number(calStatus.calibrated_at_ms) > 0 ? ` · ${new Date(Number(calStatus.calibrated_at_ms)).toLocaleString()}` : ''}
              {` · ${m('magCalResidual')} ${existing.residualPct.toFixed(1)}%`}
              {existingDue.daysLeft !== null ? ` · ${m('magCalDaysLeft', { n: existingDue.daysLeft })}` : ''}
            </div>
            <div className="form-footer">
              <button className="button" type="button" onClick={() => setPhase('prepare')}>{m('magCalRecalibrate')}</button>
              <button className="button primary" type="button" onClick={() => onClose(true)}>{m('magCalUseExisting')}</button>
            </div>
          </div>
        ) : null}

        {phase === 'prepare' ? (
          <div className="mag-cal-body mag-cal-split">
            <BoardTurnAnimation art={art} caption={m('magCalTurnCaption')} />
            <div className="mag-cal-copy">
              <h4>{m('magCalPrepareTitle')}</h4>
              <ul className="mag-cal-checklist">
                <li>{m('magCalPrepare1')}</li>
                <li>{m('magCalPrepare2')}</li>
                <li>{m('magCalPrepare3')}</li>
              </ul>
              {magState && magState !== 'ready' ? (
                <p className="notice warning">{magState === 'blocked' ? m('magBlockedByImu') : m('magCalNotReady')}</p>
              ) : null}
              <div className="form-footer">
                <button className="button" type="button" onClick={() => onClose(false)}>{t('cancel')}</button>
                <button className="button primary" type="button" onClick={startCollecting}>{m('magCalStart')}</button>
              </div>
            </div>
          </div>
        ) : null}

        {phase === 'collect' ? (
          <div className="mag-cal-body mag-cal-split">
            <BoardTurnAnimation art={art} caption={m('magCalTurnCaption')} />
            <div className="mag-cal-copy">
              <CoverageSphere coverage={coverage} points={session.points} label={m('magCalSphereLabel')} />
              <div className="mag-cal-progress">
                <svg viewBox="0 0 64 64" className={`mag-cal-ring${ready ? ' ready' : ''}`} aria-hidden="true">
                  <circle cx={32} cy={32} r={ringRadius} className="track" />
                  <circle
                    cx={32}
                    cy={32}
                    r={ringRadius}
                    className="value"
                    strokeDasharray={ringLength}
                    strokeDashoffset={ringLength * (1 - progress)}
                    transform="rotate(-90 32 32)"
                  />
                  <text x={32} y={36} textAnchor="middle">{Math.round(progress * 100)}%</text>
                </svg>
                <div>
                  <strong>{ready ? m('magCalReady') : m('magCalCollectCopy')}</strong>
                  <p className="field-note">
                    {m('magCalCoverage', { pct: Math.round(coverage.fraction * 100) })} · {m('magCalPoints', { n: pointCount })}
                  </p>
                  {!ready && coverage.nextFace ? <p className="field-note">{m('magCalNextHint')}</p> : null}
                </div>
              </div>
              {noSamples ? <p className="notice warning">{m('magCalNoSamples')}</p> : null}
              <div className="form-footer">
                <button className="button" type="button" onClick={() => onClose(false)}>{t('cancel')}</button>
                <button className={ready ? 'button primary' : 'button'} type="button" disabled={!canCompute} onClick={compute}>
                  {ready || !canCompute ? m('magCalCompute') : m('magCalComputeHardIron')}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {phase === 'result' && result ? (
          <div className="mag-cal-body">
            <CalibrationResultPlot before={result.before} after={result.after} fieldUt={result.fit.fieldUt} beforeLabel={m('magCalBefore')} afterLabel={m('magCalAfter')} />
            <dl className="mag-cal-facts">
              <div><dt>{m('magCalMode')}</dt><dd>{magModeLabel(m, result.calibration.mode)}</dd></div>
              <div>
                <dt>{m('magCalField')}</dt>
                <dd>
                  {result.calibration.fieldUt.toFixed(1)} µT
                  <small>{m('magCalFieldReference', { ref: MAG_REFERENCE_FIELD_UT })}</small>
                </dd>
              </div>
              <div><dt>{m('magCalResidual')}</dt><dd>{result.fit.residualPct.toFixed(2)}%</dd></div>
              <div><dt>{m('magCalPointsLabel')}</dt><dd>{result.before.length}</dd></div>
            </dl>
            {result.fallbackReason ? <p className="notice">{m(`magCalFallback_${result.fallbackReason}` as MagKey)}</p> : null}
            {result.residualWarn ? <p className="notice warning">{m('magCalResidualWarn')}</p> : null}
            {result.problem ? <p className="notice error">{m('magCalProblem')} ({result.problem})</p> : null}
            <details className="mag-cal-numbers">
              <summary>{m('magCalNumbers')}</summary>
              <p>{m('magCalOffset')}: [{result.calibration.offset.map((v) => v.toFixed(2)).join(', ')}] µT</p>
              <p>{m('magCalMatrix')}:</p>
              <pre>{[0, 1, 2].map((row) => result.calibration.matrix.slice(row * 3, row * 3 + 3).map((v) => v.toFixed(4).padStart(8)).join(' ')).join('\n')}</pre>
            </details>
            <div className="form-footer">
              <button className="button" type="button" disabled={applying} onClick={() => onClose(false)}>{t('cancel')}</button>
              <button className="button" type="button" disabled={applying} onClick={startCollecting}>{m('magCalRedo')}</button>
              <button className="button primary" type="button" disabled={applying || result.problem !== null} onClick={() => void apply()}>
                {applying ? t('running') : m('magCalApply')}
              </button>
            </div>
          </div>
        ) : null}

        {fromEnable && phase !== 'choose' ? <p className="field-note mag-cal-footnote">{m('magCalCancelDisables')}</p> : null}
      </div>
    </div>
  );
}
