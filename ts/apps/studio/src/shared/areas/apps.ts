// Typed API of the "apps" area (see ../areas.ts): the device App Library
// (catalog, packages, validation -- @nhgw/host apps), App Studio projects
// saved as files under <dataFolder>/apps/<project>/, and the import/export
// dialogs. Device commands (install, activate, app_view …) do not come
// through here: the renderer sends them with api.sendCommand, one at a time.

export type AppKind = 'flow' | 'readout' | 'panel';

/** A per-locale catalog string; only `en` is guaranteed. */
export type Localised = { en: string; ja?: string; 'zh-CN'?: string };

export interface AppCatalogEntry {
  id: string;
  name: Localised | string;
  summary: Localised | string;
  version: string;
  author: string;
  license?: string;
  category?: string;
  capabilities?: string[];
  kind?: AppKind;
  permissions?: string[];
  min_os: string;
  nodes?: number;
  estimated_us?: number;
  memory_bytes?: number;
  device_path: string;
  icon_url?: string;
  readme_url?: Partial<Record<'en' | 'ja' | 'zh-CN', string>>;
  homepage?: string;
  package: { url: string; sha256: string; size: number };
}

export interface AppCatalog {
  items: AppCatalogEntry[];
  generated_at?: string;
  cell_count?: number;
  source?: string;
  /** A cached copy served because the library was unreachable. */
  stale?: boolean;
  error?: string | null;
}

/** A validated package, ready to be written to a device. */
export interface AppPackage {
  id: string;
  version: string;
  min_os: string;
  kind: AppKind;
  nodes: number;
  capabilities: string[];
  permissions?: string[];
  device_path: string;
  sha256: string;
  size: number;
  cache_key: string;
  /** Hex, because file_write_chunk takes hex. */
  data_hex: string;
}

/** A library app's source, for App Studio to open. */
export interface AppSource {
  id: string;
  version: string;
  kind: AppKind;
  filename: string;
  source: string;
  /** What the source must compile to, byte for byte, if it is the published version. */
  package_sha256?: string;
}

/** An App Studio project as saved in <dataFolder>/apps/<id>/ (project.json + its source file). */
export interface StudioProject {
  id: string;
  kind: AppKind;
  source: string;
  /** Set when the project was opened from the App Library. */
  origin?: { appId: string; version: string; packageSha256?: string };
  updatedAt: number;
}

/** A file App Studio exports (source, app.nha, meta.json, README.md). */
export interface ExportFile {
  filename: string;
  content: string | Uint8Array;
}

export interface AppsAreaApi {
  /** The catalog (cached for 15 min, ETag-revalidated; stale copy when offline). */
  libraryIndex(refresh?: boolean): Promise<AppCatalog>;
  libraryApp(appId: string): Promise<AppCatalogEntry>;
  librarySource(appId: string): Promise<AppSource>;
  /** Downloaded, size- and sha256-checked against the catalog, validated. */
  libraryPackage(appId: string, version?: string): Promise<AppPackage>;
  /** An app's README (allowlisted hosts only), or null. */
  libraryReadme(url: string): Promise<string | null>;
  /** An app's icon as a data: URL (the renderer's CSP allows no remote images), or null. */
  libraryIcon(url: string): Promise<string | null>;
  /** Open dialog for a .nha; validated. Null when cancelled. */
  importPackage(): Promise<AppPackage | null>;
  /** A package built in App Studio, validated like any other. */
  validatePackageBytes(bytes: Uint8Array): Promise<AppPackage>;

  listProjects(): Promise<StudioProject[]>;
  saveProject(project: StudioProject): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  /** Open dialog for a .nhs / .json source; null when cancelled. */
  openSourceFile(): Promise<{ name: string; text: string } | null>;
  /** Folder picker, then writes the files into <folder>/<appId>/. Resolves with that folder or null. */
  exportFiles(appId: string, files: ExportFile[]): Promise<string | null>;
  /** Show the project's folder in Finder / Explorer. */
  revealProject(projectId: string): Promise<void>;
  /** Where projects are kept (<dataFolder>/apps). */
  projectsFolder(): Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AppsAreaEvents {}
