// App Studio runs a vendored copy of the NHOS-App-Library SDK
// (src/renderer/areas/apps/sdk, copied by its sync.mjs). If the copy drifts
// from the library, Studio accepts a package the library's CI would build
// differently -- so the two are compared file by file whenever the library is
// checked out beside New-Horizons-Gateway (port of the Desktop's
// appSdkSync.test.mjs). Also: @nhgw/host's hand-kept package contract
// matches the SDK's opset, and every published library package passes the
// host's gate through the same AppLibrary the area uses.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { apps } from '@nhgw/host';

import * as sdk from '../../src/renderer/areas/apps/sdk/lib/index.mjs';
import { PANEL_PERMISSIONS } from '../../src/renderer/areas/apps/lib/panelRules';
import { DEFAULT_LIBRARY, EXAMPLE_FLOWS, EXAMPLE_PANELS, EXAMPLE_READOUTS } from '../../src/renderer/areas/apps/sdk/sync.mjs';

const VENDORED = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/renderer/areas/apps/sdk');
const LIBRARY = DEFAULT_LIBRARY as string;
const hasLibrary = existsSync(join(LIBRARY, 'sdk', 'lib', 'index.mjs'));

describe.skipIf(!hasLibrary)('the vendored SDK matches NHOS-App-Library (run sdk/sync.mjs on failure)', () => {
  it('lib/*.mjs and index.d.ts are identical', () => {
    const libraryFiles = readdirSync(join(LIBRARY, 'sdk', 'lib')).filter((n) => n.endsWith('.mjs')).sort();
    const vendoredFiles = readdirSync(join(VENDORED, 'lib')).filter((n) => n.endsWith('.mjs')).sort();
    expect(vendoredFiles).toEqual(libraryFiles);
    for (const name of libraryFiles) {
      expect(readFileSync(join(VENDORED, 'lib', name), 'utf8'), name).toBe(readFileSync(join(LIBRARY, 'sdk', 'lib', name), 'utf8'));
    }
    expect(readFileSync(join(VENDORED, 'lib', 'index.d.mts'), 'utf8')).toBe(readFileSync(join(LIBRARY, 'sdk', 'index.d.ts'), 'utf8'));
  });

  it('the authoring guide and the example apps are identical', () => {
    const copies: [string, string][] = [['docs/authoring.md', join(LIBRARY, 'docs', 'authoring.md')]];
    for (const app of EXAMPLE_FLOWS as string[]) copies.push([`examples/${app}.nhs`, join(LIBRARY, 'apps', app, 'app.nhs')]);
    for (const app of EXAMPLE_READOUTS as string[]) copies.push([`examples/${app}.readout.json`, join(LIBRARY, 'apps', app, 'readout.json')]);
    for (const app of EXAMPLE_PANELS as string[]) copies.push([`examples/${app}.panel.json`, join(LIBRARY, 'apps', app, 'panel.json')]);
    expect(readdirSync(join(VENDORED, 'examples')).sort()).toEqual(copies.slice(1).map(([name]) => name.slice('examples/'.length)).sort());
    for (const [vendored, original] of copies) expect(readFileSync(join(VENDORED, vendored), 'utf8'), vendored).toBe(readFileSync(original, 'utf8'));
  });

  it('compiles every library app to its published bytes', () => {
    const appsDir = join(LIBRARY, 'apps');
    for (const id of readdirSync(appsDir)) {
      const source = join(appsDir, id, 'app.nhs');
      if (!existsSync(source)) continue;
      const analysis = sdk.analyzeFlow(readFileSync(source, 'utf8'));
      expect(analysis.ok, `${id}: ${JSON.stringify(analysis.diagnostics)}`).toBe(true);
      expect(new TextDecoder().decode(analysis.bytes ?? new Uint8Array()), id).toBe(readFileSync(join(appsDir, id, 'app.nha'), 'utf8'));
    }
  });

  it('every catalog entry downloads, checks and validates through the host library', async () => {
    const index = readFileSync(join(LIBRARY, 'index.json'));
    const files = new Map<string, Uint8Array>();
    const library = new apps.AppLibrary({
      http: {
        async get(url) {
          if (url === 'https://example.test/index.json') return { status: 200, headers: {}, body: new Uint8Array(index) };
          // Serve the published URL from the checkout: .../main/<path>.
          const path = /\/main\/(.+)$/.exec(new URL(url).pathname)?.[1];
          const file = path ? join(LIBRARY, path) : '';
          return file && existsSync(file) ? { status: 200, headers: {}, body: new Uint8Array(readFileSync(file)) } : { status: 404, headers: {}, body: new Uint8Array() };
        },
      },
      store: { read: async (p) => files.get(p) ?? null, write: async (p, b) => void files.set(p, b) },
      sha256: async (b) => createHash('sha256').update(b).digest('hex'),
      indexUrl: 'https://example.test/index.json',
    });
    const catalog = await library.catalog();
    expect(catalog.items.length).toBeGreaterThan(0);
    for (const item of catalog.items) {
      const pkg = await library.downloadPackage(String(item.id));
      expect(pkg.kind, String(item.id)).toBe(item.kind ?? 'flow');
      expect(pkg.device_path).toBe(item.device_path);
      const source = await library.fetchSource(String(item.id));
      expect(source.source.length, String(item.id)).toBeGreaterThan(0);
    }
  });
});

describe("the host's package contract follows the SDK", () => {
  it('knows every op and capability the SDK has, and the same limits', () => {
    expect([...apps.KNOWN_OPS].sort()).toEqual(Object.keys(sdk.OPS).sort());
    expect([...apps.CAPABILITIES].sort()).toEqual(Object.keys(sdk.CAPABILITIES).sort());
    expect([apps.MAX_NODES, apps.MAX_PACKAGE_BYTES, apps.MAX_EVENT_NAME]).toEqual([sdk.MAX_NODES, sdk.MAX_PACKAGE_BYTES, sdk.MAX_EVENT_NAME]);
  });

  it('the panel permission table is the same in the SDK, the host and the prompt', () => {
    const plain = (table: Readonly<Record<string, readonly string[]>>) => Object.fromEntries(Object.entries(table).map(([k, v]) => [k, [...v]]));
    expect(plain(apps.PANEL_PERMISSIONS)).toEqual(plain(sdk.panelset.PERMISSIONS as Record<string, readonly string[]>));
    expect(plain(PANEL_PERMISSIONS)).toEqual(plain(apps.PANEL_PERMISSIONS));
    expect([...apps.READOUT_SOURCES].sort()).toEqual([...sdk.readoutset.ALLOWED_SOURCES].sort());
  });
});
