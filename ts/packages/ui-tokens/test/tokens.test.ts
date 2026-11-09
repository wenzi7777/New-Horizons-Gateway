import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_SOURCE, camelName, drift, parseThemes, renderCss } from '../scripts/gen-tokens';
import { cssNames, dark, light, numeric, type TokenName } from '../src/tokens';
import { cubicBezier, parseShadow, terminalPalette } from '../src/mapping';

const haveDesktop = existsSync(DEFAULT_SOURCE);

describe('gen-tokens', () => {
  it.skipIf(!haveDesktop)('committed tokens.css/tokens.ts match the Desktop styles.css', () => {
    expect(drift()).toEqual([]);
  });

  it('takes only the top-level :root and dark blocks, dark cascading over light', () => {
    const css = `
      :root { --a: 1px; --b: red; color: blue; /* --c: no */ }
      :root.theme-fading { --a: 9px; }
      @media (prefers-reduced-motion: reduce) { :root { --a: 0px; } }
      :root[data-theme="dark"] { color-scheme: dark; --b:
        black; }
    `;
    const themes = parseThemes(css);
    expect(themes.light).toEqual([['--a', '1px'], ['--b', 'red']]);
    expect(themes.dark).toEqual([['--a', '1px'], ['--b', 'black']]);
    expect(themes.colorScheme).toEqual({ dark: 'dark' });
    expect(renderCss(themes)).toContain(':root[data-theme="dark"] {\n  color-scheme: dark;\n  --a: 1px;\n  --b: black;\n}');
  });

  it('fails on a second top-level theme block or a dark-only token', () => {
    expect(() => parseThemes(':root{--a:1px} :root[data-theme="dark"]{} :root{--a:2px}')).toThrow(/exactly one/);
    expect(() => parseThemes(':root{--a:1px}')).toThrow(/exactly one/);
    expect(() => parseThemes(':root{--a:1px} :root[data-theme="dark"]{--z:1px}')).toThrow(/only in the dark/);
  });

  it('camel-cases custom-property names', () => {
    expect(camelName('--text-dim')).toBe('textDim');
    expect(camelName('--syntax-definition')).toBe('syntaxDefinition');
    expect(camelName('--bg')).toBe('bg');
  });
});

describe('tokens', () => {
  it('light and dark have the same keys, in the same order', () => {
    expect(Object.keys(dark)).toEqual(Object.keys(light));
    expect(Object.keys(cssNames)).toEqual(Object.keys(light));
    for (const key of Object.keys(light) as TokenName[]) {
      expect(camelName(cssNames[key])).toBe(key);
    }
  });

  it('dark differs from light in colour but shares radius and motion', () => {
    expect(dark.bg).not.toBe(light.bg);
    expect(dark.radiusMd).toBe(light.radiusMd);
    expect(dark.durMed).toBe(light.durMed);
  });

  it('numeric() reads px and durations, rejects anything else', () => {
    expect(numeric(light.radiusSm)).toBe(8);
    expect(numeric(light.radiusPill)).toBe(999);
    expect(numeric(light.durFast)).toBe(120);
    expect(numeric('0.3s')).toBe(300);
    expect(() => numeric(light.accent)).toThrow();
    expect(() => numeric(light.tint)).toThrow();
  });

  it('mapping helpers parse the token strings', () => {
    expect(cubicBezier(light.easeOut)).toEqual([0.22, 1, 0.36, 1]);
    for (const theme of [light, dark]) {
      for (const shadow of [theme.shadowSm, theme.shadowMd]) {
        for (const layer of parseShadow(shadow)) expect(layer.color).toMatch(/^rgba\(/);
      }
      for (const colour of Object.values(terminalPalette(theme))) expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(parseShadow(light.shadowSm)).toEqual([
      { offsetX: 0, offsetY: 1, blur: 2, spread: 0, color: 'rgba(0, 0, 0, 0.04)' },
      { offsetX: 0, offsetY: 1, blur: 3, spread: 0, color: 'rgba(0, 0, 0, 0.06)' },
    ]);
  });
});
