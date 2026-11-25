// Magnetometer calibration on NH Pocket -- the Desktop's and Studio's wizard
// on a phone, stacked: (use existing?) -> prepare -> turn the board while the
// live feed fills a coverage sphere -> result -> apply. The fitting is
// @nhgw/host's MagCalibrationSession; this only draws it.
//
// Opened by switching the magnetometer on (fromEnable): leaving without
// applying -- Cancel, back, a swipe -- switches it off again, so the UI never
// leaves an uncalibrated magnetometer behind.

import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, { Circle, G, Line, Rect, Text as SvgText } from 'react-native-svg';
import {
  boardArtFor,
  calibrationDue,
  calibrationFromStatus,
  COVERAGE_DIRECTIONS,
  MAG_CAL_FULL_MIN_COVERAGE,
  MAG_CAL_FULL_MIN_POINTS,
  MAG_REFERENCE_FIELD_UT,
  MagCalibrationSession,
  type BoardArt,
  type MagCalibrationResult,
  type MagCoverage,
  type MagFace,
  type MagVec,
} from '@nhgw/host';

import { errorText } from '../../i18n/strings';
import { Body, Button, Caption, Card, Collapsible, Empty, FactRow, Notice, Screen } from '../components/primitives';
import { magModeText } from '../components/MagnetometerCard';
import { useI18n } from '../i18n';
import { useStore, useStoreSelector } from '../store';
import { useToast } from '../components/feedback';
import { useTheme } from '../theme';

type Phase = 'choose' | 'prepare' | 'collect' | 'result';

const NO_SAMPLE_WARN_MS = 3000;
const FACE_AXIS: Record<MagFace, MagVec> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };

function nextFaceDirection(dir: MagVec, face: MagFace | null): boolean {
  if (!face) return false;
  const a = FACE_AXIS[face];
  return dir[0] * a[0] + dir[1] * a[1] + dir[2] * a[2] > 0.5;
}

// ---- the turning board ---------------------------------------------------------

/** The board turning (figure-8 then each face), with RN Animated; still under reduce-motion. */
function TurningBoard({ art, caption }: { art: BoardArt | null; caption: string }) {
  const theme = useTheme();
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (theme.reduceMotion) return undefined;
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 12000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [spin, theme.reduceMotion]);
  const steps = [0, 0.06, 0.12, 0.18, 0.24, 0.36, 0.45, 0.54, 0.63, 0.72, 0.81, 0.9, 1];
  const rotateX = spin.interpolate({ inputRange: steps, outputRange: ['0deg', '35deg', '0deg', '-35deg', '0deg', '0deg', '0deg', '0deg', '0deg', '70deg', '-70deg', '0deg', '0deg'] });
  const rotateY = spin.interpolate({ inputRange: steps, outputRange: ['0deg', '40deg', '0deg', '-40deg', '0deg', '0deg', '180deg', '70deg', '-70deg', '0deg', '0deg', '0deg', '0deg'] });
  const rotateZ = spin.interpolate({ inputRange: steps, outputRange: ['0deg', '10deg', '0deg', '-10deg', '0deg', '0deg', '0deg', '0deg', '0deg', '0deg', '0deg', '0deg', '360deg'] });
  const width = art?.width ?? 30;
  const height = art?.height ?? 40;
  const pad = 6;
  return (
    <View style={{ alignItems: 'center', gap: 8 }}>
      <View style={{ height: 180, width: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.panelSoft, borderRadius: 12 }}>
        <Animated.View
          style={{
            width: 96,
            height: 128,
            transform: theme.reduceMotion ? [{ perspective: 600 }, { rotateX: '20deg' }, { rotateY: '-25deg' }] : [{ perspective: 600 }, { rotateX }, { rotateY }, { rotateZ }],
          }}
        >
          <Svg width="100%" height="100%" viewBox={`${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`}>
            <Rect x={0} y={0} width={width} height={height} rx={1.6} fill="#1f6b54" stroke="#17533f" strokeWidth={0.6} />
            {art ? (
              art.parts.map((part, i) => (
                <Rect key={i} x={part.x} y={part.y} width={part.w} height={part.h} rx={0.4} fill={part.kind === 'module' ? '#c9ccd1' : part.kind === 'antenna' ? '#2f8a6d' : part.kind === 'fpc' || part.kind === 'connector' ? '#f1ede2' : part.kind === 'ic' ? '#2b2b2e' : '#a7abb2'} />
              ))
            ) : (
              <>
                <Rect x={width * 0.3} y={height * 0.12} width={width * 0.4} height={height * 0.3} rx={0.6} fill="#c9ccd1" />
                <Rect x={width * 0.42} y={height * 0.6} width={width * 0.16} height={width * 0.16} rx={0.4} fill="#2b2b2e" />
              </>
            )}
          </Svg>
        </Animated.View>
      </View>
      <Caption style={{ textAlign: 'center' }}>{caption}</Caption>
    </View>
  );
}

