// Generates src/tokens.css and src/tokens.ts from the Desktop app's
// styles.css, the single source of truth for the UI's colours, radii,
// shadows and motion. Run from ts/:
//
//   node packages/ui-tokens/scripts/gen-tokens.ts           # write
//   node packages/ui-tokens/scripts/gen-tokens.ts --check   # exit 1 on drift
//
// (`npm run gen:tokens` / `npm run check:tokens`.) Node 22.18+ runs this
// .ts file directly (type stripping), so it uses only erasable syntax.
//
// Which blocks are the themes: exactly the rules at the top level of the
// stylesheet (not inside @media/@supports/...) whose selector is exactly
// `:root` (light) or exactly `:root[data-theme="dark"]` (dark). Compound
// selectors such as `:root.theme-fading` are behaviour, not tokens, and are
// skipped. Each of the two selectors must occur exactly once at the top
// level; a second one (a later override) fails the run instead of being
// silently missed. Only custom properties (`--*`) are tokens; the plain
// declarations in those blocks (color, background, font-family, ...) style
// the Desktop page itself and are left out -- except `color-scheme`, which
// is carried into tokens.css (form controls/scrollbars follow it).
// Dark cascades over light in the browser, so the dark theme here is light
// with dark's declarations applied: both themes then carry the same names,
// and a dark-only name (nothing to fall back to in light) is an error.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = resolve(HERE, '..');
// ts/packages/ui-tokens -> New-Horizons-Gateway -> its parent, where the
// Desktop checkout sits beside it.
const GATEWAY_ROOT = resolve(PACKAGE_DIR, '../../..');
export const DEFAULT_SOURCE = resolve(GATEWAY_ROOT, '../New-Horizons-Desktop/frontend/src/styles.css');
export const SOURCE_LABEL = 'New-Horizons-Desktop/frontend/src/styles.css';
export const CSS_OUT = resolve(PACKAGE_DIR, 'src/tokens.css');
export const TS_OUT = resolve(PACKAGE_DIR, 'src/tokens.ts');

export const LIGHT_SELECTOR = ':root';
export const DARK_SELECTOR = ':root[data-theme="dark"]';

export type Declarations = Array<[name: string, value: string]>;
export type Themes = { light: Declarations; dark: Declarations; colorScheme: { light?: string; dark?: string } };

type Rule = { selector: string; body: string; topLevel: boolean };

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Splits a stylesheet into rules, remembering whether each sits at the top
// level or inside an at-rule block. Good enough for a hand-written
// stylesheet: no strings containing braces are expected in it.
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const stack: Array<{ prelude: string; start: number }> = [];
  let preludeStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      stack.push({ prelude: css.slice(preludeStart, i).trim(), start: i + 1 });
      preludeStart = i + 1;
    } else if (ch === '}') {
      const open = stack.pop();
      if (!open) throw new Error(`unbalanced "}" at offset ${i}`);
      const enclosing = stack.map((s) => s.prelude);
      if (!open.prelude.startsWith('@')) {
        out.push({
          selector: open.prelude.replace(/\s+/g, ' '),
          body: css.slice(open.start, i),
          topLevel: enclosing.length === 0,
        });
      }
      preludeStart = i + 1;
    } else if (ch === ';' && stack.length === 0) {
      preludeStart = i + 1; // top-level @import/@charset
    }
  }
  if (stack.length) throw new Error('unbalanced "{" at end of stylesheet');
  return out;
}

function declarations(body: string, keep: (name: string) => boolean = (n) => n.startsWith('--')): Declarations {
  const out: Declarations = [];
  for (const raw of body.split(';')) {
    const decl = raw.trim();
    if (!decl) continue;
    const colon = decl.indexOf(':');
    if (colon < 0) throw new Error(`malformed declaration: ${decl}`);
    const name = decl.slice(0, colon).trim();
    const value = decl.slice(colon + 1).trim().replace(/\s+/g, ' ');
    if (keep(name)) out.push([name, value]);
  }
  return out;
}

