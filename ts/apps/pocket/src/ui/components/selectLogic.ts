// Pure behaviour of the Select sheet (kept out of the component for tests):
// which option is highlighted when it opens and how the keyboard moves it.

export type SelectOption<T> = { value: T; label: string; disabled?: boolean };

/** Index of the chosen option, or the first enabled one when none matches. */
export function initialIndex<T>(options: readonly SelectOption<T>[], value: T): number {
  const chosen = options.findIndex((o) => o.value === value && !o.disabled);
  if (chosen >= 0) return chosen;
  return options.findIndex((o) => !o.disabled);
}

export type SelectKeyResult = { index: number; action: 'none' | 'choose' | 'close' };

/** Keyboard handling as the Desktop's Select: arrows wrap and skip disabled, Home/End, Enter/Space choose, Escape closes. */
export function selectKey<T>(options: readonly SelectOption<T>[], index: number, key: string): SelectKeyResult {
  const n = options.length;
  const step = (from: number, dir: 1 | -1) => {
    for (let i = 1; i <= n; i++) {
      const next = (((from + dir * i) % n) + n) % n;
      if (!options[next]?.disabled) return next;
    }
    return from;
  };
  switch (key) {
    case 'ArrowDown':
      return { index: n ? step(index, 1) : -1, action: 'none' };
    case 'ArrowUp':
      return { index: n ? step(index < 0 ? 0 : index, -1) : -1, action: 'none' };
    case 'Home':
      return { index: n ? step(n - 1, 1) : -1, action: 'none' };
    case 'End':
      return { index: n ? step(0, -1) : -1, action: 'none' };
    case 'Enter':
    case ' ':
      return { index, action: index >= 0 && !options[index]?.disabled ? 'choose' : 'none' };
    case 'Escape':
      return { index, action: 'close' };
    default:
      return { index, action: 'none' };
  }
}

export function selectedLabel<T>(options: readonly SelectOption<T>[], value: T, fallback = ''): string {
  return options.find((o) => o.value === value)?.label ?? fallback;
}
