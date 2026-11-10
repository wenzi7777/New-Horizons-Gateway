// Main-process handlers of the "apps" area (see ../../shared/areas/apps.ts):
// the App Library client (@nhgw/host apps; cache under <userData>/app-library),
// App Studio projects as files under <dataFolder>/apps/<project>/, and the
// open / save dialogs. Electron is reached only through AppsAreaPorts, so the
// handlers are testable with fakes.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

import { apps } from '@nhgw/host';

import type { AppCatalog, AppCatalogEntry, AppKind, AppPackage, AppSource, AppsAreaApi, ExportFile, StudioProject } from '../../shared/areas/apps';
import type { AreaContext, AreaHandlers, AreaModule } from './registry';

export interface AppsAreaPorts {
  http: apps.LibraryHttp;
  /** Open dialog: the chosen absolute path, or null. */
  openFile(options: { title: string; extensions: string[] }): Promise<string | null>;
  /** Folder picker: the chosen absolute path, or null. */
  chooseFolder(title: string): Promise<string | null>;
  reveal(path: string): Promise<void>;
}

export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PROJECT_SOURCE = 256 * 1024;
const MAX_SOURCE_FILE = 256 * 1024;
const MAX_README_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 256 * 1024;
const EXPORT_NAME_RE = /^(app\.nhs|readout\.json|panel\.json|app\.nha|meta\.json|README\.md)$/;
const KINDS: readonly AppKind[] = ['flow', 'readout', 'panel'];

export function sourceFilename(kind: AppKind): string {
  return kind === 'flow' ? 'app.nhs' : kind === 'panel' ? 'panel.json' : 'readout.json';
}

export const sha256 = async (data: Uint8Array): Promise<string> => createHash('sha256').update(data).digest('hex');

