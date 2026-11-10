// The "apps" area's main-process handlers: projects as files under
// <dataFolder>/apps/<project>/, the library through a fake HTTP, the dialogs
// through fake ports, and argument checking at the IPC boundary.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apps } from '@nhgw/host';

import { appsHandlers, folderStore, type AppsAreaPorts } from '../../src/main/areas/apps';
import { AreaRegistry } from '../../src/main/areas/registry';
import type { StudioProject } from '../../src/shared/areas/apps';
import type { StudioController } from '../../src/main/studioController';

const BASE = 'https://raw.githubusercontent.com/o/NHOS-App-Library/main';
const PKG = {
  nhapp: 1,
  manifest: { id: 'demo', name: 'Demo', version: '1.0.0', author: 'me', summary: 'x', capabilities: ['read_matrix'] },
  nodes: [{ op: 'total' }],
};
const PKG_BYTES = apps.canonicalPackageBytes(PKG);
const PKG_SHA = createHash('sha256').update(PKG_BYTES).digest('hex');

let dir: string;
let dataFolder: string;
let routes: Map<string, { status: number; body: Uint8Array; headers?: Record<string, string> }>;
let opened: string | null;
let folder: string | null;
let revealed: string[];

function handlers() {
  const ports: Partial<AppsAreaPorts> = {
    http: {
      async get(url) {
        const route = routes.get(url);
        return route ? { status: route.status, headers: route.headers ?? {}, body: route.body } : { status: 404, headers: {}, body: new Uint8Array() };
      },
    },
    openFile: async () => opened,
    chooseFolder: async () => folder,
    reveal: async (path) => {
      revealed.push(path);
    },
  };
  const controller = { settings: () => ({ dataFolder }) } as unknown as StudioController;
  return appsHandlers({ controller, userDataDir: join(dir, 'userData') }, { ports, indexUrl: `${BASE}/index.json` }) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nh-apps-'));
  dataFolder = join(dir, 'data');
  opened = null;
  folder = null;
  revealed = [];
  const encode = (text: string) => new TextEncoder().encode(text);
  routes = new Map([
    [`${BASE}/index.json`, { status: 200, body: encode(JSON.stringify({ apps: [{ id: 'demo', version: '1.0.0', icon_url: `${BASE}/apps/demo/icon.svg`, package: { url: `${BASE}/dist/demo/demo-1.0.0.nha`, sha256: PKG_SHA, size: PKG_BYTES.length } }] })) }],
    [`${BASE}/dist/demo/demo-1.0.0.nha`, { status: 200, body: PKG_BYTES }],
    [`${BASE}/apps/demo/app.nhs`, { status: 200, body: encode('app demo {}\n') }],
    [`${BASE}/apps/demo/README.md`, { status: 200, body: encode('# Demo') }],
    [`${BASE}/apps/demo/icon.svg`, { status: 200, body: encode('<svg/>'), headers: { 'content-type': 'text/plain' } }],
  ]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const project = (patch: Partial<StudioProject> = {}): StudioProject => ({ id: 'p1', kind: 'flow', source: 'app demo {}\n', updatedAt: 5, ...patch });

describe('projects', () => {
  it('saves a project as files, lists it back, and deletes it', async () => {
    const h = handlers();
    expect(await h.listProjects!()).toEqual([]);
    await h.saveProject!(project({ origin: { appId: 'demo', version: '1.0.0', packageSha256: 'ab' } }));
    const folderPath = join(dataFolder, 'apps', 'p1');
    expect(readFileSync(join(folderPath, 'app.nhs'), 'utf8')).toBe('app demo {}\n');
    expect(JSON.parse(readFileSync(join(folderPath, 'project.json'), 'utf8'))).toEqual({ kind: 'flow', origin: { appId: 'demo', version: '1.0.0', packageSha256: 'ab' }, updatedAt: 5 });
    expect(await h.listProjects!()).toEqual([project({ origin: { appId: 'demo', version: '1.0.0', packageSha256: 'ab' } })]);
    await h.deleteProject!('p1');
    expect(existsSync(folderPath)).toBe(false);
  });

  it('newest first, and a readout turned panel leaves no stale source', async () => {
    const h = handlers();
    await h.saveProject!(project({ id: 'old', updatedAt: 1 }));
    await h.saveProject!(project({ id: 'view', kind: 'readout', source: '{"kind":"readout"}', updatedAt: 9 }));
    await h.saveProject!(project({ id: 'view', kind: 'panel', source: '{"kind":"panel"}', updatedAt: 10 }));
    expect(readdirSync(join(dataFolder, 'apps', 'view')).sort()).toEqual(['panel.json', 'project.json']);
    const listed = (await h.listProjects!()) as StudioProject[];
    expect(listed.map((p) => [p.id, p.kind])).toEqual([['view', 'panel'], ['old', 'flow']]);
  });

  it('skips folders that are not projects instead of failing', async () => {
    const h = handlers();
    await h.saveProject!(project());
    const junk = join(dataFolder, 'apps', 'junk');
    rmSync(junk, { recursive: true, force: true });
    mkdirSync(junk, { recursive: true });
    writeFileSync(join(junk, 'project.json'), '{bad');
    writeFileSync(join(dataFolder, 'apps', 'notes.txt'), 'x');
    expect(((await h.listProjects!()) as StudioProject[]).map((p) => p.id)).toEqual(['p1']);
  });

  it('refuses ids and documents that could leave the projects folder', async () => {
    const h = handlers();
    for (const id of ['../x', 'a/b', '', 'x'.repeat(65)]) {
      await expect(h.saveProject!(project({ id }))).rejects.toThrow();
      await expect(h.deleteProject!(id)).rejects.toThrow();
    }
    await expect(h.saveProject!({ ...project(), kind: 'script' })).rejects.toThrow('invalid_project_kind');
    await expect(h.saveProject!({ ...project(), source: 1 })).rejects.toThrow('invalid_project_source');
    await expect(h.saveProject!(null)).rejects.toThrow('invalid_project');
  });

  it('reveals a project folder', async () => {
    const h = handlers();
    await h.revealProject!('p1');
    expect(revealed).toEqual([join(dataFolder, 'apps', 'p1')]);
    expect(await h.projectsFolder!()).toBe(join(dataFolder, 'apps'));
  });
});

describe('dialogs', () => {
  it('opens a source file, or nothing when cancelled', async () => {
    const h = handlers();
    expect(await h.openSourceFile!()).toBeNull();
    opened = join(dir, 'tilt.nhs');
    writeFileSync(opened, 'app tilt {}');
    expect(await h.openSourceFile!()).toEqual({ name: 'tilt.nhs', text: 'app tilt {}' });
  });

  it('exports only the App Library file names into <folder>/<appId>/', async () => {
    const h = handlers();
    const files = [
      { filename: 'app.nhs', content: 'src' },
      { filename: 'app.nha', content: new Uint8Array([1, 2, 3]) },
    ];
    expect(await h.exportFiles!('demo', files)).toBeNull();
    folder = join(dir, 'out');
    expect(await h.exportFiles!('demo', files)).toBe(join(folder, 'demo'));
    expect(readFileSync(join(folder, 'demo', 'app.nhs'), 'utf8')).toBe('src');
    expect([...readFileSync(join(folder, 'demo', 'app.nha'))]).toEqual([1, 2, 3]);
    await expect(h.exportFiles!('demo', [{ filename: '../evil.sh', content: 'x' }])).rejects.toThrow('invalid_filename');
    await expect(h.exportFiles!('../demo', files)).rejects.toThrow('invalid_id');
  });

  it('imports a package file through the same validation', async () => {
    const h = handlers();
    expect(await h.importPackage!()).toBeNull();
    opened = join(dir, 'demo.nha');
    writeFileSync(opened, PKG_BYTES);
    expect(await h.importPackage!()).toMatchObject({ id: 'demo', kind: 'flow', sha256: PKG_SHA });
    writeFileSync(opened, '{"nhapp":1}');
    await expect(h.importPackage!()).rejects.toThrow('missing_manifest');
  });
});

describe('library', () => {
  it('serves the catalog, an entry, a package, its source, README and icon', async () => {
    const h = handlers();
    const catalog = (await h.libraryIndex!()) as { items: unknown[]; source: string };
    expect(catalog.items).toHaveLength(1);
    expect(catalog.source).toBe('remote');
    expect(await h.libraryApp!('demo')).toMatchObject({ id: 'demo' });
    expect(await h.libraryPackage!('demo')).toMatchObject({ id: 'demo', data_hex: Buffer.from(PKG_BYTES).toString('hex') });
    expect(await h.librarySource!('demo')).toMatchObject({ filename: 'app.nhs', source: 'app demo {}\n' });
    expect(await h.libraryReadme!(`${BASE}/apps/demo/README.md`)).toBe('# Demo');
    expect(await h.libraryReadme!(`${BASE}/apps/demo/missing.md`)).toBeNull();
    expect(await h.libraryIcon!(`${BASE}/apps/demo/icon.svg`)).toBe(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`);
    await expect(h.libraryReadme!('https://evil.example/x.md')).rejects.toThrow('package_host_not_allowed');
    await expect(h.libraryIcon!('file:///etc/passwd')).rejects.toThrow('package_host_not_allowed');
    await expect(h.libraryApp!('../x')).rejects.toThrow('invalid_id');
    // The catalog is cached under userData.
    expect(existsSync(join(dir, 'userData', 'app-library', 'index.json'))).toBe(true);
  });

  it('validates bytes App Studio built', async () => {
    const h = handlers();
    expect(await h.validatePackageBytes!(PKG_BYTES)).toMatchObject({ id: 'demo' });
    await expect(h.validatePackageBytes!('nope')).rejects.toThrow('invalid_bytes');
  });

  it('keeps cache paths inside the cache folder', async () => {
    const store = folderStore(join(dir, 'cache'));
    await expect(store.write('../escape', new Uint8Array())).rejects.toThrow('invalid_cache_path');
    await store.write('packages/a.nha', new Uint8Array([7]));
    expect([...((await store.read('packages/a.nha')) ?? [])]).toEqual([7]);
    expect(await store.read('missing')).toBeNull();
  });

  it('is reachable only through the registered method names', async () => {
    const controller = { settings: () => ({ dataFolder }) } as unknown as StudioController;
    const registry = new AreaRegistry({ controller, logger: { info() {}, warn() {}, error() {} }, userDataDir: dir, version: 'v0' }, { senders: () => [] });
    registry.add({ area: 'apps', register: (context) => appsHandlers(context, { ports: { openFile: async () => null } }) });
    await expect(registry.call({} as never, 'apps', 'openSourceFile', [])).resolves.toBeNull();
    await expect(registry.call({} as never, 'apps', 'constructor', [])).rejects.toThrow('unknown_method');
  });
});