function themeBlock(all: Rule[], selector: string): { decls: Declarations; colorScheme?: string } {
  const matches = all.filter((r) => r.topLevel && r.selector === selector);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one top-level "${selector} { … }" block, found ${matches.length}`);
  }
  const body = matches[0]!.body;
  const decls = declarations(body);
  const colorScheme = declarations(body, (n) => n === 'color-scheme').at(-1)?.[1];
  const seen = new Set<string>();
  for (const [name] of decls) {
    if (seen.has(name)) throw new Error(`${selector} declares ${name} twice`);
    seen.add(name);
  }
  return colorScheme === undefined ? { decls } : { decls, colorScheme };
}

export function parseThemes(css: string): Themes {
  const all = rules(stripComments(css));
  const lightBlock = themeBlock(all, LIGHT_SELECTOR);
  const darkBlock = themeBlock(all, DARK_SELECTOR);
  const light = lightBlock.decls;
  const darkOverrides = new Map(darkBlock.decls);
  const lightNames = new Set(light.map(([n]) => n));
  for (const name of darkOverrides.keys()) {
    if (!lightNames.has(name)) throw new Error(`${name} is set only in the dark theme`);
  }
  const dark: Declarations = light.map(([name, value]) => [name, darkOverrides.get(name) ?? value]);
  const colorScheme: Themes['colorScheme'] = {};
  if (lightBlock.colorScheme) colorScheme.light = lightBlock.colorScheme;
  if (darkBlock.colorScheme) colorScheme.dark = darkBlock.colorScheme;
  return { light, dark, colorScheme };
}

export function camelName(custom: string): string {
  return custom.replace(/^--/, '').replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

const HEADER = (comment: (s: string) => string) =>
  comment(
    `GENERATED by ts/packages/ui-tokens/scripts/gen-tokens.ts from ${SOURCE_LABEL}\n` +
      '(top-level :root and :root[data-theme="dark"] blocks). Do not edit:\n' +
      'change the Desktop stylesheet, then run `npm run gen:tokens` in ts/.',
  );

export function renderCss(themes: Themes): string {
  const scheme = (s?: string) => (s ? [`color-scheme: ${s};`] : []);
  const block = (selector: string, decls: Declarations, extra: string[] = []) =>
    `${selector} {\n${[...extra, ...decls.map(([n, v]) => `${n}: ${v};`)].map((l) => `  ${l}`).join('\n')}\n}\n`;
  return (
    HEADER((s) => `/*\n${s.split('\n').map((l) => ` * ${l}`).join('\n')}\n */`) +
    '\n\n' +
    block(LIGHT_SELECTOR, themes.light, scheme(themes.colorScheme.light)) +
    '\n' +
    block(DARK_SELECTOR, themes.dark, scheme(themes.colorScheme.dark))
  );
}

export function renderTs(themes: Themes): string {
  const obj = (decls: Declarations) =>
    `{\n${decls.map(([n, v]) => `  ${camelName(n)}: ${JSON.stringify(v)},`).join('\n')}\n}`;
  const names = themes.light.map(([n]) => `  ${camelName(n)}: ${JSON.stringify(n)},`).join('\n');
  return `${HEADER((s) => s.split('\n').map((l) => `// ${l}`).join('\n'))}

/** Light theme: the Desktop's \`:root\` custom properties, raw CSS values. */
export const light = ${obj(themes.light)} as const;

export type TokenName = keyof typeof light;
export type ThemeTokens = { readonly [K in TokenName]: string };

/** Dark ("Graphite") theme: light with \`:root[data-theme="dark"]\` applied, so the names match. */
export const dark = ${obj(themes.dark)} as const satisfies ThemeTokens;

export const themes = { light, dark } as const;

/** Each token's CSS custom-property name, for \`var(...)\` in web code. */
export const cssNames = {
${names}
} as const satisfies { readonly [K in TokenName]: \`--\${string}\` };

/**
 * A length or duration token as a number: "12px" -> 12, "220ms" -> 220,
 * "0.3s" -> 300 (durations in ms). Throws on anything else (colours,
 * shadows, percentages), so a token changing kind fails loudly.
 */
export function numeric(value: string): number {
  const match = /^(-?\\d*\\.?\\d+)(px|ms|s)$/.exec(value.trim());
  if (!match) throw new Error(\`not a px/ms/s value: \${value}\`);
  const n = Number(match[1]);
  return match[2] === 's' ? n * 1000 : n;
}
`;
}

export function generate(source = DEFAULT_SOURCE): { css: string; ts: string } {
  const themes = parseThemes(readFileSync(source, 'utf8'));
  return { css: renderCss(themes), ts: renderTs(themes) };
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Files whose committed content differs from what the source generates. */
export function drift(source = DEFAULT_SOURCE): string[] {
  const { css, ts } = generate(source);
  return [
    [CSS_OUT, css],
    [TS_OUT, ts],
  ]
    .filter(([path, want]) => readOrEmpty(path!) !== want)
    .map(([path]) => path!);
}

function main(argv: string[]): number {
  const check = argv.includes('--check');
  const sourceIndex = argv.indexOf('--source');
  const source = sourceIndex >= 0 && argv[sourceIndex + 1] ? resolve(argv[sourceIndex + 1]!) : DEFAULT_SOURCE;
  const rel = (p: string) => relative(process.cwd(), p) || p;
  if (check) {
    const stale = drift(source);
    for (const path of stale) console.error(`out of date: ${rel(path)} (run npm run gen:tokens)`);
    if (!stale.length) console.log('ui-tokens: up to date');
    return stale.length ? 1 : 0;
  }
  const { css, ts } = generate(source);
  writeFileSync(CSS_OUT, css);
  writeFileSync(TS_OUT, ts);
  console.log(`wrote ${rel(CSS_OUT)} and ${rel(TS_OUT)} from ${rel(source)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`gen-tokens: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
