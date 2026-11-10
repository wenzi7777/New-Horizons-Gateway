// The UI's quick commands as device payloads -- the same payloads the
// Desktop's device settings send (New-Horizons-Desktop/frontend/src/pages/
// DeviceSettingsPage.tsx, components/calibration/CalibrationWorkbench.tsx;
// commands in NewHorizonsOS-OTA/spec/commands.md).
import type { QuickCommand } from './contract';

/** CalibrationWorkbench's ZERO_DURATION_MS: how long a tare averages. */
export const TARE_DURATION_MS = 1000;

export function quickCommandPayload(command: QuickCommand): Record<string, unknown> {
  switch (command.kind) {
    case 'status':
      return { command: 'status' };
    case 'reboot':
      return { command: 'reboot' };
    case 'enter_maintenance':
      // The settings page's mode switch sends reason "manual" (calibration sends "calibration").
      return { command: 'enter_maintenance', reason: 'manual' };
    case 'exit_maintenance':
      return { command: 'exit_maintenance' };
    case 'scan_rate':
      // applyScanPreset(): 60 fps settles 20 µs, above 60 fps 15 µs; every frame sent.
      return { command: 'set_scan_timing', target_fps: command.fps, settle_us: command.fps > 60 ? 15 : 20, send_every_n_frames: 1 };
    case 'tare':
      return { command: 'calibration_tare_capture', duration_ms: TARE_DURATION_MS };
    case 'tare_clear':
      return { command: 'calibration_tare_clear' };
  }
}
