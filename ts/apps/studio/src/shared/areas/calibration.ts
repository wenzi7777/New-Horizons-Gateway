// Typed API of the "calibration" area (see ../areas.ts). main/areas/calibration.ts
// implements it and renderer/areas/calibration/api.ts calls it. Device
// commands themselves go through the generic api.sendCommand; the area only
// owns what the renderer cannot do alone: saving an export through the
// system's save dialog.

export type CalibrationExportFormat = 'csv' | 'json';

export interface CalibrationExportRequest {
  /** File name without extension, e.g. calibration-<uid>-<time>; sanitised by main. */
  fileStem: string;
  format: CalibrationExportFormat;
  content: string;
}

/** Largest export main will write (a 32x32 matrix with many levels is well under 1 MB). */
export const CALIBRATION_EXPORT_MAX_BYTES = 16 * 1024 * 1024;

export interface CalibrationAreaApi {
  /** Save dialog, then write; the absolute path, or null when cancelled. */
  saveExport(request: CalibrationExportRequest): Promise<string | null>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CalibrationAreaEvents {}