// ---- the coverage sphere ---------------------------------------------------------

function CoverageSphere({ coverage, points }: { coverage: MagCoverage; points: readonly MagVec[] }) {
  const { colors } = useTheme();
  const project = (d: MagVec) => ({ x: (d[0] - d[1]) * 0.8 * 80, y: (-d[2] * 0.9 + (d[0] + d[1]) * 0.35) * 80, depth: d[0] + d[1] });
  const samples = points.slice(-200).map((p) => {
    const d: MagVec = [p[0] - coverage.centre[0], p[1] - coverage.centre[1], p[2] - coverage.centre[2]];
    const n = Math.hypot(d[0], d[1], d[2]) || 1;
    return project([d[0] / n, d[1] / n, d[2] / n]);
  });
  const markers = COVERAGE_DIRECTIONS.map((dir, i) => ({ dir, i, ...project(dir) })).sort((a, b) => a.depth - b.depth);
  return (
    <View style={{ height: 220, backgroundColor: colors.panelSoft, borderRadius: 12 }}>
      <Svg width="100%" height="100%" viewBox="-110 -110 220 220">
        <Circle cx={0} cy={0} r={92} fill="none" stroke={colors.lineStrong} />
        <G>
          {samples.map((p, i) => (
            <Circle key={`s${i}`} cx={p.x} cy={p.y} r={1.2} fill={colors.accent} opacity={0.35} />
          ))}
        </G>
        {markers.map(({ dir, i, x, y, depth }) => {
          const covered = coverage.covered[i] === true;
          const next = !covered && nextFaceDirection(dir, coverage.nextFace);
          return (
            <Circle
              key={i}
              cx={x}
              cy={y}
              r={next ? 7 : depth < 0 ? 4 : 5.5}
              fill={covered ? colors.accent : next ? colors.warning : colors.textMuted}
              opacity={covered || next ? 1 : depth < 0 ? 0.25 : 0.55}
            />
          );
        })}
      </Svg>
    </View>
  );
}

function ProgressRing({ progress, ready }: { progress: number; ready: boolean }) {
  const { colors } = useTheme();
  const r = 26;
  const length = 2 * Math.PI * r;
  return (
    <Svg width={64} height={64} viewBox="0 0 64 64">
      <Circle cx={32} cy={32} r={r} fill="none" stroke={colors.lineStrong} strokeWidth={6} />
      <Circle
        cx={32}
        cy={32}
        r={r}
        fill="none"
        stroke={ready ? colors.success : colors.accent}
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={`${length}`}
        strokeDashoffset={length * (1 - progress)}
        transform="rotate(-90 32 32)"
      />
      <SvgText x={32} y={36} fontSize={13} fontWeight="600" textAnchor="middle" fill={colors.text}>
        {`${Math.round(progress * 100)}%`}
      </SvgText>
    </Svg>
  );
}

// ---- before / after ------------------------------------------------------------

function ResultPlot({ result }: { result: MagCalibrationResult }) {
  const { colors } = useTheme();
  const thin = (points: readonly MagVec[]) => (points.length <= 400 ? points : points.filter((_, i) => i % Math.ceil(points.length / 400) === 0));
  const before = thin(result.before);
  const after = thin(result.after);
  const field = result.fit.fieldUt;
  let extent = field * 1.15;
  for (const p of [...before, ...after]) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const scale = 46 / Math.max(1, extent * 1.05);
  const planes: { label: string; a: 0 | 1 | 2; b: 0 | 1 | 2 }[] = [
    { label: 'X–Y', a: 0, b: 1 },
    { label: 'X–Z', a: 0, b: 2 },
    { label: 'Y–Z', a: 1, b: 2 },
  ];
  return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {planes.map((plane) => (
        <View key={plane.label} style={{ flex: 1, alignItems: 'center', backgroundColor: colors.panelSoft, borderRadius: 8, padding: 4 }}>
          <Svg width="100%" height={100} viewBox="-50 -50 100 100">
            <Line x1={-50} y1={0} x2={50} y2={0} stroke={colors.lineStrong} strokeWidth={0.4} />
            <Line x1={0} y1={-50} x2={0} y2={50} stroke={colors.lineStrong} strokeWidth={0.4} />
            <Circle cx={0} cy={0} r={field * scale} fill="none" stroke={colors.success} strokeWidth={0.6} strokeDasharray="2 1.5" />
            {before.map((p, i) => (
              <Circle key={`b${i}`} cx={p[plane.a] * scale} cy={-p[plane.b] * scale} r={0.9} fill={colors.textMuted} opacity={0.45} />
            ))}
            {after.map((p, i) => (
              <Circle key={`a${i}`} cx={p[plane.a] * scale} cy={-p[plane.b] * scale} r={0.9} fill={colors.accent} opacity={0.8} />
            ))}
          </Svg>
          <Caption>{plane.label}</Caption>
        </View>
      ))}
    </View>
  );
}

