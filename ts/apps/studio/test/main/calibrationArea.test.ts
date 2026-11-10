import { describe, expect, it } from 'vitest';

import { createCalibrationArea, sanitizeFileStem, validateExportRequest } from '../../src/main/areas/calibration';
import type { AreaContext } from '../../src/main/areas';

const logger = { info() {}, warn() {}, error() {} };
const context = { controller: {} as AreaContext['controller'], logger, userDataDir: '/tmp', version: 'v0', emit: () => undefined } as AreaContext;

function area(chosen: string | null) {
  const written: [string, string][] = [];
  const asked: unknown[] = [];
  const handlers = createCalibrationArea(() => ({
    showSaveDialog: async (options) => (asked.push(options), chosen),
    writeFile: async (file, content) => void written.push([file, content]),
  })).register(context) as { saveExport: (request: unknown) => Promise<string | null> };
  return { handlers, written, asked };
}

describe('calibration area: saveExport', () => {
  it('asks, then writes the chosen file', async () => {
    const { handlers, written, asked } = area('/Users/x/cal');
    expect(await handlers.saveExport({ fileStem: 'calibration-AB-1', format: 'csv', content: 'a,b\n' })).toBe('/Users/x/cal.csv');
    expect(written).toEqual([['/Users/x/cal.csv', 'a,b\n']]);
    expect(asked).toEqual([{ fileName: 'calibration-AB-1.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] }]);
  });

  it('writes nothing when cancelled', async () => {
    const { handlers, written } = area(null);
    expect(await handlers.saveExport({ fileStem: 'x', format: 'json', content: '{}' })).toBeNull();
    expect(written).toEqual([]);
  });

  it('refuses bad requests and relative paths', async () => {
    expect(() => validateExportRequest(null)).toThrow('invalid_export');
    expect(() => validateExportRequest({ format: 'exe', content: '' })).toThrow('invalid_export_format');
    expect(() => validateExportRequest({ format: 'csv', content: 5 })).toThrow('invalid_export_content');
    await expect(area('relative.csv').handlers.saveExport({ fileStem: 'x', format: 'csv', content: '' })).rejects.toThrow('invalid_export_path');
  });

  it('sanitises the suggested name', () => {
    expect(sanitizeFileStem('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeFileStem('a:b*c')).toBe('a-b-c');
    expect(sanitizeFileStem('')).toBe('calibration');
  });
});
