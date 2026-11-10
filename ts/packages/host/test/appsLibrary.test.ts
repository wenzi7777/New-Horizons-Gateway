// The App Library client (src/apps): catalog cache + ETag, package checks,
// source fetch and validation -- the Desktop's app_library.py behaviour,
// against a fake HTTP and an in-memory store.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { apps } from '../src';

const { AppLibrary, AppLibraryError, AppPackageError, validatePackage, canonicalPackageBytes, panelCommandAllowed } = apps;

const encode = (text: string) => new TextEncoder().encode(text);
const sha256 = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const BASE = 'https://raw.githubusercontent.com/o/NHOS-App-Library/main';

function flowPackage(id = 'demo', extra: Record<string, unknown> = {}) {
  return {
    nhapp: 1,
    manifest: { id, name: 'Demo', version: '1.0.0', author: 'me', summary: 'x', min_os: 'v1.2.0', capabilities: ['read_matrix', 'emit_event'] },
    nodes: [{ op: 'total' }, { op: 'threshold', in: [0], value: 40 }, { op: 'emit', in: [1], event: 'pressed' }],
    ...extra,
  };
}

function readoutPackage() {
  return {
    nhapp: 1,
    kind: 'readout',
    manifest: { id: 'scan', name: 'Scan', version: '1.0.0', author: 'me', summary: 'x' },
    readout: { sources: [{ id: 's', command: 'scan_health' }], sections: [{ kind: 'stats', title: 'S', items: [] }] },
  };
}

function panelPackage(overrides: Record<string, unknown> = {}) {
  return {
    nhapp: 1,
    kind: 'panel',
    manifest: { id: 'tasks', name: 'Tasks', version: '1.0.0', author: 'me', summary: 'x', min_os: 'v1.19.0', permissions: ['task_control'] },
    panel: {
      sources: [{ id: 'tasks', command: 'task_list', path: 'tasks' }],
      actions: [{ id: 'stop', label: 'Stop', command: 'task_stop', args: { name: '$row.name' } }],
      sections: [
        { kind: 'run', title: 'Run', candidates: [{ source: 'tasks', field: 'name', action: 'stop' }] },
        { kind: 'table', title: 'T', source: 'tasks', row_actions: ['stop'], columns: [] },
      ],
      ...overrides,
    },
  };
}

class FakeHttp implements apps.LibraryHttp {
  routes = new Map<string, () => apps.LibraryResponse>();
  calls: { url: string; headers?: Record<string, string> }[] = [];
  offline = false;

  serve(url: string, body: Uint8Array | string, status = 200, headers: Record<string, string> = {}) {
    this.routes.set(url, () => ({ status, headers, body: typeof body === 'string' ? encode(body) : body }));
  }

  async get(url: string, options: { headers?: Record<string, string>; timeoutMs: number; maxBytes?: number }) {
    this.calls.push({ url, headers: options.headers });
    if (this.offline) throw new Error('ECONNREFUSED');
    const route = this.routes.get(url);
    if (!route) return { status: 404, headers: {}, body: new Uint8Array() };
    const response = route();
    if (response.status === 200 && options.headers?.['If-None-Match'] && options.headers['If-None-Match'] === response.headers.etag) {
      return { status: 304, headers: response.headers, body: new Uint8Array() };
    }
    return response;
  }
}

class MemoryStore implements apps.LibraryStore {
  files = new Map<string, Uint8Array>();
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes);
  }
}

function setup(entries: Record<string, unknown>[] = [], now = { t: 1_000_000 }) {
  const http = new FakeHttp();
  const store = new MemoryStore();
  const index = { schema: 1, generated_at: 'g', cell_count: 225, apps: entries };
  http.serve(`${BASE}/index.json`, JSON.stringify(index), 200, { etag: '"v1"' });
  const library = new AppLibrary({ http, store, sha256, now: () => now.t, indexUrl: `${BASE}/index.json` });
  return { http, store, library, now };
}

function entryFor(doc: unknown, overrides: Record<string, unknown> = {}) {
  const bytes = canonicalPackageBytes(doc);
  const id = (doc as { manifest: { id: string } }).manifest.id;
  return {
    bytes,
    entry: { id, version: '1.0.0', min_os: 'v1.2.0', kind: (doc as { kind?: string }).kind ?? 'flow', package: { url: `${BASE}/dist/${id}/${id}-1.0.0.nha`, sha256: hex(bytes), size: bytes.length }, ...overrides },
  };
}

