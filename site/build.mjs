#!/usr/bin/env node
// Assembles the download page into site/dist/ (GitHub Pages serves that
// folder; see .github/workflows/pages.yml). Node 22, built-ins only, no
// bundler: the hand-written sources are copied as they are, plus the two
// files shared with the Gateway web UI, which live only in ts/ and are
// copied here at build time (never committed twice):
//   ts/packages/ui-tokens/src/tokens.css   -- the Desktop design tokens
//   ts/packages/node/webui/theme.js        -- auto/light/dark (window.NHGTheme)
// "__BUILD__" in the sources becomes a short content hash, so browsers pick up
// a new deploy instead of a cached copy.
//
//   node site/build.mjs [--out <dir>]
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SITE_DIR, "..");

export const SOURCES = ["index.html", "app.js", "app.css", "download.js", "i18n.js"];
export const SHARED = {
  "tokens.css": join(REPO_DIR, "ts/packages/ui-tokens/src/tokens.css"),
  "theme.js": join(REPO_DIR, "ts/packages/node/webui/theme.js"),
};
// Files whose text gets the build stamp (the rest are copied byte for byte).
const STAMPED = new Set(["index.html", "app.js"]);

export function build(outDir = join(SITE_DIR, "dist")) {
  const files = new Map();
  for (const name of SOURCES) files.set(name, readFileSync(join(SITE_DIR, name)));
  for (const [name, path] of Object.entries(SHARED)) files.set(name, readFileSync(path));

  const hash = createHash("sha256");
  for (const [name, data] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) hash.update(name).update(data);
  const stamp = hash.digest("hex").slice(0, 10);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [name, data] of files) {
    const out = STAMPED.has(name) ? Buffer.from(data.toString("utf8").replaceAll("__BUILD__", stamp)) : data;
    writeFileSync(join(outDir, name), out);
  }
  // Serve files as they are (no Jekyll processing on Pages).
  writeFileSync(join(outDir, ".nojekyll"), "");
  return { outDir, stamp, files: [...files.keys(), ".nojekyll"] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--out");
  const outDir = index > 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]) : undefined;
  const result = build(outDir);
  console.log(`site: built ${result.files.length} files into ${result.outDir} (build ${result.stamp})`);
}
