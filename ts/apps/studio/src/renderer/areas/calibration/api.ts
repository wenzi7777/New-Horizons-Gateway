// Typed client for the "calibration" area (see ../../../shared/areas/calibration.ts).
import type { CalibrationAreaApi, CalibrationExportRequest } from '../../../shared/areas/calibration';
import type { StudioApi } from '../../../shared/contract';

export function calibrationApi(api: StudioApi) {
  return {
    saveExport: (request: CalibrationExportRequest) => api.call<Awaited<ReturnType<CalibrationAreaApi['saveExport']>>>('calibration', 'saveExport', request),
    on: (event: string, listener: (payload: unknown) => void) => api.onAreaEvent('calibration', event, listener),
  };
}