describe('catalog', () => {
  it('fetches, caches within the TTL, then revalidates with the ETag', async () => {
    const { http, library, now } = setup([{ id: 'demo' }]);
    const first = await library.catalog();
    expect(first).toMatchObject({ source: 'remote', stale: false, error: null, generated_at: 'g', cell_count: 225 });
    expect(first.items).toHaveLength(1);
    expect((await library.catalog()).source).toBe('cache');
    expect(http.calls).toHaveLength(1);
    now.t += apps.DEFAULT_TTL_MS + 1;
    const revalidated = await library.catalog();
    expect(revalidated).toMatchObject({ source: 'cache', stale: false });
    expect(http.calls[1]?.headers?.['If-None-Match']).toBe('"v1"');
    // The 304 refreshed fetched_at: no request inside the next TTL.
    await library.catalog();
    expect(http.calls).toHaveLength(2);
  });

  it('force refetches even inside the TTL', async () => {
    const { http, library } = setup();
    await library.catalog();
    await library.catalog(true);
    expect(http.calls).toHaveLength(2);
  });

  it('serves the cached copy marked stale when the library is unreachable or failing', async () => {
    const { http, library } = setup([{ id: 'demo' }]);
    await library.catalog();
    http.offline = true;
    expect(await library.catalog(true)).toMatchObject({ source: 'cache', stale: true, error: 'unreachable' });
    http.offline = false;
    http.serve(`${BASE}/index.json`, 'nope', 500);
    expect(await library.catalog(true)).toMatchObject({ stale: true, error: 'http_500' });
    http.serve(`${BASE}/index.json`, '{not json');
    expect(await library.catalog(true)).toMatchObject({ stale: true, error: 'malformed_index' });
  });

  it('fails without a cached copy', async () => {
    const { http, library } = setup();
    http.offline = true;
    await expect(library.catalog()).rejects.toThrow('unreachable');
    http.offline = false;
    http.serve(`${BASE}/index.json`, 'x', 503);
    await expect(library.catalog()).rejects.toThrow('http_503');
    http.serve(`${BASE}/index.json`, '[1');
    await expect(library.catalog()).rejects.toThrow(AppLibraryError);
  });

  it('finds an entry or says app_not_found', async () => {
    const { library } = setup([{ id: 'demo', version: '1.0.0' }]);
    expect((await library.entry('demo')).version).toBe('1.0.0');
    await expect(library.entry('other')).rejects.toThrow('app_not_found');
  });
});

describe('packages', () => {
  it('downloads, checks and validates a package, and caches it', async () => {
    const { entry, bytes } = entryFor(flowPackage());
    const { http, store, library } = setup([entry]);
    http.serve(entry.package.url, bytes);
    const pkg = await library.downloadPackage('demo');
    expect(pkg).toMatchObject({ id: 'demo', kind: 'flow', nodes: 3, device_path: 'apps/demo.nha', size: bytes.length, cache_key: 'demo-1.0.0', sha256: entry.package.sha256 });
    expect(pkg.data_hex).toBe(Buffer.from(bytes).toString('hex'));
    expect(store.files.has('packages/demo-1.0.0.nha')).toBe(true);
    // A good cached copy is not downloaded again.
    const before = http.calls.length;
    await library.downloadPackage('demo');
    expect(http.calls.length).toBe(before);
    expect((await library.cachedPackage('demo-1.0.0')).sha256).toBe(pkg.sha256);
  });

  it('refuses a wrong checksum, a wrong size and a host outside the allowlist', async () => {
    const { entry, bytes } = entryFor(flowPackage());
    const bad = { ...entry, package: { ...entry.package, sha256: '0'.repeat(64) } };
    let ctx = setup([bad]);
    ctx.http.serve(entry.package.url, bytes);
    await expect(ctx.library.downloadPackage('demo')).rejects.toThrow('checksum_mismatch');

    ctx = setup([{ ...entry, package: { ...entry.package, size: bytes.length + 1 } }]);
    ctx.http.serve(entry.package.url, bytes);
    await expect(ctx.library.downloadPackage('demo')).rejects.toThrow('size_mismatch');

    for (const url of ['https://evil.example/dist/demo.nha', 'http://raw.githubusercontent.com/x/dist/demo.nha', 'not a url']) {
      ctx = setup([{ ...entry, package: { ...entry.package, url } }]);
      await expect(ctx.library.downloadPackage('demo')).rejects.toThrow('package_host_not_allowed');
    }
  });

  it('refuses a bad id, an unknown version and an unreachable package', async () => {
    const { entry } = entryFor(flowPackage());
    const { http, library } = setup([entry]);
    await expect(library.downloadPackage('../x')).rejects.toThrow(AppPackageError);
    await expect(library.downloadPackage('demo', '9.9.9')).rejects.toThrow('version_not_available');
    await expect(library.downloadPackage('demo')).rejects.toThrow('package_unreachable');
    http.offline = true;
    await expect(library.downloadPackage('demo')).rejects.toThrow();
  });

  it('refuses an oversize or malformed package', async () => {
    const { library } = setup();
    await expect(library.importPackage(new Uint8Array(apps.MAX_PACKAGE_BYTES + 1))).rejects.toThrow('package_too_large');
    await expect(library.importPackage(encode('{oops'))).rejects.toThrow('malformed_package');
    await expect(library.importPackage(new Uint8Array([0xff, 0xfe]))).rejects.toThrow('malformed_package');
  });

  it('imports a local package under a content key', async () => {
    const { library } = setup();
    const bytes = canonicalPackageBytes(readoutPackage());
    const pkg = await library.importPackage(bytes);
    expect(pkg.cache_key).toBe(`local-${hex(bytes).slice(0, 8)}`);
    expect(pkg.kind).toBe('readout');
  });

  it('cached packages are looked up by key only', async () => {
    const { library } = setup();
    for (const key of ['../x', 'a/b', 'a\\b', '']) await expect(library.cachedPackage(key)).rejects.toThrow('invalid_cache_key');
    await expect(library.cachedPackage('nothing-1.0.0')).rejects.toThrow('not_cached');
  });
});

