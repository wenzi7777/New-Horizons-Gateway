// Typed API of the "tools" area (see ../areas.ts): recording analysis, the
// device terminal, device files, the timestamp converter and the lab's
// pressure chamber. main/areas/tools.ts implements it; renderer/areas/tools
// calls it through renderer/areas/tools/api.ts.

/** One Terminal help card (the Desktop's /api/terminal/help item). */
export interface TerminalHelpItem {
  command: string;
  description: string;
  example: string;
}

/** compile_terminal_command()'s result. */
export interface CompiledTerminalCommand {
  command: string;
  payload: Record<string, unknown>;
  argv: string[];
}

export type TerminalCompileResult = { ok: true; compiled: CompiledTerminalCommand } | { ok: false; error: string };

/**
 * A file the analysis tool can stream: a Studio recording's data / events
 * file, or one the user picked with openAnalysisFile (by its token, so the
 * renderer never names an arbitrary path).
 */
export type ToolsFileSource = { kind: 'recording'; recordingId: string; file: 'data' | 'events' } | { kind: 'opened'; token: string };

export interface ToolsRecordingFiles {
  recordingId: string;
  /** Data CSV size in bytes (0 when missing). */
  dataBytes: number;
  eventsBytes: number;
  /** The folder's .meta.json, parsed (null when missing or unreadable). */
  meta: Record<string, unknown> | null;
  dataName: string;
}

export interface ToolsOpenedFile {
  token: string;
  name: string;
  bytes: number;
  /** Token of the `.events.csv` beside the file, when there is one. */
  eventsToken?: string | null;
  /** The `.meta.json` beside the file, parsed (null when missing or unreadable). */
  meta?: Record<string, unknown> | null;
}

export interface ToolsChunk {
  /** Raw bytes (UTF-8 text for CSV); decode with a streaming TextDecoder. */
  data: Uint8Array;
  nextOffset: number;
  done: boolean;
  totalBytes: number;
}

export interface ToolsSaveRequest {
  defaultName: string;
  /** e.g. [{ name: 'CSV', extensions: ['csv'] }] */
  filters?: { name: string; extensions: string[] }[];
  /** Text is written as UTF-8. */
  data: string | Uint8Array;
}

export interface ToolsUploadFile {
  name: string;
  data: Uint8Array;
}

export interface PressurePreset {
  id: string;
  label: string;
  url: string;
}

/** The Desktop's GET /api/pressure-cal/settings (the token itself is never returned). */
export interface PressureSettingsView {
  preset: string;
  url: string;
  /** First 8 characters + "..." or "". */
  tokenHint: string;
  configured: boolean;
  presets: PressurePreset[];
}

export interface PressureSettingsInput {
  preset: string;
  url?: string;
  /** Empty / missing keeps the stored token. */
  token?: string;
}

/** A pressure API call's outcome; errors use the Desktop's codes (pressure_cal_not_configured, target_kpa_exceeds_safety_limit, ...). */
export type PressureResult<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; error: string; status?: number };

export interface PressureReadings {
  uno: { pressure_kpa: number; safety_latched?: boolean; [key: string]: unknown };
  imada: { value: number; unit: string; [key: string]: unknown } | null;
  [key: string]: unknown;
}

export interface ToolsAreaApi {
  terminalHelp(): Promise<TerminalHelpItem[]>;
  /** deviceCommands: the device's own catalog names (firmware v1.15.0+), accepted on top of the allowlist. */
  terminalCompile(commandLine: string, deviceCommands?: string[]): Promise<TerminalCompileResult>;
  terminalHistory(uid: string): Promise<string[]>;
  terminalHistoryAdd(uid: string, commandLine: string): Promise<string[]>;
  terminalHistoryClear(uid: string): Promise<void>;

  recordingFiles(recordingId: string): Promise<ToolsRecordingFiles>;
  /** Open dialog for a CSV; null when cancelled. */
  openAnalysisFile(): Promise<ToolsOpenedFile | null>;
  readChunk(source: ToolsFileSource, offset: number, length?: number): Promise<ToolsChunk>;

  /** Save dialog; resolves with the saved path or null when cancelled. */
  saveFile(request: ToolsSaveRequest): Promise<string | null>;
  /** Open dialog for a file to upload to a device (≤ maxBytes); null when cancelled. */
  openUploadFile(maxBytes?: number): Promise<ToolsUploadFile | null>;

  pressureSettings(): Promise<PressureSettingsView>;
  pressureSaveSettings(input: PressureSettingsInput): Promise<PressureResult<{ status: 'saved' }>>;
  pressureHealth(): Promise<PressureResult>;
  pressureReadings(): Promise<PressureResult<PressureReadings>>;
  pressureSetTarget(kpa: number): Promise<PressureResult>;
  pressureStop(): Promise<PressureResult>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ToolsAreaEvents {}

export const TOOLS_CHUNK_BYTES = 1 << 20;
export const TOOLS_MAX_CHUNK_BYTES = 8 << 20;
export const TOOLS_MAX_UPLOAD_BYTES = 1 << 20;
