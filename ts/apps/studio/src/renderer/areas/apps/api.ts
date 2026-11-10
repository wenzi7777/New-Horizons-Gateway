// Typed client for the "apps" area (see ../../../shared/areas/apps.ts).
import type { AppsAreaApi } from '../../../shared/areas/apps';
import type { StudioApi } from '../../../shared/contract';

export type AppsClient = AppsAreaApi;

export function appsApi(api: StudioApi): AppsClient {
  const call =
    <M extends keyof AppsAreaApi>(method: M) =>
    (...args: Parameters<AppsAreaApi[M]>) =>
      api.call<Awaited<ReturnType<AppsAreaApi[M]>>>('apps', method, ...args);
  return {
    libraryIndex: call('libraryIndex'),
    libraryApp: call('libraryApp'),
    librarySource: call('librarySource'),
    libraryPackage: call('libraryPackage'),
    libraryReadme: call('libraryReadme'),
    libraryIcon: call('libraryIcon'),
    importPackage: call('importPackage'),
    validatePackageBytes: call('validatePackageBytes'),
    listProjects: call('listProjects'),
    saveProject: call('saveProject'),
    deleteProject: call('deleteProject'),
    openSourceFile: call('openSourceFile'),
    exportFiles: call('exportFiles'),
    revealProject: call('revealProject'),
    projectsFolder: call('projectsFolder'),
  };
}

/** The message of an IPC rejection without Electron's "Error invoking remote method" prefix. */
export function errorCode(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '');
}