describe('sources', () => {
  it('finds the source beside dist/ and falls back to its cached copy offline', async () => {
    const { entry } = entryFor(flowPackage());
    const { http, library } = setup([entry]);
    http.serve(`${BASE}/apps/demo/app.nhs`, 'app demo {}\n');
    const source = await library.fetchSource('demo');
    expect(source).toMatchObject({ id: 'demo', kind: 'flow', filename: 'app.nhs', source: 'app demo {}\n', package_sha256: entry.package.sha256 });
    http.offline = true;
    expect((await library.fetchSource('demo')).source).toBe('app demo {}\n');
  });

  it('names readout and panel sources by kind and caps their size', async () => {
    const readout = entryFor(readoutPackage()).entry;
    const panel = entryFor(panelPackage()).entry;
    const { http, library } = setup([readout, panel]);
    http.serve(`${BASE}/apps/scan/readout.json`, '{}');
    http.serve(`${BASE}/apps/tasks/panel.json`, 'x'.repeat(apps.MAX_SOURCE_BYTES + 1));
    expect((await library.fetchSource('scan')).filename).toBe('readout.json');
    await expect(library.fetchSource('tasks')).rejects.toThrow('source_too_large');
  });

  it('has no source without a dist/ URL or when nothing was ever fetched', async () => {
    const { entry } = entryFor(flowPackage());
    let ctx = setup([{ ...entry, package: { ...entry.package, url: 'https://raw.githubusercontent.com/x/demo.nha' } }]);
    await expect(ctx.library.fetchSource('demo')).rejects.toThrow('source_unavailable');
    ctx = setup([entry]);
    await expect(ctx.library.fetchSource('demo')).rejects.toThrow('source_unreachable');
  });
});

