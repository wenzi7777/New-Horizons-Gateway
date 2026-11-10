import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PLATFORM_KEYS, PRODUCTS } from "../download.js";
import { STRINGS } from "../i18n.js";
import { BRAND, build, SHARED, SOURCES } from "../build.mjs";

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANGS = ["en", "ja", "zh-CN"];

test("every i18n key exists in all three languages, non-empty", () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LANGS].sort());
  const keys = new Set(LANGS.flatMap((lang) => Object.keys(STRINGS[lang])));
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.equal(typeof STRINGS[lang][key], "string", `${lang} lacks ${key}`);
      assert.ok(STRINGS[lang][key].trim(), `${lang}.${key} is empty`);
    }
  }
});

test("placeholders and code spans match across languages", () => {
  const shape = (value) => ({
    vars: (value.match(/\{\w+\}/g) || []).sort().join(","),
    ticks: (value.match(/`/g) || []).length % 2,
  });
  for (const key of Object.keys(STRINGS.en)) {
    for (const lang of LANGS) {
      const got = shape(STRINGS[lang][key]);
      assert.equal(got.vars, shape(STRINGS.en[key]).vars, `${lang}.${key} placeholders`);
      assert.equal(got.ticks, 0, `${lang}.${key} has an unclosed code span`);
    }
  }
});

test("the page shows the full product names and drops the old product", () => {
  const html = readFileSync(join(SITE_DIR, "index.html"), "utf8");
  for (const name of ["New Horizons Studio", "New Horizons Studio (headless)", "New Horizons Studio Pocket"]) assert.ok(html.includes(`>${name}<`), name);
  for (const lang of LANGS) {
    assert.equal(STRINGS[lang].studioName, "New Horizons Studio");
    assert.equal(STRINGS[lang].headlessName, "New Horizons Studio (headless)");
    assert.equal(STRINGS[lang].pocketName, "New Horizons Studio Pocket");
    assert.match(STRINGS[lang].migrateCopy, /v1\.2\.0/);
    assert.match(STRINGS[lang].macStep2 + STRINGS[lang].headlessLogin, /--login/);
  }
  assert.doesNotMatch(html, /python-view|NH Gateway for Python/);
});

test("every key the page uses is defined", () => {
  const html = readFileSync(join(SITE_DIR, "index.html"), "utf8");
  const app = readFileSync(join(SITE_DIR, "app.js"), "utf8");
  const used = new Set([...html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)].map((m) => m[1]));
  for (const m of app.matchAll(/\btr\("([^"]+)"/g)) used.add(m[1]);
  for (const m of app.matchAll(/:\s*"((?:mac|notBuilt)\w*Note)"/g)) used.add(m[1]);
  for (const key of PLATFORM_KEYS) used.add(`platform.${key}`);
  for (const product of PRODUCTS) for (const suffix of ["Name", "Short", "Copy"]) used.add(`${product.id}${suffix}`);
  for (const key of used) assert.ok(key in STRINGS.en, `missing i18n key ${key}`);
});

test("app.css uses only design tokens for colours", () => {
  const css = readFileSync(join(SITE_DIR, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, "hex colour in app.css");
  assert.doesNotMatch(css, /\b(rgba?|hsla?)\(/, "rgb()/hsl() colour in app.css");
  assert.doesNotMatch(css, /@import|url\(/, "external resource in app.css");
});

test("build.mjs assembles dist with the shared tokens.css and theme.js", () => {
  const out = mkdtempSync(join(tmpdir(), "nh-site-"));
  try {
    const result = build(out);
    const html = readFileSync(join(out, "index.html"), "utf8");
    for (const name of [...SOURCES, ...Object.keys(BRAND), "tokens.css", "theme.js", ".nojekyll"]) assert.ok(existsSync(join(out, name)), `dist lacks ${name}`);
    for (const [name, source] of Object.entries(SHARED)) assert.equal(readFileSync(join(out, name), "utf8"), readFileSync(source, "utf8"), `${name} differs from ${source}`);
    for (const [name, source] of Object.entries(BRAND)) assert.equal(readFileSync(join(out, name), "utf8"), readFileSync(source, "utf8"), `${name} differs from ${source}`);
    // Every brand/ file the page references is in dist.
    for (const m of html.matchAll(/(?:src|href)="(brand\/[^"]+)"/g)) assert.ok(existsSync(join(out, m[1])), `dist lacks ${m[1]}`);
    assert.match(readFileSync(join(out, "tokens.css"), "utf8"), /--accent:/);
    assert.match(readFileSync(join(out, "theme.js"), "utf8"), /window\.NHGTheme/);
    assert.doesNotMatch(html, /__BUILD__/);
    assert.doesNotMatch(readFileSync(join(out, "app.js"), "utf8"), /__BUILD__/);
    assert.match(html, new RegExp(`tokens\\.css\\?v=${result.stamp}`));
    // Relative paths only: Pages serves the site under /New-Horizons-Gateway/.
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.ok(!m[1].startsWith("/"), `absolute path ${m[1]}`);
      assert.ok(!/^https?:/.test(m[1]) || m[1].startsWith("https://github.com/wenzi7777/"), `external resource ${m[1]}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
