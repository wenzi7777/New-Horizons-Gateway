// Main-process handlers of the "calibration" area (see ../../shared/areas.ts).
// Only saveExport: the save dialog and the file write for the workbench's
// CSV / JSON export. Electron is loaded lazily and injectable, so this stays
// testable without it (like ../ipc.ts).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CALIBRATION_EXPORT_MAX_BYTES,
  type CalibrationExportFormat,
  type CalibrationExportRequest,
} from '../../shared/areas/calibration';
import type { AreaContext, AreaModule } from './registry';

export interface CalibrationAreaDeps {
  /** Ask where to save (suggesting `fileName` in a sensible folder); the chosen absolute path or null. */
  showSaveDialog(options: { fileName: string; filters: { name: string; extensions: string[] }[] }): Promise<string | null>;
  writeFile(file: string, content: string): Promise<void>;
}

const FILTERS: Record<CalibrationExportFormat, { name: string; extensions: string[] }> = {
  csv: { name: 'CSV', extensions: ['csv'] },
  json: { name: 'JSON', extensions: ['json'] },
};

/** A plain file name: no separators, no control or reserved characters, bounded. */
export function sanitizeFileStem(stem: unknown): string {
  const text = typeof stem === 'string' ? stem : '';
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-').replace(/^[.\s-]+/, '').slice(0, 120).trim();
  return clean || 'calibration';
}

export function validateExportRequest(value: unknown): CalibrationExportRequest {
  const request = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!request) throw new Error('invalid_export');
  const format = request.format;
  if (format !== 'csv' && format !== 'json') throw new Error('invalid_export_format');
  if (typeof request.content !== 'string') throw new Error('invalid_export_content');
  if (Buffer.byteLength(request.content, 'utf8') > CALIBRATION_EXPORT_MAX_BYTES) throw new Error('export_too_large');
  return { fileStem: sanitizeFileStem(request.fileStem), format, content: request.content };
}

export function createCalibrationArea(deps: (context: AreaContext) => CalibrationAreaDeps): AreaModule {
  return {
    area: 'calibration',
    register(context) {
      const io = deps(context);
      return {
        async saveExport(raw: unknown): Promise<string | null> {
          const request = validateExportRequest(raw);
          const extension = FILTERS[request.format].extensions[0];
          const chosen = await io.showSaveDialog({
            fileName: `${request.fileStem}.${extension}`,
            filters: [FILTERS[request.format]],
          });
          if (!chosen) return null;
          if (!path.isAbsolute(chosen)) throw new Error('invalid_export_path');
          const file = path.extname(chosen) ? chosen : `${chosen}.${extension}`;
          await io.writeFile(file, request.content);
          context.logger.info(`calibration export saved: ${file}`);
          return file;
        },
      };
    },
  };
}

/** The real module: Electron's dialog, loaded when first used. */
export const calibrationArea: AreaModule = createCalibrationArea(() => ({
  async showSaveDialog({ fileName, filters }) {
    const { app, BrowserWindow, dialog } = await import('electron');
    const options = { defaultPath: path.join(app.getPath('documents'), fileName), filters };
    const window = BrowserWindow.getFocusedWindow();
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  },
  writeFile: (file, content) => writeFile(file, content, 'utf8'),
}));