/** Node's fetch as the library's HTTP port: every status resolves, a body is read up to maxBytes. */
export const fetchLibraryHttp: apps.LibraryHttp = {
  async get(url, { headers, timeoutMs, maxBytes }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
      const out: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        out[key.toLowerCase()] = value;
      });
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          chunks.push(value);
          total += value.length;
          if (maxBytes !== undefined && total >= maxBytes) {
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      return { status: response.status, headers: out, body: maxBytes !== undefined ? body.subarray(0, maxBytes) : body };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** The library's cache as files under one folder; paths are the library's own fixed names. */
export function folderStore(root: string): apps.LibraryStore {
  const full = (path: string) => {
    const target = resolve(root, path);
    if (!target.startsWith(resolve(root) + sep)) throw new Error('invalid_cache_path');
    return target;
  };
  return {
    async read(path) {
      try {
        return new Uint8Array(await readFile(full(path)));
      } catch {
        return null;
      }
    },
    async write(path, bytes) {
      const target = full(path);
      await mkdir(dirname(target), { recursive: true });
      const temp = `${target}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, target);
    },
  };
}

function electronPorts(): AppsAreaPorts {
  const electron = () => import('electron');
  return {
    http: fetchLibraryHttp,
    async openFile({ title, extensions }) {
      const { BrowserWindow, dialog } = await electron();
      const window = BrowserWindow.getFocusedWindow();
      const options = { title, properties: ['openFile' as const], filters: [{ name: title, extensions }] };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    async chooseFolder(title) {
      const { BrowserWindow, dialog } = await electron();
      const window = BrowserWindow.getFocusedWindow();
      const options = { title, properties: ['openDirectory' as const, 'createDirectory' as const] };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    async reveal(path) {
      const { shell } = await electron();
      shell.showItemInFolder(path);
    },
  };
}

function str(value: unknown, what: string, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`invalid_${what}`);
  return value;
}

function projectIdArg(value: unknown): string {
  const id = str(value, 'project_id', 64);
  if (!PROJECT_ID_RE.test(id)) throw new Error('invalid_project_id');
  return id;
}

function appIdArg(value: unknown): string {
  const id = str(value, 'app_id', 32);
  if (!apps.APP_ID_RE.test(id)) throw new Error('invalid_id');
  return id;
}

function bytesArg(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) return Uint8Array.from(value as number[]);
  throw new Error('invalid_bytes');
}

function allowedUrl(url: unknown, hosts: readonly string[]): string {
  const text = str(url, 'url', 2048);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('invalid_url');
  }
  if (parsed.protocol !== 'https:' || !hosts.includes(parsed.hostname)) throw new Error('package_host_not_allowed');
  return text;
}

function projectFromDisk(id: string, meta: unknown, source: string): StudioProject | null {
  if (!meta || typeof meta !== 'object') return null;
  const record = meta as Record<string, unknown>;
  const kind = record.kind;
  if (!KINDS.includes(kind as AppKind)) return null;
  const project: StudioProject = { id, kind: kind as AppKind, source, updatedAt: Number(record.updatedAt) || 0 };
  const origin = record.origin as Record<string, unknown> | undefined;
  if (origin && typeof origin.appId === 'string' && typeof origin.version === 'string') {
    project.origin = { appId: origin.appId, version: origin.version };
    if (typeof origin.packageSha256 === 'string') project.origin.packageSha256 = origin.packageSha256;
  }
  return project;
}

function projectArg(value: unknown): StudioProject {
  if (!value || typeof value !== 'object') throw new Error('invalid_project');
  const record = value as Record<string, unknown>;
  const id = projectIdArg(record.id);
  if (!KINDS.includes(record.kind as AppKind)) throw new Error('invalid_project_kind');
  if (typeof record.source !== 'string' || record.source.length > MAX_PROJECT_SOURCE) throw new Error('invalid_project_source');
  const project = projectFromDisk(id, { kind: record.kind, origin: record.origin, updatedAt: record.updatedAt }, record.source);
  if (!project) throw new Error('invalid_project');
  return project;
}

export interface AppsAreaOptions {
  ports?: Partial<AppsAreaPorts>;
  /** Overrides the cache folder (default <userData>/app-library). */
  cacheDir?: string;
  indexUrl?: string;
  allowedHosts?: readonly string[];
  now?: () => number;
}

/** The handlers, given a context; exported for tests. */
export function appsHandlers(context: Pick<AreaContext, 'controller' | 'userDataDir'>, options: AppsAreaOptions = {}): AreaHandlers {
  const ports: AppsAreaPorts = { ...electronPorts(), ...options.ports };
  const allowedHosts = options.allowedHosts ?? apps.DEFAULT_ALLOWED_HOSTS;
  const library = new apps.AppLibrary({
    http: ports.http,
    store: folderStore(options.cacheDir ?? join(context.userDataDir, 'app-library')),
    sha256,
    now: options.now,
    indexUrl: options.indexUrl ?? process.env.NEWHORIZONS_APP_LIBRARY_URL ?? undefined,
    allowedHosts,
  });
  const projectsRoot = () => join(context.controller.settings().dataFolder, 'apps');
  const projectDir = (id: string) => join(projectsRoot(), id);

  const fetchSmall = async (url: string, maxBytes: number): Promise<{ bytes: Uint8Array; type: string } | null> => {
    try {
      const response = await ports.http.get(url, { timeoutMs: apps.FETCH_TIMEOUT_MS, maxBytes: maxBytes + 1 });
      if (response.status < 200 || response.status >= 300 || response.body.length > maxBytes) return null;
      return { bytes: response.body, type: response.headers['content-type'] ?? '' };
    } catch {
      return null;
    }
  };

  const api: AppsAreaApi = {
    async libraryIndex(refresh) {
      return (await library.catalog(refresh === true)) as unknown as AppCatalog;
    },
    async libraryApp(appId) {
      return (await library.entry(appIdArg(appId))) as unknown as AppCatalogEntry;
    },
    async librarySource(appId) {
      return (await library.fetchSource(appIdArg(appId))) as unknown as AppSource;
    },
    async libraryPackage(appId, version) {
      const wanted = typeof version === 'string' && version.trim() ? version.trim() : null;
      return (await library.downloadPackage(appIdArg(appId), wanted)) as AppPackage;
    },
    async libraryReadme(url) {
      const got = await fetchSmall(allowedUrl(url, allowedHosts), MAX_README_BYTES);
      if (!got) return null;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(got.bytes);
      } catch {
        return null;
      }
    },
    async libraryIcon(url) {
      const target = allowedUrl(url, allowedHosts);
      const got = await fetchSmall(target, MAX_ICON_BYTES);
      if (!got) return null;
      const ext = extname(new URL(target).pathname).toLowerCase();
      // raw.githubusercontent.com serves every file as text/plain: go by the extension.
      const type = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : '';
      if (!type) return null;
      return `data:${type};base64,${Buffer.from(got.bytes).toString('base64')}`;
    },
    async importPackage() {
      const path = await ports.openFile({ title: 'App package', extensions: ['nha', 'json'] });
      if (!path) return null;
      const bytes = await readFile(path);
      if (bytes.length > 64 * 1024) throw new Error('package_too_large');
      return (await library.importPackage(new Uint8Array(bytes))) as AppPackage;
    },
    async validatePackageBytes(bytes) {
      return (await library.importPackage(bytesArg(bytes))) as AppPackage;
    },

    async listProjects() {
      let names: string[];
      try {
        names = await readdir(projectsRoot());
      } catch {
        return [];
      }
      const projects: StudioProject[] = [];
      for (const name of names) {
        if (!PROJECT_ID_RE.test(name)) continue;
        try {
          const meta = JSON.parse(await readFile(join(projectDir(name), 'project.json'), 'utf8')) as unknown;
          const kind = (meta as { kind?: AppKind }).kind;
          if (!kind || !KINDS.includes(kind)) continue;
          const source = await readFile(join(projectDir(name), sourceFilename(kind)), 'utf8');
          const project = projectFromDisk(name, meta, source);
          if (project) projects.push(project);
        } catch {
          // Not a project (or half written): skipped, never deleted.
        }
      }
      return projects.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async saveProject(value) {
      const project = projectArg(value);
      const dir = projectDir(project.id);
      await mkdir(dir, { recursive: true });
      const write = async (name: string, text: string) => {
        const temp = join(dir, `.${name}.tmp`);
        await writeFile(temp, text, 'utf8');
        await rename(temp, join(dir, name));
      };
      await write(sourceFilename(project.kind), project.source);
      // A readout turned into a panel (or back) leaves no stale source beside it.
      for (const kind of KINDS) {
        if (sourceFilename(kind) !== sourceFilename(project.kind)) await rm(join(dir, sourceFilename(kind)), { force: true });
      }
      const meta = { kind: project.kind, origin: project.origin, updatedAt: project.updatedAt || Date.now() };
      await write('project.json', `${JSON.stringify(meta, null, 2)}\n`);
    },
    async deleteProject(projectId) {
      const id = projectIdArg(projectId);
      await rm(projectDir(id), { recursive: true, force: true });
    },
    async openSourceFile() {
      const path = await ports.openFile({ title: 'App source', extensions: ['nhs', 'json'] });
      if (!path) return null;
      const bytes = await readFile(path);
      if (bytes.length > MAX_SOURCE_FILE) throw new Error('source_too_large');
      return { name: basename(path), text: bytes.toString('utf8') };
    },
    async exportFiles(appId, files) {
      const id = appIdArg(appId);
      if (!Array.isArray(files) || files.length === 0 || files.length > 8) throw new Error('invalid_files');
      const checked = (files as ExportFile[]).map((file) => {
        if (!file || typeof file.filename !== 'string' || !EXPORT_NAME_RE.test(file.filename)) throw new Error('invalid_filename');
        const content = typeof file.content === 'string' ? file.content : bytesArg(file.content);
        return { filename: file.filename, content };
      });
      const folder = await ports.chooseFolder('Export app');
      if (!folder) return null;
      const target = join(folder, id);
      await mkdir(target, { recursive: true });
      for (const file of checked) await writeFile(join(target, file.filename), file.content);
      return target;
    },
    async revealProject(projectId) {
      const dir = projectDir(projectIdArg(projectId));
      await ports.reveal(dir);
    },
    async projectsFolder() {
      return projectsRoot();
    },
  };
  return api as unknown as AreaHandlers;
}

export function createAppsArea(options: AppsAreaOptions = {}): AreaModule {
  return { area: 'apps', register: (context) => appsHandlers(context, options) };
}

export const appsArea: AreaModule = createAppsArea();
