// Small building blocks in the Desktop's look (styles.css / Gateway webui
// app.css): cards, segmented controls, switches, disclosures, status dots,
// confirm dialogs, toasts, the battery indicator and the brand mark.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, BatteryCharging, Check, CircleAlert, Info, X } from 'lucide-react';

import brandUrl from '../assets/nh-studio-rounded.svg';
import { useStudio } from '../state/studio';

export function BrandMark({ size = 28 }: { size?: number }) {
  return <img className="brand-mark" src={brandUrl} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}

export function StatusDot({ state, label }: { state: 'online' | 'offline' | 'connecting' | 'disabled' | 'maintenance'; label?: string }) {
  return <span className={`status-dot ${state}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export function Card({ title, copy, actions, children, className = '' }: { title?: ReactNode; copy?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <header className="card-head">
          <div>
            {title ? <h3>{title}</h3> : null}
            {copy ? <p className="card-copy">{copy}</p> : null}
          </div>
          {actions ? <div className="actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export type SegmentOption<V extends string | number> = { value: V; label: ReactNode; disabled?: boolean };

/** A radio group drawn as the Desktop's segmented control (arrow keys move the choice). */
export function Segmented<V extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: V | null;
  options: readonly SegmentOption<V>[];
  onChange: (value: V) => void;
  label: string;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, delta: number) => {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    const at = enabled.indexOf(from);
    const next = enabled[(at + delta + enabled.length) % enabled.length];
    if (next === undefined) return;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };
  return (
    <div className="segmented-control" role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || (value === null && index === 0) ? 0 : -1}
            className={active ? 'active' : ''}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                move(index, -1);
              }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled on/off switch row (checkbox with role="switch"). */
export function SwitchRow({ checked, onChange, title, copy, disabled }: { checked: boolean; onChange: (next: boolean) => void; title: ReactNode; copy?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <label className="switch-row" htmlFor={id}>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <strong>{title}</strong>
      {copy ? <small>{copy}</small> : null}
    </label>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? <span className="field-error" role="alert">{error}</span> : hint ? <span className="field-note">{hint}</span> : null}
    </div>
  );
}

export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="disclosure" open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function Facts({ items }: { items: readonly (readonly [ReactNode, ReactNode])[] }) {
  return (
    <dl className="facts">
      {items.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{value === null || value === undefined || value === '' ? '-' : value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warning' | 'error' | 'success'; children: ReactNode }) {
  const Icon = kind === 'error' ? CircleAlert : kind === 'warning' ? AlertTriangle : kind === 'success' ? Check : Info;
  return (
    <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={15} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function BatteryIndicator({ percent, charging, label }: { percent: number | null; charging: boolean; label: string }) {
  if (percent === null) return null;
  const fill = Math.max(0, Math.min(100, percent));
  const low = fill <= 15 && !charging;
  return (
    <span className={`battery${low ? ' low' : ''}${charging ? ' charging' : ''}`} role="img" aria-label={label} title={label}>
      <span className="battery-body" aria-hidden="true">
        <span className="battery-fill" style={{ width: `${fill}%` }} />
      </span>
      {charging ? <BatteryCharging size={13} aria-hidden="true" /> : null}
      <span className="battery-text" aria-hidden="true">{Math.round(fill)}%</span>
    </span>
  );
}

// ---- Confirm dialog -------------------------------------------------------------

export type ConfirmRequest = { title: string; message: ReactNode; confirmLabel: string; danger?: boolean };

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: (ok: boolean) => void }) {
  const { t } = useStudio();
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => previous?.focus?.();
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose(false);
      }}
    >
      <div
        ref={panelRef}
        className="modal-panel confirm-modal-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose(false);
          } else if (event.key === 'Tab') {
            const focusable = panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)');
            if (!focusable || focusable.length === 0) return;
            const first = focusable[0]!;
            const last = focusable[focusable.length - 1]!;
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className={`modal-icon${request.danger ? ' danger' : ''}`} aria-hidden="true">
          <AlertTriangle size={34} />
        </div>
        <h3 id={titleId}>{request.title}</h3>
        <p id={messageId}>{request.message}</p>
        <div className="actions">
          <button ref={cancelRef} className="button" type="button" onClick={() => onClose(false)}>
            {t('cancel')}
          </button>
          <button className={`button ${request.danger ? 'danger-solid' : 'primary'}`} type="button" onClick={() => onClose(true)}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** [dialog element, ask()] — ask resolves true when confirmed. */
export function useConfirm(): [ReactNode, (request: ConfirmRequest) => Promise<boolean>] {
  const [pending, setPending] = useState<{ request: ConfirmRequest; resolve: (ok: boolean) => void } | null>(null);
  const ask = useCallback((request: ConfirmRequest) => new Promise<boolean>((resolve) => setPending({ request, resolve })), []);
  const element = pending ? (
    <ConfirmDialog
      request={pending.request}
      onClose={(ok) => {
        pending.resolve(ok);
        setPending(null);
      }}
    />
  ) : null;
  return [element, ask];
}

// ---- Toasts ----------------------------------------------------------------------

export function Toasts() {
  const { toasts, dismissToast, t } = useStudio();
  return (
    <div className="toast-stack" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
          <span className="toast-icon" aria-hidden="true">
            {toast.kind === 'error' ? <CircleAlert size={14} /> : toast.kind === 'success' ? <Check size={14} /> : <Info size={14} />}
          </span>
          <span className="toast-text">{toast.text}</span>
          <button className="toast-close" type="button" aria-label={t('dismiss')} onClick={() => dismissToast(toast.id)}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
