// The renderer's only way to the engine: window.nhStudio (the preload bridge,
// StudioApi in src/shared/contract.ts). In a plain browser (`vite` dev
// server, no Electron) it falls back to the canned MockStudioApi so the whole
// app can be reviewed without a device.

import type { StudioApi } from '../shared/contract';
import { createMockApi } from './mock';

export type ApiSource = 'electron' | 'mock';

export function resolveApi(win: { nhStudio?: StudioApi } | undefined): { api: StudioApi; source: ApiSource } {
  const bridge = win?.nhStudio;
  if (bridge && typeof bridge.snapshot === 'function') return { api: bridge, source: 'electron' };
  return { api: createMockApi(), source: 'mock' };
}

let cached: { api: StudioApi; source: ApiSource } | null = null;

/** The StudioApi for this window (created once). */
export function getApi(): { api: StudioApi; source: ApiSource } {
  if (!cached) cached = resolveApi(typeof window === 'undefined' ? undefined : (window as { nhStudio?: StudioApi }));
  return cached;
}

/** "darwin" | "win32" | "other", from the user agent (the preload does not expose process). */
export function platformOf(userAgent: string): 'darwin' | 'win32' | 'other' {
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'darwin';
  if (/Windows/i.test(userAgent)) return 'win32';
  return 'other';
}