// ---- the screen ----------------------------------------------------------------

export function MagCalibrationScreen({ uid, fromEnable }: { uid: string; fromEnable: boolean }) {
  const { t, locale } = useI18n();
  const store = useStore();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const device = useStoreSelector((s) => s.devices().find((d) => d.uid === uid) ?? null);
  const mag = device?.magnetometer;
  const calStatus = mag?.calibration ?? {};
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
  const art = useMemo(() => boardArtFor(device?.hardwareModel), [device?.hardwareModel]);

  // Leaving without a calibration (Cancel, back, swipe) switches the magnetometer off again.
  const keptRef = useRef(false);
  useEffect(
    () => () => {
      if (fromEnable && !keptRef.current) void store.run(uid, { kind: 'mag', enabled: false });
    },
    [fromEnable, store, uid],
  );

  useEffect(() => {
    if (phase !== 'collect') return undefined;
    const off = store.subscribeLive(uid, (frame) => {
      if (!frame.mag || frame.mag.length < 3) return;
      lastSampleAtRef.current = Date.now();
      session.add(frame.mag);
    });
    const timer = setInterval(() => setTick((n) => n + 1), 250);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [phase, session, store, uid]);

  const leave = (kept: boolean) => {
    keptRef.current = kept;
    if (router.canGoBack()) router.back();
  };

  const startCollecting = () => {
    session.start();
    lastSampleAtRef.current = 0;
    setCollectStartedAt(Date.now());
    setResult(null);
    setPhase('collect');
  };

  const compute = () => {
    const next = session.compute();
    if (!next) return;
    setResult(next);
    setPhase('result');
  };

  const apply = async () => {
    if (!result || result.problem) return;
    setApplying(true);
    try {
      const outcome = await store.run(uid, { kind: 'mag_calibration', calibration: result.calibration, nowMs: Date.now() });
      if (outcome.ok) {
        toast.show(t('actionDone'));
        leave(true);
      } else {
        toast.show(t('actionFailed', { error: errorText(locale, outcome.message) }), 'danger');
      }
    } finally {
      setApplying(false);
    }
  };

  if (!device || !mag) {
    return (
      <Screen topInset={false}>
        <Stack.Screen options={{ title: t('magCalTitle') }} />
        <Card>
          <Empty>{t('deviceGone')}</Empty>
        </Card>
      </Screen>
    );
  }

  const coverage = session.coverage();
  const count = session.points.length;
  const progress = Math.min(1, Math.min(count / MAG_CAL_FULL_MIN_POINTS, coverage.fraction / MAG_CAL_FULL_MIN_COVERAGE));
  const ready = session.ready();
  const canCompute = session.canCompute();
  const noSamples = phase === 'collect' && Date.now() - Math.max(lastSampleAtRef.current, collectStartedAt) > NO_SAMPLE_WARN_MS;
  const row = { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' } as const;

  return (
    <Screen topInset={false}>
      <Stack.Screen options={{ title: t('magCalTitle') }} />

      {phase === 'choose' && existing ? (
        <Card>
          <Body>{t('magCalChooseCopy')}</Body>
          <Caption>
            {[
              magModeText(t, existing.mode),
              Number(calStatus.calibrated_at_ms) > 0 ? new Date(Number(calStatus.calibrated_at_ms)).toLocaleString() : '',
              `${t('magCalResidual')} ${existing.residualPct.toFixed(1)}%`,
              existingDue.daysLeft !== null ? t('magCalDaysLeft', { n: existingDue.daysLeft }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Caption>
          <View style={row}>
            <Button label={t('magCalRecalibrate')} onPress={() => setPhase('prepare')} />
            <Button label={t('magCalUseExisting')} variant="primary" onPress={() => leave(true)} />
          </View>
        </Card>
      ) : null}

      {phase === 'prepare' || phase === 'collect' ? (
        <Card>
          <TurningBoard art={art} caption={t('magCalTurnCaption')} />
        </Card>
      ) : null}

      {phase === 'prepare' ? (
        <Card>
          <Body style={{ fontWeight: '600' }}>{t('magCalPrepareTitle')}</Body>
          <Caption>• {t('magCalPrepare1')}</Caption>
          <Caption>• {t('magCalPrepare2')}</Caption>
          <Caption>• {t('magCalPrepare3')}</Caption>
          {mag.state !== 'ready' ? <Notice tone="warning">{mag.state === 'blocked' ? t('magBlockedByImu') : t('magCalNotReady')}</Notice> : null}
          <View style={row}>
            <Button label={t('cancel')} onPress={() => leave(false)} />
            <Button label={t('magCalStart')} variant="primary" onPress={startCollecting} />
          </View>
        </Card>
      ) : null}

      {phase === 'collect' ? (
        <Card>
          <CoverageSphere coverage={coverage} points={session.points} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 }}>
            <ProgressRing progress={progress} ready={ready} />
            <View style={{ flex: 1 }}>
              <Body style={{ fontWeight: '600' }}>{ready ? t('magCalReady') : t('magCalCollectCopy')}</Body>
              <Caption>
                {t('magCalCoverage', { pct: Math.round(coverage.fraction * 100) })} · {t('magCalPoints', { n: count })}
              </Caption>
              {!ready && coverage.nextFace ? <Caption>{t('magCalNextHint')}</Caption> : null}
            </View>
          </View>
          {noSamples ? <Notice tone="warning">{t('magCalNoSamples')}</Notice> : null}
          <View style={row}>
            <Button label={t('cancel')} onPress={() => leave(false)} />
            <Button label={ready || !canCompute ? t('magCalCompute') : t('magCalComputeHardIron')} variant={ready ? 'primary' : 'secondary'} disabled={!canCompute} onPress={compute} />
          </View>
        </Card>
      ) : null}

      {phase === 'result' && result ? (
        <Card>
          <ResultPlot result={result} />
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 16 }}>
            <Caption>
              <Body style={{ color: colors.textMuted }}>●</Body> {t('magCalBefore')}
            </Caption>
            <Caption>
              <Body style={{ color: colors.accent }}>●</Body> {t('magCalAfter')}
            </Caption>
          </View>
          <FactRow label={t('magCalMode')} value={magModeText(t, result.calibration.mode)} />
          <FactRow label={t('magCalField')} value={`${result.calibration.fieldUt.toFixed(1)} µT`} />
          <Caption>{t('magCalFieldReference', { ref: MAG_REFERENCE_FIELD_UT })}</Caption>
          <FactRow label={t('magCalResidual')} value={`${result.fit.residualPct.toFixed(2)}%`} />
          <FactRow label={t('magCalPointsLabel')} value={String(result.before.length)} />
          {result.fallbackReason ? <Notice tone="muted">{t(`magCalFallback_${result.fallbackReason}` as never)}</Notice> : null}
          {result.residualWarn ? <Notice tone="warning">{t('magCalResidualWarn')}</Notice> : null}
          {result.problem ? <Notice tone="danger">{`${t('magCalProblem')} (${result.problem})`}</Notice> : null}
          <Collapsible title={t('magCalNumbers')}>
            <Caption>{`${t('magCalOffset')}: [${result.calibration.offset.map((v) => v.toFixed(2)).join(', ')}] µT`}</Caption>
            <Caption>{`${t('magCalMatrix')}:\n${[0, 1, 2].map((r) => result.calibration.matrix.slice(r * 3, r * 3 + 3).map((v) => v.toFixed(4)).join('  ')).join('\n')}`}</Caption>
          </Collapsible>
          <View style={row}>
            <Button label={t('cancel')} disabled={applying} onPress={() => leave(false)} />
            <Button label={t('magCalRedo')} disabled={applying} onPress={startCollecting} />
            <Button label={t('magCalApply')} variant="primary" busy={applying} disabled={result.problem !== null} onPress={() => void apply()} />
          </View>
        </Card>
      ) : null}

      {fromEnable && phase !== 'choose' ? <Caption style={{ textAlign: 'center' }}>{t('magCalCancelDisables')}</Caption> : null}
    </Screen>
  );
}
