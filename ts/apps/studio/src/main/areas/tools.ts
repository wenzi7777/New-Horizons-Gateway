// Main-process handlers of the "tools" area (see ../../shared/areas/tools.ts):
// the terminal compiler (the Desktop backend's terminal.py, in @nhgw/host),
// per-device terminal history, streamed reads of recordings / opened CSVs
// for the analysis tool, save / open dialogs, and the lab pressure chamber
// proxy (pressure_cal_client.py) whose settings live in userData. The token
// never leaves this process and is never logged.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isMetaFile, metaNameFor, sidecarNameFor } from '@nhgw/analysis';

import {
  applyPressureSettings,
  compileTerminalCommand,
  normalizePressureSettings,
  pressureClientFor,
  pressureSettingsView,
  pressureTargetError,
  runPressureCall,
  terminalHelpItems,
  type FetchLike,
  type PressureCalStored,
} from '@nhgw/host';

import {
  TOOLS_CHUNK_BYTES,
  TOOLS_MAX_CHUNK_BYTES,
  TOOLS_MAX_UPLOAD_BYTES,
  type PressureReadings,
  type PressureResult,
  type PressureSettingsInput,
  type ToolsChunk,
  type ToolsFileSource,
  type ToolsRecordingFiles,
  type ToolsSaveRequest,
} from '../../shared/areas/tools';
import type { AreaContext, AreaHandlers, AreaModule } from './registry';

export const TERMINAL_HISTORY_LIMIT = 200;
const HISTORY_FILE = 'tools-terminal-history.json';
const PRESSURE_FILE = 'tools-pressure.json';
const META_MAX_BYTES = 4 << 20;

export interface ToolsDialogs {
  save(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  open(filters: { name: string; extensions: string[] }[]): Promise<string | null>;
}

export interface ToolsDeps {
  dialogs?: ToolsDialogs;
  fetch?: FetchLike;
  /** Absolute folder of a recording id (default: the controller's). */
  recordingPath?: (recordingId: string) => string;
}

/** Electron's dialogs, loaded lazily so this module stays testable without Electron. */
const electronDialogs: ToolsDialogs = {
  async save(defaultName, filters) {
    const { dialog, BrowserWindow } = await import('electron');
    const win = BrowserWindow.getFocusedWindow();
    const options = { defaultPath: defaultName, filters };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  },
  async open(filters) {
    const { dialog, BrowserWindow } = await import('electron');
    const win = BrowserWindow.getFocusedWindow();
    const options = { properties: ['openFile' as const], filters };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  },
};

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, path);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return 0;
  }
}

/** Reads [offset, offset+length) of a file. */
export async function readFileChunk(path: string, offset: number, length = TOOLS_CHUNK_BYTES): Promise<ToolsChunk> {
  const size = Math.min(Math.max(1, Math.floor(length) || TOOLS_CHUNK_BYTES), TOOLS_MAX_CHUNK_BYTES);
  const start = Math.max(0, Math.floor(offset) || 0);
  const handle = await fs.open(path, 'r');
  try {
    const totalBytes = (await handle.stat()).size;
    const want = Math.max(0, Math.min(size, totalBytes - start));
    const data = new Uint8Array(want);
    let read = 0;
    while (read < want) {
      const { bytesRead } = await handle.read(data, read, want - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const nextOffset = start + read;
    return { data: read === want ? data : data.slice(0, read), nextOffset, done: nextOffset >= totalBytes, totalBytes };
  } finally {
    await handle.close();
  }
}

/** A recording folder's data / events / meta files (meta.files names them, else <folder>.data.csv). */
export async function recordingFilesIn(directory: string): Promise<{ data: string; events: string; meta: Record<string, unknown> | null }> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(directory);
  } catch {
    throw new Error('recording_not_found');
  }
  const metaName = entries.find((name) => name.endsWith('.meta.json'));
  let meta: Record<string, unknown> | null = null;
  if (metaName) {
    const path = join(directory, metaName);
    if ((await fileSize(path)) <= META_MAX_BYTES) {
      const parsed = await readJson(path);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    }
  }
  const named = (meta?.files ?? {}) as Record<string, unknown>;
  const safe = (value: unknown) => (typeof value === 'string' && value && basename(value) === value && entries.includes(value) ? value : null);
  const base = basename(directory);
  const data = safe(named.data) ?? (entries.includes(`${base}.data.csv`) ? `${base}.data.csv` : entries.find((n) => n.endsWith('.data.csv')) ?? `${base}.data.csv`);
  const events = safe(named.events) ?? (entries.includes(`${base}.events.csv`) ? `${base}.events.csv` : entries.find((n) => n.endsWith('.events.csv')) ?? `${base}.events.csv`);
  return { data: join(directory, data), events: join(directory, events), meta };
}

