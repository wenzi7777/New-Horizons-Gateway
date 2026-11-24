// The "Illustrated" interface's big choice buttons: one card per option, the
// chosen one outlined in the accent colour with a check (a printer's
// "Cooling ✓ / Heating ○"). Same behaviour as what it replaces: picking only
// changes the draft or runs the same handler, Apply stays where it was. In the
// classic interface it renders `classic`, or by default the same options as a
// Segmented control. The Desktop has a copy.
import { Check } from 'lucide-react';
import { useRef, type ReactNode } from 'react';

import { useStudio } from '../../state/studio';
import { Segmented } from '../ui';
import './callout.css';

export type ChoiceOption<V extends string | number> = { value: V; label: ReactNode; detail?: ReactNode; disabled?: boolean };

export function ChoiceSegment<V extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
  classic,
}: {
  value: V | null;
  options: readonly ChoiceOption<V>[];
  onChange: (value: V) => void;
  label: string;
  disabled?: boolean;
  /** What the classic interface shows instead (the old select); default: a Segmented control. */
  classic?: ReactNode;
}) {
  const { uiStyle } = useStudio();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  if (uiStyle !== 'modern') {
    return classic !== undefined ? <>{classic}</> : <Segmented<V> label={label} value={value} disabled={disabled} options={options.map(({ value: v, label: l, disabled: d }) => ({ value: v, label: l, disabled: d }))} onChange={onChange} />;
  }
  const move = (from: number, delta: number) => {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    const next = enabled[(enabled.indexOf(from) + delta + enabled.length) % enabled.length];
    const option = next === undefined ? undefined : options[next];
    if (!option || next === undefined) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };
  return (
    <div className="choice-segment" role="radiogroup" aria-label={label} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
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
            className={`choice-option${active ? ' is-active' : ''}`}
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
            <span className="choice-check" aria-hidden="true">
              {active ? <Check size={13} strokeWidth={3} /> : null}
            </span>
            <span className="choice-text">
              <strong>{option.label}</strong>
              {option.detail ? <small>{option.detail}</small> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
