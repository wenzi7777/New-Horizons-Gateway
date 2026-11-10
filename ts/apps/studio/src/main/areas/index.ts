// Every feature area's main-process module, in registration order. Adding an
// area means one line here and one in ../../shared/areas.ts.
import { appArea } from './app';
import { appsArea } from './apps';
import { calibrationArea } from './calibration';
import { profilesArea } from './profiles';
import type { AreaModule } from './registry';
import { syncArea } from './sync';
import { toolsArea } from './tools';

export const AREA_MODULES: readonly AreaModule[] = [appArea, syncArea, profilesArea, appsArea, toolsArea, calibrationArea];

export { AreaRegistry, type AreaContext, type AreaHandlers, type AreaModule } from './registry';