/**
 * The events sidecar and meta file that sit beside a data CSV a user picked (a Desktop export,
 * or a copy of a Studio recording folder). Same names as the Desktop's file picker matches:
 * `<base>.events.csv`, `<base>.meta.json`, else the one meta file whose `files.data` names this CSV.
 */
export async function siblingFilesOf(path: string): Promise<{ events: string | null; meta: Record<string, unknown> | null }> {
  const directory = dirname(path);
  const name = basename(path);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return { events: null, meta: null };
  }
  const events = entries.find((entry) => entry.toLowerCase() === sidecarNameFor(name).toLowerCase()) ?? null;
  const readMeta = async (entry: string) => {
    const file = join(directory, entry);
    if ((await fileSize(file)) > META_MAX_BYTES) return null;
    const parsed = await readJson(file);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  };
  const exact = entries.find((entry) => entry.toLowerCase() === metaNameFor(name).toLowerCase());
  let meta = exact ? await readMeta(exact) : null;
  if (!meta) {
    for (const entry of entries.filter(isMetaFile)) {
      const candidate = await readMeta(entry);
      if (candidate && (candidate.files as Record<string, unknown> | undefined)?.data === name) {
        meta = candidate;
        break;
      }
    }
  }
  return { events: events ? join(directory, events) : null, meta };
}

