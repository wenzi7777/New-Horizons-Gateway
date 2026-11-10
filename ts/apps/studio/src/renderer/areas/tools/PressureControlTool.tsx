// Tools > Pressure control: the Desktop's PressureControlTool against the
// lab Raspberry Pi pressure chamber, proxied by the main process (tools area
// pressure* methods). The safety flow is the Desktop's exactly: 28 kPa cap,
// "compressor ON" confirmation before start, and on stop hold 0.5 kPa ->
// ask for the compressor OFF -> residual test at 5 kPa for 15 s -> only then
// stop (the UNO's PCTRL,0 opens the intake valve, so stop is never sent while
// the compressor could still feed air).

import { useEffect, useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';

import type { PressurePreset, PressureReadings, PressureResult } from '../../../shared/areas/tools';
import { Card, Field, Notice, useConfirm, NumberInput, Select, TextInput } from '../../components/ui';
import { useStudio } from '../../state/studio';
import { useAreaT } from '../i18n';
import { toolsApi } from './api';
import { toolsStrings } from './toolsStrings';
import './tools-analysis.css';

export const PRESSURE_MAX_KPA = 28;
export const PRESSURE_BASELINE_KPA = 0.5;
export const PRESSURE_RESIDUAL_TEST_KPA = 5;
export const PRESSURE_RESIDUAL_TEST_TIMEOUT_MS = 15000;
export const STABLE_TOLERANCE_KPA = 0.5;
export const STABLE_CONFIRM_SAMPLES = 5;
export const POLL_INTERVAL_MS = 500;

type PressurePhase = 'idle' | 'pressurizing' | 'stabilizing' | 'stable' | 'stopping' | 'awaiting_compressor_off' | 'testing_residual' | 'residual_unsafe' | 'safe_done';

/** The Desktop's api helpers threw on a non-2xx reply; keep that shape. */
async function unwrap<T>(result: Promise<PressureResult<T>>): Promise<T> {
  const r = await result;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export function PressureControlTool() {
  const t = useAreaT(toolsStrings);
  const { api } = useStudio();
  const tools = useMemo(() => toolsApi(api), [api]);
  const [confirmNode, confirm] = useConfirm();

  const [serverPresets, setServerPresets] = useState<PressurePreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState('lab_pi');
  const [customUrl, setCustomUrl] = useState('');
  const [token, setToken] = useState('');
  const [tokenHint, setTokenHint] = useState('');
  const [configured, setConfigured] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [healthText, setHealthText] = useState('');

  const [targetInput, setTargetInput] = useState('10');
  const [isRunning, setIsRunning] = useState(false);
  const [phase, setPhase] = useState<PressurePhase>('idle');
  const [currentKpa, setCurrentKpa] = useState<number | null>(null);
  const [imadaReading, setImadaReading] = useState<PressureReadings['imada']>(null);
  const [showCompressorOffBanner, setShowCompressorOffBanner] = useState(false);
  const [compressorOffAsked, setCompressorOffAsked] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stableCountRef = useRef(0);
  const abortShutdownRef = useRef(false);
  const targetInputRef = useRef(targetInput);
  useEffect(() => {
    targetInputRef.current = targetInput;
  }, [targetInput]);

  const refreshSettings = async () => {
    const s = await tools.pressureSettings();
    setConfigured(s.configured);
    setServerPresets(s.presets ?? []);
    setSelectedPreset(s.preset ?? 'lab_pi');
    setTokenHint(s.tokenHint);
    if (s.url) setCustomUrl(s.url);
  };

  useEffect(() => {
    refreshSettings().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools]);

  useEffect(() => {
    if (isRunning) {
      pollRef.current = setInterval(() => {
        void pollReadings();
      }, POLL_INTERVAL_MS);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
      stableCountRef.current = 0;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  async function pollReadings() {
    try {
      const r = await unwrap(tools.pressureReadings());
      const kpa = r.uno.pressure_kpa;
      setCurrentKpa(kpa);
      setImadaReading(r.imada);
      if (r.uno.safety_latched) setPhase('pressurizing'); // safety clamp: UNO paused intake, target preserved, auto-resumes

      const target = parseFloat(targetInputRef.current);
      if (isNaN(target)) return;

      if (Math.abs(kpa - target) <= STABLE_TOLERANCE_KPA) {
        stableCountRef.current += 1;
        setPhase(stableCountRef.current >= STABLE_CONFIRM_SAMPLES ? 'stable' : 'stabilizing');
      } else {
        stableCountRef.current = 0;
        setPhase('pressurizing');
      }
    } catch {
      /* ignore transient errors */
    }
  }

  async function handleSaveSettings() {
    setSettingsSaving(true);
    setSettingsError('');
    try {
      await unwrap(
        selectedPreset === 'custom'
          ? tools.pressureSaveSettings({ preset: 'custom', url: customUrl, token: token || undefined })
          : tools.pressureSaveSettings({ preset: selectedPreset, token: token || undefined }),
      );
      await refreshSettings();
      setToken('');
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleHealth() {
    setHealthText('');
    setSettingsError('');
    try {
      await unwrap(tools.pressureHealth());
      setHealthText(t('healthOk'));
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleStart() {
    const kpa = parseFloat(targetInput);
    if (isNaN(kpa) || kpa < 0 || kpa > PRESSURE_MAX_KPA) return;
    const ok = await confirm({ title: t('compressorOnConfirmTitle'), message: t('compressorOnConfirm'), confirmLabel: t('compressorOnConfirmOk') });
    if (ok) await handleStartConfirmed();
  }

  async function handleStartConfirmed() {
    setShowCompressorOffBanner(false);
    const kpa = parseFloat(targetInput);
    try {
      await unwrap(tools.pressureSetTarget(kpa));
      stableCountRef.current = 0;
      setCurrentKpa(null);
      setPhase('pressurizing');
      setIsRunning(true);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function askCompressorOff() {
    setCompressorOffAsked(true);
    const ok = await confirm({ title: t('compressorOffConfirmTitle'), message: t('compressorOffConfirmMsg'), confirmLabel: t('compressorOffConfirmOk') });
    setCompressorOffAsked(false);
    if (ok) await runResidualSafetyTest();
  }

  async function handleStop() {
    // Stop the live polling loop; the residual test does its own manual polling.
    setIsRunning(false);
    abortShutdownRef.current = false;
    setPhase('stopping');
    // Hold at baseline so the intake valve stops feeding air before we ask the
    // user to turn off the compressor.
    try {
      await unwrap(tools.pressureSetTarget(PRESSURE_BASELINE_KPA));
    } catch {
      /* ignore */
    }
    setPhase('awaiting_compressor_off');
    await askCompressorOff();
  }

  async function waitForResidualOrTimeout(targetKpa: number, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    let stable = 0;
    while (Date.now() - startedAt < timeoutMs) {
      if (abortShutdownRef.current) return false;
      try {
        const r = await unwrap(tools.pressureReadings());
        setCurrentKpa(r.uno.pressure_kpa);
        setImadaReading(r.imada);
        if (Math.abs(r.uno.pressure_kpa - targetKpa) < STABLE_TOLERANCE_KPA) {
          stable++;
          if (stable >= STABLE_CONFIRM_SAMPLES) return true;
        } else {
          stable = 0;
        }
      } catch {
        /* ignore */
      }
      await new Promise<void>((res) => setTimeout(res, POLL_INTERVAL_MS));
    }
    return false;
  }

  async function runResidualSafetyTest() {
    abortShutdownRef.current = false;
    try {
      setPhase('testing_residual');
      await unwrap(tools.pressureSetTarget(PRESSURE_RESIDUAL_TEST_KPA));
      const reached = await waitForResidualOrTimeout(PRESSURE_RESIDUAL_TEST_KPA, PRESSURE_RESIDUAL_TEST_TIMEOUT_MS);
      if (abortShutdownRef.current) {
        try {
          await unwrap(tools.pressureStop());
        } catch {
          /* ignore */
        }
        setPhase('idle');
        setCurrentKpa(null);
        setImadaReading(null);
        return;
      }
      if (reached) {
        // Residual still high: not safe to disable. Return to baseline and wait.
        try {
          await unwrap(tools.pressureSetTarget(PRESSURE_BASELINE_KPA));
        } catch {
          /* ignore */
        }
        setPhase('residual_unsafe');
      } else {
        // Residual depleted: safe to disable.
        await unwrap(tools.pressureStop());
        setPhase('safe_done');
      }
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
      try {
        await unwrap(tools.pressureStop());
      } catch {
        /* ignore */
      }
      setPhase('idle');
      setCurrentKpa(null);
      setImadaReading(null);
    }
  }

  const isShuttingDown = phase === 'stopping' || phase === 'awaiting_compressor_off' || phase === 'testing_residual' || phase === 'residual_unsafe';
  // Active shutdown steps block Start; the terminal states (residual_unsafe,
  // safe_done) do not, so the user can start again without a reload.
  const shutdownActive = phase === 'stopping' || phase === 'awaiting_compressor_off' || phase === 'testing_residual';

  const phaseLabel = (() => {
    switch (phase) {
      case 'pressurizing':
        return t('pluginPressureControlPressurizing');
      case 'stabilizing':
        return t('pluginPressureControlStabilizing');
      case 'stable':
        return t('pluginPressureControlStable');
      case 'stopping':
        return t('pressureCalStateStoppingPressure');
      case 'awaiting_compressor_off':
        return t('pressureCalStateAwaitingCompressorOff');
      case 'testing_residual':
        return t('pressureCalStateTestingResidual');
      case 'residual_unsafe':
        return t('pressureCalStateResidualUnsafe');
      case 'safe_done':
        return t('pressureCalStateSafeDone');
      default:
        return t('pluginPressureControlIdle');
    }
  })();

  const pressureFillPercent = Math.max(0, Math.min(100, ((currentKpa ?? 0) / PRESSURE_MAX_KPA) * 100));
  const targetKpa = parseFloat(targetInput);
  const targetValid = !isNaN(targetKpa) && targetKpa >= 0 && targetKpa <= PRESSURE_MAX_KPA;
  const preset = serverPresets.find((p) => p.id === selectedPreset);

  return (
    <div className="stack">
      {confirmNode}
      {showCompressorOffBanner ? (
        <div className="pressure-banner" role="alert">
          <TriangleAlert size={20} aria-hidden="true" />
          <span>{t('compressorOffBanner')}</span>
          <button className="button" type="button" onClick={() => setShowCompressorOffBanner(false)}>
            {t('compressorOffDismiss')}
          </button>
        </div>
      ) : null}
      {phase === 'awaiting_compressor_off' && !compressorOffAsked ? (
        <div className="pressure-buttons">
          <button className="button primary" type="button" onClick={() => void askCompressorOff()}>
            {t('compressorOffConfirmOk')}
          </button>
        </div>
      ) : null}

      <Card
        title={t('pluginPressureControlApiSettings')}
        actions={
          <div className="pressure-buttons" style={{ marginTop: 0 }}>
            <button className="button" type="button" disabled={!configured || settingsSaving} onClick={() => void handleHealth()}>
              {t('health')}
            </button>
            <button className="button primary" type="button" disabled={settingsSaving || isRunning} onClick={() => void handleSaveSettings()}>
              {settingsSaving ? '…' : t('pressureCalApiSave')}
            </button>
          </div>
        }
      >
        <div className="field-grid">
          <Field label={t('pressureCalServer')}>
            {(id) => (
              <Select id={id} value={selectedPreset} onChange={(e) => setSelectedPreset(e.target.value)} disabled={isRunning}>
                {serverPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">{t('pressureCalServerCustom')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('pressureCalApiUrl')}>
            {(id) =>
              selectedPreset !== 'custom' && preset ? (
                <TextInput id={id} type="url" value={preset.url} readOnly />
              ) : (
                <TextInput id={id} type="url" value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} disabled={isRunning} />
              )
            }
          </Field>
          <Field label={t('pressureCalApiToken')} hint={tokenHint ? t('tokenSaved', { hint: tokenHint }) : selectedPreset !== 'custom' ? t('presetTokenNote') : undefined}>
            {(id) => (
              <TextInput
                id={id}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={tokenHint ? t('tokenKeep') : ''}
                disabled={isRunning}
              />
            )}
          </Field>
        </div>
        {settingsError ? <Notice kind="error">{settingsError}</Notice> : null}
        {settingsSaved && !settingsError ? <Notice kind="success">{t('pressureSavedOk')}</Notice> : null}
        {healthText && !settingsError ? <Notice kind="success">{healthText}</Notice> : null}
        {!configured && !settingsError ? <Notice>{t('pluginPressureControlNotConfigured')}</Notice> : null}
      </Card>

      <div className="pressure-layout">
        <Card title={t('pluginPressureControlName')}>
          <Field label={t('pluginPressureControlTarget')} hint={t('pluginPressureControlSafetyLimit')}>
            {(id) => (
              <div className="pressure-input-row">
                <NumberInput id={id} min={0} max={PRESSURE_MAX_KPA} step={0.5} value={targetInput} onChange={(e) => setTargetInput(e.target.value)} disabled={isRunning} />
                <span>kPa</span>
              </div>
            )}
          </Field>
          <div className="pressure-buttons">
            <button className="button primary" type="button" onClick={() => void handleStart()} disabled={isRunning || shutdownActive || !configured || !targetValid}>
              {t('pluginPressureControlStart')}
            </button>
            <button className="button danger" type="button" onClick={() => void handleStop()} disabled={!isRunning || isShuttingDown}>
              {t('pluginPressureControlStop')}
            </button>
          </div>
          {isRunning || isShuttingDown || phase === 'safe_done' ? (
            <div className={`pressure-phase phase-${phase}`} role="status" aria-live="polite">
              {phaseLabel}
            </div>
          ) : null}
          {phase === 'residual_unsafe' ? (
            <>
              <Notice kind="warning">{t('residualUnsafeMessage')}</Notice>
              <div className="pressure-buttons">
                <button className="button primary" type="button" onClick={() => void runResidualSafetyTest()}>
                  {t('residualRetryTest')}
                </button>
              </div>
            </>
          ) : null}
          {phase === 'safe_done' ? <Notice kind="success">{t('residualSafeMessage')}</Notice> : null}
        </Card>

        {isRunning || isShuttingDown || currentKpa !== null ? (
          <Card title={t('pluginPressureControlLiveReading')}>
            <div
              className="pressure-bar"
              role="meter"
              aria-label={t('pluginPressureControlLiveReading')}
              aria-valuemin={0}
              aria-valuemax={PRESSURE_MAX_KPA}
              aria-valuenow={currentKpa ?? 0}
            >
              <i style={{ width: `${pressureFillPercent}%` }} />
            </div>
            <div className="pressure-values" aria-live="polite">
              <span>
                {t('pluginPressureControlCurrentKpa')}: <strong>{currentKpa !== null ? `${currentKpa.toFixed(2)} kPa` : '—'}</strong>
              </span>
              {isRunning ? (
                <span>
                  {t('pluginPressureControlTargetKpa')}: <strong>{targetValid ? `${targetKpa.toFixed(2)} kPa` : '—'}</strong>
                </span>
              ) : null}
              <span>
                {t('pluginPressureControlRefSensor')}:{' '}
                {imadaReading ? <strong>{`${imadaReading.value.toFixed(2)} ${imadaReading.unit}`}</strong> : <strong className="muted">{t('pressureCalRefNotConnected')}</strong>}
              </span>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
