// Browser-preview (mock) implementation of the "calibration" area: the same
// methods as main/areas/calibration.ts, with canned behaviour. There is no
// save dialog in a browser, so saveExport pretends and names a path.
import type { AreaMock } from '../mockTypes';

export const calibrationMock: AreaMock = () => ({
  saveExport: async (request: { fileStem?: string; format?: string }) => `~/Documents/${request.fileStem ?? 'calibration'}.${request.format === 'json' ? 'json' : 'csv'}`,
});