export function createToolsArea(deps: ToolsDeps = {}): AreaModule {
  return {
    area: 'tools',
    register(context: AreaContext): AreaHandlers {
      const dialogs = deps.dialogs ?? electronDialogs;
      const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
      const recordingPath = deps.recordingPath ?? ((id: string) => context.controller.recordingPath(id));
      const opened = new Map<string, string>();
      const historyPath = join(context.userDataDir, HISTORY_FILE);
      const pressurePath = join(context.userDataDir, PRESSURE_FILE);

      let historyQueue: Promise<unknown> = Promise.resolve();
      const loadHistory = async (): Promise<Record<string, string[]>> => {
        const raw = await readJson(historyPath);
        const out: Record<string, string[]> = {};
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [uid, lines] of Object.entries(raw as Record<string, unknown>)) {
            if (Array.isArray(lines)) out[uid] = lines.filter((line): line is string => typeof line === 'string');
          }
        }
        return out;
      };
      const mutateHistory = <T>(fn: (all: Record<string, string[]>) => T): Promise<T> => {
        const next = historyQueue.then(async () => {
          const all = await loadHistory();
          const value = fn(all);
          await writeJson(historyPath, all);
          return value;
        });
        historyQueue = next.catch(() => undefined);
        return next;
      };
      const uidKey = (uid: unknown) => {
        const key = String(uid ?? '').trim().toUpperCase();
        if (!/^[A-Z0-9:_-]{1,64}$/.test(key)) throw new Error('invalid_uid');
        return key;
      };

      const loadPressure = async (): Promise<PressureCalStored> => normalizePressureSettings(await readJson(pressurePath));
      const pressureCall = async <T = Record<string, unknown>>(call: Parameters<typeof runPressureCall>[1]): Promise<PressureResult<T>> => {
        const result = await runPressureCall<T>(pressureClientFor(await loadPressure(), fetchFn), call);
        if (!result.ok) context.logger.warn(`tools: pressure api ${result.status ?? 0}`);
        return result;
      };

      const sourcePath = async (source: ToolsFileSource): Promise<string> => {
        if (source && source.kind === 'opened') {
          const path = opened.get(String(source.token));
          if (!path) throw new Error('unknown_file');
          return path;
        }
        if (source && source.kind === 'recording') {
          const files = await recordingFilesIn(recordingPath(String(source.recordingId)));
          return source.file === 'events' ? files.events : files.data;
        }
        throw new Error('invalid_source');
      };

      return {
        terminalHelp: () => terminalHelpItems(),
        terminalCompile: (commandLine: string, deviceCommands?: string[]) => {
          try {
            const names = Array.isArray(deviceCommands) ? deviceCommands.filter((n) => typeof n === 'string') : null;
            return { ok: true, compiled: compileTerminalCommand(String(commandLine ?? ''), names) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
        terminalHistory: async (uid: string) => (await loadHistory())[uidKey(uid)] ?? [],
        terminalHistoryAdd: (uid: string, commandLine: string) => {
          const key = uidKey(uid);
          const line = String(commandLine ?? '').trim().slice(0, 4096);
          return mutateHistory((all) => {
            const list = (all[key] ?? []).filter((item) => item !== line);
            if (line) list.push(line);
            all[key] = list.slice(-TERMINAL_HISTORY_LIMIT);
            return all[key];
          });
        },
        terminalHistoryClear: async (uid: string) => {
          const key = uidKey(uid);
          await mutateHistory((all) => {
            delete all[key];
          });
        },

        recordingFiles: async (recordingId: string): Promise<ToolsRecordingFiles> => {
          const files = await recordingFilesIn(recordingPath(String(recordingId)));
          return {
            recordingId: String(recordingId),
            dataBytes: await fileSize(files.data),
            eventsBytes: await fileSize(files.events),
            meta: files.meta,
            dataName: basename(files.data),
          };
        },
        openAnalysisFile: async () => {
          const path = await dialogs.open([{ name: 'CSV', extensions: ['csv'] }]);
          if (!path) return null;
          const token = randomUUID();
          opened.set(token, path);
          const siblings = await siblingFilesOf(path);
          let eventsToken: string | null = null;
          if (siblings.events) {
            eventsToken = randomUUID();
            opened.set(eventsToken, siblings.events);
          }
          return { token, name: basename(path), bytes: await fileSize(path), eventsToken, meta: siblings.meta };
        },
        readChunk: async (source: ToolsFileSource, offset: number, length?: number) => {
          const path = await sourcePath(source);
          try {
            return await readFileChunk(path, offset, length);
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { data: new Uint8Array(), nextOffset: 0, done: true, totalBytes: 0 };
            throw error;
          }
        },

        saveFile: async (request: ToolsSaveRequest) => {
          const name = basename(String(request?.defaultName || 'export'));
          const path = await dialogs.save(name, Array.isArray(request?.filters) ? request.filters : []);
          if (!path) return null;
          const data = request.data;
          await fs.writeFile(path, typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
          return path;
        },
        openUploadFile: async (maxBytes?: number) => {
          const limit = Math.min(TOOLS_MAX_UPLOAD_BYTES, Math.max(1, Number(maxBytes) || TOOLS_MAX_UPLOAD_BYTES));
          const path = await dialogs.open([]);
          if (!path) return null;
          if ((await fileSize(path)) > limit) throw new Error('file_too_large');
          return { name: basename(path), data: new Uint8Array(await fs.readFile(path)) };
        },

        pressureSettings: async () => pressureSettingsView(await loadPressure()),
        pressureSaveSettings: async (input: PressureSettingsInput): Promise<PressureResult<{ status: 'saved' }>> => {
          const next = applyPressureSettings(await loadPressure(), input ?? {});
          if ('error' in next) return { ok: false, error: next.error };
          await writeJson(pressurePath, next);
          return { ok: true, data: { status: 'saved' } };
        },
        pressureHealth: () => pressureCall((c) => c.health()),
        pressureReadings: () => pressureCall<PressureReadings>((c) => c.readings()),
        pressureSetTarget: async (kpa: number): Promise<PressureResult> => {
          const error = pressureTargetError(kpa);
          if (error) return { ok: false, error, status: 422 };
          return pressureCall((c) => c.setTarget(kpa));
        },
        pressureStop: () => pressureCall((c) => c.stop()),
      };
    },
  };
}

export const toolsArea: AreaModule = createToolsArea();
