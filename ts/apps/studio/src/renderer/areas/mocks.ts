// Every area's mock, for MockStudioApi.call / onAreaEvent (one line per area).
import type { AreaName } from '../../shared/areas';
import { appMock } from './app/mock';
import { appsMock } from './apps/mock';
import { calibrationMock } from './calibration/mock';
import type { AreaMock } from './mockTypes';
import { profilesMock } from './profiles/mock';
import { syncMock } from './sync/mock';
import { toolsMock } from './tools/mock';

export const AREA_MOCKS: Record<AreaName, AreaMock> = {
  app: appMock,
  sync: syncMock,
  profiles: profilesMock,
  apps: appsMock,
  tools: toolsMock,
  calibration: calibrationMock,
};
