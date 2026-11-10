// App state: the latest StudioSnapshot, the language and theme derived from
// its settings, toasts, and the operation log. Every user-started action goes
// through exec(), which logs it, shows its outcome as a toast and returns it.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Locale } from '@nhgw/ui-tokens';

import type { CommandOutcome, StudioApi, StudioSettings, StudioSnapshot } from '../../shared/contract';
import type { ApiSource } from '../api';
import { errorText, translate, type Key } from '../i18n/strings';
import { effectiveLocale, htmlLang } from '../lib/locale';
import { finishOp, startOp, type OpEntry } from '../lib/opLog';
import { applyTheme, recheckDelayMs, themeSnapshot, THEME_FADE_MS, type ThemeSnapshot } from '../lib/theme';

export type T = (key: Key, vars?: Readonly<Record<string, unknown>>) => string;

export type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };

export type ExecOptions = {
  uid?: string;
  payload?: Record<string, unknown> | null;
  /** Toast on success (default: "<label>: done"); false for none. */
  success?: string | false;
  /** false: no error toast, for callers that show the error inline (still logged). */
  error?: false;
};

type StudioContextValue = {
  api: StudioApi;
  source: ApiSource;
  snapshot: StudioSnapshot | null;
  locale: Locale;
  t: T;
  errorText: (code: string) => string;
  theme: ThemeSnapshot;
  updateSettings: (patch: Partial<StudioSettings>) => Promise<void>;
  toasts: Toast[];
  toast: (kind: Toast['kind'], text: string) => void;
  dismissToast: (id: number) => void;
  opLog: OpEntry[];
  clearOpLog: () => void;
  exec: (label: string, run: () => Promise<CommandOutcome | void | string | null>, options?: ExecOptions) => Promise<CommandOutcome>;
  platform: 'darwin' | 'win32' | 'other';
};

const StudioContext = createContext<StudioContextValue | null>(null);

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function StudioProvider({ api, source, platform, children }: { api: StudioApi; source: ApiSource; platform: StudioContextValue['platform']; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [opLog, setOpLog] = useState<OpEntry[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    let alive = true;
    const off = api.onSnapshot((next) => {
      if (alive) setSnapshot(next);
    });
    void api.snapshot().then((first) => {
      if (alive) setSnapshot((current) => current ?? first);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  // ---- Language -------------------------------------------------------------
  const preferred = typeof navigator !== 'undefined' ? [...(navigator.languages ?? [navigator.language])] : [];
  const locale = effectiveLocale(snapshot?.settings.locale ?? 'system', preferred);
  useEffect(() => {
    document.documentElement.lang = htmlLang(locale);
  }, [locale]);
  const t = useCallback<T>((key, vars) => translate(locale, key, vars), [locale]);
  const errText = useCallback((code: string) => errorText(locale, code), [locale]);

  // ---- Theme (Auto by sunrise/sunset at the lab, re-evaluated at nextChange) --
  const mode = snapshot?.settings.theme ?? 'auto';
  const [theme, setTheme] = useState<ThemeSnapshot>(() => themeSnapshot(mode, new Date()));
  const firstApply = useRef(true);
  useEffect(() => {
    let timer = 0;
    let fadeTimer = 0;
    const evaluate = () => {
      const now = new Date();
      const next = themeSnapshot(mode, now);
      setTheme(next);
      const root = document.documentElement;
      const fade = !firstApply.current && !reducedMotion();
      if (applyTheme(root, next.theme, storage(), fade) && fade) {
        window.clearTimeout(fadeTimer);
        fadeTimer = window.setTimeout(() => root.classList.remove('theme-fading'), THEME_FADE_MS);
      }
      firstApply.current = false;
      timer = window.setTimeout(evaluate, recheckDelayMs(next, now));
    };
    evaluate();
    return () => {
      window.clearTimeout(timer);
    };
  }, [mode]);

  // ---- Toasts and the operation log ------------------------------------------
  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (kind: Toast['kind'], text: string) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, kind, text }]);
      window.setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : 3800);
    },
    [dismissToast],
  );

  const exec = useCallback<StudioContextValue['exec']>(
    async (label, run, options = {}) => {
      const id = nextId.current++;
      setOpLog((log) => startOp(log, { id, atMs: Date.now(), uid: options.uid ?? '', label, payload: options.payload ?? null }));
      let outcome: CommandOutcome;
      try {
        const result = await run();
        outcome =
          result && typeof result === 'object' && 'ok' in result
            ? result
            : { ok: true, message: typeof result === 'string' ? result : '', data: result ?? null };
      } catch (error) {
        outcome = { ok: false, message: errorMessage(error), data: null };
      }
      const message = outcome.ok ? outcome.message : errText(outcome.message || 'error');
      setOpLog((log) => finishOp(log, id, outcome.ok, message, Date.now()));
      if (!outcome.ok) {
        if (options.error !== false) toast('error', t('opFailed', { label, error: message }));
      }
      else if (options.success !== false) toast('success', options.success ?? t('opDone', { label }));
      return outcome;
    },
    [errText, t, toast],
  );

  const updateSettings = useCallback(
    async (patch: Partial<StudioSettings>) => {
      // Optimistic: the next snapshot confirms it.
      setSnapshot((s) => (s ? { ...s, settings: { ...s.settings, ...patch } } : s));
      await api.updateSettings(patch);
    },
    [api],
  );

  const value = useMemo<StudioContextValue>(
    () => ({
      api,
      source,
      snapshot,
      locale,
      t,
      errorText: errText,
      theme,
      updateSettings,
      toasts,
      toast,
      dismissToast,
      opLog,
      clearOpLog: () => setOpLog([]),
      exec,
      platform,
    }),
    [api, source, snapshot, locale, t, errText, theme, updateSettings, toasts, toast, dismissToast, opLog, exec, platform],
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudio(): StudioContextValue {
  const value = useContext(StudioContext);
  if (!value) throw new Error('useStudio outside StudioProvider');
  return value;
}

/** Subscribe to one device's live frames while mounted (null until the first frame). */
export function useLiveFrame(uid: string | null) {
  const { api } = useStudio();
  const [frame, setFrame] = useState<import('../../shared/contract').LiveFrame | null>(null);
  useEffect(() => {
    setFrame(null);
    if (!uid) return undefined;
    let pending: import('../../shared/contract').LiveFrame | null = null;
    let raf = 0;
    const off = api.subscribeLive(uid, (next) => {
      pending = next;
      if (!raf) {
        raf = window.requestAnimationFrame(() => {
          raf = 0;
          setFrame(pending);
        });
      }
    });
    return () => {
      off();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [api, uid]);
  return frame;
}
