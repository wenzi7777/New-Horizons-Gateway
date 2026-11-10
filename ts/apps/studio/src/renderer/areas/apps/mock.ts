// Browser-preview (mock) implementation of the "apps" area: the methods of
// main/areas/apps.ts with canned behaviour -- a two-app catalog, projects in
// memory, dialogs that open nothing.
import type { AppCatalog, AppCatalogEntry, AppPackage, StudioProject } from '../../../shared/areas/apps';
import type { AreaMock } from '../mockTypes';

const ENTRIES: AppCatalogEntry[] = [
  {
    id: 'steps',
    name: { en: 'Step Counter', ja: '歩数計', 'zh-CN': '计步器' },
    summary: { en: 'Counts heel strikes and shows the count on the OLED.', ja: 'かかとの接地を数えて OLED に表示します。', 'zh-CN': '统计脚跟着地次数并显示在 OLED 上。' },
    version: '1.2.0',
    author: 'nhos',
    category: 'gait',
    kind: 'flow',
    capabilities: ['read_matrix', 'emit_event', 'display'],
    min_os: 'v1.6.0',
    nodes: 9,
    estimated_us: 310,
    device_path: 'apps/steps.nha',
    package: { url: 'https://raw.githubusercontent.com/x/main/dist/steps/steps-1.2.0.nha', sha256: '0'.repeat(64), size: 1480 },
  },
  {
    id: 'sysmon',
    name: { en: 'System Monitor', ja: 'システムモニター', 'zh-CN': '系统监视器' },
    summary: { en: 'Tasks, services and memory, with stop and start.', ja: 'タスク・サービス・メモリ。停止と開始つき。', 'zh-CN': '任务、服务与内存，可停止和启动。' },
    version: '2.0.0',
    author: 'nhos',
    category: 'diagnostics',
    kind: 'panel',
    permissions: ['task_control'],
    min_os: 'v1.19.0',
    device_path: 'apps/sysmon.nha',
    package: { url: 'https://raw.githubusercontent.com/x/main/dist/sysmon/sysmon-2.0.0.nha', sha256: '1'.repeat(64), size: 3900 },
  },
];

function fakePackage(entry: AppCatalogEntry): AppPackage {
  const doc = JSON.stringify({ nhapp: 1, manifest: { id: entry.id, version: entry.version } });
  return {
    id: entry.id,
    version: entry.version,
    min_os: entry.min_os,
    kind: entry.kind ?? 'flow',
    nodes: entry.nodes ?? 0,
    capabilities: entry.capabilities ?? [],
    permissions: entry.permissions,
    device_path: entry.device_path,
    sha256: entry.package.sha256,
    size: doc.length,
    cache_key: `${entry.id}-${entry.version}`,
    data_hex: Array.from(new TextEncoder().encode(doc), (b) => b.toString(16).padStart(2, '0')).join(''),
  };
}

export const appsMock: AreaMock = () => {
  const projects = new Map<string, StudioProject>();
  const find = (id: string) => {
    const entry = ENTRIES.find((item) => item.id === id);
    if (!entry) throw new Error('app_not_found');
    return entry;
  };
  return {
    libraryIndex: (): AppCatalog => ({ items: ENTRIES, source: 'cache', stale: false, error: null }),
    libraryApp: (id: string) => find(id),
    librarySource: (id: string) => {
      const entry = find(id);
      return { id, version: entry.version, kind: entry.kind ?? 'flow', filename: 'app.nhs', source: `app ${id} {\n  name "${id}"\n  version ${entry.version}\n  author nhos\n  summary "Preview"\n}\n\nsignal load = total()\nevent pressed when load > 40\n` };
    },
    libraryPackage: (id: string) => fakePackage(find(id)),
    libraryReadme: () => '# Preview\n\nThe README is fetched from the App Library in the real app.',
    libraryIcon: () => null,
    importPackage: () => null,
    validatePackageBytes: () => fakePackage(ENTRIES[0]!),
    listProjects: () => [...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    saveProject: (project: StudioProject) => {
      projects.set(project.id, project);
    },
    deleteProject: (id: string) => {
      projects.delete(id);
    },
    openSourceFile: () => null,
    exportFiles: () => null,
    revealProject: () => undefined,
    projectsFolder: () => '/Users/preview/Documents/NH Studio/apps',
  };
};
