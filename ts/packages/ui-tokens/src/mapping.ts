// How each token category is applied where the CSS feature behind it does
// not exist: the React Native app and the Ink terminal UI. The web UI uses
// tokens.css as is. Values always come from tokens.ts; this file only says
// which token stands in for which, plus small parsers for the CSS strings.

import type { ThemeTokens, TokenName } from './tokens';

export type Platform = 'web' | 'native' | 'terminal';

export type CategoryMapping = {
  readonly tokens: readonly TokenName[];
  readonly web: string;
  readonly native: string;
  readonly terminal: string;
};

export const mapping = {
  surfaces: {
    tokens: ['bg', 'panel', 'panelSolid', 'panelSoft', 'chrome', 'blurChrome'],
    web: 'background colours; --chrome is translucent and sits on backdrop-filter: blur(var(--blur-chrome)).',
    native: 'backgroundColor as is (RN accepts #hex and rgba()). There is no backdrop blur: use panelSolid wherever the web uses chrome, and ignore blurChrome.',
    terminal: 'none: the terminal keeps its own background.',
  },
  separators: {
    tokens: ['line', 'lineStrong'],
    web: '1px borders and dividers.',
    native: 'borderColor with StyleSheet.hairlineWidth.',
    terminal: 'box borders drawn in textDim.',
  },
  text: {
    tokens: ['text', 'textDim', 'textMuted'],
    web: 'color.',
    native: 'color.',
    terminal: 'text and textDim only; textMuted falls back to textDim.',
  },
  semantic: {
    tokens: ['accent', 'accentSoft', 'accentStrong', 'accentHover', 'onAccent', 'controlSelected', 'danger', 'dangerHover', 'success', 'warning'],
    web: 'buttons, selection, status; *Hover on :hover.',
    native: 'as on the web; touch has no hover, so *Hover is unused (pressed state = opacity).',
    terminal: 'accent, success, warning, danger as foreground colours only, never as backgrounds; the rest is unused.',
  },
  tints: {
    tokens: ['tint', 'tintLine', 'ink'],
    web: 'percentages fed to color-mix() to fade hard-coded pastels/inks in the dark theme.',
    native: 'no color-mix(): not applied; use the semantic colours instead of pastel tints.',
    terminal: 'unused.',
  },
  syntax: {
    tokens: ['syntaxComment', 'syntaxKeyword', 'syntaxString', 'syntaxNumber', 'syntaxFunction', 'syntaxDefinition'],
    web: 'code editor colours.',
    native: 'color, in code views only.',
    terminal: 'unused.',
  },
  radius: {
    tokens: ['radiusSm', 'radiusMd', 'radiusLg', 'radiusPill'],
    web: 'border-radius.',
    native: 'borderRadius: numeric(value).',
    terminal: 'any radius -> Ink borderStyle "round".',
  },
  shadows: {
    tokens: ['shadowSm', 'shadowMd'],
    web: 'box-shadow (several layers).',
    native: 'RN >= 0.76 on the New Architecture takes the string as boxShadow; otherwise use parseShadow(value)[0] for shadowColor/shadowOffset/shadowOpacity/shadowRadius (iOS) and elevation (Android: sm 1, md 4).',
    terminal: 'none.',
  },
  motion: {
    tokens: ['easeOut', 'durFast', 'durMed'],
    web: 'transition timing; off under prefers-reduced-motion.',
    native: 'Easing.bezier(...cubicBezier(easeOut)), duration numeric(dur*); duration 0 when AccessibilityInfo.isReduceMotionEnabled().',
    terminal: 'no animation.',
  },
} as const satisfies Record<string, CategoryMapping>;

/** The six foreground colours the terminal UI may use (all #hex in both themes). */
export type TerminalPalette = Pick<ThemeTokens, 'text' | 'textDim' | 'accent' | 'success' | 'warning' | 'danger'>;

export function terminalPalette(tokens: ThemeTokens): TerminalPalette {
  const { text, textDim, accent, success, warning, danger } = tokens;
  return { text, textDim, accent, success, warning, danger };
}

/** The native stand-in for the translucent chrome (bars, sheets): the solid panel colour. */
export function nativeChromeColor(tokens: ThemeTokens): string {
  return tokens.panelSolid;
}

/** `cubic-bezier(a, b, c, d)` as its four numbers (for RN Easing.bezier). */
export function cubicBezier(value: string): [number, number, number, number] {
  const match = /^cubic-bezier\(\s*([^)]*)\)$/.exec(value.trim());
  const parts = match?.[1]?.split(',').map((p) => Number(p.trim()));
  if (!parts || parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`not a cubic-bezier(): ${value}`);
  }
  return parts as [number, number, number, number];
}

export type ShadowLayer = { offsetX: number; offsetY: number; blur: number; spread: number; color: string };

/** A box-shadow value as layers (lengths in px). Inset shadows are not supported. */
export function parseShadow(value: string): ShadowLayer[] {
  // Split on commas outside parentheses (rgba(...) has its own).
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      layers.push(value.slice(start, i));
      start = i + 1;
    }
  }
  layers.push(value.slice(start));
  return layers.map((layer) => {
    const match = /^\s*(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?(?:\s+([\d.]+)(?:px)?)?(?:\s+(-?[\d.]+)(?:px)?)?\s+(.+?)\s*$/.exec(layer);
    if (!match) throw new Error(`unsupported box-shadow layer: ${layer.trim()}`);
    return {
      offsetX: Number(match[1]),
      offsetY: Number(match[2]),
      blur: Number(match[3] ?? 0),
      spread: Number(match[4] ?? 0),
      color: match[5]!,
    };
  });
}