describe('validatePackage', () => {
  const rejects = (doc: unknown, code: string) => expect(() => validatePackage(doc)).toThrow(code);

  it('accepts the three kinds and summarises them', () => {
    expect(validatePackage(flowPackage())).toMatchObject({ kind: 'flow', nodes: 3, min_os: 'v1.2.0', device_path: 'apps/demo.nha' });
    expect(validatePackage(readoutPackage())).toMatchObject({ kind: 'readout', nodes: 0, min_os: 'v1.0.0' });
    expect(validatePackage(panelPackage())).toMatchObject({ kind: 'panel', permissions: ['task_control'] });
  });

  it('checks the envelope and the manifest', () => {
    rejects([], 'not_a_package');
    rejects({ ...flowPackage(), nhapp: 2 }, 'unsupported_package_version');
    rejects({ ...flowPackage(), kind: 'script' }, 'unsupported_kind');
    rejects({ nhapp: 1 }, 'missing_manifest');
    rejects(flowPackage('Bad'), 'invalid_id');
    rejects(flowPackage('a_very_long_app_id'), 'invalid_id');
    rejects(flowPackage('index'), 'reserved_id');
    const m = (patch: Record<string, unknown>) => ({ ...flowPackage(), manifest: { ...flowPackage().manifest, ...patch } });
    rejects(m({ version: '1.0' }), 'invalid_version');
    rejects(m({ summary: '  ' }), 'invalid_manifest');
    rejects(m({ min_os: '1.2' }), 'invalid_min_os');
    rejects(m({ capabilities: ['fly'] }), 'unknown_capability');
    rejects(m({ capabilities: 'read_matrix' }), 'invalid_manifest');
    rejects(m({ permissions: ['task_control'] }), 'permissions_need_a_panel');
  });

  it('checks a flow graph', () => {
    const g = (nodes: unknown) => ({ ...flowPackage(), nodes });
    rejects(g('x'), 'missing_nodes');
    rejects(g([]), 'empty_graph');
    rejects(g(Array.from({ length: apps.MAX_NODES + 1 }, () => ({ op: 'total' }))), 'too_many_nodes');
    rejects(g([1]), 'invalid_node');
    rejects(g([{ op: 'eval' }]), 'unknown_op');
    rejects(g([{ op: 'total', in: [0] }]), 'input_out_of_order');
    rejects(g([{ op: 'total' }, { op: 'abs', in: 1 }]), 'input_out_of_order');
    rejects(g([{ op: 'total' }, { op: 'emit', in: [0], event: 'x'.repeat(apps.MAX_EVENT_NAME + 1) }]), 'invalid_event_name');
    expect(validatePackage(g([{ op: 'total' }, { op: 'abs', in: 0 }])).nodes).toBe(2);
    rejects({ ...flowPackage(), readout: {} }, 'flow_must_not_declare_a_readout');
  });

  it('checks readouts', () => {
    const r = (readout: unknown) => ({ ...readoutPackage(), readout });
    rejects({ ...readoutPackage(), nodes: [] }, 'readout_must_not_declare_nodes');
    rejects(r(null), 'missing_readout');
    rejects(r({ ...readoutPackage().readout, actions: [] }), 'readout_must_not_declare_actions');
    rejects(r({ sources: [], sections: [] }), 'missing_sources');
    rejects(r({ sources: [{ command: 'file_write_begin' }], sections: [{ kind: 'stats' }] }), 'readout_source_not_allowed');
    rejects(r({ sources: [{ command: 'status' }], sections: [] }), 'missing_sections');
    rejects(r({ sources: [{ command: 'status' }], sections: [{ kind: 'run' }] }), 'unknown_section_kind');
  });

  it('checks panels: permissions, actions, templates, tabs', () => {
    const p = panelPackage;
    rejects({ ...p(), manifest: { ...p().manifest, permissions: ['root'] } }, 'unknown_permission');
    rejects({ ...p(), nodes: [] }, 'panel_must_not_declare_nodes');
    rejects(p({ actions: [{ id: 'x', command: 'reboot' }] }), 'panel_action_not_permitted');
    rejects(p({ actions: [{ id: 'x', command: 'service_stop' }] }), 'panel_action_not_permitted');
    rejects(p({ actions: [{ id: 'stop', command: 'task_stop' }, { id: 'stop', command: 'task_start' }] }), 'invalid_action');
    rejects(p({ actions: [{ id: 'stop', command: 'task_stop', args: { name: '$env.HOME' } }] }), 'invalid_arg_template');
    rejects(p({ actions: [{ id: 'stop', command: 'task_stop', args: { name: '$input.name' } }] }), 'input_not_declared');
    rejects(p({ actions: [{ id: 'stop', command: 'task_stop', args: { command: 'reboot' } }] }), 'invalid_arg_name');
    rejects(p({ actions: Array.from({ length: apps.MAX_PANEL_ACTIONS + 1 }, (_, i) => ({ id: `a${i}`, command: 'task_stop' })) }), 'too_many_actions');
    rejects(p({ sections: [{ kind: 'table', title: 'T', source: 'tasks', row_actions: ['nope'] }] }), 'unknown_action');
    rejects(p({ sections: [{ kind: 'run', title: 'R', candidates: [{ source: 'other', action: 'stop' }] }] }), 'unknown_source');
    rejects(p({ sections: [{ kind: 'tabs', title: 'T', tabs: [{ title: 'a', sections: [{ kind: 'tabs', tabs: [{ sections: [] }] }] }] }] }), 'nested_tabs');
    expect(
      validatePackage(p({ actions: [{ id: 'stop', command: 'task_stop', input: { field: 'name', default: '$row.name' }, args: { name: '$input.name', force: true } }] })).kind,
    ).toBe('panel');
  });

  it('a panel may only send what its permissions name, and never a forbidden command', () => {
    expect(panelCommandAllowed('task_stop', ['task_control'])).toBe(true);
    expect(panelCommandAllowed('task_stop', ['service_control'])).toBe(false);
    expect(panelCommandAllowed('set_wifi', ['task_control'])).toBe(false);
    expect(panelCommandAllowed('app_install', ['app_control'])).toBe(false);
  });

  it('canonical bytes sort keys and end with a newline, as the library serialises', () => {
    expect(new TextDecoder().decode(canonicalPackageBytes({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: 'é' } }))).toBe('{"a":{"c":"é","d":[2,{"y":0,"z":1}]},"b":1}\n');
  });
});
