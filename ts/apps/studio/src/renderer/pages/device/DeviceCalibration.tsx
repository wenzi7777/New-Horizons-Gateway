// The device page's Calibration tab: the full workbench, owned by the
// "calibration" area (../../areas/calibration/).
import type { DeviceView } from '../../../shared/contract';
import { CalibrationWorkbench } from '../../areas/calibration/CalibrationWorkbench';

export function DeviceCalibration({ device }: { device: DeviceView }) {
  return <CalibrationWorkbench device={device} />;
}
