import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PLATFORM_KEYS } from "../download.js";
import { STRINGS } from "../i18n.js";
import { build, SHARED, SOURCES } from "../build.mjs";

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

test("every key the page uses is defined", () => {
  const html = readFileSync(join(SITE_DIR, "index.html"), "utf8");
  const app = readFileSync(join(SITE_DIR, "app.js"), "utf8");
  const used = new Set([...html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)].map((m) => m[1]));
  for (const m of app.matchAll(/\btr\("([^"]+)"/g)) used.add(m[1]);
  for (const m of app.matchAll(/:\s*"((?:mac|ios|notBuilt|unknown)\w*Note)"/g)) used.add(m[1]);
  for (const key of PLATFORM_KEYS) used.add(`platform.${key}`);
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
    for (const name of [...SOURCES, "tokens.css", "theme.js", ".nojekyll"]) assert.ok(existsSync(join(out, name)), `dist lacks ${name}`);
    for (const [name, source] of Object.entries(SHARED)) assert.equal(readFileSync(join(out, name), "utf8"), readFileSync(source, "utf8"), `${name} differs from ${source}`);
    assert.match(readFileSync(join(out, "tokens.css"), "utf8"), /--accent:/);
    assert.match(readFileSync(join(out, "theme.js"), "utf8"), /window\.NHGTheme/);
    const html = readFileSync(join(out, "index.html"), "utf8");
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
